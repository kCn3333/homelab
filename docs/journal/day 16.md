# 16 - OCI

# K3s Homelab — Sesja 16 (OCI Helm Chart + Progressive Delivery Setup)

**Data:** 2026-03-03  
**Środowisko:** 3x HP T630, k3s v1.34.4, Flux v2.8.1, Helm v3.14.0

---

### Cel sesji:

1. **Publikowanie Helm chart jako OCI image na GHCR** — automatycznie przy każdym tagu
2. **Flux pobiera chart z OCI registry** zamiast z GitRepository
3. **helm test** — automatyczny test po każdym deploy
4. **values-staging.yaml** — osobne wartości dla środowiska staging
5. **Środowisko dev** — H2 in-memory, deploy przy każdym tagu
6. **Środowisko staging** — PostgreSQL, osobna baza, deploy przy każdym tagu
7. **Poprawka NetworkPolicy** — dozwolony ruch intra-namespace dla helm test

---
### 1. OCI Helm Registry — jak to działa

**OCI (Open Container Initiative)** — ten sam standard co obrazy Docker, używany do przechowywania Helm chartów. GHCR (GitHub Container Registry) obsługuje OCI.

```
helm package helm/clients-api          # tworzy clients-api-1.5.0.tgz
helm push clients-api-1.5.0.tgz \
  oci://ghcr.io/kcn3333/charts         # pushuje jako OCI image
```

**Adres charta:** `ghcr.io/kcn3333/charts/clients-api:1.5.0`

Zalety OCI vs GitRepository:

- Chart jest wersjonowany niezależnie od kodu aplikacji
- Można dystrybuować między organizacjami bez dostępu do repo
- Flux pobiera konkretną wersję — deterministyczne deploy

### 2. GitHub Actions — job publish-chart

dodany nowy job który uruchamia się **tylko na tagach** (`v*`):

```yaml
publish-chart:
  name: Publish Helm Chart to GHCR
  runs-on: ubuntu-latest
  needs: build-and-push
  if: startsWith(github.ref, 'refs/tags/v')

  steps:
    - name: Extract version from tag
      id: version
      run: echo "VERSION=${GITHUB_REF_NAME#v}" >> $GITHUB_OUTPUT

    - name: Update chart version and appVersion
      run: |
        sed -i "s/^version:.*/version: ${{ steps.version.outputs.VERSION }}/" helm/clients-api/Chart.yaml
        sed -i "s/^appVersion:.*/appVersion: \"${{ steps.version.outputs.VERSION }}\"/" helm/clients-api/Chart.yaml

    - name: Package and push chart
      run: |
        helm package helm/clients-api
        helm push clients-api-${{ steps.version.outputs.VERSION }}.tgz \
          oci://${{ env.CHART_REGISTRY }}
```

**Wniosek:** CI dynamicznie nadpisuje `version` i `appVersion` w `Chart.yaml`. Lokalny plik to placeholder — nie zmieniaj go ręcznie przed tagowaniem.

**Wersjonowanie:** tag `v1.5.0` → chart `1.5.0` + Docker image `1.5.0`. Jedna wersja dla obu.

### 3. Flux HelmRepository dla OCI

```yaml
apiVersion: source.toolkit.fluxcd.io/v1
kind: HelmRepository
metadata:
  name: clients-api
  namespace: flux-system
spec:
  type: oci          # ← kluczowe!
  interval: 1m
  url: oci://ghcr.io/kcn3333/charts
```

**Ważne:** `apiVersion: v1` (nie `v1beta2`). Sprawdź przed użyciem:

```bash
kubectl get crd helmrepositories.source.toolkit.fluxcd.io \
  -o jsonpath='{.spec.versions[*].name}'
```

**GHCR visibility:** Package musi być **publiczny** żeby Flux mógł go pobrać bez secretu. Ustaw w: `github.com/users/kcn3333/packages/container/charts%2Fclients-api/settings`

### 4. HelmRelease z OCI

```yaml
chart:
  spec:
    chart: clients-api
    version: ">=1.0.0"      # ← semver range
    sourceRef:
      kind: HelmRepository
      name: clients-api
      namespace: flux-system
    interval: 1m
```

