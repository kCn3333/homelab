# 34 - aktualizacja stosu obserwowalności i baz danych

**Data:** 2026-10-01  
**Środowisko końcowe:** 3× HP T630, K3s `v1.36.4+k3s1`, Cilium `1.20.2`, Longhorn `1.12.1`, kube-prometheus-stack `91.8.2`, Prometheus `3.15.0`, Alertmanager `0.34.1`, Grafana `13.2.3`, CloudNativePG `1.30.1`, PostgreSQL `17.11`, Alloy `1.20.0`, Loki `3.7.8`

## Cel sesji

1. Sprawdzić stan klastra po ponownym uruchomieniu.
2. Zaktualizować kube-prometheus-stack w obrębie wersji `91.x`.
3. Zaktualizować operator CloudNativePG.
4. Wykonać zabezpieczoną aktualizację PostgreSQL `17.4 → 17.11`, najpierw na stagingu, a następnie na produkcji.
5. Zaktualizować Alloy i potwierdzić dalsze wysyłanie logów.
6. Zaktualizować Loki w obrębie wersji głównej chartu `18.x`.
7. Ocenić możliwość aktualizacji Longhorna bez wykonywania ryzykownej zmiany.

---

## 1. Kontrola klastra po starcie

Prometheus po starcie klastra osiągnął stan:

```text
Pod:        prometheus-kube-prometheus-stack-prometheus-0
Ready:      2/2
Status:     Running
Restarts:   0
Node:       master
```

Custom Resource Prometheusa miał:

```text
Desired:     1
Ready:       1
Reconciled:  True
Available:   True
```

Wolumen Prometheusa:

```text
PVC:          prometheus-kube-prometheus-stack-prometheus-db-prometheus-kube-prometheus-stack-prometheus-0
Longhorn:     attached, healthy
Node:         master
Replicas:     2
Scheduled:    True
Restore:      niewymagany
```

Obie repliki Longhorna działały na `worker1` i `worker2`, bez błędów ani prób przebudowy.

Prometheus ocenił wszystkie reguły poprawnie:

```json
{
  "healthCounts": [
    {
      "health": "ok",
      "count": 229
    }
  ],
  "problematic": []
}
```

Grafana nie zgłaszała nowych timeoutów, blokad SQLite ani błędów HTTP 5xx.

### Uwaga dotycząca powłoki

Pierwsza próba uruchomienia `kubectl port-forward` zakończyła się lokalnym błędem:

```text
bash: /tmp/prometheus-pf.log: nie można nadpisać istniejącego pliku
```

Przyczyną było aktywne `noclobber`, a nie awaria klastra. Do kontrolowanego nadpisania pliku użyto operatora:

```bash
>|/tmp/prometheus-pf.log
```

---

## 2. Aktualizacja kube-prometheus-stack

Stan początkowy:

```text
chart:    91.8.1
Grafana:  13.2.2-distroless
```

W repozytorium Helm dostępna była wersja:

```text
chart:      91.8.2
appVersion: v0.94.1
```

Porównanie renderów `91.8.1` i `91.8.2` wykazało zmianę wyłącznie w podcharcie Grafany:

```text
grafana chart: 13.2.6 → 13.2.7
Grafana:       13.2.2 → 13.2.3
```

Pozostałe obrazy nie zmieniły wersji.

Po aktualizacji Flux zgłosił:

```text
HelmRelease: kube-prometheus-stack
Revision:    91.8.2
Ready:       True
```

Grafana po rollout:

```text
image:       docker.io/grafana/grafana:13.2.3-distroless
Ready:       true,true,true
Restarts:    0,0,0
database:    ok
```

Zachowano wcześniej dobrane parametry:

```yaml
resources:
  requests:
    cpu: 100m
    memory: 512Mi
  limits:
    cpu: 500m
    memory: 1280Mi
env:
  GOMEMLIMIT: 900MiB
grafana.ini:
  plugins:
    preinstall_disabled: true
```

Bezpośrednio po starcie wystąpiła pojedyncza krótka blokada SQLite:

```text
database is locked (SQLITE_BUSY), retry=0
```

Ponowne sprawdzenie ostatniej minuty logów nie wykazało dalszych blokad ani błędów. Dashboardy i API Grafany działały prawidłowo.

---

## 3. Aktualizacja operatora CloudNativePG

Przed zmianą oba klastry PostgreSQL były zdrowe:

| Namespace | Cluster | Instancje | Ready | Primary |
|---|---|---:|---:|---|
| `clients` | `clients-db` | 2 | 2 | `clients-db-2` |
| `clients-staging` | `clients-db-staging` | 2 | 2 | `clients-db-staging-1` |

