# 31 - przejęcie cert-managera przez Flux i aktualizacja Flux

**Data:** 2026-09-23
**Środowisko końcowe:** 3× HP T630, Ubuntu 24.04.5 LTS, K3s `v1.36.4+k3s1`, Cilium `1.20.2`, Longhorn `1.12.1`, CloudNativePG `1.30.0`, PostgreSQL `17.4`, Metrics Server `v0.9.0`, cert-manager `v1.21.2`, Flux `v2.9.5`

## Cel sesji

1. Potwierdzić poprawny zimny start po aktualizacji Longhorna i Metrics Server.
2. Zinwentaryzować instalację cert-managera `v1.19.4`.
3. Przejąć istniejący release cert-managera pod zarządzanie Flux bez odtwarzania zasobów.
4. Zaktualizować cert-manager etapami `v1.19.4 → v1.20.4 → v1.21.2`.
5. Potwierdzić działanie issuerów, certyfikatów, webhooka i DNS po zimnym starcie.
6. Przenieść zasoby Image Toolkit z `v1beta2` do stabilnego API `v1`.
7. Zaktualizować dystrybucję Flux z `v2.8.1` do `v2.9.5`.

---

## 1. Zimny start i stan wejściowy

Playbook potwierdził:

- SSH, Ansible i `sudo` na wszystkich trzech nodach;
- aktywną usługę K3s na wszystkich nodach;
- lokalne API i embedded etcd `3/3`;
- dokładnie trzy oczekiwane obiekty Node;
- wszystkie nody `Ready`;
- macierz API server → kubelet `9/9`;
- prawidłowe włączenie i wyłączenie interfejsu WoL;
- brak konieczności wykonania resyncu remotedialera.

Po starcie klastra potwierdzono również:

- brak Podów poza fazami `Running` i `Succeeded`;
- wszystkie Kustomization Flux `Ready=True`;
- wszystkie HelmRelease `Ready=True`;
- sześć wolumenów Longhorna `attached` i `healthy`;
- wszystkie wolumeny na `longhorn-engine:v1.12.1`;
- brak uszkodzonych lub zatrzymanych replik Longhorna;
- oba klastry CloudNativePG `2/2 Ready`;
- Metrics API `Available=True`;
- działające `kubectl top nodes`.

Aktualizacje Longhorna i Metrics Server z poprzedniej sesji przeszły test zimnego startu.

---

## 2. Inwentaryzacja cert-managera

W klastrze działały trzy Deploymenty:

```text
cert-manager              v1.19.4
cert-manager-cainjector   v1.19.4
cert-manager-webhook      v1.19.4
```

Zasoby miały etykiety i adnotacje Helm:

```text
app.kubernetes.io/managed-by=Helm
meta.helm.sh/release-name=cert-manager
meta.helm.sh/release-namespace=cert-manager
```

W repozytorium GitOps nie istniały jednak manifesty `HelmRepository` ani `HelmRelease` dla cert-managera. Operator był zainstalowany przez Helm, ale nie był deklaratywnie zarządzany przez Flux.

Stan funkcjonalny przed migracją:

- CRD cert-managera istniały;
- oba `ClusterIssuer` miały `Ready=True`;
- pięć certyfikatów miało `Ready=True`;
- release Helm nazywał się `cert-manager`;
- release i workloady działały w namespace `cert-manager`.

Przejęcie musiało zachować istniejące nazwy release i namespace, aby Flux wykonał aktualizację istniejącej instalacji zamiast tworzyć drugi zestaw zasobów.

---

## 3. Dodanie cert-managera do GitOps

Dodano katalog:

```text
infrastructure/operators/cert-manager/
```

Zawiera on:

```text
namespace.yaml
helmrepository.yaml
helmrelease.yaml
kustomization.yaml
```

Główna Kustomization operatorów została rozszerzona o:

```yaml
resources:
  - cert-manager
```

HelmRelease zachował:

```yaml
metadata:
  name: cert-manager
  namespace: cert-manager
spec:
  releaseName: cert-manager
  targetNamespace: cert-manager
```

CRD są zarządzane przez chart:

```yaml
values:
  crds:
    enabled: true
```

Repozytorium zawiera tylko konfigurację i zasoby SealedSecret. Nie dodano żadnych jawnych tokenów, haseł ani innych sekretów. Backup istniejących danych konfiguracyjnych pozostał poza publicznym repozytorium.

Walidacja lokalna:

```bash
kubectl kustomize infrastructure/operators/cert-manager
kubectl kustomize infrastructure/operators >/dev/null
```

Oba polecenia zakończyły się poprawnie.

---

## 4. Przejęcie istniejącego release bez zmiany wersji

Najpierw Flux wdrożył cert-manager w tej samej wersji `v1.19.4`.

```text
HelmRelease: cert-manager/cert-manager
chart:       cert-manager v1.19.4
Ready:       True
```

Historia Helm po przejęciu:

```text
revision 1: install v1.19.4
revision 2: upgrade v1.19.4
```

Oznacza to, że Flux zaktualizował istniejący release. Nie utworzył osobnej instalacji i nie zmienił nazw zasobów.

Po przejęciu:

- wszystkie trzy Deploymenty były dostępne;
- obrazy nadal miały wersję `v1.19.4`;
- oba `ClusterIssuer` pozostały `Ready=True`;
- wszystkie certyfikaty pozostały `Ready=True`;
- nie wystąpiła ponowna emisja ani utrata certyfikatów.

---

## 5. Aktualizacja cert-managera

Aktualizację wykonano dwoma osobnymi etapami:

```text
v1.19.4 → v1.20.4
v1.20.4 → v1.21.2
```

Po każdym etapie Flux zakończył Helm upgrade ze stanem `Ready=True`.

Stan końcowy:

| Deployment | Ready | Available | Obraz |
|---|---:|---:|---|
| `cert-manager` | 1 | 1 | `quay.io/jetstack/cert-manager-controller:v1.21.2` |
| `cert-manager-cainjector` | 1 | 1 | `quay.io/jetstack/cert-manager-cainjector:v1.21.2` |
| `cert-manager-webhook` | 1 | 1 | `quay.io/jetstack/cert-manager-webhook:v1.21.2` |

Rollout wszystkich Deploymentów zakończył się poprawnie. W namespace `cert-manager` nie było Podów poza `Running` i `Succeeded`.

Zweryfikowano również reguły roli `cert-manager-edit` dla API ACME. Uprawnienia do `challenges` i `orders` nie zawierały niepotrzebnych operacji odczytu sekretów ani szerszego zakresu niż wymagany przez nową wersję.

---

## 6. Weryfikacja certyfikatów

Po aktualizacji oba issuery działały:

```text
letsencrypt-prod-cluster-issuer      Ready=True
letsencrypt-staging-cluster-issuer   Ready=True
```

Issuer staging potwierdził aktualny stan kontrolera:

```text
generation:         1
observedGeneration: 1
ready:              True
reason:             ACMEAccountRegistered
```

Certyfikaty po aktualizacji:

| Namespace | Certyfikat | Ready |
|---|---|---:|
| `default` | `local-cert-kcn333` | `True` |
| `default` | `local-prod-cert-kcn333` | `True` |
| `kube-system` | `hubble-tls` | `True` |
| `monitoring` | `grafana-tls` | `True` |
| `traefik` | `traefik-dashboard-tls` | `True` |

Powiązane `CertificateRequest` były zatwierdzone i gotowe. Nie było aktywnych obiektów `Challenge`.

---

## 7. Zachowanie cert-managera po zimnym starcie

Bezpośrednio po uruchomieniu klastra log kontrolera zawierał:

```text
dial tcp: lookup acme-staging-v02.api.letsencrypt.org on 10.43.0.10:53:
read: connection refused
```

Następnie pojawiały się komunikaty:

```text
ACME client for issuer not initialised/available
```