**`reconcileStrategy`** — domyślnie `ChartVersion` (update tylko gdy zmieni się wersja). Dla GitRepository używałem `Revision`. Dla OCI nie jest potrzebne — każdy nowy tag = nowa wersja.

### 5. helm test

Testy które uruchamiają się po `helm install/upgrade`:

```yaml
# templates/tests/test-connection.yaml
apiVersion: v1
kind: Pod
metadata:
  name: "{{ include "clients-api.fullname" . }}-test"
  annotations:
    "helm.sh/hook": test
    "helm.sh/hook-delete-policy": before-hook-creation,hook-succeeded
spec:
  restartPolicy: Never
  containers:
    - name: test
      image: curlimages/curl:8.5.0
      command:
        - sh
        - -c
        - |
          curl -sf http://{{ include "clients-api.fullname" . }}.{{ .Release.Namespace }}.svc.cluster.local/actuator/health/readiness
          curl -sf -u user:user http://{{ include "clients-api.fullname" . }}.{{ .Release.Namespace }}.svc.cluster.local/api/clients
```

**Uruchomienie:**

```bash
helm test clients-api -n clients --logs
```

**Ważne annotacje:**

- `helm.sh/hook: test` — uruchom jako test hook
- `helm.sh/hook-delete-policy: before-hook-creation,hook-succeeded` — usuń pod po sukcesie

**Problem z HPA i test podem:** Test pod nie ma `resources.requests` → HPA nie może liczyć metryk → `FailedGetResourceMetric`. Rozwiązuje się samo gdy test pod zostaje usunięty po sukcesie.

### 6. NetworkPolicy — intra-namespace traffic

Test pod jest w tym samym namespace co aplikacja ale NetworkPolicy blokował mu ruch. Fix — dodaj `podSelector: {}`:

```yaml
ingress:
  - from:
      - namespaceSelector:
          matchLabels:
            kubernetes.io/metadata.name: kube-system
      - namespaceSelector:
          matchLabels:
            kubernetes.io/metadata.name: monitoring
      - podSelector: {}    # ← wszystkie pody z tego samego namespace
```

`podSelector: {}` = pusty selector = wszystkie pody w namespace gdzie jest NetworkPolicy.

### 7. Warunkowe env vars w Deployment template

Dev używa H2 (nie potrzebuje credentiali DB), prod/staging używa PostgreSQL. Rozwiązanie przez warunek w template:

```yaml
{{- if .Values.database.credentialsSecret }}
- name: SPRING_DATASOURCE_URL
  value: "jdbc:postgresql://..."
- name: SPRING_DATASOURCE_USERNAME
  valueFrom:
    secretKeyRef:
      name: {{ .Values.database.credentialsSecret }}
      key: username
{{- end }}
```

W `values.yaml` dla dev:

```yaml
database:
  credentialsSecret: ""    # pusty = warunek false = nie montuj secretu
```

### 8. Trzy środowiska — architektura

```
clients-dev     ← profil local (H2 in-memory)
clients-staging ← profil prod (PostgreSQL osobna baza)
clients         ← profil prod (PostgreSQL produkcyjna baza)
```

**Flux Kustomizations:**

```
clusters/k3s-homelab/
├── apps.yaml           → apps/base    (production)
├── apps-dev.yaml       → apps/dev     (dev)
└── apps-staging.yaml   → apps/staging (staging)
```

**Każde środowisko ma własny HelmRelease** z odpowiednimi values override.

### 9. Staging baza danych

Staging ma osobną bazę PostgreSQL przez CloudNativePG:

```yaml
# apps/staging/db-cluster.yaml
apiVersion: postgresql.cnpg.io/v1
kind: Cluster
metadata:
  name: clients-db-staging
  namespace: clients-staging
spec:
  bootstrap:
    initdb:
      database: clients_db_staging
      owner: clients_user
      secret:
        name: clients-db-secret   # SealedSecret w namespace clients-staging
```

