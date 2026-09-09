# 19 - Cluster DNS, Cilium IPAM and Longhorn Recovery

# K3s Homelab — Sesja 19 (DNS klastra, Cilium IPAM i odzyskanie Longhorna)

**Data:** 2026-09-04

**Środowisko:** 3x HP T630, k3s v1.34.4+k3s1, Flux v2.8.1, Cilium v1.19.1, Longhorn v1.11.0

---

### Cel sesji:

1. Prześledzenie zapytania DNS od Poda do CoreDNS.
2. Rozdzielenie odpowiedzialności CoreDNS, Service, kube-proxy i Cilium.
3. Porównanie `dnsPolicy: ClusterFirst` i `dnsPolicy: Default`.
4. Sprawdzenie rzeczywistego dataplane Service w konfiguracji `kubeProxyReplacement=false`.
5. Usunięcie niezgodności między PodCIDR K3s i pulą adresową Cilium.
6. Bezpieczne odzyskanie wolumenów Longhorna po migracji adresacji.
7. Utrwalenie docelowej konfiguracji przez Flux GitOps.

---

### 1. Stabilny adres DNS klastra

Service `kube-dns` udostępnia stabilny ClusterIP, natomiast Pod CoreDNS ma adres efemeryczny. Pod aplikacji nie powinien znać bezpośredniego adresu CoreDNS — korzysta z adresu Service.

```text
Pod aplikacji
→ ClusterIP Service/kube-dns
→ reguły kube-proxy
→ endpoint wskazany w EndpointSlice
→ Pod CoreDNS
```

EndpointSlice przechowuje aktualny adres Poda CoreDNS oraz jego warunki:

```text
ready=true
serving=true
terminating=false
```

Po zastąpieniu Poda CoreDNS zmienia się endpoint, ale ClusterIP Service pozostaje taki sam.

### 2. `/etc/resolv.conf` i polityki DNS

Zwykły Pod korzystał z domyślnej polityki `ClusterFirst`. Jego `resolv.conf` zawierał:

- ClusterIP `kube-dns` jako `nameserver`;
- domeny wyszukiwania właściwe dla namespace i klastra;
- `options ndots:5`.

Zapytania o `kubernetes.default`, pełną nazwę Service oraz domenę zewnętrzną były wysyłane do CoreDNS.

Drugi Pod został uruchomiony z:

```yaml
dnsPolicy: Default
```

Odziedziczył konfigurację resolvera noda. Rozwiązywał domeny publiczne, ale zwracał `NXDOMAIN` dla `*.svc.cluster.local`, ponieważ zewnętrzne resolvery nie posiadają strefy Kubernetes.

CoreDNS sam używa `dnsPolicy: Default`, aby jego `forward . /etc/resolv.conf` prowadził do resolverów noda, a nie z powrotem do Service `kube-dns`. Zapobiega to pętli przekazywania zapytań zewnętrznych.

### 3. Corefile CoreDNS

Najważniejsze pluginy:

- `kubernetes cluster.local` — odpowiedzi autorytatywne dla zasobów klastra;
- `hosts` — dodatkowe wpisy hostów zarządzane przez K3s;
- `forward . /etc/resolv.conf` — przekazanie pozostałych zapytań do resolverów noda;
- `cache 30` — krótkotrwałe buforowanie odpowiedzi;
- `ready` i `health` — endpointy stanu procesu;
- `prometheus :9153` — metryki CoreDNS;
- `loadbalance` — rotacja kolejności odpowiedzi.

Ostrzeżenia o braku plików pasujących do opcjonalnych wzorców `custom/*.override` i `custom/*.server` nie oznaczały awarii.

### 4. Podział odpowiedzialności sieciowej

W aktualnej konfiguracji komponenty uzupełniają się, ale nie wykonują tego samego zadania:

| Komponent | Odpowiedzialność |
|:--|:--|
| CoreDNS | rozwiązywanie nazw wewnętrznych i przekazywanie zapytań zewnętrznych |
| kube-proxy | semantyka Service i DNAT z ClusterIP do endpointu przy użyciu iptables |
| Cilium | sieć Podów, IPAM, routing i transport między nodami przez VXLAN |
| EndpointSlice | deklaratywny rejestr gotowych backendów Service |

Cilium działał z:

```text
kubeProxyReplacement=false
routing-mode=tunnel
tunnel-protocol=vxlan
```

Dlatego wpisy widoczne w `cilium-dbg service list` nie oznaczały, że Cilium zastępuje kube-proxy. Rzeczywistą translację ClusterIP wykonywały łańcuchy `KUBE-SERVICES`, `KUBE-SVC-*` i `KUBE-SEP-*` w tabeli NAT iptables.

### 5. Wykryta niezgodność IPAM

K3s przydzielił każdemu nodowi PodCIDR ze swojej puli, natomiast Cilium działał w domyślnym trybie `cluster-pool` z niezależnym zakresem. Powstały dwa konkurencyjne modele adresacji:

```text
Node.spec.podCIDR       → pula zarządzana przez K3s
Cilium cluster-pool     → osobna pula zarządzana przez Cilium
```

Szeroka pula Cilium obejmowała również inne prywatne zakresy używane w homelabie. Nie powodowało to natychmiastowej awarii DNS, ale było realnym błędem architektury i ryzykiem kolizji routingu.

Docelowa konfiguracja HelmRelease:

```yaml
ipam:
  mode: kubernetes
k8s:
  requireIPv4PodCIDR: true
```

