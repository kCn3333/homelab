# 27 - dokończenie migracji Alloy i aktualizacja K3s oraz Cilium

**Data:** 2026-09-16

**Środowisko:** 3× HP T630, K3s `v1.34.4+k3s1` → `v1.35.8+k3s1`, Cilium `1.19.7` → `1.20.2`, Flux `v2.8.1`, Loki `3.6`, Alloy `1.19.2`

## Cel sesji

1. Potwierdzić działanie Alloy po zimnym starcie klastra.
2. Zakończyć migrację z Promtaila do Alloy bez luki w dostarczaniu logów.
3. Zebrać dowody dotyczące kolejnego błędu remotedialera.
4. Przygotować kontrolowany i powtarzalny proces aktualizacji K3s.
5. Zaktualizować K3s z `v1.34.4+k3s1` do `v1.35.8+k3s1`.
6. Sprawdzić nowe wersje przez pełne zimne starty klastra.
7. Zaktualizować Cilium najpierw do `1.19.8`, a następnie do `1.20.2`.
8. Potwierdzić działanie sieci, DNS, polityk Cilium, Sealed Secrets i Fluxa.

## Zakończenie migracji z Promtaila do Alloy

Po zimnym starcie oba kolektory działały równolegle:

```text
Promtail: 3 desired / 3 ready / 3 available
Alloy:    3 desired / 3 ready / 3 available
```

W logach Alloy z ostatnich trzech godzin nie było błędów, timeoutów, odpowiedzi
`429`, odrzuconych batchy ani problemów z prawami dostępu.

Na każdym nodzie istniał i był aktualizowany lokalny plik pozycji:

```text
/var/lib/alloy/loki.source.file.pod_logs/positions.yml
```

Pliki przetrwały restart nodów, ponieważ `/var/lib/alloy` jest hostPath, a nie
`tmpfs`. Każdy node zachowuje własny plik pozycji odpowiadający lokalnym plikom
`/var/log/pods`.

## Test równoległego zapisu

Utworzono kontrolny Pod `alloy-cutover-074958`, który wygenerował 12 unikalnych
linii. Zapytanie LogQL zwróciło:

| Kolektor | Etykieta `collector` | Linie |
|---|---|---:|
| Promtail | brak | 12 |
| Alloy | `alloy` | 12 |
| **Razem** |  | **24** |

Oba kolektory odczytały ten sam kompletny zestaw. Nie brakowało linii i żaden z
kolektorów nie wysłał ich wielokrotnie w obrębie własnego strumienia.

Test potwierdził jednocześnie, że:

- Alloy prawidłowo wykrywa nowe pliki logów;
- przesuwa lokalny offset;
- przetwarza format CRI;
- wysyła wpisy do Loki;
- zachowuje etykiety wymagane do filtrowania;
- działa po ponownym uruchomieniu nodów.

## Usunięcie Promtaila

Po udanym teście Promtail został usunięty z GitOps. Flux usunął HelmRelease,
DaemonSet oraz release Helm:

```text
HelmRelease/promtail: NotFound
DaemonSet/promtail:   NotFound
helm list:            tylko alloy
```

Stan docelowego kolektora:

```text
chart:      alloy 1.12.1
aplikacja:  Alloy v1.19.2
DaemonSet:  3 desired / 3 ready / 3 available
```

Stare strumienie bez etykiety `collector` nadal mogą być zwracane przez Loki do
końca retencji. Są to dane historyczne wysłane przez Promtail, a nie dowód, że
Promtail nadal działa.

Migracja została zakończona bez przerwy w dostarczaniu logów. Okres równoległego
zapisu celowo powodował duplikaty między kolektorami; był to koszt bezpiecznego
cutoveru bez ryzyka pominięcia ważnych wpisów.

## Błąd remotedialera po starcie

Klaster uruchomiony na K3s `v1.34.4+k3s1` miał wszystkie nody `Ready`, ale jedna
ścieżka API server → kubelet zwracała błąd:

```text
worker1 API → worker2 kubelet: 502 Bad Gateway
```

Pozostałe osiem ścieżek działało. `EndpointSlice/default/kubernetes` zawierał trzy
gotowe adresy:

```text
192.168.55.10
192.168.55.11
192.168.55.12
```

Poprawny EndpointSlice ponownie nie wystarczył do potwierdzenia kompletnego zestawu
sesji remotedialera. Błąd dotyczył lokalnego API servera na `worker1`, który nie
miał działającej ścieżki do kubeleta `worker2`.

Przed naprawą zachowano pełne logi bieżącego bootu w:

```text
~/k3s-remotedialer-debug-20260916T063254Z
```

## Resynchronizacja tunelu

Uruchomiono potwierdzony wcześniej skrypt:

```bash
~/k3s/remotedialer-resync.sh
```

Zmiana adnotacji EndpointSlice wywołała na `worker2` ponowną synchronizację listy
API serverów. Logi pokazały:

```text
Syncing apiserver addresses from tunnel watch:
[192.168.55.10:6443 192.168.55.11:6443 192.168.55.12:6443]

Settled apiserver addresses sync:
[192.168.55.10:6443 192.168.55.11:6443 192.168.55.12:6443]

Started tunnel to 192.168.55.11:6443
Connected to proxy wss://192.168.55.11:6443/v1-k3s/connect
Remotedialer connected to proxy
```

Po resynchronizacji:

```text
API server → kubelet matrix: 9/9 OK
```

Skrypt naprawił stan bez restartu K3s. Nadal był to workaround, a nie usunięcie
przyczyny. Z tego powodu nie dodano automatycznego resyncu do playbooka Power On.
Automatyczna naprawa ukrywałaby wystąpienia błędu i utrudniała ocenę kolejnych wersji.

## Kontrolowany playbook aktualizacji

Do repozytorium Ansible dodano:

```text
cluster/playbooks/maintenance/k3s-upgrade.yml
```

Playbook wymaga pełnej wersji przekazanej jawnie jako:

```text
k3s_target_version=v1.35.8+k3s1
```

Najważniejsze zabezpieczenia:

1. wymagane pełne inventory: jeden master i dwa workery;
2. zakaz użycia `--limit`;
3. sprawdzenie pliku binarnego, architektury, wersji i aktywnej usługi;
4. sprawdzenie lokalnego API i etcd na każdym serwerze;
5. zakaz downgrade'u i przeskoku o więcej niż jeden minor;
6. jeden snapshot embedded etcd przed zmianami;
7. pobranie oficjalnego pliku sum SHA-256;
8. weryfikacja pobranego binarium;
9. atomowa podmiana `/usr/local/bin/k3s` z zachowaniem backupu;
10. aktualizacja `worker1` → `worker2` → `master`, `serial: 1`;
11. oczekiwanie na usługę, lokalne API, etcd i `Node Ready` po każdym serwerze;
12. końcowa walidacja wersji, dokładnego członkostwa nodów i macierzy `3×3`.

## Aktualizacja K3s do `v1.34.10+k3s1`

Pierwsza aktualizacja została wykonana przez zadanie Semaphore
`K3S | 40 Controlled Upgrade`.

Kolejność:

```text
worker1 → worker2 → master
```

Na każdym nodzie playbook:

- pobrał listę sum i binarium;
- zweryfikował SHA-256;
- zachował kopię starego `/usr/local/bin/k3s`;
- atomowo podmienił binarium;
- zrestartował wyłącznie usługę K3s;
- poczekał na lokalne API, etcd i `Node Ready`.

Przed zmianą powstał snapshot:

```text
pre-k3s-upgrade-v1.34.10_k3s1-master-1789548727
```

Końcowa macierz była kompletna, wszystkie nody działały na:

```text
K3s:       v1.34.10+k3s1
containerd: 2.2.5-k3s2
```

Podczas aktualizacji nie zaobserwowano utraty dostępu do klastra. Przy trzech
serwerach control-plane aktualizowanych pojedynczo pozostałe serwery nadal
obsługiwały API i quorum etcd.

## Aktualizacja do ostatniego patcha `1.34`

Po sprawdzeniu klastra wykonano kolejny kontrolowany upgrade:

```text
v1.34.10+k3s1 → v1.34.11+k3s1
```

Stan po aktualizacji:

```text
K3s:        v1.34.11+k3s1
containerd: 2.2.7-k3s1
Nodes:      3/3 Ready
matrix:     9/9 OK
```

## Zimny start na `v1.34.11+k3s1`

Klaster został całkowicie wyłączony i uruchomiony playbookiem `K3S | 10 Power On`.
Playbook potwierdził:

| Kontrola | master | worker1 | worker2 |
|---|---|---|---|
| SSH | OK | OK | OK |
| Ansible | OK | OK | OK |
| sudo | OK | OK | OK |
| usługa K3s | OK | OK | OK |
| lokalne API i etcd | OK | OK | OK |
| Kubernetes Node Ready | OK | OK | OK |

Macierz API server → kubelet:

| API server / kubelet | master | worker1 | worker2 |
|---|---|---|---|
| master | OK | OK | OK |
| worker1 | OK | OK | OK |
| worker2 | OK | OK | OK |

