# 18 - Cluster Baseline and Routing Incident

# K3s Homelab — Sesja 18 (Powrót do klastra i diagnostyka routingu)

**Data:** 2026-09-03–2026-09-04

**Środowisko:** 3x HP T630, k3s v1.34.4+k3s1, Flux v2.8.1, Cilium v1.19.1

---

### Cel sesji:

1. Odtworzenie modelu działania klastra po dłuższej przerwie.
2. Prześledzenie drogi `Service → EndpointSlice → Pod` na przykładzie CoreDNS.
3. Powtórzenie różnic między stanem Poda i gotowością kontenerów.
4. Diagnoza rzeczywistej awarii Loki → Garage S3.
5. Usunięcie konfliktu routingu powodowanego przez interfejs Wake-on-LAN.
6. Walidacja pełnego cyklu Power Off → Power On na fizycznie wyłączonym klastrze.

---

### 1. Stan początkowy klastra

Klaster składa się z trzech fizycznych nodów. Każdy z nich pełni role `control-plane` i `etcd`, dzięki czemu embedded etcd zachowuje trzy głosy i toleruje utratę jednego członka.

```bash
kubectl get nodes -o wide
```

Wszystkie nody były `Ready`, nie miały taintów i mogły przyjmować zwykłe workloady. Nazwy `master`, `worker1` i `worker2` są nazwami hostów, ale nie decydują samodzielnie o pracy schedulera.

Lokalny `kubectl` miał wersję o dwa wydania minor nowszą niż serwer. Przekracza to wspierany skew `±1`, dlatego aktualizacja klastra lub dopasowanie klienta trafiły do backlogu. Nie był to jednak powód omawianej awarii.

### 2. CoreDNS, Service i EndpointSlice

CoreDNS działa wewnątrz klastra jako Deployment. Stabilny adres DNS udostępnia Service `kube-dns`, a jego aktualne endpointy są przechowywane w EndpointSlice.

```text
Deployment/coredns
└── ReplicaSet/coredns-...
    └── Pod/coredns-...

Service/kube-dns
└── EndpointSlice
    └── gotowy adres Poda CoreDNS
```

Pod wysyłający zapytanie DNS nie zna aktualnego IP Poda CoreDNS. Korzysta ze stabilnego ClusterIP Service. EndpointSlice jest dynamicznym rejestrem endpointów, a nie dodatkowym serwerem DNS ani elementem, który sam przekazuje pakiety.

```bash
kubectl -n kube-system get service kube-dns -o wide

kubectl -n kube-system get pods \
  -l k8s-app=kube-dns \
  -o wide

kubectl -n kube-system get endpointslice \
  -l kubernetes.io/service-name=kube-dns \
  -o wide
```

Gdy Pod zostanie zastąpiony i otrzyma inne IP, kontroler aktualizuje EndpointSlice. Cilium obserwuje Service i EndpointSlice, a następnie programuje dataplane eBPF kierujący ruch do gotowych endpointów.

### 3. Running nie oznacza Ready

Pod Loki zawierał dwa kontenery:

| Kontener | Stan |
|:--|:--|
| `loki` | Running, ale `Ready=false`; wielokrotne restarty |
| `loki-sc-rules` | Running i `Ready=true` |

Dlatego Pod miał `STATUS=Running`, ale `READY=1/2`. Faza `Running` mówi o cyklu życia Poda, natomiast readiness odpowiada na pytanie, czy workload powinien otrzymywać ruch.

Probe wykonuje kubelet, nie Service:

```text
kubelet wykonuje readiness probe
→ aktualizuje warunek Ready Poda
→ kontroler aktualizuje EndpointSlice
→ dataplane pomija lub dodaje endpoint
```

- readiness decyduje o dopuszczeniu nowego ruchu i nie restartuje kontenera;
- liveness może spowodować restart kontenera;
- startup chroni wolno uruchamiającą się aplikację przed przedwczesną oceną przez pozostałe probes.

### 4. Objawy awarii Loki

Readiness probe Loki do `/ready` kończyła się timeoutem. Główny kontener okresowo kończył pracę kodem `1`, natomiast sidecar pozostawał zdrowy.

EndpointSlice headless Service `loki-memberlist` pokazywał endpoint Poda jako niegotowy:

```text
READY=false
```

Garage odpowiadał lokalnie oraz z komputera w podstawowej sieci LAN, ale połączenia inicjowane z nodów K3s kończyły się timeoutem. Oznaczało to, że należy sprawdzić ścieżkę sieciową, zanim zmieniona zostanie konfiguracja Loki lub poświadczenia S3.

### 5. Diagnoza warstwowa

Ten sam endpoint sprawdzono z kilku punktów sieci:

```bash
curl -sS -o /dev/null \
  --connect-timeout 3 \
  --max-time 5 \
  -w 'HTTP=%{http_code} CONNECT=%{time_connect}s TOTAL=%{time_total}s\n' \
  http://<GARAGE_ENDPOINT>/
```

