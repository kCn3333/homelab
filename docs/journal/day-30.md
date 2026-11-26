# 30 - aktualizacja Longhorna i Metrics Server

**Data:** 2026-09-22
**Środowisko końcowe:** 3× HP T630, Ubuntu 24.04.5 LTS, K3s `v1.36.4+k3s1`, Cilium `1.20.2`, CloudNativePG `1.30.0`, PostgreSQL `17.4`, Longhorn `1.12.1`, Metrics Server `v0.9.0`

## Cel sesji

1. Potwierdzić poprawny stan klastra po poprzedniej sesji.
2. Zamknąć weryfikację dwuinstancyjnych klastrów CloudNativePG.
3. Zinwentaryzować komponenty wymagające aktualizacji.
4. Zaktualizować Longhorna kontrolowanymi etapami `1.11.0 → 1.11.3 → 1.12.1`.
5. Przenieść wszystkie wolumeny na aktualny obraz silnika Longhorna.
6. Potwierdzić poprawność storage po zimnych startach klastra.
7. Zaktualizować Metrics Server z chartu `3.13.1` do `3.14.0`.

---

## 1. Stan klastra po uruchomieniu

Kolejny start klastra zakończył się bez błędów.

Potwierdzono:

- trzy nody `Ready`;
- K3s `v1.36.4+k3s1` na wszystkich nodach;
- Ubuntu `24.04.5 LTS` i kernel `6.8.0-139-generic`;
- brak Podów poza fazami `Running` i `Succeeded`;
- wszystkie Kustomization Flux w stanie `Ready=True`;
- wszystkie HelmRelease w stanie `Ready=True`;
- CloudNativePG `2/2 Ready` w obu namespace;
- Longhorn `1.11.0` w stanie `Ready` przed rozpoczęciem aktualizacji.

Stan CloudNativePG:

| Namespace | Klaster | Instancje | Ready | Primary |
|---|---|---:|---:|---|
| `clients` | `clients-db` | 2 | 2 | `clients-db-2` |
| `clients-staging` | `clients-db-staging` | 2 | 2 | `clients-db-staging-2` |

---

## 2. Weryfikacja replikacji CloudNativePG

Na obu primary sprawdzono `pg_stat_replication`.

Produkcja:

```text
application_name: clients-db-1
state:            streaming
sync_state:       async
```

Staging:

```text
application_name: clients-db-staging-1
state:            streaming
sync_state:       async
```

Na replikach:

```text
pg_is_in_recovery() = true
pg_is_wal_replay_paused() = false
```

Etap zwiększania CloudNativePG do dwóch instancji został uznany za zamknięty.

---

## 3. Wybór kolejnego komponentu

Po przeglądzie wersji do aktualizacji wybrano Longhorna.

Przyjęto aktualizację dwuetapową:

```text
1.11.0 → 1.11.3 → test → zimny start
1.11.3 → 1.12.1 → migracja silników → zimny start
```

Nie wykonywano bezpośredniego skoku z `1.11.0` do `1.12.1` bez punktu kontrolnego. Każdy etap obejmował osobno:

- rollout komponentów Longhorna;
- kontrolę wolumenów i replik;
- migrację obrazów silnika;
- sprawdzenie workloadów używających PVC;
- zimny start klastra.

---

## 4. Aktualizacja Longhorna `1.11.0 → 1.11.3`

HelmRelease został zaktualizowany do:

```text
chart: longhorn 1.11.3
manager: longhorn-manager:v1.11.3
engine: longhorn-engine:v1.11.3
```

Po rollout wszystkie komponenty Longhorna były gotowe:

- `longhorn-manager` — `3/3`;
- `longhorn-csi-plugin` — `3/3`;
- `longhorn-driver-deployer` — `1/1`;
- `longhorn-ui` — `2/2`;
- wszystkie kontrolery CSI — gotowe;
- brak Podów Longhorna poza `Running` i `Succeeded`.

Nowy obraz silnika został wdrożony na wszystkich trzech nodach. Początkowo wolumeny nadal korzystały z `v1.11.0`; samo podniesienie chartu nie aktualizuje automatycznie silnika istniejących wolumenów.

Silniki wszystkich wolumenów zaktualizowano w Longhorn UI do:

```text
docker.io/longhornio/longhorn-engine:v1.11.3
```

Po migracji:

- wszystkie wolumeny były `attached` i `healthy`;
- nowy EngineImage miał aktywne referencje;
- workloady Loki, Prometheus i CloudNativePG działały;
- zimny start klastra zakończył się poprawnie.

---

## 5. Punkt odzyskiwania przed Longhornem `1.12.1`

Przed drugim etapem ponownie potwierdzono:

