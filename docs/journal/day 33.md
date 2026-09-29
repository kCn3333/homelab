# 33 - aktualizacja kube-prometheus-stack i stabilizacja Grafany

**Data:** 2026-09-29\
**Środowisko końcowe:** 3× HP T630, Ubuntu 24.04.5 LTS, K3s `v1.36.4+k3s1`, Cilium `1.20.2`, Longhorn `1.12.1`, Flux `v2.9.5`, kube-prometheus-stack chart `91.8.1`, Prometheus Operator `v0.94.1`, Prometheus `v3.15.0`, Alertmanager `v0.34.1`, Grafana `13.2.2`

## Cel sesji

1. Potwierdzić kolejny poprawny zimny start klastra po aktualizacji K3s.
2. Zamknąć problem niepełnej macierzy połączeń API server → kubelet.
3. Zinwentaryzować instalację kube-prometheus-stack oraz sposób aktualizacji CRD.
4. Zaktualizować chart etapami z `82.10.1` do `91.8.1`.
5. Walidować po każdej wersji Prometheusa, Alertmanagera, Grafanę, kube-state-metrics, node-exporter i operator.
6. Usunąć przyczyny przejściowej niedostępności Grafany i alertów `CPUThrottlingHigh`.
7. Przeprowadzić migrację uwierzytelniania ServiceMonitor wymaganą przez chart `90.x`.
8. Potwierdzić działanie zaostrzonego RBAC Prometheus Operatora w chartcie `91.x`.

---

## 1. Zimny start klastra

Playbook potwierdził:

- prawidłową walidację pełnego inventory;
- wysłanie WoL do wszystkich trzech hostów;
- poprawny cykl aktywacji i dezaktywacji interfejsu WoL na `logos`;
- dostępność SSH na `master`, `worker1` i `worker2`;
- łączność Ansible i działające nieinteraktywne `sudo`;
- aktywną usługę K3s na wszystkich nodach;
- lokalne API i embedded etcd `3/3`;
- dokładny skład klastra;
- wszystkie trzy nody `Ready`;
- macierz API server → kubelet `9/9`;
- brak użycia resyncu remotedialera.

K3s potrzebował kilku ponowień podczas oczekiwania na stan `active`. Wszystkie trzy usługi uruchomiły się w dopuszczalnym czasie, a końcowy wynik playbooka nie zawierał błędów.

Był to kolejny pełny zimny start z macierzą `9/9`. Problem niepełnych tuneli remotedialera można uznać za rozwiązany przez aktualizację K3s do `v1.36.4+k3s1`. Skrypt resync pozostaje narzędziem diagnostycznym i nie musiał ingerować w start klastra.

---

## 2. Stan początkowy kube-prometheus-stack

Przed aktualizacją działający release miał stan:

```text
Helm release: kube-prometheus-stack
namespace:    monitoring
revision:     4
chart:        82.10.1
app version:  v0.89.0
status:       deployed
```

Instalacja była zarządzana przez Flux za pomocą:

```text
infrastructure/operators/monitoring/helmrelease.yaml
```

Wartości obejmowały:

- Prometheus z retencją `7d`;
- PVC Prometheusa `10Gi` w StorageClass `longhorn`;
- jedną replikę Prometheusa i Alertmanagera;
- Grafanę z dashboardami dostarczanymi przez sidecar;
- kube-state-metrics;
- node-exporter jako DaemonSet na trzech nodach;
- monitoring kubeleta przez HTTPS;
- wyłączony kube-proxy, ponieważ jego funkcję realizuje Cilium;
- wyłączony monitoring kube-controller-manager, kube-scheduler i etcd;
- automatyczny hook aktualizujący CRD:

```yaml
crds:
  upgradeJob:
    enabled: true
```

CRD nie były aktualizowane ręcznie. Helm uruchamiał Job `kube-prometheus-stack-crds-upgrade` przed każdą aktualizacją.

---

## 3. Strategia aktualizacji

Chart został zaktualizowany kolejno przez wszystkie główne wersje:

