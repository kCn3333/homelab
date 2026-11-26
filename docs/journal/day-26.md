# 26 - migracja Promtail do Alloy

**Data:** 2026-09-15

**Środowisko:** 3× HP T630, k3s `v1.34.4+k3s1`, Cilium `1.19.7`, Flux `v2.8.1`, Loki `3.6`, Promtail `3.5.1`, Alloy `1.19.2`

## Cel sesji

1. Zdiagnozować błąd API server → kubelet po zimnym starcie klastra.
2. Sprawdzić bezrestartową metodę resynchronizacji tuneli K3s.
3. Zinwentaryzować obecną konfigurację Promtaila.
4. Wdrożyć Alloy jako docelowy kolektor logów.
5. Uruchomić Alloy najpierw w trybie shadow, a następnie równolegle z Promtailem.
6. Potwierdzić odczyt lokalnych plików i zapis nowych logów do Loki.
7. Zachować Promtail do testu po następnym zimnym starcie.

## Stan po uruchomieniu

Wszystkie trzy nody osiągnęły `Ready`, ale jedna z dziewięciu ścieżek API server →
kubelet nie działała:

```text
worker1 API → worker2 kubelet: 502 Bad Gateway
```

`EndpointSlice/default/kubernetes` zawierał gotowe adresy wszystkich trzech nodów.
Sam poprawny EndpointSlice nie gwarantuje jednak, że lokalny serwer remotedialera na
każdym nodzie ma aktywne sesje do wszystkich kubeletów.

Każdy API server potrzebuje własnej działającej ścieżki do każdego kubeleta. Tunelu
nie należy traktować jako jednej wspólnej, symetrycznej sesji dla całego klastra.

## Resynchronizacja remotedialera

Użyto skryptu `~/k3s/remotedialer-resync.sh`, który dodaje, a następnie usuwa
techniczną adnotację z EndpointSlice usługi `kubernetes`:

```bash
#!/usr/bin/env bash

set -euo pipefail

annotation="diagnostics.kcn333.com/remotedialer-resync"

echo "Wymuszam ponowną synchronizację tuneli K3s..."

kubectl annotate endpointslice kubernetes \
  --namespace default \
  "${annotation}=$(date -u +%s)" \
  --overwrite

sleep 5

kubectl annotate endpointslice kubernetes \
  --namespace default \
  "${annotation}-"

echo "Zdarzenie EndpointSlice wysłane."
```

Zmiana obiektu wywołała ponowne przetworzenie EndpointSlice bez restartowania K3s.
Po wykonaniu skryptu macierz połączeń dała wynik:

```text
API server → kubelet matrix: 9/9 OK
```

Skrypt jest potwierdzoną metodą naprawczą. Nie znamy jeszcze przyczyny, dla której
brakująca sesja nie została odtworzona automatycznie podczas uruchamiania klastra.
Przy kolejnym wystąpieniu błędu należy najpierw zachować macierz i logi bieżącego
bootu, a dopiero później uruchomić resynchronizację.

## Stan Promtaila

```text
chart:     6.17.1
aplikacja: 3.5.1
DaemonSet: 3 desired / 3 ready / 3 available
```

Jeden Pod Promtaila działał na każdym nodzie i wysyłał logi do:

```text
http://loki.loki.svc.cluster.local:3100/loki/api/v1/push
```

W logach z ostatnich 30 minut nie było błędów, timeoutów, odpowiedzi `429` ani
informacji o odrzuconych wpisach. Liczniki restartów Podów odpowiadały uruchomieniu
klastra, a nie awarii Promtaila.

Promtail zapisywał pozycje w:

```text
/run/promtail/positions.yaml
```

`/run` jest `tmpfs`. Plik przeżywa restart Poda, ponieważ jest zamontowany z noda,
ale znika po restarcie noda. Utrata pozycji nie uszkadza bazy Loki. Może natomiast
spowodować ponowne wysłanie części logów albo ich pominięcie.

Logi kontenerów miały właściciela `root:root`. Katalog `/var/log/pods` miał prawa
`750`, a pliki przeważnie `640`. Promtail działał jako UID i GID `0`, dlatego mógł
je odczytywać.

## Wybór Alloy

Promtail jest wycofywany, dlatego wybrano Grafana Alloy:

```text
chart:     1.12.1
aplikacja: 1.19.2
controller: DaemonSet
```

Każdy Pod Alloy ma czytać wyłącznie logi lokalnego noda. Discovery zostało
ograniczone selektorem:

```alloy
selectors {
  role  = "pod"
  field = "spec.nodeName=" + sys.env("K8S_NODE_NAME")
}
```

Jeden współdzielony plik pozycji nie byłby poprawny. Każdy node ma inne lokalne
pliki `/var/log/pods`, a równoczesny zapis wielu instancji do jednego pliku mógłby
uszkodzić jego spójność.

## Prawa dostępu Alloy

Główny kontener działa z następującymi ograniczeniami:

```yaml
allowPrivilegeEscalation: false
readOnlyRootFilesystem: true
runAsNonRoot: true
runAsUser: 65534
runAsGroup: 0
seccompProfile:
  type: RuntimeDefault
capabilities:
  drop:
    - ALL
```

GID `0` pozwala korzystać z praw grupy `root`, co jest potrzebne do odczytu plików
`640` i przechodzenia przez katalog `/var/log/pods` z prawami `750`. Nie jest to
równoważne działaniu z UID `0`: proces nie jest właścicielem plików i nie ma
capabilities roota.

Stan Alloy jest przechowywany osobno na każdym nodzie:

```text
/var/lib/alloy
```