Odpowiedź `HTTP=403` bez poświadczeń była oczekiwana. Potwierdzała routing, TCP i odpowiedź HTTP Garage. `HTTP=000` z timeoutem oznaczał, że kompletna odpowiedź nie wróciła do klienta.

Decyzję routingu kernela sprawdzono poleceniem:

```bash
ip route get <K3S_NODE_ADDRESS>
```

Następnie `tcpdump` na Logosie wykazał, że:

1. SYN przychodził przez podstawowy interfejs i router;
2. kontener Garage odpowiadał SYN-ACK;
3. odpowiedź opuszczała Logos przez interfejs VLAN przeznaczony do WOL;
4. klient nie otrzymywał poprawnej odpowiedzi i ponawiał SYN.

### 6. Root cause

Logos miał stale aktywny interfejs w VLAN-ie klastra, używany przez Semaphore do wysyłania Wake-on-LAN. Adres z prefiksem `/24` powodował utworzenie bezpośredniej trasy connected do całej podsieci K3s.

Ruch przychodzący przez router otrzymywał odpowiedź wysłaną bezpośrednio przez interfejs WOL. Powstał routing asymetryczny.

```yaml
dhcp4-overrides:
  use-routes: false
```

nie rozwiązywało problemu. Ustawienie odrzuca trasy przekazane przez DHCP, ale nie usuwa trasy connected wynikającej z adresu i jego prefiksu.

### 7. Naprawa i automatyzacja

Profil Netplanu otrzymał:

```yaml
activation-mode: manual
```

Po wygenerowaniu konfiguracji interfejs został przetestowany ręcznie:

```bash
sudo networkctl up <WOL_INTERFACE>
sudo networkctl down <WOL_INTERFACE>
```

Playbook Power On został następnie zmieniony zgodnie z workflow Git:

```text
branch → review → CI → merge → test na rzeczywistym środowisku
```

Jego ścieżka wykonania jest następująca:

```text
walidacja prywatnego inventory
→ SSH do gatewaya WOL
→ networkctl up
→ sprawdzenie globalnego IPv4
→ WOL do wszystkich nodów
→ networkctl down w always
→ oczekiwanie na SSH
→ K3s, API i etcd ready
→ dokładny zestaw Node Ready
```

Adresy, MAC, nazwa interfejsu i broadcast pozostały w prywatnym inventory Semaphore. Publiczny playbook opisuje mechanizm, ale nie ujawnia prywatnego planu adresowego.

Power Off nie aktywuje interfejsu WOL. Do wyłączenia działających nodów wystarcza zwykły routing przez router.

### 8. Pełny test zimnego startu

Test wykonano przy fizycznie wyłączonych wszystkich trzech nodach:

```text
Power Off
→ networkctl up na gatewayu
→ trzy wysyłki WOL
→ networkctl down
→ SSH dostępne na każdym nodzie
→ k3s active
→ lokalne API i etcd ready
→ wszystkie trzy obiekty Node Ready
```

Podczas startu zadanie `Wait for active K3s service` wykonało kilka retry. Było to oczekiwane odpytywanie usług w trakcie uruchamiania, nie błąd playbooka.

Końcowa walidacja na Logosie potwierdziła:

```text
State: off (configured)
Activation Policy: manual
```

oraz trasę do nodów przez podstawowy interfejs i router. `kubectl get nodes -o wide` pokazał trzy nody `Ready`.

### 9. Rezultat

- Loki odzyskał gotowość `2/2` i dostęp do Garage;
- EndpointSlice `loki-memberlist` zmienił `READY=false` na `READY=true`;
- interfejs WOL nie wpływa już stale na routing Logosa;
- pełny zimny start klastra został zweryfikowany;
- prywatne dane infrastruktury pozostały poza publicznym repozytorium;
- procedura Power On kończy się dopiero po weryfikacji SSH, K3s, API, etcd i Kubernetes Node Ready.

### 10. Najważniejsze wnioski

1. `Running` nie jest synonimem `Ready`.
2. EndpointSlice opisuje aktualne endpointy Service, ale nie przekazuje samodzielnie ruchu.
3. Kod HTTP błędu może potwierdzić sprawność niższych warstw połączenia.
4. `ip route get` pokazuje decyzję routingu dla konkretnego celu.
5. `tcpdump` pozwala potwierdzić rzeczywistą drogę pakietów i wykryć asymetrię.
6. Trasa connected istnieje niezależnie od tras przekazywanych przez DHCP.
7. Tymczasowy interfejs operacyjny powinien mieć jawny lifecycle i cleanup także po błędzie.
8. Automatyzacja jest ukończona dopiero po teście na rzeczywistym scenariuszu, a nie po samym przejściu CI.

### Następna sesja:

CI dla repozytorium GitOps: budowanie punktów wejścia Kustomize, walidacja YAML i CRD oraz test negatywny blokujący błędny pull request.