| Etap | Chart | Prometheus Operator | Prometheus | Alertmanager | Grafana |
|---:|---:|---:|---:|---:|---:|
| 0 | `82.10.1` | `v0.89.0` | stan początkowy | stan początkowy | stan początkowy |
| 1 | `83.7.0` | `v0.90.1` | zgodny z chartem | zgodny z chartem | zgodna z chartem |
| 2 | `84.5.0` | `v0.90.1` | zgodny z chartem | zgodny z chartem | `13.0.1` |
| 3 | `85.4.0` | `v0.90.1` | `v3.11.3-distroless` | `v0.32.1` | `13.0.1-security-01` |
| 4 | `86.3.2` | `v0.91.0` | `v3.12.0-distroless` | `v0.33.0` | `13.0.2` |
| 5 | `87.21.0` | `v0.92.1` | `v3.13.1-distroless` | `v0.33.1` | `13.1.1` |
| 6 | `88.6.5` | `v0.93.1` | `v3.14.0-distroless` | `v0.34.0` | `13.2.0` |
| 7 | `89.2.4` | `v0.93.1` | `v3.14.0-distroless` | `v0.34.0` | `13.2.1-distroless` |
| 8 | `90.2.0` | `v0.93.1` | `v3.14.0-distroless` | `v0.34.0` | `13.2.1-distroless` |
| 9 | `91.8.1` | `v0.94.1` | `v3.15.0-distroless` | `v0.34.1` | `13.2.2-distroless` |

Każdy etap został:

1. sprawdzony w oficjalnym `UPGRADE.md`;
2. wyrenderowany lokalnie z wartościami z HelmRelease;
3. skontrolowany pod kątem obrazów, hooków i zmian zasobów;
4. wdrożony przez commit i Flux;
5. zakończony sprawdzeniem rolloutów, Podów, logów, targetów i reguł.

Nie wykonywano bezpośredniego `helm upgrade` ani ręcznego `kubectl apply` na zasobach zarządzanych przez Flux.

---

## 4. Aktualizacje `83.x–86.x`

Aktualizacje do `83.7.0`, `84.5.0`, `85.4.0` i `86.3.2` zakończyły się poprawnie.

Po każdym etapie potwierdzano rollout:

```text
deployment/kube-prometheus-stack-operator
deployment/kube-prometheus-stack-grafana
deployment/kube-prometheus-stack-kube-state-metrics
daemonset/kube-prometheus-stack-prometheus-node-exporter
statefulset/prometheus-kube-prometheus-stack-prometheus
statefulset/alertmanager-kube-prometheus-stack-alertmanager
```

Sprawdzano także:

- stan Prometheus i Alertmanager CR;
- endpoint kube-state-metrics;
- metrykę `up{job="kube-state-metrics"}`;
- obecność metryki `kube_resourcequota`;
- stan reguł przez `/api/v1/rules`;
- logi Prometheusa pod kątem `many-to-many` i błędów ewaluacji;
- zdrowie API Grafany;
- stan wolumenu Prometheusa w Longhornie.

Wolumen Prometheusa zachował tożsamość:

```text
PVC: prometheus-kube-prometheus-stack-prometheus-db-prometheus-kube-prometheus-stack-prometheus-0
PV:  pvc-e3b84907-a0e1-4843-b522-02da79e01a75
```

Longhorn raportował wolumen jako `attached` i `healthy`.

---

## 5. Przejściowe podwójne targety po rolloutach

Podczas kolejnych rolloutów Prometheus chwilowo widział stare i nowe Pody kube-state-metrics oraz node-exportera.

Przykładowo zapytania zwróciły:

```text
kube-state-metrics: 2 zdrowe targety
node-exporter:       6 zdrowych targetów
```

Nie oznaczało to utworzenia dodatkowych stałych replik. W czasie rolling update stare Pody nadal istniały w TSDB i przez krótki czas pozostawały aktywnymi targetami. Po zakończeniu rolloutów EndpointSlice zawierał wyłącznie nowy gotowy endpoint, a liczba targetów wróciła do oczekiwanej wartości.