Init container tworzy właściwe prawa do katalogu, używając jedynie capabilities
`CHOWN` i `FOWNER`, po czym kończy działanie. Jego status `Completed` oznacza
prawidłowo zakończoną inicjalizację, a nie błąd Poda.

## Wdrożenie etapowe

Istotne rewizje:

| Rewizja | Zmiana |
|---|---|
| `167bb4b` | dodanie HelmRelease Alloy i DaemonSetu |
| `d33cf466` | uruchomienie pipeline'u w trybie shadow |
| `395743a` | naprawa przekazywania znalezionych plików do źródła Loki |
| `2bdc935` | włączenie zapisu do Loki i etykiety `collector="alloy"` |

Tryb shadow odczytywał pliki i przesuwał pozycje, ale nie wysyłał danych do Loki.
Promtail cały czas pozostawał aktywny, dlatego nie powstała przerwa w zbieraniu
logów. Ustawienie `tail_from_end = true` zapobiegło ponownemu wysłaniu całej historii.

## Błąd źródła plikowego

Pody Alloy były `Ready`, ale Alloy początkowo nie czytał aktywnych logów. W logach
pojawiały się błędy `stat` dla ścieżek zawierających nierozwinięty znak `*`.

Przyczyna: komponent `local.file_match` był skonfigurowany, lecz jego wynik nie był
używany. `loki.source.file` otrzymywał bezpośrednio cele z `discovery.relabel`.

Poprawne połączenie:

```alloy
local.file_match "pod_logs" {
  path_targets = discovery.relabel.pod_logs.output
  sync_period  = "10s"
}

loki.source.file "pod_logs" {
  targets       = local.file_match.pod_logs.targets
  forward_to    = [loki.process.pod_logs.receiver]
  tail_from_end = true
}
```

Po poprawce liczba aktywnie obserwowanych plików wynosiła:

| Node | Pliki |
|---|---:|
| `master` | 73 |
| `worker1` | 65 |
| `worker2` | 82 |

Rosły liczniki odczytanych linii i bajtów. Pliki pozycji były niepuste, miały prawa
`600` i właściciela `nobody:root`.

## Test odtworzenia Poda

Na `worker1` usunięto Pod `alloy-9z92z`. DaemonSet utworzył `alloy-kssgr`, który
osiągnął `Ready` z zerową liczbą restartów. Nie wystąpiły błędy dostępu do plików.

Plik pozycji przed i po odtworzeniu:

```text
przed: inode=169848 size=3540
po:    inode=169849 size=20251
```

Zmiana inode jest zgodna z atomowym zapisem pliku. Test potwierdził dostęp nowego
Poda do trwałego katalogu hostPath. Nie potwierdził jeszcze zachowania po restarcie
noda ani tego, że każdy offset został odtworzony bez utraty lub duplikacji wpisów.

Do pełnego testu potrzebne są jednocześnie plik pozycji i odpowiadający mu plik logu,
ponieważ sam offset bez źródłowego pliku nie pozwala wznowić odczytu.

## Włączenie zapisu do Loki

Do strumieni Alloy dodano etykietę:

```text
collector="alloy"
```

Następnie `loki.process` połączono z `loki.write` kierującym dane do obecnego
Service Loki. Promtail pozostał aktywny, więc od tego momentu oba kolektory wysyłają
logi równolegle.

Próbka metryk po uruchomieniu zapisu:

| Node | Wpisy | Bajty | Odpowiedzi HTTP 204 |
|---|---:|---:|---:|
| `master` | 171 | 34 926 | 32 |
| `worker1` | 261 | 39 265 | 45 |
| `worker2` | 288 | 42 231 | 29 |
| **Razem** | **720** | **116 422** | **106** |

```text
retries=0
dropped=0
```

HTTP `204` potwierdza przyjęcie batcha przez Loki, ale nie dowodzi jeszcze, że wpisy
mają poprawny format i zestaw etykiet. Osobne zapytanie LogQL zwróciło świeże
strumienie `collector="alloy"` ze wszystkich trzech nodów oraz oczekiwane etykiety:
`namespace`, `pod`, `container`, `job`, `node_name`, `stream` i `collector`.

## Stan końcowy

```text
Promtail: 3 desired / 3 ready / 3 available
Alloy:    3 desired / 3 ready / 3 available
```

Alloy poprawnie wykrywa lokalne pliki, aktualizuje pozycje i wysyła nowe wpisy do
Loki. Promtail nadal działa jako bezpieczna ścieżka podstawowa. Czasowe duplikaty są
akceptowalne; ważniejsze jest uniknięcie luki w dostarczaniu logów.

Migracja nie została jeszcze uznana za zakończoną. Stan przejściowy pozostaje tylko
w journalu i nie jest wprowadzany do dokumentacji bieżącego stanu klastra.

## Następna sesja

Po zimnym starcie należy:

1. sprawdzić macierz API server → kubelet przed użyciem skryptu naprawczego;
2. w razie błędu zachować logi remotedialera z bieżącego bootu;
3. potwierdzić `3/3 Ready` dla Promtaila i Alloy;
4. sprawdzić pliki pozycji Alloy oraz odpowiadające im pliki źródłowe;
5. potwierdzić wzrost liczników odczytu i zapisu;
6. znaleźć świeże strumienie `{collector="alloy"}` ze wszystkich trzech nodów;
7. sprawdzić brak retry, odrzuconych batchy i dropped entries;
8. dopiero po zaliczeniu testu usunąć Promtail z GitOps;
9. zaktualizować README i dokumentację obserwowalności dopiero po zakończeniu migracji.
