# 29 - playbook aktualizacji Ubuntu i replikacja CloudNativePG

**Data:** 2026-09-21
**Środowisko końcowe:** 3× HP T630, Ubuntu 24.04.4 LTS, K3s `v1.36.4+k3s1`, Cilium `1.20.2`, CloudNativePG `1.30.0`, PostgreSQL `17.4`, Longhorn `1.11.0`

## Cel sesji

1. Potwierdzić kolejny poprawny zimny start klastra.
2. Przygotować prosty, kontrolowany playbook aktualizacji pakietów Ubuntu.
3. Przetestować playbook w Semaphore bez wykonywania niepotrzebnego maintenance.
4. Usunąć konieczność ręcznego przełączania `nodeMaintenanceWindow` przed każdym uruchomieniem.
5. Zwiększyć klastry CloudNativePG z jednej do dwóch instancji.
6. Zdiagnozować i usunąć blokadę tworzenia replik PostgreSQL.

---

## 1. Start klastra

Kolejny pełny start klastra zakończył się bez błędów.

Potwierdzony stan bazowy:

- trzy nody uruchomione;
- wszystkie nody `Ready`;
- K3s działa na wszystkich serwerach;
- nie wystąpił błąd remotedialera;
- klaster nadawał się do testu nowego playbooka maintenance.

Był to kolejny poprawny start po aktualizacji K3s do `v1.36.4+k3s1`.

---

## 2. Założenia kontrolowanej aktualizacji Ubuntu

Przyjęty przebieg:

1. jawne zatwierdzenie operacji;
2. sprawdzenie kompletnego inventory i braku `--limit`;
3. preflight systemu i K3s na wszystkich nodach;
4. sprawdzenie zdrowia całego klastra;
5. odświeżenie cache APT i symulacja `dist-upgrade` przed `cordon`;
6. pominięcie maintenance dla noda bez aktualizacji i bez wymaganego restartu;
7. jeden snapshot etcd tylko wtedy, gdy przynajmniej jeden node wymaga maintenance;
8. aktualizacja jednego noda naraz:
   - `cordon`;
   - `drain` przez eviction API;
   - `apt dist-upgrade`;
   - reboot tylko przy `/var/run/reboot-required`;
   - oczekiwanie na SSH, K3s, API, etcd, Node i Cilium;
   - `uncordon` dopiero po pełnym odzyskaniu;
9. sprawdzenie całego klastra i macierzy API server → kubelet `9/9`;
10. przejście do następnego noda.

Playbook nie używa:

```text
--force
--disable-eviction
ignore_errors
autoremove
```

Awaria zatrzymuje kolejkę. Ścieżka ratunkowa nie wykonuje automatycznego `uncordon` uszkodzonego noda.

---

## 3. Pliki implementacji

Dodano:

```text
cluster/playbooks/maintenance/k3s-os-upgrade.yml
cluster/tasks/k3s-os-cluster-health.yml
cluster/tasks/k3s-os-proxy-matrix.yml
docs/k3s-os-upgrade.md
```

Zaktualizowano:

```text
cluster/README.md
tests/test-k3s-lifecycle.py
```

Playbook wymaga:

```yaml
k3s_os_upgrade_confirm: true
```

Opcjonalna kolejność jest przekazywana jako zmienna uruchomienia, bez modyfikowania inventory:

```yaml
k3s_os_upgrade_order:
  - worker1
  - worker2
  - master
```

---

## 4. Optymalizacja ścieżki bez dostępnych aktualizacji

Pierwotny przebieg wykonywałby `cordon`, `drain` i snapshot również wtedy, gdy APT nie miał nic do zainstalowania.

Zmieniono kolejność:

```text
pełny preflight
  ↓
apt update
  ↓
apt dist-upgrade --simulate
  ↓
kontrola reboot-required
  ↓
decyzja CURRENT albo MAINTENANCE
```

Node wymaga maintenance tylko wtedy, gdy:

- symulacja APT wykazuje pakiety do aktualizacji; lub
- istnieje `/var/run/reboot-required`.

Jeżeli żaden node nie wymaga zmian:

- snapshot etcd jest pomijany;
- `cordon` i `drain` są pomijane;
- APT nie wykonuje instalacji;
- nie ma rebootu;
- wykonywana jest końcowa walidacja klastra;
- raport oznacza wszystkie nody jako `CURRENT`.

---

## 5. Problem jednoinstancyjnych baz podczas drainu

Oba klastry CloudNativePG działały wcześniej z:

```yaml
spec:
  instances: 1
```

Przy jednej instancji drain noda z primary zawsze powoduje przerwę. `nodeMaintenanceWindow.inProgress: true` usuwa PDB i pozwala przeprowadzić maintenance, ale nie zapewnia dostępności bazy.

Ręczne przełączanie tego pola przed i po każdym uruchomieniu playbooka nie jest właściwym modelem operacyjnym.

Przyjęto docelowo:

```yaml
spec:
  instances: 2
```

dla:

```text
clients/clients-db
clients-staging/clients-db-staging
```

`nodeMaintenanceWindow` pozostaje wyłączone podczas zwykłej pracy. CloudNativePG utrzymuje PDB i może wykonać switchover przed eksmisją primary.

PDB z:

```text
ALLOWED DISRUPTIONS: 0
```

nie jest sam w sobie błędem. Chroni primary do czasu, aż operator potwierdzi gotową replikę i bezpieczną zmianę roli.

---

## 6. Repliki nie kończyły inicjalizacji

Po ustawieniu `instances: 2` oba klastry przez kilkanaście minut pozostawały w stanie:

```text
instances: 2
readyInstances: 1
phase: Creating a new replica
Ready: false
```

Primary działały na `worker1`:

```text
clients-db-1          primary   worker1
clients-db-staging-1  primary   worker1
```

Operator utworzył Pody zadań join na `master`:

```text
clients-db-2-join-...
clients-db-staging-2-join-...
```

Nowe PVC zostały poprawnie utworzone i związane przez Longhorn:

| Namespace | PVC | Wolumen | Stan |
|---|---|---|---|
| `clients` | `clients-db-2` | `pvc-583d8934-49bb-4fc1-890a-0779d64c1fe5` | `Bound` |
| `clients-staging` | `clients-db-staging-2` | `pvc-b9b16f17-ece3-4ce9-8dd5-c1c57ae4cee5` | `Bound` |

Storage i scheduling działały. Problem występował podczas łączenia nowej instancji z primary.

Logi join pokazywały cykliczne timeouty TCP/5432:

```text
clients-db-rw:5432          timeout after 10 seconds
clients-db-staging-rw:5432  timeout after 10 seconds
```

Service i EndpointSlice były poprawne:

| Service | Endpoint | Ready |
|---|---|---:|
| `clients-db-rw` | `10.42.1.182:5432` | `true` |
| `clients-db-staging-rw` | `10.42.1.230:5432` | `true` |

Nie był to problem DNS, Service, EndpointSlice, PVC ani operatora.

---

## 7. Przyczyna: brak reguły dla ruchu wewnętrznego PostgreSQL

W obu namespace obowiązywały polityki ingress wybierające Pody baz.

Polityka aplikacyjna dopuszczała:

```text
clients-api → PostgreSQL
```

Polityka operatora dopuszczała:

```text
cnpg-system/cloudnative-pg → TCP/8000
```

Brakowało reguły:

```text
instancja CNPG → instancja CNPG → TCP/5432
```

Zadanie join miało etykietę klastra, więc było objęte izolacją ingress, ale nie pasowało do żadnego dozwolonego źródła dla portu PostgreSQL.

Pliki wymagające uzupełnienia:

```text
apps/base/clients-api/networkpolicy-cnpg-operator.yaml
apps/staging/networkpolicy-cnpg-operator.yaml
```

Dodano osobną, czytelną regułę dla ruchu wewnętrznego każdej bazy:

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
spec:
  podSelector:
    matchLabels:
      cnpg.io/cluster: <cluster>
      cnpg.io/podRole: instance
  policyTypes:
    - Ingress
  ingress:
    - from:
        - podSelector:
            matchLabels:
              cnpg.io/cluster: <cluster>
      ports:
        - protocol: TCP
          port: 5432
