# 17 - Progressive Delivery

# K3s Homelab — Sesja 17 (Progressive Delivery)

**Data:** 2026-03-21  
**Środowisko:** 3x HP T630, k3s v1.34.4, Flux v2.8.1

---

## Co zbudowaliśmy

Pełny pipeline progressive delivery z trzema środowiskami i różnymi triggerami deploy:

```
git tag v*  →  dev (auto)  →  staging (auto)  →  prod (PR review)
```

---

## Czego się nauczyłem

### 1. Progressive Delivery — koncepcja

Progressive delivery to strategia deploymentu gdzie nowa wersja przechodzi przez kolejne środowiska zanim dotrze do produkcji. Każde środowisko daje możliwość wykrycia błędów przed wpłynięciem na użytkowników końcowych.

```
clients-api repo
       │ git tag v1.5.4
       ▼
GitHub Actions (test → build → push Docker + Helm chart)
       │
       ▼
Flux ImagePolicy wykrywa nowy tag
       │
       ├──→ dev (clients-dev)     auto-deploy ← fluxbot commit na main
       │
       ├──→ staging (clients-staging) auto-deploy ← fluxbot commit na staging branch
       │
       └──→ prod (clients)        manual PR → merge → deploy
```

### 2. Branch-based environments

Każde środowisko ma osobne źródło Git które Flux obserwuje:

|Środowisko|Flux source|Branch|Trigger|
|:--|:--|:--|:--|
|dev|`flux-system`|main|każdy nowy tag (auto)|
|staging|`flux-system-staging`|staging|każdy nowy tag (auto)|
|prod|`flux-system`|main|PR merge (manual)|

**Kluczowe:** staging Kustomization obserwuje branch `staging`, nie `main`. Fluxbot commituje aktualizacje tagu do odpowiedniego brancha.

### 3. Osobne GitRepository dla staging

```yaml
apiVersion: source.toolkit.fluxcd.io/v1
kind: GitRepository
metadata:
  name: flux-system-staging
  namespace: flux-system
spec:
  interval: 1m
  url: ssh://git@github.com/kCn3333/k3s-homelab  # ← SSH, nie HTTPS!
  ref:
    branch: staging
  secretRef:
    name: flux-system  # ← ten sam deploy key co główny flux-system
```

**Lekcja:** URL musi być SSH (`ssh://git@github.com/...`) — deploy key w `flux-system` secret jest kluczem SSH i nie działa z HTTPS URL.

### 4. Osobne ImagePolicy per środowisko

Każde środowisko ma własną ImagePolicy żeby fluxbot wiedział do którego pliku zapisać aktualizację tagu:

```yaml
# flux-system/imagepolicy dla dev
metadata:
  name: clients-api-dev

# flux-system/imagepolicy dla staging  
metadata:
  name: clients-api-staging

# flux-system/imagepolicy dla prod (istniejąca)
metadata:
  name: clients-api
```

**Marker w HelmRelease** musi wskazywać na właściwą ImagePolicy:

```yaml
# apps/dev/helmrelease.yaml
image:
  tag: "1.5.4" # {"$imagepolicy": "flux-system:clients-api-dev:tag"}

# apps/staging/helmrelease.yaml (na branchu staging)
image:
  tag: "1.5.4" # {"$imagepolicy": "flux-system:clients-api-staging:tag"}

# apps/base/clients-api/helmrelease.yaml (prod)
image:
  tag: "1.5.3" # {"$imagepolicy": "flux-system:clients-api:tag"}
```

### 5. Osobne ImageUpdateAutomation per środowisko

```yaml
# Dev automation — commituje do main, aktualizuje ./apps/dev
apiVersion: image.toolkit.fluxcd.io/v1beta2
kind: ImageUpdateAutomation
metadata:
  name: flux-system-dev
spec:
  sourceRef:
    kind: GitRepository
    name: flux-system        # ← obserwuje main branch
  git:
    push:
      branch: main           # ← commituje na main
  update:
    path: ./apps/dev         # ← tylko dev pliki
```

```yaml
# Staging automation — commituje do staging, aktualizuje ./apps/staging
apiVersion: image.toolkit.fluxcd.io/v1beta2
kind: ImageUpdateAutomation
metadata:
  name: flux-system-staging
spec:
  sourceRef:
    kind: GitRepository
    name: flux-system-staging  # ← obserwuje staging branch
  git:
    push:
      branch: staging          # ← commituje na staging
  update:
    path: ./apps/staging       # ← tylko staging pliki
```

### 6. Flow deploy na produkcję (manual PR)

Produkcja nie ma ImageUpdateAutomation — tag jest pinned i zmienia się tylko przez PR:

```bash
# 1. Stwórz feature branch
git checkout -b release/1.5.4

# 2. Zaktualizuj tag w prod HelmRelease
sed -i 's/tag: "1.5.3"/tag: "1.5.4"/' apps/base/clients-api/helmrelease.yaml

# 3. Commit
git add apps/base/clients-api/helmrelease.yaml
git commit -m "chore(release): promote clients-api 1.5.4 to production"
git push origin release/1.5.4

# 4. Otwórz PR na GitHubie: release/1.5.4 → main
# 5. Code review + approve
# 6. Merge → Flux automatycznie deployuje na prod
```

