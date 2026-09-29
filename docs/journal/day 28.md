# 28 - zakończenie aktualizacji K3s i CloudNativePG

**Data:** 2026-09-17

**Środowisko końcowe:** 3× HP T630, K3s `v1.36.4+k3s1`, Cilium `1.20.2`, Flux `v2.8.1`, CloudNativePG `1.30.0`, PostgreSQL `17.4`, Longhorn `1.11.0`

## Cel sesji

1. Potwierdzić poprawny zimny start po wcześniejszych aktualizacjach.
2. Dokończyć kontrolowane podnoszenie K3s.
3. Zweryfikować sieć, DNS, ingress, GitOps i podstawowe usługi po zmianie K3s.
4. Podnieść operator CloudNativePG z `1.25.1` do `1.30.0` małymi krokami.
5. Zachować logiczne kopie obu baz przed zmianą operatora.
6. Sprawdzić zachowanie jednoinstancyjnych klastrów PostgreSQL i eksportera metryk.

## Stan po uruchomieniu klastra

Klaster wystartował bez błędu remotedialera. Wszystkie trzy nody osiągnęły `Ready`,
a podstawowe kontrole klastra nie wykazały błędów.

## Dokończenie aktualizacji K3s

Kontrolowany playbook Ansible podniósł wszystkie trzy serwery do:

```text
K3s:       v1.36.4+k3s1
containerd: 2.3.4-k3s1.36
```

Stan końcowy nodów:

| Node | Role | Wersja | Runtime |
|---|---|---|---|
| `master` | `control-plane,etcd` | `v1.36.4+k3s1` | `containerd 2.3.4-k3s1.36` |
| `worker1` | `control-plane,etcd` | `v1.36.4+k3s1` | `containerd 2.3.4-k3s1.36` |
| `worker2` | `control-plane,etcd` | `v1.36.4+k3s1` | `containerd 2.3.4-k3s1.36` |

Przed wymianą binarek playbook utworzył snapshot embedded etcd:

```text
pre-k3s-upgrade-v1.36.4_k3s1-master-1789627910
size:    50 434 080 B
created: 2026-09-17T06:51:50Z
```

Aktualizacja została wykonana pojedynczo na serwerach. Po zmianie wykonano zimny
start całego klastra. Klaster ponownie uruchomił się bez błędów.

## Weryfikacja po aktualizacji K3s

Nie było Podów w fazie innej niż `Running` lub `Succeeded`.

Wszystkie `Kustomization` Flux miały `Ready=True`:

```text
apps
apps-dev
apps-staging
flux-system
infrastructure-config
infrastructure-operators
```

Wszystkie `HelmRelease` miały `Ready=True`.

Cilium i Hubble:

```text
Cilium: 1.20.2
DaemonSet/cilium: rollout zakończony
Deployment/cilium-operator: rollout zakończony
Deployment/hubble-relay: rollout zakończony
cilium-dbg status --brief: OK na 3/3 nodach
Hubble UI: HTTP 200
```

Test DNS z tymczasowego Poda zwrócił:

```text
kubernetes.default.svc.cluster.local → 10.43.0.1
```

Pozostałe kontrole:

```text
Grafana: HTTP 302 — przekierowanie do logowania
Sealed Secrets: pobranie certyfikatu zakończone poprawnie
Traefik: 1/1 Ready
```

## Traefik i Cilium

Traefik pozostaje komponentem pakowanym i zarządzanym przez K3s:

```text
HelmChart/traefik
HelmChart/traefik-crd
Deployment/traefik: 1/1 Ready
image: rancher/mirrored-library-traefik:3.7.8
```

`HelmChartConfig/kube-system/traefik` jest zarządzany przez Flux i ustawia dashboard
oraz przekierowanie HTTP → HTTPS.

Traefik realizuje ingress, a Cilium realizuje sieć
Podów. Flannel jest wyłączony argumentem K3s `--flannel-backend=none`.

Plik `/etc/rancher/k3s/config.yaml` wyłącza tylko wbudowany `metrics-server`:

```yaml
disable:
  - metrics-server
```

Zewnętrzny `metrics-server` jest zarządzany przez Flux jako osobny `HelmRelease`.

## Stan CloudNativePG przed aktualizacją

```text
chart:    0.23.2
operator: 1.25.1
```

Operator zarządzał dwoma klastrami:

| Namespace | Cluster | Instancje | Primary | PostgreSQL |
|---|---|---:|---|---|
| `clients` | `clients-db` | 1 | `clients-db-1` | `17.4` |
| `clients-staging` | `clients-db-staging` | 1 | `clients-db-staging-1` | `17.4` |

Obie instancje działały na `worker1`. Każda baza korzystała z PVC Longhorn `1 GiB`.
Wolumeny były `attached` i `healthy`.

Nie było zasobów `ScheduledBackup` ani `Backup` CloudNativePG. Przed zmianą
operatora wykonano dlatego logiczne kopie obu klastrów.

## Kopie logiczne PostgreSQL

Kopie zapisano lokalnie w:

```text
/home/kcn/cnpg-backups/pre-1.26.1-20260917T073411Z/
```

Pliki miały prawa `600` i poprawną strukturę dumpa klastrowego.

## Aktualizacja CloudNativePG

Operator został podniesiony etapami, po jednej obsługiwanej wersji aplikacji:

| Krok | Chart | Operator |
|---:|---:|---:|
| stan początkowy | `0.23.2` | `1.25.1` |
| 1 | `0.25.0` | `1.26.1` |
| 2 | `0.26.1` | `1.27.1` |
| 3 | `0.27.1` | `1.28.1` |
| 4 | `0.28.3` | `1.29.1` |
| 5 | `0.29.0` | `1.30.0` |

Każdy krok był osobnym wdrożeniem Flux. Po każdym wdrożeniu sprawdzano:

- obraz operatora;
- warunek `Ready` obu zasobów `Cluster`;
- gotowość Podów PostgreSQL;
- liczbę restartów;
- logi operatora.

Logi operatora nie zawierały `error`, `failed`, `panic`, `fatal` ani błędów
rekonsyliacji.

## Dostępność baz podczas zmiany operatora

Oba klastry mają:

```text
instances: 1
primaryUpdateStrategy: unsupervised
primaryUpdateMethod: restart
```

Po zmianie operatora CloudNativePG odtwarzało Pod każdej bazy. Przy jednej instancji
nie istnieje replika, na którą można wykonać switchover. Każdy taki restart powoduje
krótką, nieuniknioną przerwę w dostępności danej bazy.

W czasie ostatniego kroku stan przejściowy był następujący:

```text
Primary instance is being restarted without a switchover
```

Pody miały wtedy `Ready=false`. Nie był to zakończony stan aktualizacji.

CloudNativePG `1.30.0` utworzył zasoby `Lease` dla primary. Pola `holderIdentity`,
`acquireTime` i `renewTime` były puste podczas restartu. Przy metodzie `restart` i
jednej instancji nie było kandydata do promocji, dlatego pusty Lease nie dowodził
awarii.

Stan końcowy:

| Namespace | Pod | Created | Ready | Restarts | Node |
|---|---|---|---|---:|---|
| `clients` | `clients-db-1` | `2026-09-17T09:00:13Z` | `true` | 0 | `worker1` |
| `clients-staging` | `clients-db-staging-1` | `2026-09-17T09:00:14Z` | `true` | 0 | `worker1` |

Oba Pody zostały odtworzone i oba klastry ponownie osiągnęły `Ready`.

## Zmiana eksportera metryk w CloudNativePG 1.29

Przed aktualizacją do `1.29.1` zapytanie o rolę zwracało pusty wynik:

```text
cnpg_metrics_exporter: brak roli
```

Po aktualizacji rola istniała w obu klastrach:

```text
rolname:              cnpg_metrics_exporter
rolsuper:             false
rolcanlogin:          true
member_of_pg_monitor: true
```

Eksporter przestał wykonywać zapytania jako `postgres`. Metryki pokazały połączenie:

```text
application_name="cnpg_metrics_exporter"
usename="cnpg_metrics_exporter"
```

W obu klastrach:

```text
cnpg_collector_last_collection_error 0
```

## Dostęp do endpointu metryk

Bezpośrednia próba połączenia z tymczasowego Poda do `PodIP:9187` zakończyła się
timeoutem. Endpoint działał poprawnie przez `kubectl port-forward`.

Przyczyną timeoutu były istniejące `NetworkPolicy` wybierające Pody baz. Ruch z
przypadkowego Poda w namespace `default` nie był dozwolony. Nie był to błąd
eksportera ani operatora.

Port-forward potwierdził metryki `cnpg_*` i `pg_*` dla obu baz.

`enablePodMonitor` pozostaje ustawione na `false`. Prometheus nie ma jeszcze
deklaratywnego `PodMonitor` i odpowiadających reguł ingress na port `9187`.

## ConfigMap zapytań monitorujących

Klastry wskazują `cnpg-default-monitoring` jako `customQueriesConfigMap`, a domyślne zapytania nie są wyłączone.

ConfigMapy w namespace `cnpg-system`, `clients` i `clients-staging` miały identyczną zawartość.

W logach baz nie było ostrzeżeń o nadpisywaniu zapytań ani powielonych nazwach.
Nie usuwano ConfigMap i nie zmieniano konfiguracji monitoringu w trakcie aktualizacji.

## Stan końcowy

```text
K3s:                    v1.36.4+k3s1 na 3/3 nodach
Cilium:                 1.20.2, status OK na 3/3 nodach
CloudNativePG chart:    0.29.0
CloudNativePG operator: 1.30.0
PostgreSQL:             17.4
CNPG clusters:          2/2 Ready
CNPG Pods:              2/2 Ready, 0 restartów
Flux:                   wszystkie Kustomization i HelmRelease Ready
```

Sesja zakończyła się poprawnym zimnym startem, zakończoną aktualizacją K3s oraz
zakończoną aktualizacją CloudNativePG. Nie pozostał stan przejściowy operatora ani
klastrów PostgreSQL.

## Następna sesja

1. Przygotować kontrolowany playbook aktualizacji Ubuntu dla nodów klastra.
2. Aktualizować system pojedynczo, z kontrolą quorum embedded etcd i gotowości noda.
3. Dodać `PodMonitor` dla obu klastrów CloudNativePG.
4. Dodać wąskie reguły `NetworkPolicy` zezwalające Prometheusowi na port `9187`.
5. Dodać `ScheduledBackup` oraz docelowy magazyn backupów CloudNativePG.
6. Wykonać i udokumentować test odtworzenia bazy, a nie tylko test utworzenia dumpa.