- wszystkie wolumeny `attached` i `healthy`;
- wszystkie wolumeny używają silnika `v1.11.3`;
- każda replika Longhorna działa;
- brak wpisów `failedAt`;
- CloudNativePG `2/2 Ready` dla obu klastrów;
- brak nieprawidłowych Podów;
- HelmRelease Longhorna `Ready=True`.

### Snapshot etcd

Utworzono snapshot:

```text
pre-longhorn-upgrade-v1.12.1-master-1790065855
```

K3s zgłosił ostrzeżenie:

```text
Unknown flag --disable found in config.yaml, skipping
```

Snapshot został mimo ostrzeżenia zapisany poprawnie. Ostrzeżenie należy przeanalizować osobno; nie blokowało bieżącej operacji.

### Backup systemowy Longhorna

Backup target S3 w Garage był dostępny:

```text
s3://longhorn-backup@garage/
AVAILABLE=true
```

`SystemBackup` zachował konfigurację Longhorna i utworzył backupy wolumenów zgodnie z:

```yaml
volumeBackupPolicy: always
```

---

## 6. Aktualizacja Longhorna `1.11.3 → 1.12.1`

Flux zakończył aktualizację HelmRelease:

```text
REVISION: 1.12.1
READY:    True
MESSAGE:  Helm upgrade succeeded
```

Komponenty po rollout:

```text
longhorn-manager:v1.12.1
longhorn-ui:v1.12.1
longhorn-share-manager:v1.12.1
longhorn-engine:v1.12.1
```

Potwierdzono:

- `longhorn-manager` — `3/3 Ready`;
- `longhorn-csi-plugin` — `3/3 Ready`;
- `longhorn-ui` — `2/2 Ready`;
- `longhorn-driver-deployer` — `1/1 Ready`;
- wszystkie kontrolery CSI gotowe;
- brak nieprawidłowych Podów w `longhorn-system`;
- brak istotnych błędów w logach managerów.

Po aktualizacji chartu nowy EngineImage był dostępny, ale istniejące wolumeny nadal używały `v1.11.3`:

```text
v1.12.1  REFCOUNT=0
v1.11.3  REFCOUNT=24
```

Jest to oczekiwane. Aktualizacja managera nie wymusza jednoczesnej migracji wszystkich działających silników.

---

## 7. Migracja silników wolumenów do `v1.12.1`

W Longhorn UI wykonano aktualizację obrazu silnika dla wszystkich sześciu wolumenów.

Objęte PVC:

| Namespace | PVC | Node po migracji |
|---|---|---|
| `loki` | `storage-loki-0` | `master` |
| `monitoring` | `prometheus-kube-prometheus-stack-prometheus-db-prometheus-kube-prometheus-stack-prometheus-0` | `master` |
| `clients` | `clients-db-1` | `worker1` |
| `clients` | `clients-db-2` | `master` |
| `clients-staging` | `clients-db-staging-1` | `worker1` |
| `clients-staging` | `clients-db-staging-2` | `master` |

Stan po migracji:

```text
STATE:  attached
HEALTH: healthy
ENGINE: docker.io/longhornio/longhorn-engine:v1.12.1
```

EngineImage po zakończeniu:

```text
v1.12.1  deployed  REFCOUNT=24
v1.11.3  deployed  REFCOUNT=0
v1.11.0  deployed  REFCOUNT=0
```

Starszych obrazów nie usunięto podczas tej sesji. Brak referencji oznacza, że nie obsługują aktywnych silników, ale pozostawienie ich do czasu kolejnych poprawnych startów ułatwia diagnostykę i ewentualny rollback.

---

## 8. Repliki Longhorna

Każdy z sześciu wolumenów miał dwie działające repliki:

```text
worker1: running
worker2: running
failedAt: ""
```

Łącznie potwierdzono:

```text
6 wolumenów
12 replik
12/12 running
0 failedAt
```

Wolumeny były podłączone do `master` lub `worker1`, natomiast ich repliki danych znajdowały się na `worker1` i `worker2`.

Należy rozróżniać:

- `currentNodeID` wolumenu — node, do którego podłączony jest aktywny silnik;
- `spec.nodeID` repliki — node przechowujący kopię danych.

---

## 9. Zimny start po aktualizacji Longhorna

Po pełnym wyłączeniu i uruchomieniu klastra potwierdzono:

- trzy nody `Ready`;
- brak Podów poza `Running` i `Succeeded`;
- HelmRelease Longhorna `1.12.1` w stanie `Ready=True`;
- sześć wolumenów `attached` i `healthy`;
- wszystkie wolumeny używają `longhorn-engine:v1.12.1`;
- wszystkie repliki działają bez `failedAt`;
- oba klastry CloudNativePG mają `2/2 Ready`;
- Loki i Prometheus odzyskały wolumeny;
- nie wystąpiła utrata danych ani konieczność ręcznego naprawiania storage.