Od tej chwili Cilium pobiera PodCIDR z obiektu Node i nie tworzy niezależnej puli.

### 6. Bezpieczne wdrożenie przez właściciela zasobu

Flux zarządza HelmRelease Cilium. Przed migracją wykonano:

- eksport manifestów i wartości Helm;
- zapis obiektów Node i CiliumNode;
- zapis listy Podów;
- snapshot embedded etcd;
- zawieszenie nadrzędnych Kustomization i HelmRelease.

Bezpośrednia próba `helm upgrade` zakończyła się konfliktami Server-Side Apply z polami należącymi do `helm-controller`. Próba rollbacku również nie mogła przejąć tych pól. Klaster pozostał zdrowy, a `helm-controller` przywrócił release.

Właściwa ścieżka polegała na zmianie specyfikacji HelmRelease i wznowieniu jego kontrolera. Po udanym reconcile ConfigMap Cilium zawierał nowy tryb IPAM. DaemonSet Cilium wymagał osobnego restartu, ponieważ zmiana danych ConfigMap nie zmieniła szablonu Poda.

### 7. Migracja istniejących Podów

Zmiana IPAM dotyczy tylko nowych sandboxów sieciowych. Już działające Pody zachowały stare adresy aż do odtworzenia.

Po restarcie agentów Cilium nowe Pody na wszystkich trzech nodach otrzymały adresy ze zgodnych PodCIDR. Testowe Pody potwierdziły:

- prawidłowy przydział adresu na każdym nodzie;
- rozwiązywanie `kubernetes.default.svc.cluster.local`;
- działanie ClusterIP `kube-dns` przez kube-proxy;
- transport między nodami przez Cilium VXLAN.

Stare sandboxy usunięto przez kontrolowane, sekwencyjne restarty nodów.

### 8. Problem Longhorna podczas restartów

Po restarcie worker1 trzy wolumeny pozostały w stanie:

```text
state=detaching
robustness=faulted
```

Kubernetes nadal posiadał bilety attachment do worker1. Jednocześnie jedyne repliki bez `failedAt` były raportowane jako `running` przez Instance Manager na jeszcze niezrestartowanym masterze. Proces ten miał stary adres z poprzedniej puli Cilium i był nieosiągalny z nowej sieci.

Kontroler Longhorna widział więc niespójność:

```text
desired replica state: stopped
reported current state: running
instance manager: old, unreachable Pod IP
engine destination: empty IP and port
```

Nie usunięto `VolumeAttachment`, nie kasowano replik i nie wymuszano salvage bez sprawdzenia danych. Najpierw potwierdzono katalogi replik na dysku mastera oraz ich rozmiary.

### 9. Odzyskanie storage

Usunięto wyłącznie osierocony Pod Instance Managera. Ponieważ lokalny `longhorn-manager` mastera również działał pod starym adresem i nie przechodził readiness, odtworzono także ten Pod.

Nowy manager i Instance Manager otrzymały adresy z właściwego PodCIDR. Longhorn mógł wtedy:

1. rozliczyć stare procesy replik;
2. zakończyć detach;
3. wykonać automatyczny salvage;
4. ponownie podłączyć wolumeny;
5. odbudować brakujące repliki.

Po restarcie mastera wolumeny tymczasowo przeszły do `degraded`. Longhorn odczekał skonfigurowane 600 sekund `replica-replenishment-wait-interval`, po czym utworzył zastępcze repliki. Wszystkie wolumeny wróciły do `attached/healthy`.

### 10. Utrwalenie przez GitOps

Zmiana została scalona do `main` przed wznowieniem nadrzędnych Kustomization. Było to konieczne, ponieważ Flux traktuje repozytorium jako źródło prawdy i przywróciłby poprzednią konfigurację `cluster-pool`, gdyby aktywowano go przed mergem.

Końcowy stan:

- wszystkie Kustomization są `Ready=True` i korzystają z aktualnej rewizji;
- HelmRelease Cilium jest `Ready=True`;
- aktywny ConfigMap ma `ipam=kubernetes`;
- wszystkie nody i CiliumNode używają zgodnych PodCIDR;
- brak aktywnych Podów ze starej puli;
- wszystkie wolumeny Longhorn są `attached/healthy`.

### 11. Najważniejsze wnioski

1. CoreDNS rozwiązuje nazwy, ale nie realizuje routingu do swojego Service.
2. EndpointSlice opisuje backendy; nie wybiera samodzielnie trasy pakietu.
3. Przy `kubeProxyReplacement=false` Service jest realizowany przez kube-proxy i iptables.
4. Cilium odpowiada za sieć Podów i transport VXLAN między nodami.
5. Zmiana IPAM nie przenumerowuje istniejących sandboxów sieciowych.
6. Przy migracji CNI trzeba uwzględnić procesy storage używające Pod IP.
7. `attached/degraded` oznacza dostępny wolumen bez pełnej redundancji; przed kolejnym restartem należy poczekać na `healthy`.
8. Zasób zarządzany przez Flux należy zmieniać przez jego deklaratywne źródło i właściwy kontroler.
9. Nadrzędnego GitOps nie wolno wznowić, dopóki docelowa konfiguracja nie znajduje się w obserwowanej gałęzi.

### Następna sesja:

Kontrolowana awaria CoreDNS: obserwacja readiness, EndpointSlice, kube-proxy i zachowania zapytań DNS podczas zastępowania Poda.
