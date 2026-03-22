# K3s Homelab — Sesja 05

**Data:** 2026-03-03  
**Środowisko:** 3x HP T630, k3s v1.34.4, Flux v2.8.1

---

## Co zbudowaliśmy

Pełna pętla GitOps z automatyczną aktualizacją obrazów:

```
GitHub repo (źródło prawdy)
       ↓ (Flux obserwuje co 1 min)
Flux porównuje stan repo ze stanem klastra
       ↓
Jeśli różnica → aplikuje zmiany
       ↑
ImagePolicy wykrywa nowszy tag → Flux commituje do repo
```

---

## Czego się nauczyłem

### 1. GitOps — filozofia

**Problem z klasycznym podejściem (`kubectl apply`):**

- Brak jednego źródła prawdy o stanie klastra
- Trudny rollback
- Brak audytu kto co zmienił i kiedy
- Chaos przy pracy zespołowej

**GitOps rozwiązuje to przez:**

- Git repo = jedyne źródło prawdy
- Agent w klastrze (Flux) sam ciągnie zmiany (pull model)
- Każda zmiana = commit = historia = możliwość rollbacku przez `git revert`

**Pull vs Push model:**

- Push (klasyczne CI/CD): pipeline pcha zmiany do klastra — wymaga dostępu do klastra z zewnątrz
- Pull (GitOps): agent wewnątrz klastra sam pobiera zmiany — bezpieczniejsze, klaster nie musi być dostępny z zewnątrz

---

### 2. Flux — komponenty

**Instalacja:**

```bash
# Sprawdź wymagania
flux check --pre

# Bootstrap z GitHubem
flux bootstrap github \
  --owner=<user> \
  --repository=<repo> \
  --private=false \
  --personal=true \
  --path=clusters/<nazwa-klastra> \
  --components-extra=image-reflector-controller,image-automation-controller \
  --read-write-key
```

**Cztery podstawowe kontrolery:**

- `source-controller` — obserwuje GitHub, pobiera repo co 1 min
- `kustomize-controller` — aplikuje manifesty YAML
- `helm-controller` — obsługuje Helm releases
- `notification-controller` — wysyła powiadomienia (Slack, webhook)

**Dwa dodatkowe dla Image Automation:**

- `image-reflector-controller` — skanuje registry w poszukiwaniu nowych tagów
- `image-automation-controller` — commituje zaktualizowane tagi do repo

**Nie są instalowane domyślnie** — trzeba dodać `--components-extra`.

---

### 3. Struktura repo GitOps

```
k3s-homelab/                          ← root repo
├── apps/
│   └── base/
│       ├── kustomization.yaml        ← lista aplikacji
│       └── nginx/
│           ├── kustomization.yaml    ← pliki dla nginx
│           ├── namespace.yaml
│           ├── nginx-deploy.yaml
│           ├── imagerepository.yaml
│           └── imagepolicy.yaml
└── clusters/
    └── k3s-homelab/
        ├── apps.yaml                 ← Flux Kustomization → ./apps/base
        └── flux-system/
            ├── gotk-components.yaml
            ├── gotk-sync.yaml
            └── kustomization.yaml
```

**Kluczowe rozróżnienie:**

- `clusters/<nazwa>/` — **co** deployujemy na ten klaster (wskaźniki)
- `apps/base/` — **jak** wygląda aplikacja (rzeczywiste manifesty)

**Dlaczego taka separacja:** jedna aplikacja może działać na wielu klastrach. Manifesty aplikacji są niezależne od klastra.

---

### 4. Dwa rodzaje Kustomization

```yaml
# kustomize.config.k8s.io — natywny Kustomize, składa pliki YAML
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - nginx

# kustomize.toolkit.fluxcd.io — CRD Fluxa, mówi Fluxowi co deployować
apiVersion: kustomize.toolkit.fluxcd.io/v1
kind: Kustomization
metadata:
  name: apps
  namespace: flux-system
spec:
  interval: 1m0s
  path: ./apps/base
  prune: true
  sourceRef:
    kind: GitRepository
    name: flux-system
```

**`prune: true`** — Flux usuwa zasoby które zniknęły z repo. Jeśli usuniesz plik, Flux usunie też odpowiadający zasób w klastrze.

---

### 5. Image Automation — pełna pętla

Trzy zasoby potrzebne do automatycznej aktualizacji tagów:

**ImageRepository** — obserwuje registry:

```yaml
apiVersion: image.toolkit.fluxcd.io/v1beta2
kind: ImageRepository
metadata:
  name: nginx
  namespace: flux-system
spec:
  image: nginx
  interval: 1m0s
```

**ImagePolicy** — wybiera tag według reguły:

```yaml
apiVersion: image.toolkit.fluxcd.io/v1beta2
kind: ImagePolicy
metadata:
  name: nginx
  namespace: flux-system
spec:
  imageRepositoryRef:
    name: nginx
  policy:
    semver:
      range: 1.29.x
```