Resynchronizacja EndpointSlice nie była potrzebna.

Wszystkie kontrole zakończyły się powodzeniem.

## Aktualizacja K3s do `v1.35.8+k3s1`

Po zaliczeniu testu gałęzi `1.34` wykonano upgrade o jeden minor:

```text
v1.34.11+k3s1 → v1.35.8+k3s1
```

Ponownie utworzono snapshot, zweryfikowano binaria i zastosowano kolejność:

```text
worker1 → worker2 → master
```

Końcowy stan wszystkich nodów:

```text
K3s:        v1.35.8+k3s1
containerd: 2.2.7-k3s1
Nodes:      3/3 Ready
matrix:     9/9 OK
```

Nie było Podów w stanie innym niż `Running` lub `Succeeded`. Wszystkie
Kustomization i HelmRelease zarządzane przez Flux miały `Ready=True`.

## Zimny start na `v1.35.8+k3s1`

Po aktualizacji minor wykonano drugi pełny zimny start. Power On ponownie potwierdził:

```text
SSH:                         3/3 OK
Ansible:                     3/3 OK
sudo:                        3/3 OK
K3s service:                 3/3 OK
local API and etcd:          3/3 OK
Kubernetes Node Ready:       3/3 OK
API server → kubelet matrix: 9/9 OK
exact Node membership:       OK
WOL interface lifecycle:     OK
```

Skrypt `remotedialer-resync.sh` nie został użyty. Dwa zimne starty po aktualizacjach
zakończyły się pełną macierzą, podczas gdy pierwszy start na `v1.34.4+k3s1` miał
jedną niedziałającą ścieżkę.

To jest mocny wynik testu regresji, ale nie dowodzi jeszcze definitywnie, że
sporadyczny błąd remotedialera został usunięty. Należy nadal sprawdzać macierz przy
kolejnych uruchomieniach i zachować konfigurację debug do czasu zebrania większej
liczby poprawnych startów.

## Stan Cilium przed aktualizacją

Po aktualizacji K3s klaster działał na Cilium `1.19.7`. Konfiguracja obejmowała:

```text
IPAM:                    kubernetes
requireIPv4PodCIDR:      true
kube-apiserver:          192.168.55.10:6443
operator replicas:       1
Hubble:                  enabled
Hubble listen address:   :4244
Hubble TLS:              enabled
Hubble Relay:            enabled
Hubble UI ingress:       Traefik
```

W klastrze była jedna CiliumNetworkPolicy:

```text
flux-system/sealed-secrets-allow-api-server-proxy
```

Pozwala ona encji `remote-node` łączyć się wyłącznie z Podem kontrolera Sealed
Secrets na TCP/8080. Nie było CCNP, `CiliumNodeConfig` ani używanych zasobów
`TLSRoute`.

## Aktualizacja Cilium `1.19.7` → `1.19.8`

Najpierw zainstalowano ostatni patch obecnej gałęzi. Flux wdrożył chart `1.19.8`.

Walidacja:

```text
DaemonSet/cilium:        3/3 available
cilium-dbg status:       OK na wszystkich nodach
cilium-operator:         rollout complete
hubble-relay:            rollout complete
HelmRelease/cilium:      Ready=True
```

Oddzielenie patch upgrade'u od zmiany minor ograniczyło liczbę zmiennych podczas
diagnostyki.

## Preflight przed Cilium `1.20.2`

Uruchomiono oficjalny preflight z chartu docelowej wersji:

```bash
helm install \
  cilium-preflight \
  cilium/cilium \
  --version 1.20.2 \
  --namespace kube-system \
  --set preflight.enabled=true \
  --set agent=false \
  --set operator.enabled=false
```

DaemonSet preflight uruchomił po jednym Podzie na każdym nodzie:

```text
3 Pody, każdy 2/2 Running, 0 restartów
```

Walidator polityk zwrócił:

```text
Validation OK! type=CiliumNetworkPolicy
name=flux-system/sealed-secrets-allow-api-server-proxy
All CCNPs and CNPs valid!
```

Preflight potwierdził, że istniejąca polityka jest akceptowana przez Cilium `1.20.2`.

## Aktualizacja Cilium `1.19.8` → `1.20.2`

W HelmRelease ustawiono docelowy chart `1.20.2` oraz zgodność aktualizacji z linią
źródłową:

```yaml
upgradeCompatibility: "1.19"
```

Flux wykonał upgrade release'u do rewizji `v43`. Rollout zakończyły:

```text
DaemonSet/cilium
Deployment/cilium-operator
Deployment/hubble-relay
```