Przyczyna była przejściowa: cert-manager rozpoczął pracę zanim CoreDNS zaczął obsługiwać Service `kube-dns` pod adresem `10.43.0.10`.

Po ustabilizowaniu DNS potwierdzono:

- CoreDNS `1/1 Running`;
- EndpointSlice `kube-dns` z gotowym adresem;
- oba `ClusterIssuer` `Ready=True`;
- wszystkie certyfikaty `Ready=True`;
- brak nowych błędów cert-managera w kolejnej minucie logów.

Nie wykonywano restartu cert-managera ani ręcznej ingerencji w issuery. Kontroler sam ponowił operacje po odzyskaniu DNS.

---

## 8. Stan Flux przed aktualizacją

Lokalny klient:

```text
flux: v2.9.5
```

Dystrybucja w klastrze:

```text
distribution: flux-v2.8.1
```

Kontrolery przed zmianą:

| Kontroler | Wersja |
|---|---|
| `source-controller` | `v1.8.0` |
| `kustomize-controller` | `v1.8.1` |
| `helm-controller` | `v1.5.1` |
| `notification-controller` | `v1.8.1` |
| `image-reflector-controller` | `v1.1.0` |
| `image-automation-controller` | `v1.1.0` |

`flux check --pre` potwierdził zgodność Kubernetes `v1.36.4+k3s1` z wymaganiami nowej dystrybucji.

---

## 9. Migracja API Image Toolkit

Repozytorium zawierało dziesięć deklaracji używających:

```text
image.toolkit.fluxcd.io/v1beta2
```

Dotyczyło to:

- `ImageRepository`;
- `ImagePolicy`;
- `ImageUpdateAutomation`;
- zasobów na gałęziach `main` i `staging`.

CRD w klastrze już obsługiwały stabilne `v1`, a ich wersją storage było `v1`:

```text
served:        v1, v1beta2
storage:       v1
storedVersions: [v1]
```

Najpierw wykonano podgląd:

```bash
flux migrate \
  --version=2.8 \
  --path=. \
  --dry-run
```

Narzędzie wskazało wyłącznie migrację dziesięciu deklaracji z `v1beta2` do `v1`.

Po migracji gałęzi `main` próba przeniesienia tego samego commita przez `cherry-pick` na `staging` ujawniła konflikt `modify/delete` dla zasobów `k8s-badge`. Pliki istniały na `main`, ale zostały celowo usunięte na `staging`.

Nie przywracano ich na gałęzi staging. Migrację wykonano osobno na aktualnym drzewie każdej gałęzi. Końcowa kontrola:

```text
origin/main:    brak image.toolkit.fluxcd.io/v1beta2
origin/staging: brak image.toolkit.fluxcd.io/v1beta2
```

Wniosek: zmian strukturalnych pomiędzy gałęziami nie należy przenosić bezwarunkowym `cherry-pick`. Migracja uruchomiona w kontekście każdej gałęzi zachowuje jej zamierzony zestaw zasobów.

---

## 10. Migracja żywych zasobów Flux

Po zastosowaniu nowych manifestów wykonano:

```bash
flux migrate
```

Narzędzie zmigrowało działające zasoby do aktualnych wersji API:

```text
GitRepository          → v1
HelmRepository         → v1
HelmChart              → v1
HelmRelease            → v2
Kustomization          → v1
ImageRepository        → v1
ImagePolicy            → v1
ImageUpdateAutomation  → v1
```

Migracja zakończyła się komunikatem:

```text
custom resources migrated successfully
```

Po migracji wszystkie źródła, polityki obrazów, automatyzacje, HelmRelease i Kustomization pozostały `Ready=True`.

---

## 11. Punkt odzyskiwania przed aktualizacją Flux

Przed wymianą kontrolerów utworzono snapshot etcd:

```text
pre-flux-v2.9.5-master-1790156948
```
Snapshot został zapisany poprawnie.

---

## 12. Generowanie manifestu Flux `v2.9.5`