Po starcie role baz zmieniły się na:

| Namespace | Primary | Replica |
|---|---|---|
| `clients` | `clients-db-1` | `clients-db-2` |
| `clients-staging` | `clients-db-staging-1` | `clients-db-staging-2` |

Zmiana primary jest poprawnym wynikiem elekcji CloudNativePG po pełnym starcie. Oba klastry pozostały `Cluster in healthy state`.

Aktualizacja Longhorna do `1.12.1` została uznana za zakończoną.

---

## 10. Aktualizacja Metrics Server

Jako ostatni, bezstanowy komponent wybrano Metrics Server.

Zakres:

```text
Helm chart: 3.13.1 → 3.14.0
aplikacja:  v0.8.1  → v0.9.0
```

Flux zakończył operację:

```text
REVISION: 3.14.0
READY:    True
MESSAGE:  Helm upgrade succeeded
```

Deployment:

```text
READY:     1
AVAILABLE: 1
IMAGE:     registry.k8s.io/metrics-server/metrics-server:v0.9.0
```

API agregowane:

```text
APIService: v1beta1.metrics.k8s.io
Available:  True
Reason:     Passed
```

Testy funkcjonalne:

- `kubectl top nodes` zwróciło metryki trzech nodów;
- `kubectl top pods --all-namespaces` zwróciło metryki workloadów;
- brak błędów `error`, `failed`, `panic` i `fatal` w logach;
- rollout zakończył się poprawnie.

Aktualizacja Metrics Server została uznana za zakończoną.

---

## 11. Stan końcowy

### K3s i GitOps

- trzy nody `Ready`;
- K3s `v1.36.4+k3s1`;
- Cilium `1.20.2`;
- brak nieprawidłowych Podów;
- Flux poprawnie wdrożył obie aktualizacje;
- kolejne zimne starty zakończyły się bez błędu remotedialera.

### Longhorn

- chart i manager `1.12.1`;
- sześć wolumenów `attached` i `healthy`;
- sześć wolumenów na silniku `v1.12.1`;
- 12/12 replik `running`;
- brak `failedAt`;
- backup target S3 dostępny;
- `SystemBackup` sprzed aktualizacji ma stan `Ready`;
- snapshot etcd został zapisany.

### CloudNativePG

- oba klastry `2/2 Ready`;
- oba w fazie `Cluster in healthy state`;
- replikacja asynchroniczna działa;
- repliki nie mają wstrzymanego replay WAL;
- zmiana primary po zimnym starcie przebiegła automatycznie.

### Metrics Server

- chart `3.14.0`;
- aplikacja `v0.9.0`;
- Deployment `1/1 Ready`;
- Metrics API dostępne;
- `kubectl top` działa dla nodów i Podów.

---

## 12. Wnioski

1. Aktualizacja chartu Longhorna i migracja obrazu silnika wolumenów to dwie osobne operacje.
2. Nowy EngineImage z `REFCOUNT=0` oznacza tylko, że żaden aktywny silnik jeszcze go nie używa.
3. `SystemBackup` Longhorna nie zastępuje snapshotu etcd ani backupów danych wolumenów; zabezpieczenia pełnią różne role.
4. Nazwy zasobów Kubernetes muszą spełniać RFC 1123; znaczniki czasu nie mogą zawierać wielkich liter.
5. `currentNodeID` wolumenu nie wskazuje lokalizacji wszystkich replik danych.
6. Dwie repliki CloudNativePG umożliwiają automatyczny wybór primary po restarcie, ale replikacja jest obecnie asynchroniczna.
7. Aktualizacje stanowego storage należy rozdzielać punktami kontrolnymi i zimnymi startami.
8. Metrics Server można zweryfikować nie tylko przez gotowość Deploymentu, lecz także przez stan `APIService` i rzeczywiste zapytania `kubectl top`.

---

## 13. Następna sesja

1. Nie wykonywać kolejnej dużej aktualizacji przed następnym poprawnym startem klastra.
2. Ponownie sprawdzić:

   ```text
   Longhorn: 6/6 volumes healthy
   Longhorn: 12/12 replicas running
   CloudNativePG: 2/2 Ready w obu klastrach
   Metrics API: Available=True
   API server → kubelet: 9/9
   ```

3. Zinwentaryzować sposób instalacji cert-managera `1.19.4` i jego zasoby CRD.
4. Zaplanować aktualizację cert-managera jako osobną zmianę z testem wystawiania certyfikatu.
5. Osobno zaplanować aktualizację Flux i wcześniej przeskanować repozytorium pod kątem przestarzałych wersji API.
6. Nie łączyć aktualizacji cert-managera, Flux, Traefika, Loki ani kube-prometheus-stack w jednej sesji.