---

## 6. Niedostępność Grafany po aktualizacji `87.21.0`

Po wdrożeniu chartu `87.21.0` Grafana okresowo zwracała przez Traefik:

```text
no available server
```

Wszystkie dashboardy traciły jednocześnie dostęp, a po odświeżeniu GUI chwilowo wracały. EndpointSlice Grafany przechodził między stanem gotowym i niegotowym, mimo braku restartu kontenera.

Początkowe zasoby Grafany wynosiły:

```yaml
requests:
  cpu: 50m
  memory: 256Mi
limits:
  cpu: 200m
  memory: 512Mi
```

Pomiary historyczne wykazały:

```text
maksymalne CPU:                    200m
maksymalne użycie pamięci:         510.14Mi
maksymalne CPU throttling:         100%
```

Grafana jednocześnie osiągała limit CPU i prawie cały limit pamięci. Readiness probe `/api/health` nie odpowiadał w wymaganym czasie, dlatego Kubernetes usuwał Pod z EndpointSlice. Traefik nie miał wtedy gotowego backendu i zwracał `no available server`.

Logi zawierały między innymi:

```text
database is locked (SQLITE_BUSY)
context canceled
failed to fetch dashboards
status=500 /api/annotations
```

Nie była to awaria Prometheusa ani pojedynczego dashboardu. Problem dotyczył procesu Grafany i jego zasobów.

---

## 7. Zmiana zasobów Grafany

Zasoby zwiększono najpierw do:

```yaml
requests:
  cpu: 100m
  memory: 384Mi
limits:
  cpu: 500m
  memory: 768Mi
```

CPU throttling Grafany spadł do około `3.2%`, a dashboardy zaczęły działać stabilnie. Podczas dalszych aktualizacji Grafana `13.2.0` osiągała jednak ponad `1Gi` pamięci:

```text
1021Mi
1019Mi
1049Mi
```

Ostateczna konfiguracja otrzymała:

```yaml
grafana:
  resources:
    requests:
      cpu: 100m
      memory: 512Mi
    limits:
      cpu: 500m
      memory: 1280Mi
  env:
    GOMEMLIMIT: 900MiB
```

`GOMEMLIMIT=900MiB` wymusza wcześniejszą pracę garbage collectora Go, pozostawiając zapas między celem sterty a limitem cgroup `1280Mi`.

Po zmianie:

- Grafana pozostawała `Ready`;
- liczba restartów wynosiła `0`;
- EndpointSlice pozostawał gotowy;
- dashboardy działały;
- nie pojawiało się `no available server`;
- nie występowały OOMKill ani trwałe timeouty.

W końcowym stanie Grafana używała około `735Mi` pamięci przy limicie `1280Mi`.

---

## 8. CPU throttling node-exportera

Po aktualizacji chartu alert `CPUThrottlingHigh` dotyczył wszystkich trzech Podów node-exportera.

Początkowa konfiguracja:

```yaml
prometheus-node-exporter:
  resources:
    requests:
      cpu: 10m
      memory: 32Mi
    limits:
      cpu: 100m
      memory: 64Mi
```

Prometheus raportował throttling około:

```text
worker1: 57–62%
worker2: 57–62%
master:  57–62%
```

Zwiększenie limitu CPU do `250m` nie usunęło alertu. Node-exporter wykonuje krótkie, gwałtowne serie pracy podczas scrape, dlatego liczba okresów ograniczonych przez CFS nadal była wysoka mimo małego średniego użycia CPU.

Limit CPU został usunięty, pozostawiając request i limit pamięci:

```yaml
prometheus-node-exporter:
  resources:
    requests:
      cpu: 10m
      memory: 32Mi
    limits:
      memory: 64Mi
```

Po rolloutcie nowych Podów zapytanie:

```promql
ALERTS{alertname="CPUThrottlingHigh",alertstate=~"pending|firing"}
```

zwróciło pusty wynik.

