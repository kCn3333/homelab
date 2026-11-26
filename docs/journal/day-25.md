# 25 - aktualizacja metrics-server i Sealed Secrets

**Data:** 2026-09-14

**Środowisko:** 3× HP T630, k3s `v1.34.4+k3s1`, Cilium `1.19.7`, Flux `v2.8.1`, metrics-server `0.7.2 → 0.8.1`, Sealed Secrets `0.36.1 → 0.40.0`

## Cel sesji

1. Sprawdzić stan klastra po uruchomieniu.
2. Naprawić stan HelmRelease i zaktualizować metrics-server.
3. Zabezpieczyć prywatne klucze Sealed Secrets poza klastrem.
4. Zaktualizować chart i klienta Sealed Secrets.
5. Rozwiązać niestabilne działanie `kubeseal --fetch-cert` i `--validate`.
6. Potwierdzić pełną zbieżność Flux.

## Stan po uruchomieniu

Wszystkie trzy nody osiągnęły `Ready`, podstawowe workloady systemowe działały,
a API `metrics.k8s.io` oraz `kubectl top nodes` zwracały dane. Kontroler Sealed
Secrets miał jeden gotowy replikat, a wszystkie dziewięć zasobów raportowało
`Synced=True`.

| Komponent | Wersja początkowa |
|---|---|
| k3s | `v1.34.4+k3s1` |
| Cilium | `1.19.7` |
| Flux | `v2.8.1` |
| metrics-server | chart `3.12.2`, aplikacja `0.7.2` |
| Sealed Secrets | chart `2.18.4`, controller `0.36.1` |

## Naprawa i aktualizacja metrics-server

Warstwa danych działała: Deployment miał `1/1` gotowych replik, APIService
`v1beta1.metrics.k8s.io` raportował `Available=True`, a `kubectl top` zwracał
metryki nodów i Podów. Niespójny był stan zarządzania przez Flux: HelmRelease miał
`Ready=Unknown` i `Stalled=True` po wcześniejszych timeoutach upgrade'u.

Najpierw uodporniono HelmRelease na wolny start klastra:

```yaml
timeout: 10m
install:
  remediation:
    retries: 3
upgrade:
  remediation:
    retries: 3
```

Commit:

```text
ab621e3 fix(metrics-server): tolerate slow cluster startup
```

Po wyzerowaniu nieudanych prób Flux mógł ponownie uzgodnić release. Następnie
sprawdzono render docelowego chartu z bieżącymi wartościami. Zachowane zostały
`hostNetwork`, port `4443`, mapowanie Service `443 → 4443`, połączenia do kubeletów
na `10250`, obecne argumenty TLS oraz rozdzielczość metryk `15s`.

Chart zaktualizowano z `3.12.2` do `3.13.1`, a obraz aplikacji z `0.7.2` do
`0.8.1`:

```text
66be7dc chore(metrics-server): upgrade chart to 3.13.1
```

Po rolloutcie HelmRelease osiągnął `Ready=True`, APIService pozostał dostępny,
`kubectl top nodes` i `kubectl top pods -A` działały, a logi nowego Poda nie
zawierały błędów.

## Materiał odzyskiwania

Znaleziony wcześniej `pub-sealed-secrets.pem` zawierał tylko certyfikat publiczny.
Pozwala szyfrować nowe manifesty, ale nie odszyfruje istniejących danych i nie odtworzy
kontrolera po utracie etcd.

W `flux-system` były cztery aktywne pary kluczy:

| Secret | Utworzony |
|---|---|
| `sealed-secrets-keyhngd2` | 2026-03-04 |
| `sealed-secrets-key54lcm` | 2026-07-06 |
| `sealed-secrets-keyznnbp` | 2026-08-13 |
| `sealed-secrets-keynzwnt` | 2026-09-12 |

Starsze klucze pozostają potrzebne, ponieważ manifesty z różnych okresów mogły być
szyfrowane różnymi certyfikatami. Aktualny fingerprint SHA-256 zaczynał się od
`F3:30:60:71` i odpowiadał kluczowi z 12 września. Przegląd wcześniejszego journala
nie wykazał żadnego eksportu prywatnych kluczy.

## Zaszyfrowany backup