**ImageUpdateAutomation** — commituje zmiany tagów do repo:

```yaml
apiVersion: image.toolkit.fluxcd.io/v1beta2
kind: ImageUpdateAutomation
metadata:
  name: flux-system
  namespace: flux-system
spec:
  interval: 1m0s
  sourceRef:
    kind: GitRepository
    name: flux-system
  git:
    checkout:
      ref:
        branch: main
    commit:
      author:
        email: fluxbot@kcn333.com
        name: fluxbot
      messageTemplate: 'chore(flux): update image tags'
    push:
      branch: main
  update:
    path: ./apps
    strategy: Setters
```

**Marker w deployment.yaml** — mówi Fluxowi gdzie zmieniać tag:

```yaml
image: nginx:1.29.5 # {"$imagepolicy": "flux-system:nginx"}
```

---

### 6. Deploy key — uprawnienia do zapisu

Flux używa SSH deploy key do komunikacji z repo (nie PAT token). Domyślny bootstrap tworzy klucz **read-only**.

Do Image Automation potrzebny jest klucz **read/write** — flaga `--read-write-key` w bootstrap.

**Jeśli klucz jest read-only:**

1. Usuń stary klucz na GitHubie (Settings → Deploy keys → Delete)
2. Pobierz nowy klucz z klastra: `kubectl get secret flux-system -n flux-system -o jsonpath='{.data.identity\.pub}' | base64 -d`
3. Dodaj na GitHubie z **Allow write access**

---

### 7. Flux i konflikty Git

Flux commituje do repo automatycznie. Gdy jednocześnie Ty pushуjesz zmiany, może wystąpić konflikt.

**Rozwiązanie — rebase:**

```bash
git config pull.rebase true  # ustaw globalnie raz
git pull
git push
```

Rebase zachowuje czystą historię commitów — lepszy niż merge w repo zarządzanym przez automaty.

---

### 8. Conventional Commits

Standard commit messages używany w branży:

```
<typ>(<scope>): <opis>
```

Typy:

- `feat` — nowa funkcjonalność
- `fix` — naprawa błędu
- `chore` — maintenance, konfiguracja
- `docs` — dokumentacja
- `refactor` — refactoring
- `test` — testy

Przykłady:

```
feat(flux): add ImageRepository to monitor nginx image tags
chore(flux): update image tags
test(flux): downgrade nginx tag to verify ImageUpdateAutomation
```

Wiele narzędzi (generatory changelogów, semantic versioning) opiera się na tej konwencji.

---

### 9. Flux vs ArgoCD

| Cecha | Flux | ArgoCD |
| :--- | :--- | :--- |
| **UI** | brak (CLI) | bogaty dashboard |
| **Model** | pull, CLI-first | pull, UI-first |
| **Architektura** | mikrousługi | monolityczny |
| **Popularność** | cloud-native | enterprise |

**W chmurze:**

- Azure GitOps — oparty na Flux
- GCP Config Sync — oparty na Flux
- AWS — często Flux lub ArgoCD

Znajomość Flux = znajomość fundamentów dla wszystkich platform.

---

### 10. Progressive Delivery — architektura środowisk

```
apps/
├── base/          ← bazowe manifesty
├── staging/       ← nadpisania dla staging (auto-deploy z main)
└── production/    ← nadpisania dla prod (wymaga PR + review)
```

Kontrola przez branche:

- `staging` Kustomization → obserwuje branch `main` → push = auto-deploy
- `production` Kustomization → obserwuje branch `production` → zmiana tylko przez PR

---

## Backlog (do zrobienia)

- [ ] **Własna aplikacja (Python/Java) + CI/CD pipeline z GitHub Actions** ← następny krok
- [ ] Helm charts dla własnych aplikacji
- [ ] Progressive delivery (staging/production branches)
- [ ] External-dns — automatyczne wpisy DNS z Ingress
- [ ] HashiCorp Vault w kontenerze — zarządzanie sekretami
- [ ] Sealed Secrets / External Secrets Operator
- [ ] ArgoCD — porównanie z Flux
- [ ] Traefik dashboard z BasicAuth
- [ ] PersistentVolume / PersistentVolumeClaim
- [ ] RBAC — własni użytkownicy
- [ ] NetworkPolicy dla izolacji między aplikacjami

---

## Przydatne komendy

```bash
# Flux status
flux get all -n flux-system
flux get kustomizations
flux get sources git -n flux-system
flux get images repository -n flux-system
flux get images policy -n flux-system
flux get images update -n flux-system

# Flux reconciliation (wymuś synchronizację)
flux reconcile kustomization apps
flux reconcile image update flux-system
flux reconcile source git flux-system

# Bootstrap
flux bootstrap github \
  --owner=<user> \
  --repository=<repo> \
  --path=clusters/<klaster> \
  --components-extra=image-reflector-controller,image-automation-controller \
  --read-write-key

# Git
git config pull.rebase true
git log --oneline -5
```