Docelowy obraz agenta:

```text
quay.io/cilium/cilium:v1.20.2@sha256:2939231d0d3e3ebddcd80fffa168b7ddcc78fdf0dc864d1c8c126ff523c54f01
```

Każdy z trzech Podów Cilium miał `1/1 Running`, zero restartów i był uruchomiony na
innym nodzie. `cilium-dbg status --brief` zwrócił `OK` dla wszystkich agentów.

## Walidacja sieci po aktualizacji

Istniejąca CiliumNetworkPolicy nadal miała:

```text
Valid=True
Policy validation succeeded
```

Pobranie certyfikatu Sealed Secrets przez proxy API servera zakończyło się
powodzeniem:

```text
sha256 Fingerprint=
F3:30:60:71:95:36:2A:F8:C2:15:51:29:81:5D:46:B5:A6:B0:D8:FC:DE:D4:46:E3:B3:A6:16:0F:3C:6F:03:43
```

Potwierdza to działanie ścieżki, dla której wcześniej potrzebna była polityka
`fromEntities: remote-node`.

Test DNS z tymczasowego Poda zwrócił:

```text
Server:  10.43.0.10
Name:    kubernetes.default.svc.cluster.local
Address: 10.43.0.1
```

Pod testowy został usunięty automatycznie przez `kubectl run --rm`.

Końcowe kontrole:

```text
Pody poza Running/Succeeded: brak
Kustomization Flux Ready:    wszystkie
HelmRelease Flux Ready:      wszystkie
Cilium agents:               3/3 OK
Cilium policy:               Valid=True
DNS:                         OK
Sealed Secrets API proxy:    OK
```

## Stan końcowy

| Komponent | Wersja / stan |
|---|---|
| K3s | `v1.35.8+k3s1`, 3/3 Ready |
| containerd | `2.2.7-k3s1` |
| Cilium | `1.20.2`, 3/3 agentów OK |
| Hubble Relay | rollout complete |
| Alloy | chart `1.12.1`, aplikacja `v1.19.2`, 3/3 Ready |
| Promtail | usunięty |
| Loki | chart `6.53.0` |
| Sealed Secrets | chart `2.20.0`, proxy test OK |
| metrics-server | chart `3.13.1` |
| kube-prometheus-stack | chart `82.10.1` |
| Flux Kustomizations | wszystkie Ready |
| Flux HelmReleases | wszystkie Ready |
| API server → kubelet | `9/9 OK` po dwóch zimnych startach |

W jednej sesji zakończono migrację kolektora logów, wprowadzono kontrolowany proces
aktualizacji K3s, podniesiono Kubernetes o jedną gałąź minor i zaktualizowano Cilium
o jedną gałąź minor. Każdy większy etap miał osobny punkt kontrolny i test regresji.

## Najważniejsze wnioski

1. `Node Ready` nie zastępuje testu pełnej macierzy API server → kubelet.
2. Resync EndpointSlice jest skutecznym workaroundem, ale nie powinien automatycznie
   ukrywać błędu przy każdym starcie.
3. Upgrade K3s musi jawnie porównywać wersje.
4. Aktualizacja serwerów pojedynczo zachowała dostępność API i quorum etcd.
5. No-op jest ważnym testem playbooka utrzymaniowego: nie może tworzyć snapshotu ani
   restartować usług, ale powinien nadal wykonać walidację końcową.
6. Przed zmianą minor Cilium warto najpierw wejść na ostatni patch bieżącej gałęzi i
   uruchomić preflight z chartu docelowego.
7. `Ready` Poda nie dowodzi działania całego pipeline'u logów. Cutover Alloy został
   zatwierdzony dopiero po zapytaniu do Loki i porównaniu kompletnych strumieni.
8. Historyczne strumienie Promtaila pozostają widoczne do końca retencji mimo
   usunięcia samego kolektora.

## Następna sesja

1. Powtórzyć zimny start i sprawdzić macierz `3×3` bez automatycznego resyncu.
2. Zachować logi przed naprawą, jeżeli błąd remotedialera wróci.
3. Sprawdzić Hubble Relay, Hubble UI oraz napływ nowych flows po Cilium `1.20.2`.
4. Potwierdzić świeże logi `collector="alloy"` ze wszystkich trzech nodów.
5. Zaktualizować README repozytorium Flux i dokumentację Kubernetes do stanu
   docelowego: Alloy bez Promtaila, K3s `v1.35.8+k3s1`, Cilium `1.20.2`.
6. Po kilku kolejnych poprawnych startach zdecydować, czy usunąć tymczasową
   konfigurację debug remotedialera.