Cztery Secrety pobrano przez API, ograniczono do danych potrzebnych do odtworzenia i
przekazano strumieniowo do symetrycznego GPG AES-256. Jawny JSON nie został zapisany
na dysku. Plik wynikowy i checksum miały prawa `600`.

Strumieniowe odszyfrowanie potwierdziło dokument `List`, cztery zasoby typu
`kubernetes.io/tls` oraz pola `tls.crt` i `tls.key` w każdym z nich. Przenośny
plik SHA-256 przeszedł `sha256sum --check`. Zaszyfrowany backup i checksumę
skopiowano na dysk zewnętrzny poza klastrem i stacją roboczą.

Backup trzeba odświeżać po każdej rotacji tworzącej nowy
`sealed-secrets-key*`.

## Aktualizacja

Porównanie chartów `2.18.4` i `2.20.0` wykazało zmianę aplikacji
`0.36.1 → 0.40.0` oraz dodatkowe zabezpieczenia kontenera, między innymi
`seccompProfile: RuntimeDefault` i `allowPrivilegeEscalation: false`.

W repo Flux zmieniono wyłącznie wersję chartu. Commit:

```text
7486a1c chore(sealed-secrets): upgrade chart to 2.20.0
```

Flux wdrożył release `sealed-secrets-controller.v3`. Pod z obrazem `0.40.0`
załadował wszystkie cztery klucze, miał zero restartów, a dziewięć SealedSecrets
pozostało zsynchronizowanych. Klient `kubeseal` zaktualizowano do `0.40.0` po
sprawdzeniu checksumy oficjalnego archiwum.

## Objaw i diagnostyka

Po aktualizacji `kubeseal --fetch-cert` okresowo zwracał:

```text
proxy error from 127.0.0.1:6443 while dialing 10.42.0.201:8080,
code 502: 502 Bad Gateway
```

Pierwsza walidacja repo dała trzy sukcesy i sześć błędów transportowych. Service i
EndpointSlice były gotowe. Node z Podem kontrolera uzyskiwał HTTP 200, natomiast
pozostałe dwa nody miały timeout.

Cilium działał poprawnie w VXLAN, wszystkie agenty raportowały `OK`, a
`cilium-health` potwierdzał 3/3 osiągalnych nodów i endpointów. Hubble wskazał
właściwą granicę awarii:

```text
remote-node -> sealed-secrets-controller:8080 Policy denied DROPPED
```

## Przyczyna

`kubeseal` łączy się przez HAProxy, który wybiera jeden z trzech API serverów.
API server proxyuje żądanie do Poda kontrolera. Gdy działa na innym nodzie niż Pod,
Cilium widzi źródło jako `remote-node`, a istniejące polityki Flux dopuszczały na
port 8080 Pody, lecz nie nody.

Aktualizacja nie uszkodziła VXLAN ani kluczy. Rollout przeniósł Pod i ujawnił
istniejącą lukę, której wcześniejszy wynik zależał od backendu wybranego przez HAProxy.

## Poprawka

Dodano wąską `CiliumNetworkPolicy` dla `remote-node` do kontrolera na
`8080/TCP` i dołączono ją do Kustomization operatora. Commit:

```text
c086537 fix(sealed-secrets): allow API server proxy traffic
```

Reguła nie otwiera dostępu z LAN ani Internetu. Wybiera jeden workload, jeden port i
wyłącznie tożsamość nodów klastra.

## Walidacja końcowa

- polityka: `Valid=True`;
- trzy próby HTTP z każdego noda: `200`;
- sześć kolejnych `--fetch-cert`: identyczny fingerprint;
- wszystkie dziewięć plików `*-sealed.yaml`: walidacja `OK`;
- brak nowych dropów Hubble do kontrolera;
- wszystkie Kustomizations Flux: `Ready=True`.

## Stan końcowy

- metrics-server: chart `3.13.1`, aplikacja `0.8.1`, HelmRelease `Ready=True`;
- Metrics API, `kubectl top nodes` i `kubectl top pods -A`: działają;
- chart Sealed Secrets: `2.20.0`;
- controller i klient: `0.40.0`;
- cztery aktywne klucze: załadowane i objęte zaszyfrowanym backupem;
- dziewięć manifestów: poprawnych;
- API proxy: stabilne z każdego noda;
- Flux: zbieżny;
- backup i checksum: na dysku zewnętrznym.