Usunięcie limitu CPU nie zmienia rezerwacji schedulera. Node-exporter nadal rezerwuje `10m`, ale nie podlega sztucznemu ograniczeniu CFS podczas krótkich skoków pracy.

---

## 9. Grafana `13.2.1-distroless` i read-only root filesystem

Chart `89.2.4` wprowadził:

```text
docker.io/grafana/grafana:13.2.1-distroless
readOnlyRootFilesystem: true
```

Render potwierdził dodatkowy zapisywalny wolumen `emptyDir` zamontowany pod `/tmp`. Pod uruchomił się poprawnie, ale logi zawierały błędy:

```text
plugin.backgroundinstaller
Failed to install plugin
read-only file system
```

Background Plugin Installer próbował aktualizować wbudowane pluginy w:

```text
/usr/share/grafana/data/plugins-bundled
```

Ścieżka znajduje się w read-only root filesystem obrazu distroless. Ponieważ nie instalujemy dodatkowych pluginów w czasie startu, automatyczny instalator został wyłączony:

```yaml
grafana:
  grafana.ini:
    plugins:
      preinstall_disabled: true
```

W końcowym renderze Grafany znajdowało się:

```ini
[plugins]
preinstall_auto_update = false
preinstall_disabled = true
```

Po rolloutcie logi nie zawierały już błędów instalatora pluginów ani filesystemu. Grafana zachowała read-only root filesystem.

---

## 10. Migracja ServiceMonitor w chartcie `90.2.0`

Chart `90.x` usunął pola odwołujące się do plików z tokenem i CA znajdujących się w filesystemie Prometheusa. Dotychczasowa wartość:

```yaml
kubelet:
  serviceMonitor:
    insecureSkipVerify: true
```

została zastąpiona przez:

```yaml
kubelet:
  serviceMonitor:
    tlsConfig:
      insecureSkipVerify: true
```

Jawnie włączono utworzenie tokenu ServiceAccount:

```yaml
prometheus:
  serviceAccount:
    create: true
    createTokenSecret: true
```

Chart utworzył:

```text
Secret:         kube-prometheus-stack-prometheus-token
type:           kubernetes.io/service-account-token
serviceAccount: kube-prometheus-stack-prometheus
```

Secret zawierał token, CA oraz namespace. Wartość tokenu nie została wyświetlona ani zapisana w repozytorium. Repo zawiera wyłącznie deklarację utworzenia Secretu. Sam token został wygenerowany przez Kubernetes i jest przechowywany w Secret oraz etcd.

Wyrenderowany i żywy ServiceMonitor kubeleta używał:

```yaml
authorization:
  type: Bearer
  credentials:
    name: kube-prometheus-stack-prometheus-token
    key: token
tlsConfig:
  ca:
    configMap:
      name: kube-root-ca.crt
      key: ca.crt
  insecureSkipVerify: true
```

Po aktualizacji aktywne targety obejmowały:

```text
API server: 3/3 up
kubelet:    9/9 up
CoreDNS:    1/1 up
```

Dla każdego noda kubelet udostępniał trzy pule scrape:

```text
/metrics
/metrics/cadvisor
/metrics/probes
```

Wszystkie targety miały pusty `lastError`. Nie wystąpiły odpowiedzi `401` ani `403`.

---

## 11. Aktualizacja do `91.8.1` i zaostrzony RBAC

Chart `91.x` zaktualizował Prometheus Operator do `v0.94.1`. Nowy ClusterRole nie używa wildcardu `"*"` w `verbs`, lecz jawnie wymienia potrzebne operacje.

Przed wdrożeniem sprawdzono render RBAC. Operator zachował dostęp do wymaganych zasobów:

- obiektów API `monitoring.coreos.com`;
- ich subresource `status` i `finalizers`;
- StatefulSetów;
- ConfigMap i Secretów;
- Podów, Service, Endpoint i EndpointSlice;
- Node, Namespace i Event;
- Ingress i StorageClass.

Hook CRD miał konfigurację:

```text
name:          kube-prometheus-stack-crds-upgrade
hook:          pre-install,pre-upgrade,pre-rollback
hook-weight:   5
delete-policy: before-hook-creation,hook-succeeded
image:         registry.k8s.io/kubectl:v1.36.4
```

Job zakończył się stanem `Completed`, a Flux zgłosił `UpgradeSucceeded` dla rewizji Helm `19`.

Po rolloutcie logi operatora nie zawierały:

```text
Forbidden
permission denied
unauthorized
error
failed
panic
fatal
```

Zaostrzenie RBAC nie spowodowało regresji w tym klastrze.

---

## 12. Stan CRD

Wszystkie CRD z grupy `monitoring.coreos.com` miały:

```text
Established=True
```

Wersje przechowywane w etcd:

| CRD | storedVersions |
|---|---|
| `alertmanagerconfigs.monitoring.coreos.com` | `v1alpha1` |
| `alertmanagers.monitoring.coreos.com` | `v1` |
| `podmonitors.monitoring.coreos.com` | `v1` |
| `probes.monitoring.coreos.com` | `v1` |
| `prometheusagents.monitoring.coreos.com` | `v1alpha1` |
| `prometheuses.monitoring.coreos.com` | `v1` |
| `prometheusrules.monitoring.coreos.com` | `v1` |
| `scrapeconfigs.monitoring.coreos.com` | `v1alpha1` |
| `servicemonitors.monitoring.coreos.com` | `v1` |
| `thanosrulers.monitoring.coreos.com` | `v1` |

`v1alpha1` dla AlertmanagerConfig, PrometheusAgent i ScrapeConfig jest prawidłowym stanem tych API. Nie oznacza niedokończonej migracji i nie wymaga ręcznej modyfikacji `status.storedVersions`.

---

## 13. Końcowa walidacja Prometheusa i Grafany

Końcowy release:

```text
Helm revision: 19
chart:         kube-prometheus-stack-91.8.1
app version:   v0.94.1
status:        deployed
Flux:          Ready=True
```

Prometheus:

```text
version:     v3.15.0-distroless
desired:     1
ready:       1
reconciled:  True
available:   True
```

Alertmanager:

```text
version:     v0.34.1
replicas:    1
ready:       1
reconciled:  True
available:   True
```

Pozostałe obrazy:

```text
Prometheus Operator: v0.94.1
Grafana:             13.2.2-distroless
Grafana sidecar:     2.11.2
kube-state-metrics:  v2.20.0
node-exporter:       v1.12.1-distroless
```

Grafana:

```text
Pod:       3/3 Ready
Restarts:  0,0,0
database:  ok
memory:    około 735Mi
```

Bezpośrednio po starcie pojawiło się kilka krótkich retry SQLite:

```text
database is locked (SQLITE_BUSY)
```

Nie towarzyszyły im błędy HTTP `500`, utrata gotowości ani restarty. Kolejna kontrola logów z ostatnich dwóch minut zwróciła:

```text
Brak nowych błędów Grafany
```

Globalne kontrole Prometheusa zwróciły:

```text
targety health != up:       []
reguły health != ok:        []
reguły z niepustym błędem:  []
```

---

## 14. Stan końcowy

### K3s

- trzy nody `Ready`;
- K3s `v1.36.4+k3s1`;
- lokalne API i embedded etcd `3/3`;
- macierz API server → kubelet `9/9`;
- zimny start bez użycia remotedialer resync;
- problem niepełnej macierzy po zimnym starcie uznany za rozwiązany.

### kube-prometheus-stack

- chart `91.8.1`;
- Helm revision `19`;
- Flux `Ready=True`;
- wszystkie workloady zakończyły rollout;
- Prometheus `v3.15.0-distroless`;
- Alertmanager `v0.34.1`;
- Prometheus Operator `v0.94.1`;
- Grafana `13.2.2-distroless`;
- kube-state-metrics `v2.20.0`;
- node-exporter `v1.12.1-distroless`;
- wszystkie targety `up`;
- wszystkie reguły zdrowe;
- brak błędów RBAC operatora.