Manifest wygenerowano klientem odpowiadającym wersji docelowej:

```bash
flux install \
  --export \
  --components-extra=image-reflector-controller,image-automation-controller \
  > /tmp/gotk-components-v2.9.5.yaml
```

Zachowano dokładnie sześć dotychczasowych komponentów:

```text
source-controller
kustomize-controller
helm-controller
notification-controller
image-reflector-controller
image-automation-controller
```

Plik:

```text
clusters/k3s-homelab/flux-system/gotk-components.yaml
```

został zastąpiony pełnym wygenerowanym manifestem. Nie modyfikowano ręcznie jego CRD, RBAC ani Deploymentów.

Duży diff wynikał z wymiany całego generowanego bundla oraz zmian schematów CRD, RBAC, NetworkPolicy i argumentów kontrolerów:

```text
1347 insertions
2628 deletions
```

Zakres commita obejmował wyłącznie `gotk-components.yaml`.

---

## 13. Konflikty podczas ręcznego dry-run

Polecenie:

```bash
kubectl apply \
  --server-side \
  --dry-run=server \
  --filename /tmp/flux-v2.9.5-rendered.yaml
```

zgłosiło konflikty właścicieli pól, między innymi dla:

```text
app.kubernetes.io/version
spec.versions
obrazu kontenera manager
limitów CPU
NetworkPolicy
```

Pola były już zarządzane przez field managerów:

```text
flux
kustomize-controller
```

Nie był to błąd składni ani niezgodność API. Ręczny `kubectl` próbował zostać kolejnym właścicielem pól zarządzanych przez Flux.

Nie wykonano rzeczywistego `kubectl apply --force-conflicts`. Docelowa zmiana została wdrożona przez Kustomization Flux, czyli przez istniejącego właściciela zasobów.

---

## 14. Aktualizacja Flux `v2.8.1 → v2.9.5`

Commit aktualizacji:

```text
5dfc3e1 chore(flux): upgrade controllers to v2.9.5
```

Po push wykonano:

```bash
flux reconcile kustomization \
  flux-system \
  --namespace flux-system \
  --with-source
```

Flux pobrał i zastosował:

```text
main@sha1:5dfc3e15e7a0a867b708e47ec9d598eb801f9cb3
```

Rollout wszystkich sześciu kontrolerów zakończył się poprawnie.

Wersje końcowe:

| Kontroler | Wersja |
|---|---|
| `source-controller` | `v1.9.5` |
| `kustomize-controller` | `v1.9.5` |
| `helm-controller` | `v1.6.4` |
| `notification-controller` | `v1.9.4` |
| `image-reflector-controller` | `v1.2.5` |
| `image-automation-controller` | `v1.2.5` |

Każdy Deployment miał:

```text
READY=1
AVAILABLE=1
```

---

## 15. Walidacja końcowa Flux

`flux version` potwierdził:

```text
flux:        v2.9.5
distribution: flux-v2.9.5
```

`flux check` zakończył się:

```text
all checks passed
```

Potwierdzono:

- wszystkie kontrolery `Ready`;
- wszystkie wymagane CRD dostępne w wersjach obsługiwanych przez Flux `v2.9.5`;
- oba `GitRepository` `Ready=True`;
- wszystkie `HelmRepository` i `HelmChart` `Ready=True`;
- wszystkie `HelmRelease` `Ready=True`;
- wszystkie `Kustomization` `Ready=True`;
- trzy `ImageRepository` `Ready=True`;
- pięć `ImagePolicy` `Ready=True`;
- trzy `ImageUpdateAutomation` `Ready=True`;
- brak nieprawidłowych Podów w `flux-system`;
- brak błędów `error`, `failed`, `panic` i `fatal` w logach sześciu kontrolerów.

Kustomization korzystające z `main` zastosowały commit `5dfc3e15`. `apps-staging` prawidłowo pozostało na osobnym źródle i rewizji gałęzi `staging`.

---

## 16. Stan końcowy

### K3s

