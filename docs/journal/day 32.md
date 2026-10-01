# 32 - migracja repozytorium Helm i aktualizacja Loki

**Data:** 2026-09-24–2026-09-25
**Środowisko końcowe:** 3× HP T630, Ubuntu 24.04.5 LTS, K3s `v1.36.4+k3s1`, Cilium `1.20.2`, Longhorn `1.12.1`, CloudNativePG `1.30.0`, PostgreSQL `17.4`, Metrics Server `v0.9.0`, cert-manager `v1.21.2`, Flux `v2.9.5`, Loki chart `18.7.6`, Loki `3.7.6`

## Cel sesji

1. Potwierdzić poprawny zimny start po migracji cert-managera i aktualizacji Flux.
2. Zinwentaryzować instalację Loki i zależności jej HelmRelease.
3. Przenieść chart Loki do aktualnego repozytorium `grafana-community`.
4. Zaktualizować chart etapami z `6.53.0` do `18.7.6`.
5. Zachować tryb monolityczny, zewnętrzny storage S3 i istniejący wolumen Longhorna.
6. Zabezpieczyć PVC Loki przed automatycznym usunięciem razem ze StatefulSetem.
7. Potwierdzić działanie Loki po pełnym zimnym starcie klastra.

---

## 1. Zimny start i zamknięcie poprzedniej migracji

Playbook potwierdził:

- SSH, Ansible i `sudo` na wszystkich trzech nodach;
- aktywną usługę K3s na wszystkich nodach;
- lokalne API i embedded etcd `3/3`;
- dokładnie trzy oczekiwane obiekty Node;
- wszystkie nody `Ready`;
- macierz API server → kubelet `9/9`;
- prawidłowy cykl aktywacji i dezaktywacji interfejsu WoL;
- brak konieczności wykonania resyncu remotedialera.

Poprawny zimny start pozwolił zamknąć migracje z poprzedniej sesji:

- cert-manager działa pod kontrolą Flux w wersji `v1.21.2`;
- Flux działa w wersji `v2.9.5`;
- zasoby Image Toolkit używają stabilnego API `v1`;
- nie wystąpiła regresja control plane ani remotedialera.

---

## 2. Stan Loki przed aktualizacją

Stan początkowy:

```text
HelmRelease: loki/loki
chart:       6.53.0
aplikacja:   Loki 3.6.5
tryb:        pojedynczy StatefulSet
repliki:     1
```

Instalacja wykorzystywała:

- Pod `loki-0`;
- PVC `storage-loki-0` o pojemności `10Gi`;
- StorageClass `longhorn`;
- zewnętrzny storage obiektowy Garage zgodny z S3;
- bucket `loki-logs`;
- schemat `v13` i magazyn indeksów `TSDB`;
- retencję logów `7d`;
- Alloy jako oddzielny kolektor logów.

Wyłączone pozostawały:

```text
lokiCanary
gateway
test
chunksCache
resultsCache
```

Dane dostępowe do S3 nie zostały zapisane jawnie w publicznym repozytorium. Loki pobiera je z istniejącego Secretu `loki-s3-secret`.

---

## 3. Migracja źródła chartu

Dotychczasowe źródło chartu Loki zostało zastąpione repozytorium:

```text
name: grafana-community
url:  https://grafana-community.github.io/helm-charts
```

Repozytorium `grafana` nie zostało usunięte, ponieważ nadal korzysta z niego HelmRelease Alloy.

Po zmianie manifesty zostały wyrenderowane lokalnie:

```bash
kubectl kustomize \
  infrastructure/operators/loki \
  >/tmp/loki-rendered.yaml
```

Render potwierdził:

- użycie `HelmRepository/grafana-community`;
- prawidłowe wskazanie sourceRef przez HelmRelease Loki;
- zachowanie namespace `loki`;
- brak przypadkowej zmiany źródła chartu Alloy.

Flux pobrał nowe źródło i zastosował Kustomization `infrastructure-operators` ze stanem `Ready=True`.

---

## 4. Pierwszy etap aktualizacji `6.53.0 → 6.56.0`

Najpierw wykonano aktualizację w obrębie tej samej głównej wersji chartu:

```text
chart: 6.53.0 → 6.56.0
Loki:  3.6.5  → 3.6.7
```

Po wdrożeniu:

- HelmRelease miał `Ready=True`;
- StatefulSet zakończył rollout;
- `loki-0` był `2/2 Running`;
- liczba restartów wynosiła `0`;
- wolumen Longhorna pozostał `attached` i `healthy`;
- `/ready` zwracał `ready`;
- ring zawierał instancję `loki-0` w stanie `ACTIVE` z `128` tokenami i `100%` ownership.

Podczas pierwszych sekund startu pojawiły się przejściowe komunikaty o braku rekordu DNS dla `loki-memberlist.loki.svc.cluster.local` oraz `empty ring`. Po utworzeniu gotowego EndpointSlice memberlist kolejne logi nie zawierały błędów.

---

## 5. Aktualizacja przez kolejne główne wersje chartu

Aktualizacja była wykonywana etapami, po jednej głównej wersji chartu:

| Etap | Chart | Wersja Loki |
|---:|---:|---:|
| 1 | `6.56.0` | `3.6.7` |
| 2 | `7.0.0` | `3.6.7` |
| 3 | `8.0.0` | `3.6.7` |
| 4 | `9.0.0` | `3.6.7` |
| 5 | `10.0.0` | `3.7.1` |
| 6 | `11.0.0` | `3.7.1` |
| 7 | `12.0.0` | `3.7.1` |
| 8 | `13.0.0` | `3.7.1` |
| 9 | `14.0.0` | `3.7.2` |
| 10 | `15.0.0` | `3.7.2` |
| 11 | `16.0.0` | `3.7.2` |
| 12 | `17.0.0` | `3.7.2` |
| 13 | `18.0.0` | `3.7.2` |
| 14 | `18.7.6` | `3.7.6` |

Każdy etap został:

1. sprawdzony pod kątem zmian niezgodnych w chartcie;
2. wyrenderowany lokalnie z aktualnymi wartościami;
3. zapisany jako osobna zmiana GitOps;
4. zastosowany przez Flux;
5. zakończony kontrolą HelmRelease, StatefulSetu, Poda, logów i wolumenu.

Nie wykonywano bezpośredniego `helm upgrade` ani ręcznego `kubectl apply` na zasobach zarządzanych przez Flux.

---

## 6. Obsługa zmian niezgodnych chartu

Przed każdą wersją główną porównywano chart, wartości live i wyrenderowane manifesty.

Najważniejsze ustalenia:

| Wersja chartu | Sprawdzony obszar | Wynik dla homelabu |
|---:|---|---|
| `9.0.0` | usunięcie starego self-monitoringu i Grafana Agent Operator | brak używanych wartości i renderowanych zasobów |
| `12.0.0` | nazewnictwo trybu wdrożenia | jawnie ustawiono tryb monolityczny |
| `13.0.0` | zmiany persistence dla danych efemerycznych | brak wpływu na istniejący PVC Loki |
| `14.0.0` | zmiana domyślnego registry obrazów | render wskazał poprawne obrazy `docker.io` |
| `15.0.0` | zmiany NetworkPolicy związane z Cilium | brak takich reguł w używanej konfiguracji Loki |
| `16.0.0` | zmiany szablonu Loki Canary | `lokiCanary.enabled=false` |
| `17.0.0` | deprecjacja wbudowanego MinIO | używany jest zewnętrzny Garage S3 |
| `18.0.0` | przebudowa zasobów monitoringu chartu | brak chartowych ServiceMonitor i PrometheusRule |

Konfiguracja po migracji nadal renderowała:

- jeden StatefulSet;
- jedną replikę;
- obraz Loki zgodny z wersją chartu;
- referencję do `loki-s3-secret`;
- istniejący sposób podłączenia storage;
- brak zbędnych komponentów rozproszonych.

---

## 7. Ochrona PVC przed usunięciem

Podczas kontroli chartu `18.0.0` wykryto politykę StatefulSetu:

```json
{
  "whenDeleted": "Delete",
  "whenScaled": "Delete"
}
```

Dla jedynego wolumenu Loki był to niepotrzebny poziom ryzyka. Wartości Helm rozszerzono o:

```yaml
singleBinary:
  persistence:
    enableStatefulSetAutoDeletePVC: false
```

Po wdrożeniu chartu `18.7.6` polityka miała stan:

```json
{
  "whenDeleted": "Retain",
  "whenScaled": "Retain"
}
```

Tożsamość storage nie zmieniła się:

```text
PVC:          storage-loki-0
UID:          54bdf342-b185-48d4-a829-c90c4cd93f07
PV:           pvc-54bdf342-b185-48d4-a829-c90c4cd93f07
StorageClass: longhorn
Capacity:     10Gi
Phase:        Bound
```

Zmiana chroni PVC przy usunięciu lub przeskalowaniu StatefulSetu. Nie zastępuje backupu danych Loki w zewnętrznym storage obiektowym.

---

## 8. Stan końcowy przed zimnym startem

Historia Helm zakończyła się rewizją:

```text
revision:    16
chart:       loki-18.7.6
app version: 3.7.6
status:      deployed
```

Flux potwierdził:

```text
HelmRelease: loki/loki
revision:    18.7.6
Ready:       True
```

Stan workloadu:

```text
StatefulSet readyReplicas: 1
currentRevision:           loki-65cdc76dcf
updateRevision:            loki-65cdc76dcf
Pod loki-0:                2/2 Running
restarts:                  0
image:                     docker.io/grafana/loki:3.7.6
```

Longhorn:

```text
storage-loki-0: attached, healthy
engine:         longhorn-engine:v1.12.1
```

Memberlist:

```text
EndpointSlice: ready=true, serving=true
ring:          loki-0 ACTIVE
```

API Loki:

```text
/ready:               ready
/loki/api/v1/labels:  status=success
liczba etykiet:       12
```

Zwrócone etykiety obejmowały między innymi `namespace`, `pod`, `container`, `node_name`, `job` i `service_name`.

W ostatniej minucie logów nie było nowych błędów `empty ring`, `panic`, `fatal`, `corrupt`, `failed`, `error` ani odpowiedzi HTTP `500`.

---

## 9. Monitoring Loki

Po aktualizacji nie istniały zasoby:

```text
ServiceMonitor
PrometheusRule
```

z etykietą:

```text
app.kubernetes.io/instance=loki
```

Nie jest to regresja aktualizacji. Monitoring generowany przez chart nie był włączony również przed migracją. Loki nadal przyjmował i udostępniał logi, a Alloy pozostał oddzielnym komponentem.

Dodanie monitoringu metryk Loki pozostaje osobnym zadaniem i nie zostało połączone z aktualizacją chartu.

---

## 10. Test zimnego startu po aktualizacji

Następnego dnia wykonano pełny cykl Power Off/Power On. Semaphore uruchomił:

```text
K3S | 10 Power On
task #387
```

Playbook potwierdził:

- dostępność SSH na wszystkich nodach;
- łączność Ansible i działające `sudo`;
- aktywną usługę K3s `3/3`;
- lokalne API i embedded etcd `3/3`;
- wszystkie trzy nody `Ready`;
- dokładny skład klastra;
- macierz API server → kubelet `9/9`;
- poprawny cykl interfejsu WoL;
- brak błędu remotedialera.

Oczekiwanie na adres IPv4 interfejsu WoL oraz start K3s wymagały kilku ponowień. Wszystkie kontrole zakończyły się jednak stanem `OK`; ponowienia były częścią oczekiwania na gotowość, a nie końcową awarią.

---

## 11. Loki po zimnym starcie

Po starcie klastra potwierdzono:

```text
Pod:       loki-0
Ready:     true,true
Status:    Running
Restarts:  0,0
Node:      master
Image:     docker.io/grafana/loki:3.7.6
```

Storage pozostał bez zmian:

```text
PVC:       storage-loki-0
Status:    Bound
Capacity:  10Gi
Class:     longhorn
PV:        pvc-54bdf342-b185-48d4-a829-c90c4cd93f07
Longhorn:  attached, healthy
Engine:    longhorn-engine:v1.12.1
```

EndpointSlice memberlist zawierał gotowy i obsługujący ruch endpoint:

```text
address: 10.42.0.42
ready:   true
serving: true
```

Podczas startu Loki ponownie zarejestrował przejściowy błąd:

```text
failed to resolve loki-memberlist.loki.svc.cluster.local:
no such host
```

Komunikat wystąpił zanim DNS opublikował rekord headless Service. Loki kontynuował próby dołączenia do memberlist. Po ustabilizowaniu EndpointSlice kolejna kontrola logów z ostatniej minuty zwróciła:

```text
Brak nowych błędów Loki
```

---

## 12. Stan końcowy

### K3s

- trzy nody `Ready`;
- K3s `v1.36.4+k3s1`;
- lokalne API i embedded etcd działają na wszystkich nodach;
- macierz API server → kubelet `9/9`;
- zimny start bez resyncu remotedialera.

### Loki

- HelmRelease zarządzany przez Flux;
- chart `18.7.6`;
- Loki `3.7.6`;
- jedna replika w trybie monolitycznym;
- Pod `loki-0` `2/2 Running`, bez restartów;
- ring `ACTIVE` po ustabilizowaniu DNS;
- endpointy API odpowiadają poprawnie;
- logi są dostępne;
- brak trwałych błędów po zimnym starcie.

### Storage

- PVC `storage-loki-0` nadal `Bound`;
- zachowany ten sam UID PVC i PV;
- wolumen Longhorna `attached` i `healthy`;
- silnik Longhorna `v1.12.1`;
- polityka retencji StatefulSetu `Retain/Retain`;
- zewnętrzny Garage S3 pozostaje magazynem obiektowym Loki;
- sekrety pozostają poza publicznym repozytorium.

### GitOps

- chart pobierany z `grafana-community`;
- wszystkie aktualizacje wykonane przez Flux;
- finalny HelmRelease `Ready=True`;
- repozytorium `grafana` zachowane dla Alloy;
- żadna zmiana nie wymagała ręcznego modyfikowania zasobów zarządzanych przez Flux.

---

## 13. Wnioski

1. Dużą aktualizację chartu należy dzielić na kolejne wersje główne i walidować po każdym etapie.
2. Wersja chartu i wersja aplikacji są niezależne. Chart przeszedł z `6.53.0` do `18.7.6`, a Loki z `3.6.5` do `3.7.6`.
3. Render manifestów przed zastosowaniem pozwala wykryć zmianę trybu wdrożenia, obrazów, retencji PVC i opcjonalnych komponentów.
4. Zmiana repozytorium chartu powinna być niezależna od usuwania repozytoriów używanych przez inne HelmRelease.
5. Przy pojedynczej replice Loki polityka `Delete/Delete` dla PVC stwarzała niepotrzebne ryzyko. Jawne `Retain/Retain` lepiej odpowiada charakterowi trwałych danych.
6. Tożsamość PVC i PV należy kontrolować przed i po każdym etapie aktualizacji StatefulSetu.
7. Przejściowy błąd DNS memberlist bezpośrednio po zimnym starcie nie oznacza trwałej awarii, jeśli endpoint staje się gotowy, ring przechodzi do `ACTIVE`, a kolejne logi są czyste.
8. Błędu startowego nie należy maskować restartem przed zebraniem stanu Service, EndpointSlice, ring i logów.
9. Brak ServiceMonitor i PrometheusRule nie był skutkiem aktualizacji; zasoby te nie były wcześniej generowane przez chart.
10. Dane dostępowe do Garage S3 pozostają w Kubernetes Secret i nie mogą trafić do publicznego repozytorium.


---

## 14. Następna sesja

1. Uznać migrację Loki `6.53.0 → 18.7.6` oraz aktualizację aplikacji `3.6.5 → 3.7.6` za zakończone.
2. Zinwentaryzować pozostałe HelmRelease i wybrać następny komponent na podstawie:

   ```text
   bieżąca wersja
   najnowsza wersja stabilna
   wspierane wersje Kubernetes
   zmiany niezgodne
   własność CRD
   wpływ na storage i sieć
   plan powrotu
   ```

3. Osobno rozważyć dodanie ServiceMonitor i reguł Prometheus dla Loki.
