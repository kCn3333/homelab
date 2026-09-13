# K3s Homelab — remotedialer i naprawa Grafany

**Data:** 2026-09-12

**Środowisko:** 3× HP T630, k3s v1.34.4+k3s1, Flux v2.8.1, Cilium v1.19.1, kube-prometheus-stack 82.10.1, Grafana 12.4.0

---

## Cel sesji

1. Ponownie sprawdzić błąd tunelu remotedialer po uruchomieniu klastra.
2. Potwierdzić bezpieczne, doraźne odtworzenie brakującego tunelu.
3. Znaleźć przyczynę błędu `An error occurred within the plugin` w Grafanie.
4. Utrwalić konfigurację Grafany i Loki w repozytorium Flux.
5. Usunąć błędy sidecarów Grafany podczas uruchamiania Poda.

---

## 1. Ponowne odtworzenie błędu remotedialera

Klaster uruchomiono dotychczasowym playbookiem Power On, bez zmiany kolejności i odstępów Wake-on-LAN. Usługi K3s, lokalne API i etcd osiągnęły gotowość, ale test połączeń API server → kubelet nie przeszedł:

```text
worker1 API → worker2 kubelet: 502 Bad Gateway
```

Komunikat K3s:

```text
proxy error from 127.0.0.1:6443 while dialing 192.168.55.12:10250
```

Na `worker2` brakowało połączenia do API servera na `worker1`:

```text
BRAK worker2 -> worker1:6443
```

EndpointSlice Service `kubernetes` był poprawny:

```text
192.168.55.10 ready=true
192.168.55.11 ready=true
192.168.55.12 ready=true
```

Problem nie wynikał więc z braku noda w EndpointSlice. Lokalny proces K3s na `worker2` nie zestawił jednego z wymaganych tuneli mimo poprawnego docelowego stanu API.

## 2. Doraźny resync remotedialera

Zmiana adnotacji EndpointSlice wymusiła nowe zdarzenie obserwowane przez K3s:

```bash
kubectl annotate endpointslice kubernetes \
  --namespace default \
  diagnostics.kcn333.com/remotedialer-resync="$(date -u +%s)" \
  --overwrite
```

Na `worker2` pojawiła się pełna sekwencja synchronizacji:

```text
Syncing apiserver addresses from tunnel watch
Settled apiserver addresses sync
Sync apiserver addresses - connecting: [192.168.55.11:6443]
Started tunnel to 192.168.55.11:6443
Remotedialer connected to proxy
```

Po resyncu test zakończył się wynikiem `ok`:

```bash
ssh worker1 '
  sudo k3s kubectl \
    --request-timeout=5s \
    get --raw \
    /api/v1/nodes/worker2/proxy/healthz
'
```

Adnotację diagnostyczną następnie usunięto:

```bash
kubectl annotate endpointslice kubernetes \
  --namespace default \
  diagnostics.kcn333.com/remotedialer-resync-
```

### Stan problemu

Przyczyna pozostaje nierozstrzygnięta. Potwierdzono jedynie, że:

- błąd może wystąpić po równoczesnym uruchomieniu nodów;
- EndpointSlice może już zawierać wszystkie trzy poprawne adresy;
- jeden klient remotedialera może mimo to nie posiadać tunelu do jednego API servera;
- ponowne zdarzenie na EndpointSlice uruchamia synchronizację i odtwarza brakujący tunel;
- nie jest wymagany restart noda ani usługi K3s.

Playbook Power On pozostawiono bez sztucznego opóźnienia między nodami. Resync EndpointSlice jest obejściem, nie wyjaśnieniem przyczyny.

---

## 3. Objaw awarii Grafany

Dashboardy Grafany wyświetlały:

```text
An error occurred within the plugin
```

Log Grafany wskazał rzeczywisty błąd:

```text
dial tcp 10.43.68.211:9090: i/o timeout
```

Adres `10.43.68.211:9090` należał do Service Prometheusa. Prometheus działał z `hostNetwork: true` na `worker1`, dlatego jego backendem był adres noda:

```text
192.168.55.11:9090
```

Test lokalny na `worker1` działał zarówno przez loopback, jak i adres noda:

```text
127.0.0.1:9090       Prometheus Server is Ready
192.168.55.11:9090   Prometheus Server is Ready
```

Połączenie z `worker2` kończyło się timeoutem. `tcpdump` na `worker1` pokazał przychodzące pakiety SYN z `192.168.55.12`, ale brak odpowiedzi SYN-ACK. Potwierdziło to blokadę na hoście docelowym, a nie awarię Prometheusa, Service albo DNS.

## 4. Przyczyna i naprawa połączenia Grafana → Prometheus

UFW na nodach nie zezwalał na ruch klastra do portu `9090/tcp`, na którym Prometheus nasłuchiwał przez `hostNetwork`.

Regułę najpierw sprawdzono na `worker1`:

```bash
sudo ufw allow \
  from 192.168.55.0/24 \
  to any port 9090 \
  proto tcp
```

Po jej dodaniu:

- `worker2` otrzymał odpowiedź `Prometheus Server is Ready`;
- Grafana zaczęła łączyć się z Prometheusem przez nazwę Service;
- dashboardy natychmiast zaczęły wyświetlać dane;
- w logach Grafany przestały pojawiać się timeouty do Prometheusa.

Regułę utrwalono następnie w playbooku UFW repozytorium Ansible:

```text
9090/tcp ALLOW IN 192.168.55.0/24
```

Pierwsze uruchomienie dodało po jednej regule na każdym nodzie. Drugie uruchomienie było idempotentne:

```text
master   changed=0 failed=0
worker1  changed=0 failed=0
worker2  changed=0 failed=0
```

Nie otwarto portu `9090` dla całej sieci LAN ani Internetu.

---

## 5. Utrwalenie konfiguracji Grafany przez Flux

Grafana używała `emptyDir` dla `/var/lib/grafana`. Ręcznie utworzone obiekty mogły więc zniknąć po wymianie Poda.

Przed rolloutem wyeksportowano dashboard aplikacji:

```text
tytuł: clinets-api-APP
UID: ad549hw
liczba paneli: 6
schemaVersion: 42
```

W repozytorium Flux dodano:

- `grafana-dashboard-clients-api.yaml` — ConfigMap z etykietą `grafana_dashboard: "1"`;
- `grafana-datasource-loki.yaml` — ConfigMap z etykietą `grafana_datasource: "1"`;
- oba zasoby do `infrastructure/operators/monitoring/kustomization.yaml`.

Datasource Loki zachował dotychczasową tożsamość i adres:

```text
name: loki
uid: cffs50kq506wwe
url: http://loki.loki.svc.cluster.local:3100
```

Po reconciliacji Flux API Grafany potwierdziło:

```text
dashboard.provisioned=true
dashboard.uid=ad549hw
loki.readOnly=true
loki.uid=cffs50kq506wwe
```

Dashboard i datasource nie zależą już od efemerycznej bazy Grafany.

---

## 6. Konflikt portów sidecarów Grafany

Pod Grafany zawiera dwa sidecary `kiwigrid/k8s-sidecar`:

- `grafana-sc-dashboard`;
- `grafana-sc-datasources`.

Oba próbowały uruchomić endpoint zdrowia na domyślnym porcie `8080` we wspólnej przestrzeni sieciowej Poda. Jeden z nich zgłaszał:

```text
OSError: [Errno 98] Address in use
```

W HelmRelease ustawiono oddzielne porty:

```yaml
grafana:
  sidecar:
    dashboards:
      env:
        HEALTH_PORT: "8081"
    datasources:
      env:
        HEALTH_PORT: "8082"
```

Po rolloutcie oba kontenery działały równocześnie, a Pod osiągnął `3/3 Running` bez restartów.

## 7. Wyścig podczas uruchamiania Grafany

Po usunięciu konfliktu portów oba sidecary zgłosiły jednorazowy błąd połączenia z:

```text
http://localhost:3000/api/admin/provisioning/.../reload
```

Pomiar czasów wykazał:

```text
11:12:53.706  Starting Grafana
11:13:13.2    sidecary wyczerpały domyślne próby
11:14:20.996  HTTP Server Listen :3000
```

Grafana potrzebowała około 87 sekund na utworzenie świeżej bazy SQLite, migracje, provisionowanie i instalację pluginów. Domyślne `REQ_RETRY_TOTAL=5` zakończyło się około 68 sekund przed uruchomieniem HTTP.

Dla obu sidecarów ustawiono:

```yaml
REQ_RETRY_TOTAL: "8"
```

Nie zmieniono `REQ_RETRY_CONNECT`, ponieważ jego wartość domyślna wynosi `10`.

Po końcowym rolloutcie:

```text
kube-prometheus-stack-grafana-6855d64694-kk2jq
3/3 Running
restarts=0
```

Dashboardy Grafany wyświetlały dane. Temat Grafany został zamknięty.

---

## 8. Końcowy stan

### Grafana — naprawiona

- komunikacja Grafana → Prometheus działa;
- UFW deklaratywnie dopuszcza `9090/tcp` wyłącznie z sieci nodów;
- dashboard aplikacji jest provisionowany przez Flux;
- datasource Loki jest provisionowany przez Flux;
- sidecary używają oddzielnych portów zdrowia;
- retry sidecarów obejmuje rzeczywisty czas startu Grafany;
- Pod działa jako `3/3 Running` bez restartów;
- dashboardy pokazują dane.

### Remotedialer — problem otwarty

- błąd został ponownie odtworzony;
- zachowano logi debug z niepoprawnego startu;
- resync przez zmianę adnotacji EndpointSlice skutecznie naprawia tunel;
- właściwa przyczyna utraty pojedynczej sesji nadal wymaga ustalenia.

---

## Najważniejsze wnioski

1. `hostNetwork: true` oznacza, że dostęp do portu workloadu zależy również od firewalla noda.
2. Działający lokalnie Prometheus nie gwarantuje dostępu z innego noda.
3. SYN bez SYN-ACK na hoście docelowym wskazuje na filtrację albo brak odpowiedzi po stronie tego hosta.
4. Ręcznie utworzone obiekty Grafany nie powinny pozostawać wyłącznie w bazie przechowywanej w `emptyDir`.
5. Dashboardy i datasources można provisionować przez etykietowane ConfigMapy obserwowane przez sidecary.
6. Kontenery w jednym Podzie współdzielą przestrzeń sieciową, więc nie mogą nasłuchiwać na tym samym adresie i porcie.
7. Retry sidecara musi uwzględniać rzeczywisty czas startu aplikacji, do której wysyła żądanie reload.
8. Poprawny EndpointSlice nie gwarantuje, że lokalny stan tuneli remotedialera został zsynchronizowany.
9. Doraźny resync naprawia stan, ale nie zastępuje ustalenia przyczyny.

## Następna sesja

Diagnostyka Hubble. Problem remotedialera pozostaje zapisany jako osobny, nierozstrzygnięty wątek do porównania podczas kolejnych uruchomień klastra.