- trzy nody `Ready`;
- K3s `v1.36.4+k3s1`;
- lokalne API i embedded etcd działają na wszystkich nodach;
- macierz API server → kubelet `9/9`;
- kolejny zimny start bez błędu remotedialera.

### Storage i bazy

- Longhorn `1.12.1`;
- sześć wolumenów `attached` i `healthy`;
- wszystkie wolumeny na silniku `v1.12.1`;
- brak uszkodzonych replik;
- oba klastry CloudNativePG `2/2 Ready` i `Cluster in healthy state`.

### cert-manager

- instalacja jest deklaratywnie zarządzana przez Flux;
- chart i aplikacja `v1.21.2`;
- trzy Deploymenty dostępne;
- oba `ClusterIssuer` `Ready=True`;
- pięć certyfikatów `Ready=True`;
- brak aktywnych wyzwań ACME;
- przejściowy błąd DNS po starcie ustąpił bez ingerencji.

### Flux

- klient i dystrybucja `v2.9.5`;
- wszystkie sześć kontrolerów w docelowych wersjach;
- deklaracje Image Toolkit używają stabilnego API `v1` na `main` i `staging`;
- żywe custom resources zostały zmigrowane;
- wszystkie zasoby GitOps są `Ready=True`;
- snapshot etcd sprzed aktualizacji istnieje.

---

## 17. Wnioski

1. Istniejący release Helm można bezpiecznie przejąć przez Flux, jeśli zachowane zostaną jego nazwa, namespace i podstawowa konfiguracja.
2. Pierwsze uzgodnienie należy wykonać bez podnoszenia wersji. Oddziela to migrację sposobu zarządzania od aktualizacji oprogramowania.
3. Sekrety nie należą do publicznego repozytorium. W GitOps powinny występować wyłącznie w formie zaszyfrowanej lub jako referencje do zewnętrznego systemu.
4. Błędy ACME podczas pierwszych sekund zimnego startu mogą być skutkiem niedostępnego jeszcze DNS. O wyniku decyduje stan po ustabilizowaniu zależności i kolejne logi.
5. `Ready=True` istniejącego certyfikatu nie zastępuje kontroli issuerów, webhooka i logów kontrolera.
6. Przed aktualizacją Flux trzeba zmigrować deklaracje w repozytorium oraz działające custom resources.
7. Gałęzie o różnej strukturze należy migrować osobno; automatyczny `cherry-pick` może przywrócić zasoby celowo usunięte na jednej z nich.
8. `storedVersions: [v1]` potwierdza format przechowywany w etcd, ale repozytorium nadal może zawierać manifesty `v1beta2`.
9. Konflikt server-side apply może oznaczać konflikt field managerów, a nie wadliwy manifest.
10. Generowanego `gotk-components.yaml` nie należy poprawiać ręcznie. Powinien pochodzić z klienta Flux odpowiadającego wersji docelowej.
11. Snapshot etcd chroni stan API przed zmianą CRD i kontrolerów, lecz nie zastępuje repozytorium Git jako źródła deklaracji.

---

## 18. Następna sesja

1. Wykonać zimny start klastra po aktualizacji Flux `v2.9.5`.
2. Potwierdzić:

   ```text
   3/3 Node Ready
   API i etcd 3/3
   API server → kubelet 9/9
   flux check: all checks passed
   wszystkie Kustomization i HelmRelease: Ready=True
   wszystkie ImageRepository, ImagePolicy i ImageUpdateAutomation: Ready=True
   cert-manager: 3/3 Deployment Ready
   ClusterIssuer: 2/2 Ready
   certyfikaty: 5/5 Ready
   Longhorn: 6/6 volumes healthy
   CloudNativePG: 2/2 Ready w obu klastrach
   ```

3. Po poprawnym starcie uznać aktualizacje cert-managera i Flux za definitywnie zamknięte.
4. Następny komponent wybierać dopiero po osobnej inwentaryzacji wersji, zgodności i sposobu instalacji.