Stan początkowy operatora:

```text
chart:    0.29.0
operator: 1.30.0
```

Wersja docelowa:

```text
chart:    0.29.1
operator: 1.30.1
```

Porównanie renderów wykazało:

- aktualizację obrazu operatora `1.30.0 → 1.30.1`;
- zmianę checksum konfiguracji i RBAC;
- brak zmian wersji i trybu przechowywania CRD;
- brak zmian w zasobach i konfiguracji operatora ustawionych w HelmRelease.

Po aktualizacji:

- operator działał w wersji `1.30.1`;
- init container każdej instancji PostgreSQL używał `cloudnative-pg:1.30.1`;
- oba klastry pozostały `2/2 Ready`;
- role primary/replica były prawidłowe;
- usługi `-rw`, `-ro` i `-r` wskazywały właściwe endpointy;
- logi operatora po ustabilizowaniu nie zawierały błędów.

---

## 4. Backup logiczny przed aktualizacją PostgreSQL

Przed zmianą obrazu PostgreSQL wykonano lokalny backup logiczny obu klastrów.

Katalog backupu:

```text
/var/tmp/cnpg-preupgrade-20261001T091713Z
```

Katalog utworzono z prawami `0700`, a pliki z prawami `0600`.

Dla każdego klastra wykonano:

1. `pg_dumpall --globals-only`;
2. listę baz użytkownika;
3. `pg_dump --format custom --create` każdej bazy;
4. weryfikację każdego pliku przez `pg_restore --list`;
5. zapis i sprawdzenie sum `SHA256SUMS`.

Zabezpieczone bazy:

```text
clients/clients_db
clients/postgres
clients-staging/clients_db_staging
clients-staging/postgres
```

Weryfikacja dumpów aplikacyjnych wykazała po `12` obiektów i po `3` sekcje `TABLE DATA`. Wszystkie sumy SHA-256 były poprawne.

Istotne ograniczenie: klastry CloudNativePG nadal nie mają skonfigurowanych zasobów `Backup` ani `ScheduledBackup`. Lokalny backup logiczny zabezpieczał tę aktualizację, ale nie zastępuje docelowej polityki regularnych backupów.

---

## 5. Kontrole zgodności PostgreSQL

Przed aktualizacją potwierdzono:

- bieżącą wersję PostgreSQL `17.4`;
- system kolacji `C` dla baz aplikacyjnych i `postgres`;
- brak dodatkowych rozszerzeń poza `plpgsql`;
- brak indeksów BRIN;
- brak samoodwołujących kluczy obcych na tabelach partycjonowanych;
- wyłącznie fizyczne sloty replikacji CloudNativePG;
- mały rozmiar baz, około `8 MiB` dla każdej bazy aplikacyjnej;
- brak konieczności wykonania `pg_upgrade`, ponieważ była to aktualizacja patch w obrębie PostgreSQL 17.

Wybrany obraz:

```text
ghcr.io/cloudnative-pg/postgresql:17.11-standard-bookworm
```

Obraz przypięto również do digestu:

```text
sha256:61207ab4e051645dcb9901e1ec9358b01e4adb45624cb4425be1eab27eac6508
```

Wybór wariantu `standard-bookworm` zachował bazę Debian 12 i nie wprowadzał jednoczesnej migracji systemu bazowego do Trixie.

---

## 6. Aktualizacja PostgreSQL na stagingu

Najpierw zmieniono manifest na branchu `staging`:

```text
apps/staging/db-cluster.yaml
```

Render Kustomize potwierdził:

```text
instances: 2
storage:   1Gi, longhorn
image:     PostgreSQL 17.11 przypięty do digestu
```

Server-side dry-run zakończył się powodzeniem przed zastosowaniem zmiany przez GitOps.

Po rollout:

```text
Cluster:        clients-db-staging
Ready:          2/2
Primary:        clients-db-staging-1
PostgreSQL:     17.11
OS:             Debian 12
Restarts:       0
```

Primary zwracał `pg_is_in_recovery() = false`, a replika `true`.

Dane aplikacyjne po aktualizacji:

```text
app_authorities: 6
app_users:       3
clients:         20
```

Endpoint aplikacji staging zwracał:

```json
{
  "status": "UP",
  "components": {
    "db": {
      "status": "UP"
    }
  }
}
```

W czasie restartu instancji pojawiły się spodziewane ostrzeżenia HikariCP dotyczące zamkniętych połączeń oraz chwilowy błąd operatora podczas startu PostgreSQL. Po minucie aplikacja i operator miały czyste logi.

---

## 7. Aktualizacja PostgreSQL na produkcji