**PR description template (profesjonalny standard):**

```
## Release 1.5.4

Promotes clients-api v1.5.4 to production.

### Verified on staging
- [x] Application starts correctly
- [x] API endpoints respond
- [x] Database connection healthy

### Changes in this release
- opis zmian
```

### 7. Synchronizacja branchy

Branch `staging` jest osobnym długożyjącym branchem. Gdy robisz zmiany infrastruktury na `main` — musisz je manualne zmergować do `staging`:

```bash
git checkout staging
git merge main
git push origin staging
git checkout main
```

**Ważne:** fluxbot pushuje na `staging` — więc przed merge musisz zrobić `git pull origin staging` żeby uniknąć konfliktu.

### 8. Struktura repo po implementacji

```
k3s-homelab/
├── apps/
│   ├── base/clients-api/    ← production manifests
│   │   ├── helmrelease.yaml  tag: "1.5.4" (po promote)
│   │   └── ...
│   ├── dev/                  ← dev environment
│   │   ├── namespace.yaml
│   │   ├── helmrelease.yaml  tag: "1.5.4" (auto-updated)
│   │   ├── imagepolicy.yaml
│   │   └── kustomization.yaml
│   └── staging/              ← staging environment (branch: staging)
│       ├── namespace.yaml
│       ├── db-cluster.yaml
│       ├── db-secret-sealed.yaml
│       ├── helmrelease.yaml  tag: "1.5.4" (auto-updated)
│       ├── imagepolicy.yaml
│       └── kustomization.yaml
└── clusters/k3s-homelab/
    ├── apps.yaml                        ← prod (main branch)
    ├── apps-dev.yaml                    ← dev (main branch)
    ├── apps-staging.yaml                ← staging (staging branch)
    ├── gitrepository-staging.yaml       ← GitRepository dla staging branch
    ├── image-update-automation.yaml     ← dev automation (main)
    └── image-update-automation-staging.yaml ← staging automation
```

### 9. Różnice konfiguracyjne między środowiskami

|Parametr|dev|staging|prod|
|:--|:--|:--|:--|
|springProfile|local|prod|prod|
|replicas|1|1|2 (HPA min)|
|baza|H2 in-memory|PostgreSQL (staging)|PostgreSQL (prod)|
|HPA|disabled|disabled|enabled (2-6)|
|PDB|disabled|disabled|enabled|
|NetworkPolicy|disabled|enabled|enabled|
|ServiceMonitor|disabled|disabled|enabled|
|CPU request|250m|250m|100m|
|CPU limit|1000m|1000m|2000m|
|livenessProbe delay|120s|120s|60s|

### 10. Problemy napotkane

**`authentication required: No anonymous write access`**

- Przyczyna: `flux-system-staging` GitRepository używał HTTPS URL
- Fix: zmień na SSH URL (`ssh://git@github.com/...`)

**`staging → main rejected (fetch first)`**

- Przyczyna: fluxbot już pushował commit na staging branch
- Fix: `git pull origin staging` przed `git push`

---

## Finalna weryfikacja

```bash
# Wszystkie ImagePolicy
kubectl get imagepolicy -n flux-system
# clients-api:         1.5.4 (prod)
# clients-api-dev:     1.5.4 (dev)  
# clients-api-staging: 1.5.4 (staging)

# Tagi w HelmRelease per środowisko
grep "tag:" apps/base/clients-api/helmrelease.yaml   # prod - manual
grep "tag:" apps/dev/helmrelease.yaml                # dev - auto (main)
git show origin/staging:apps/staging/helmrelease.yaml | grep "tag:"  # staging - auto

# Status automations
kubectl get imageupdateautomation -n flux-system
# flux-system-dev:     True  repository up-to-date
# flux-system-staging: True  repository up-to-date
```

---

## Backlog

- [ ] Hubble UI — native routing migration (planned)
- [ ] HashiCorp Vault
- [ ] External-dns
- [ ] RBAC
- [ ] helm test dodać do CI/CD pipeline (automatyczne po deploy na staging)

---

## Przydatne komendy

```bash
# Synchronizacja staging branch
git checkout staging
git pull origin staging
git merge main
git push origin staging
git checkout main

# Deploy na produkcję
git checkout -b release/X.Y.Z
sed -i 's/tag: "old"/tag: "new"/' apps/base/clients-api/helmrelease.yaml
git add apps/base/clients-api/helmrelease.yaml
git commit -m "chore(release): promote clients-api X.Y.Z to production"
git push origin release/X.Y.Z
# → otwórz PR na GitHubie

# Sprawdź status środowisk
kubectl get pods -n clients-dev
kubectl get pods -n clients-staging
kubectl get pods -n clients
kubectl get imageupdateautomation -n flux-system
kubectl get imagepolicy -n flux-system

# Test API per środowisko
curl -s -u user:user https://clients-api-dev.cluster.kcn333.com/api/clients | head -3
curl -s -u user:user https://clients-api-staging.cluster.kcn333.com/api/clients | head -3
curl -s -u user:user https://clients-api.cluster.kcn333.com/api/clients | head -3
```