```

Reguła jest ograniczona do Podów tego samego klastra i portu PostgreSQL. Nie otwiera ruchu z innych namespace ani innych workloadów.

---

## 8. Stan CloudNativePG po poprawce

Po wdrożeniu polityk zadania join zakończyły się, a operator utworzył właściwe repliki.

Stan Podów:

| Namespace | Pod | Rola | Ready | Node |
|---|---|---|---:|---|
| `clients` | `clients-db-1` | primary | `true` | `worker1` |
| `clients` | `clients-db-2` | replica | `true` | `master` |
| `clients-staging` | `clients-db-staging-1` | primary | `true` | `worker1` |
| `clients-staging` | `clients-db-staging-2` | replica | `true` | `master` |

Osiągnięta topologia:

```text
worker1: primary produkcji + primary stagingu
master:  replika produkcji + replika stagingu
```

Samo pojawienie się obu replik w stanie `Ready` potwierdziło, że przyczyną blokady była brakująca reguła `NetworkPolicy` dla TCP/5432.

---

## 9. Wniosek dla playbooka aktualizacji Ubuntu

Preflight playbooka przeszedł wcześniej mimo stanu:

```text
spec.instances: 2
status.readyInstances: 1
Ready: false
```

Kontrola samych faz Podów i zdrowia Longhorna nie wykrywa degradacji klastra CloudNativePG.

Helper zdrowia klastra powinien dodatkowo odczytywać wszystkie zasoby:

```text
clusters.postgresql.cnpg.io
```

i dla każdego wymagać:

```text
status.readyInstances == spec.instances
condition Ready == True
status.phase == Cluster in healthy state
```

Kontrola powinna działać:

1. przed utworzeniem snapshotu;
2. przed `cordon` każdego noda;
3. po odzyskaniu noda, przed przejściem do następnego;
4. w końcowej walidacji.

Nie należy globalnie wymagać `disruptionsAllowed > 0` dla wszystkich PDB. W przypadku CloudNativePG wartość `0` przed rozpoczęciem kontrolowanego switchoveru może być poprawna.

---

## 10. Stan końcowy

### K3s

- trzy nody działają;
- wersja `v1.36.4+k3s1` pozostaje bez zmian;
- kolejny zimny start zakończył się poprawnie;
- macierz API server → kubelet działa `9/9`.

### Aktualizacje Ubuntu

- playbook został wdrożony w repozytorium i uruchomiony z Semaphore;
- wszystkie preflighty przeszły;
- brak dostępnych aktualizacji na trzech nodach;
- brak wymaganego restartu;
- snapshot, cordon, drain, instalacja i reboot zostały prawidłowo pominięte;
- przetestowana jest tylko ścieżka `CURRENT`.

### CloudNativePG

- oba klastry mają `instances: 2`;
- oba primary są `Ready` na `worker1`;
- obie repliki są `Ready` na `master`;
- `nodeMaintenanceWindow` nie wymaga ręcznego przełączania przed każdym maintenance;
- wewnętrzny ruch replikacji i join na TCP/5432 jest jawnie dozwolony przez `NetworkPolicy`.

### Longhorn

- PVC nowych replik zostały utworzone i związane;
- storage nie był przyczyną opóźnienia inicjalizacji replik.

---

## 11. Następna sesja

1. Dodać kontrolę CloudNativePG do `k3s-os-cluster-health.yml`.
2. Potwierdzić dla obu klastrów:

   ```text
   spec.instances = 2
   status.readyInstances = 2
   Ready = True
   phase = Cluster in healthy state
   ```

3. Sprawdzić stan replikacji SQL przez `pg_stat_replication`.
4. Zweryfikować rozłożenie nowych wolumenów Longhorn i ich replik.
5. Wykonać kontrolowany test drain noda z primary.
6. Potwierdzić automatyczny switchover, działanie Service `*-rw` i powrót klastra do `2/2 Ready`.
7. Przy pierwszych rzeczywistych aktualizacjach Ubuntu zachować pełny log ścieżki `snapshot → drain → reboot → recovery`.