Po pozytywnym teście stagingu zmieniono:

```text
apps/base/clients-api/db-cluster.yaml
```

Przed aktualizacją zapisano stan tabel produkcyjnych. Manifest przeszedł:

- render Kustomize;
- `git diff --check`;
- server-side dry-run API Kubernetes.

Po rollout:

```text
Cluster:        clients-db
Ready:          2/2
Primary:        clients-db-2
PostgreSQL:     17.11
OS:             Debian 12
Restarts:       0
```

Obie instancje używały dokładnie tego samego digestu obrazu. Porównanie statystyk tabel przed i po zmianie nie wykazało różnic.

API produkcyjne zwracało:

```json
{
  "status": "UP",
  "components": {
    "db": {
      "status": "UP"
    }
  }
}
```

Podczas przełączania instancji aplikacja rejestrowała krótkotrwałe ostrzeżenia HikariCP o zamkniętych połączeniach. Po 90 sekundach oba Pody aplikacji oraz operator miały czyste logi.

Endpoint `clients-db-rw` wskazywał wyłącznie gotowy Pod primary:

```text
clients-db-2 → 10.42.0.182
ready=true
terminating=false
```

---

## 8. Aktualizacja Alloy

Alloy został zaktualizowany przez Flux:

```text
chart:           1.12.1 → 1.13.0
Alloy:           1.19.2 → 1.20.0
config-reloader: 0.91.0 → 0.94.0
```

Stan DaemonSetu po rollout:

```text
Desired:    3
Current:    3
Updated:    3
Ready:      3
Available:  3
```

Na każdym nodzie działał jeden Pod Alloy. Wszystkie kontenery były gotowe i miały `0` restartów.

Logi Alloy i config-reloadera nie zawierały błędów, odpowiedzi HTTP 429/5xx ani problemów z autoryzacją.

Kontrolne zapytanie Loki:

```logql
sum(count_over_time({collector="alloy"}[5m]))
```

zwróciło `1750` linii. Potwierdziło to dalsze zbieranie logów po aktualizacji kolektora.

---

## 9. Przygotowanie aktualizacji Loki

Bieżące źródło chartu:

```text
HelmRepository: grafana-community
URL:            https://grafana-community.github.io/helm-charts
```

Repozytorium zostało również dodane lokalnie do klienta Helm w celu poprawnego renderowania chartu.

Stan początkowy:

```text
chart:   18.7.6
Loki:    3.7.6
sidecar: 2.10.1
```

Wersja docelowa:

```text
chart:   18.13.7
Loki:    3.7.8
sidecar: 2.11.2
```

Nie była to ponowna duża migracja Loki. Migrację przez kolejne wersje główne chartu, zmianę repozytorium oraz przejście do jawnego trybu `Monolithic` wykonano wcześniej. Dzisiejsza zmiana pozostała w obrębie wersji głównej chartu `18.x`.

Porównanie renderów potwierdziło:

- jeden StatefulSet `loki`;
- jedną replikę;
- niezmieniony `config.yaml`;
- niezmienione volumes i volume mounts;
- niezmieniony claim `storage` o wielkości `10Gi`;
- brak zmiany sposobu użycia Garage S3;
- zmianę wyłącznie obrazów Loki i sidecara.

Zabezpieczenie PVC nadal było aktywne:

```yaml
singleBinary:
  persistence:
    enableStatefulSetAutoDeletePVC: false
```

Istniejący PVC przed zmianą:

```text
PVC:          storage-loki-0
Status:       Bound
PV:           pvc-54bdf342-b185-48d4-a829-c90c4cd93f07
StorageClass: longhorn
Capacity:     10Gi
AccessMode:   ReadWriteOnce
```

---

## 10. Aktualizacja Loki

HelmRelease został zaktualizowany:

```text
chart: 18.7.6 → 18.13.7
```

Flux zakończył operację:

```text
Helm revision: 17
Ready:         True
Status:        Helm upgrade succeeded
```

StatefulSet wykonał poprawny rollout. Stan końcowy Poda:

```text
Pod:       loki-0
Node:      worker2
Phase:     Running
Ready:     true,true
Restarts:  0,0
```

Obrazy:

```text
docker.io/grafana/loki:3.7.8
docker.io/kiwigrid/k8s-sidecar:2.11.2
```

Pod zachował claim:

```text
storage → storage-loki-0
```

Longhorn poprawnie przepiął wolumen na `worker2`:

```text
State:        attached
Robustness:   healthy
Replicas:     2
Scheduled:    True
Restore:      niewymagany
```

API buildinfo zwróciło:

```text
version:   3.7.8
revision:  09e6ce2f
branch:    release-3.7.x
```

Kontrolne zapytanie z ostatnich pięciu minut zwróciło `1853` linie z kolektora Alloy.

---

## 11. Przejściowe komunikaty memberlist Loki

Podczas startu pojedynczego Poda ponownie wystąpiły komunikaty:

```text
failed to resolve loki-memberlist.loki.svc.cluster.local
empty ring
failed to fast-join the memberlist cluster
```

Przyczyną była kolejność startu:

1. Pod Loki nie był jeszcze gotowy.
2. Headless Service nie miał gotowego endpointu.
3. CoreDNS chwilowo zwracał `no such host`.
4. Loki automatycznie utworzył jednoelementowy ring.
5. Po uzyskaniu readiness EndpointSlice opublikował adres Poda.

Stan po ustabilizowaniu:

```text
Endpoint:    10.42.2.105
Ready:       true
Terminating: false
```

Log Loki potwierdził:

```text
phase=periodic_rejoin
msg="re-joined memberlist cluster"
reached_nodes=1
```

Nie był to trwały błąd DNS ani regresja po aktualizacji.

---

## 12. Stan końcowy

### Monitoring

```text
kube-prometheus-stack: 91.8.2
Prometheus:             3.15.0
Alertmanager:           0.34.1
Grafana:                13.2.3-distroless
Grafana database:       ok
Prometheus rules:       229 ok, 0 problematycznych
```

### PostgreSQL

```text
CloudNativePG chart:    0.29.1
CloudNativePG operator: 1.30.1
PostgreSQL:             17.11, Debian 12
clients-db:             2/2 Ready
clients-db-staging:     2/2 Ready
```

### Logi

```text
Alloy chart: 1.13.0
Alloy:       1.20.0
Alloy DS:    3/3 Ready
Loki chart:  18.13.7
Loki:        3.7.8
Loki Pod:    2/2 Ready, 0 restartów
```

### Storage

```text
Longhorn:          1.12.1
Nodes:             3/3 Ready i Schedulable
Volumes:           6/6 attached i healthy
Failed replicas:   0
Upgrade do 1.13.0: odłożony
```

---

## 14. Wnioski

1. PVC nie jest samym wolumenem. Jest żądaniem storage, które Kubernetes wiąże z PV; Longhorn dostarcza implementację storage, repliki, attach/detach, odbudowę i kontrolę zdrowia.
2. Aktualizacje operatora i zarządzanego przez niego operand muszą być rozdzielone. Najpierw zaktualizowano CloudNativePG, później PostgreSQL.
3. Aktualizację bazy należy rozpocząć od stagingu i przejść na produkcję dopiero po sprawdzeniu danych, replikacji, endpointów oraz aplikacji.
4. Backup logiczny należy nie tylko utworzyć, lecz także zweryfikować przez `pg_restore --list` i sumy kontrolne.
5. Przypięcie obrazu do digestu gwarantuje identyczny artefakt na wszystkich instancjach.
6. Przy aktualizacji PostgreSQL krótkie ostrzeżenia puli połączeń są spodziewane, jeśli znikają po zakończeniu restartów, a health check wraca do `UP`.
7. Pusty diff konfiguracji Loki oraz identyczny szablon PVC ograniczyły zakres aktualizacji do wymiany obrazów.
8. Przejściowy błąd memberlist podczas startu jednej repliki Loki nie oznacza awarii, jeśli później EndpointSlice jest gotowy, ring się łączy, a nowe logi są zapisywane.
9. Poprawny stan bieżącej wersji jest ważniejszy niż samo posiadanie najnowszego wydania. Longhorn `1.13.0` świadomie odłożono ze względu na świeżość i znaczenie warstwy storage.
10. Aktualizacje były wykonywane przez GitOps i kontrolowane za pomocą renderów Helm/Kustomize, dry-runów, rollout status, logów, endpointów oraz testów aplikacyjnych.

---

## 15. Następna sesja

1. Skonfigurować regularny backup klastrów CloudNativePG zamiast polegać wyłącznie na ręcznych dumpach.
2. Zinwentaryzować Data Engine wszystkich wolumenów Longhorna.
3. Sprawdzić możliwość wykonania Longhorn System Backup i backupów danych przed przyszłą aktualizacją.
4. Poczekać na ustabilizowanie linii `1.13.x`, preferencyjnie co najmniej `1.13.1`, przed aktualizacją krytycznej warstwy storage.
5. Osobno rozważyć ServiceMonitor i reguły Prometheus dla komponentów, które nadal nie eksportują metryk do bieżącego stosu monitoringu.