### Grafana

- stabilny EndpointSlice;
- brak `no available server` po korekcie zasobów;
- brak restartów i OOMKill;
- read-only root filesystem zachowany;
- automatyczny instalator pluginów wyłączony;
- `GOMEMLIMIT=900MiB`;
- limit pamięci `1280Mi`;
- przejściowe blokady SQLite ograniczone do krótkich retry podczas startu.

### Storage i sekrety

- PVC Prometheusa pozostał na Longhornie;
- wolumen był `attached` i `healthy` podczas aktualizacji;
- token ServiceAccount Prometheusa istnieje wyłącznie jako Kubernetes Secret;
- repozytorium zawiera tylko deklarację `createTokenSecret: true`;
- wartość tokenu nie trafiła do Git.

---

## 15. Wnioski

1. Duży skok chartu należy dzielić na kolejne wersje główne, nawet gdy wersja aplikacji przez kilka etapów się nie zmienia.
2. `HelmRelease Ready=True` nie wystarcza do zaliczenia aktualizacji systemu monitoringu. Trzeba sprawdzić targety, reguły, logi, API Grafany i storage.
3. Render manifestów przed wdrożeniem wykrywa zmiany obrazów, RBAC, hooków, securityContext i usuniętych wartości.
4. Hook aktualizacji CRD jest konieczny, ponieważ standardowy upgrade Helm nie aktualizuje automatycznie zawartości katalogu `crds/`.
5. `no available server` w Traefiku może oznaczać utratę gotowości jedynego backendu, a nie awarię samego reverse proxy.
6. Limit CPU `200m` i pamięci `512Mi` był zbyt niski dla Grafany 13 w tym środowisku.
7. `GOMEMLIMIT` powinien pozostawiać zapas względem limitu pamięci cgroup.
8. CPU limit node-exportera powodował wysoki CFS throttling mimo małego średniego użycia CPU. Usunięcie limitu było lepsze niż dalsze zwiększanie go.
9. Obrazy distroless i read-only root filesystem wymagają sprawdzenia pluginów, initContainerów, poleceń shellowych i zapisywalnych mountów.
10. Background Plugin Installer nie powinien modyfikować wbudowanych pluginów na read-only filesystem. Wyłączenie go usunęło trwałe błędy bez osłabiania securityContext.
11. Migracja chartu `90.x` zmieniła sposób uwierzytelniania ServiceMonitor. Po zmianie trzeba sprawdzić wszystkie targety pod kątem `401`, `403` i brakującego Secretu.
12. Długowieczny token ServiceAccount jest przechowywany w Kubernetes Secret i etcd. Do Git trafia jedynie deklaracja jego utworzenia.
13. `storedVersions: v1alpha1` nie zawsze oznacza dług techniczny. Dla części CRD Prometheus Operatora pozostaje to prawidłowa wersja storage.
14. Zaostrzenie RBAC należy weryfikować przez logi operatora i stan zarządzanych CR, a nie tylko przez obecność nowego ClusterRole.
15. Przejściowe `SQLITE_BUSY` podczas startu nie oznacza awarii, jeśli retry kończy się powodzeniem, `/api/health` zwraca `database=ok`, a kolejne logi są czyste.

---

## 16. Następna sesja

1. Po zimnym starcie potwierdzić:

   ```text
   3/3 Node Ready
   lokalne API i etcd 3/3
   API server → kubelet 9/9
   brak użycia remotedialer resync
   Prometheus PVC attached/healthy
   Prometheus i Alertmanager reconciled/available
   wszystkie targety Prometheusa up
   wszystkie reguły health=ok
   Grafana bez no available server
   Grafana bez trwałych SQLITE_BUSY i timeoutów
   Prometheus Operator bez błędów RBAC
   ```

2. Jeżeli test przejdzie, zamknąć aktualizację kube-prometheus-stack `82.10.1 → 91.8.1`.

3. Następny komponent wybrać dopiero po zamknięciu testu regresji całego monitoringu.