**Ważne:** Serwis CloudNativePG ma nazwę `{cluster-name}-rw`, więc dla stagingu: `clients-db-staging-rw`.

### 10. JVM warmup — probe tuning dla dev/staging

JVM potrzebuje więcej czasu na start przy ograniczonych zasobach -> zwiększ `initialDelaySeconds`:

```yaml
livenessProbe:
  initialDelaySeconds: 120   # domyślnie 60 — za mało dla dev/staging
  failureThreshold: 5        # domyślnie 3
readinessProbe:
  initialDelaySeconds: 90    # domyślnie 30
  failureThreshold: 5
resources:
  requests:
    cpu: 250m    # 50m to za mało dla JVM — minimum 200-250m
  limits:
    cpu: 1000m
```

---

## Progressive Delivery

**Aktualny stan:**

Wszystkie 3 środowiska aktualizują się przy każdym nowym tagu — nie ma różnicy w triggerze.

**właściwy flow:**

```
dev    → każdy commit na main  → ImagePolicy: semver
staging → każdy tag v*         → Flux obserwuje branch staging
prod    → PR merge do main      → tag pinned, zmiana przez PR
```

**Implementacja wymaga:**

1. Branch `staging` w k3s-homelab repo
2. Flux Kustomization dla staging obserwuje branch `staging`
3. Osobna ImagePolicy dla staging i prod
4. Deploy na staging = merge PR do brancha `staging` w k3s-homelab
5. Deploy na prod = merge PR do brancha `main` w k3s-homelab

---

## Struktura repo

**clients-api repo:**

```
clients-api/
├── helm/
│   └── clients-api/
│       ├── Chart.yaml         (placeholder, CI nadpisuje version/appVersion)
│       ├── values.yaml        (production defaults)
│       ├── values-staging.yaml (staging overrides — dokumentacja)
│       └── templates/
│           ├── deployment.yaml  (warunkowe DB env vars)
│           ├── networkpolicy.yaml (intra-namespace traffic)
│           └── tests/
│               └── test-connection.yaml
```

**k3s-homelab repo:**

```
apps/
├── base/clients-api/     (production)
│   ├── _raw-manifests/   (archiwum starych manifestów)
│   ├── helmrepository.yaml
│   ├── helmrelease.yaml
│   └── ...
├── dev/                  (dev environment)
│   ├── namespace.yaml
│   ├── helmrelease.yaml
│   └── kustomization.yaml
└── staging/              (staging environment)
    ├── namespace.yaml
    ├── db-cluster.yaml
    ├── db-secret-sealed.yaml
    ├── helmrelease.yaml
    └── kustomization.yaml

clusters/k3s-homelab/
├── apps.yaml             (production kustomization)
├── apps-dev.yaml         (dev kustomization)
└── apps-staging.yaml     (staging kustomization)
```

---

## Backlog

- [ ] **Progressive delivery** — osobne branche staging/main dla k3s-homelab, różne triggery ← następna sesja
- [ ] Hubble UI — native routing migration
- [ ] HashiCorp Vault
- [ ] External-dns
- [ ] RBAC

---

## Przydatne komendy

```bash
# Helm OCI
helm push clients-api-1.5.0.tgz oci://ghcr.io/kcn3333/charts
helm show chart oci://ghcr.io/kcn3333/charts/clients-api --version 1.5.0
helm pull oci://ghcr.io/kcn3333/charts/clients-api --version 1.5.0

# Helm test
helm test clients-api -n clients --logs
helm test clients-api -n clients  # bez logów

# Flux
kubectl get helmrepository -n flux-system
kubectl get kustomization -n flux-system
flux reconcile kustomization apps-dev --with-source
flux reconcile kustomization apps-staging --with-source

# Środowiska
kubectl get pods -n clients-dev
kubectl get pods -n clients-staging
kubectl get pods -n clients
curl -s -u user:user https://clients-api-dev.cluster.kcn333.com/api/clients
curl -s -u user:user https://clients-api-staging.cluster.kcn333.com/api/clients
curl -s -u user:user https://clients-api.cluster.kcn333.com/api/clients
```