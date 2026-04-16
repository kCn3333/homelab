# Applications

## clients-api — Demo Application

**[clients-api](https://github.com/kCn3333/clients-api)** is a Spring Boot REST API backed by PostgreSQL (CloudNativePG). Created to demonstrate the full production workflow: containerized build, automated CI/CD, Helm chart packaging, GitOps delivery, monitoring integration, and progressive delivery across environments.

---

## CI/CD Pipeline (GitHub Actions)

### Overview

```
Developer: git tag v1.5.0 && git push origin v1.5.0
                   │
                   ▼
GitHub Actions: mvn test → docker build → docker push → helm chart push
                   │
                   ▼
DockerHub: kcn333/clients-api:1.5.0, :1.5, :sha-XXXX, :latest
GHCR:      ghcr.io/kcn3333/charts/clients-api:1.5.0
                   │
                   ▼
Flux ImagePolicy detects new tag (polls every 1 min)
                   │
                   ▼
Flux ImageUpdateAutomation commits to Git → rolling deploy
```

### Semver tagging strategy

```yaml
# .github/workflows/ci.yml
tags: |
  type=semver,pattern={{version}}            # v1.5.0 → 1.5.0
  type=semver,pattern={{major}}.{{minor}}    # v1.5.0 → 1.5
  type=sha,prefix=sha-,format=short          # sha-XXXXXXX (every push)
  type=raw,value=latest,enable={{is_default_branch}}
```

### Critical: the `if` condition on the build job

```yaml
# WRONG — job is skipped when github.ref = refs/tags/v1.5.0
if: github.ref == 'refs/heads/main'

# CORRECT — build on tags too
if: github.ref == 'refs/heads/main' || startsWith(github.ref, 'refs/tags/v')
```

When you push a tag, `github.ref` is `refs/tags/v1.5.0` — not `refs/heads/main`. A job with only the `main` condition is entirely skipped, so the semver Docker tags are never created.

### Helm chart publication job

Runs only on version tags:

```yaml
publish-chart:
  needs: build-and-push
  if: startsWith(github.ref, 'refs/tags/v')

  steps:
    - name: Extract version from tag
      id: version
      run: echo "VERSION=${GITHUB_REF_NAME#v}" >> $GITHUB_OUTPUT

    - name: Update chart version in Chart.yaml
      run: |
        sed -i "s/^version:.*/version: ${{ steps.version.outputs.VERSION }}/" helm/clients-api/Chart.yaml
        sed -i "s/^appVersion:.*/appVersion: \"${{ steps.version.outputs.VERSION }}\"/" helm/clients-api/Chart.yaml

    - name: Package and push chart to GHCR
      run: |
        helm package helm/clients-api
        helm push clients-api-${{ steps.version.outputs.VERSION }}.tgz \
          oci://ghcr.io/kcn3333/charts
```

The `Chart.yaml` in the repo is a placeholder — CI dynamically writes `version` and `appVersion` before packaging. Don't manually bump the version before tagging.

### Semver convention

```
v1.0.0  — major: breaking changes
v1.1.0  — minor: new feature, backwards compatible
v1.1.1  — patch: bugfix
```

---

## Spring Boot Deployment

### Key environment variables

```yaml
env:
  - name: SPRING_PROFILES_ACTIVE
    value: "prod"        # activates application-prod.properties
  - name: SPRING_DATASOURCE_URL
    value: "jdbc:postgresql://clients-db-rw:5432/clients_db"
  - name: SPRING_DATASOURCE_USERNAME
    valueFrom:
      secretKeyRef:
        name: clients-db-secret
        key: username
  - name: SPRING_DATASOURCE_PASSWORD
    valueFrom:
      secretKeyRef:
        name: clients-db-secret
        key: password
```

### Verifying the correct profile is active

Check the logs:
```bash
kubectl logs -n clients deploy/clients-api | grep -E "profile|HikariPool|Exposing"

# Wrong profile (default, H2 in-memory):
# "url=jdbc:h2:mem:..."
# "Exposing 1 endpoint beneath base path '/actuator'"

# Correct profile (prod, PostgreSQL):
# 'The following 1 profile is active: "prod"'
# "HikariPool-1 - Added connection org.postgresql.jdbc.PgConnection..."
# "Exposing 4 endpoints beneath base path '/actuator'"
```

### Readiness and Liveness Probes

JVM takes a while to warm up (~90-120 seconds). Without proper probe delays, k8s considers the pod ready before it actually is and sends traffic to a cold JVM.

```yaml
readinessProbe:
  httpGet:
    path: /actuator/health/readiness   # Spring Boot dedicated endpoint
    port: 8080
  initialDelaySeconds: 30
  periodSeconds: 10
  failureThreshold: 5

livenessProbe:
  httpGet:
    path: /actuator/health/liveness
    port: 8080
  initialDelaySeconds: 60            # always > readiness initialDelay
  periodSeconds: 15
  failureThreshold: 3
```

`readinessProbe fail` → k8s stops sending traffic (pod stays Running)
`livenessProbe fail` → k8s restarts the pod

### Resource limits — JVM needs headroom

JVM under load (GC, compilation) needs room to spike. A too-tight CPU limit causes throttling, not crashing:

```yaml
resources:
  requests:
    cpu: 100m      # scheduler reservation
    memory: 256Mi
  limits:
    cpu: 2000m     # JVM can burst to 2 cores during GC — throttling at 500m was causing 502s
    memory: 512Mi
```

**How to detect CPU throttling:**
```bash
kubectl top pods -n clients
# clients-api-xxx   499m/500m  ← near-100% of limit = throttling
```

### HPA (Horizontal Pod Autoscaler)

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: clients-api
  namespace: clients
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: clients-api
  minReplicas: 2
  maxReplicas: 6
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 70   # % of requests (not limits!)
  behavior:
    scaleUp:
      stabilizationWindowSeconds: 0
      policies:
        - type: Pods
          value: 2
          periodSeconds: 30
    scaleDown:
      stabilizationWindowSeconds: 300
      policies:
        - type: Pods
          value: 1
          periodSeconds: 120
```

**Critical: remove `replicas` from Deployment when using HPA**

```yaml
# WRONG — Flux overwrites HPA-managed replicas every minute
spec:
  replicas: 2    # delete this line!

# CORRECT — HPA is the sole owner of replica count
spec:
  # no replicas field
  selector:
    matchLabels:
      app: clients-api
```

How HPA calculates: `averageUtilization: 70` + `requests.cpu: 100m` = scale up when pod uses >70m CPU.

### Pod Disruption Budget

Protects availability during node maintenance (`kubectl drain`):

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: clients-api-pdb
  namespace: clients
spec:
  minAvailable: 1
  selector:
    matchLabels:
      app: clients-api
```

Verify:
```bash
kubectl get pdb -n clients
# NAME              MIN AVAILABLE   ALLOWED DISRUPTIONS
# clients-api-pdb   1               1     ← safe to drain 1 node with 2 pods running
```

### ServiceMonitor — Prometheus integration

Three conditions for a working ServiceMonitor:

**1. Label on the Service `metadata` (not just spec.selector):**
```yaml
metadata:
  name: clients-api
  labels:
    app: clients-api    # required for Prometheus relabeling
```

**2. Named port in Service:**
```yaml
ports:
  - name: http          # required — ServiceMonitor references by name
    port: 80
    targetPort: 8080
```

**3. `release: kube-prometheus-stack` label on ServiceMonitor:**
```yaml
metadata:
  labels:
    release: kube-prometheus-stack   # must match serviceMonitorSelector
```

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: clients-api
  namespace: clients
  labels:
    release: kube-prometheus-stack
spec:
  selector:
    matchLabels:
      app: clients-api
  endpoints:
    - port: http
      path: /actuator/prometheus
      interval: 30s
```

**Debugging a `DROPPED` target in Prometheus:**

A target in DROPPED state without an error message means it was discovered but filtered out by relabeling rules. Most common cause: missing `app: clients-api` label in `metadata.labels` on the Service (not in `spec.selector`).

```bash
kubectl port-forward -n monitoring svc/kube-prometheus-stack-prometheus 9090:9090 &
# Go to http://localhost:9090/targets and check for "dropped" targets
```

### Useful PromQL for Spring Boot

```promql
# Request rate (req/s)
sum(rate(http_server_requests_seconds_count{application="clients-api"}[5m]))

# Error rate (%)
sum(rate(http_server_requests_seconds_count{application="clients-api",status=~"5.."}[5m]))
  or vector(0)
/
sum(rate(http_server_requests_seconds_count{application="clients-api"}[5m]))
* 100

# p99 latency (ms)
histogram_quantile(0.99,
  sum by(le) (
    rate(http_server_requests_seconds_bucket{
      application="clients-api",
      uri="/api/clients"
    }[5m])
  )
) * 1000

# Active DB connections
hikaricp_connections_active{application="clients-api"}
```

For percentiles to work, histograms must be enabled in `application-prod.properties`:
```properties
management.metrics.distribution.percentiles-histogram.http.server.requests=true
```

---

## Helm Chart

### Structure

```
helm/clients-api/
├── Chart.yaml          # metadata: name, version, appVersion
├── values.yaml         # all configurable defaults
├── .helmignore
└── templates/
    ├── _helpers.tpl    # reusable fragments (like functions)
    ├── NOTES.txt       # displayed after install
    ├── deployment.yaml
    ├── service.yaml
    ├── ingress.yaml
    ├── hpa.yaml
    ├── pdb.yaml
    ├── servicemonitor.yaml
    ├── networkpolicy.yaml
    └── tests/
        └── test-connection.yaml
```

### Chart.yaml

```yaml
apiVersion: v2
name: clients-api
description: Spring Boot REST API for client management
type: application
version: 0.1.0        # chart version (changes with template/values changes)
appVersion: "1.4.0"   # application version (informational)
```

`version` — bump when you change templates or values.  
`appVersion` — bump when you release a new app version. In CI, both are set dynamically from the git tag.

### values.yaml key sections

```yaml
image:
  repository: kcn333/clients-api
  tag: ""           # empty = use appVersion from Chart.yaml

springProfile: prod

database:
  host: clients-db-rw
  port: 5432
  name: clients_db
  credentialsSecret: clients-db-secret  # k8s Secret name

service:
  type: ClusterIP
  port: 80
  targetPort: 8080
  name: http          # named port — required by ServiceMonitor

autoscaling:
  enabled: true
  minReplicas: 2
  maxReplicas: 6
  targetCPUUtilizationPercentage: 70

pdb:
  enabled: true
  minAvailable: 1

networkPolicy:
  enabled: true

serviceMonitor:
  enabled: true
  namespace: monitoring
```

### Go template essentials

| Syntax | Meaning |
|--------|---------|
| `{{ .Values.image.repository }}` | Value from values.yaml |
| `{{ .Chart.AppVersion }}` | Value from Chart.yaml |
| `{{ .Release.Namespace }}` | Namespace being installed into |
| `{{ include "clients-api.fullname" . }}` | Call a helper from _helpers.tpl |
| `{{- if .Values.ingress.enabled }}` | Conditional rendering |
| `{{- toYaml .Values.resources \| nindent 12 }}` | Convert object to YAML with indent |
| `{{ .Values.image.tag \| default .Chart.AppVersion }}` | Value with fallback |

Never hardcode resource names — always use the fullname helper:
```yaml
name: {{ include "clients-api.fullname" . }}
```

### Conditional env vars (dev vs prod)

Dev uses H2 (no DB credentials needed), prod/staging uses PostgreSQL:

```yaml
{{- if .Values.database.credentialsSecret }}
- name: SPRING_DATASOURCE_URL
  value: "jdbc:postgresql://{{ .Values.database.host }}:{{ .Values.database.port }}/{{ .Values.database.name }}"
- name: SPRING_DATASOURCE_USERNAME
  valueFrom:
    secretKeyRef:
      name: {{ .Values.database.credentialsSecret }}
      key: username
{{- end }}
```

In dev values: `database.credentialsSecret: ""` → condition is false, env vars not rendered.

### Helm test

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

```bash
helm test clients-api -n clients --logs
```

**Note:** test pod has no `resources.requests` → HPA logs a `FailedGetResourceMetric` warning. This resolves itself when the test pod is deleted after success.

### OCI Helm Registry (GHCR)

Flux can pull charts from OCI registries instead of Git:

```yaml
# HelmRepository for OCI
apiVersion: source.toolkit.fluxcd.io/v1
kind: HelmRepository
metadata:
  name: clients-api
  namespace: flux-system
spec:
  type: oci           # required!
  interval: 1m
  url: oci://ghcr.io/kcn3333/charts
```

```yaml
# HelmRelease referencing OCI
spec:
  chart:
    spec:
      chart: clients-api
      version: ">=1.0.0"
      sourceRef:
        kind: HelmRepository
        name: clients-api
        namespace: flux-system
```

**GHCR package must be public** for Flux to pull without authentication. Set visibility in: GitHub → Packages → clients-api → Package settings → Change visibility.

### reconcileStrategy

| Strategy | When Flux fetches chart |
|----------|------------------------|
| `ChartVersion` (default) | Only when `version` in Chart.yaml changes |
| `Revision` | On every new Git commit |

For GitRepository-based charts during active development, `Revision` is more convenient. For OCI, `ChartVersion` works naturally since each push creates a new version.

---

## Progressive Delivery

### Three-environment architecture

```
clients-dev       — Spring profile: local (H2 in-memory)
clients-staging   — Spring profile: prod (PostgreSQL, separate DB)
clients           — Spring profile: prod (PostgreSQL, production DB)
```

### Deploy triggers per environment

| Environment | Source | Branch | Trigger |
|-------------|--------|--------|---------|
| dev | `flux-system` | main | New tag (auto via ImageUpdateAutomation) |
| staging | `flux-system-staging` | staging | New tag (auto via ImageUpdateAutomation) |
| prod | `flux-system` | main | PR merge (manual) |

### GitRepository for staging branch

```yaml
apiVersion: source.toolkit.fluxcd.io/v1
kind: GitRepository
metadata:
  name: flux-system-staging
  namespace: flux-system
spec:
  interval: 1m
  url: ssh://git@github.com/kCn3333/k3s-homelab   # SSH — deploy key auth
  ref:
    branch: staging
  secretRef:
    name: flux-system    # reuse the same deploy key
```

URL must be SSH (`ssh://git@github.com/...`), not HTTPS. The `flux-system` Secret contains an SSH key, not a token.

### ImagePolicy per environment

Each environment has its own ImagePolicy so fluxbot knows which file to update:

```yaml
# dev
metadata:
  name: clients-api-dev

# staging
metadata:
  name: clients-api-staging

# prod (existing)
metadata:
  name: clients-api
```

### Marker comments in HelmRelease

```yaml
# apps/dev/helmrelease.yaml
image:
  tag: "1.5.4" # {"$imagepolicy": "flux-system:clients-api-dev:tag"}

# apps/staging/helmrelease.yaml (on staging branch)
image:
  tag: "1.5.4" # {"$imagepolicy": "flux-system:clients-api-staging:tag"}

# apps/base/clients-api/helmrelease.yaml (prod)
image:
  tag: "1.5.3" # {"$imagepolicy": "flux-system:clients-api:tag"}
```

### ImageUpdateAutomation per environment

```yaml
# Dev — commits to main, updates ./apps/dev
metadata:
  name: flux-system-dev
spec:
  sourceRef:
    name: flux-system         # main branch
  git:
    push:
      branch: main
  update:
    path: ./apps/dev

# Staging — commits to staging, updates ./apps/staging
metadata:
  name: flux-system-staging
spec:
  sourceRef:
    name: flux-system-staging  # staging branch
  git:
    push:
      branch: staging
  update:
    path: ./apps/staging
```

### Promoting to production (manual PR flow)

```bash
# 1. Create a release branch
git checkout -b release/1.5.4

# 2. Update the image tag in prod HelmRelease
sed -i 's/tag: "1.5.3"/tag: "1.5.4"/' apps/base/clients-api/helmrelease.yaml

# 3. Commit
git add apps/base/clients-api/helmrelease.yaml
git commit -m "chore(release): promote clients-api 1.5.4 to production"
git push origin release/1.5.4

# 4. Open PR: release/1.5.4 → main on GitHub
# 5. Review, approve, merge
# 6. Flux picks up the change and deploys
```

### Keeping staging branch in sync

`staging` is a long-lived branch. Infrastructure changes made on `main` need to be merged into `staging` periodically:

```bash
git checkout staging
git pull origin staging  # important — fluxbot pushes here
git merge main
git push origin staging
git checkout main
```

### Differences between environments

| Parameter | dev | staging | prod |
|-----------|-----|---------|------|
| Spring profile | local (H2) | prod (PG) | prod (PG) |
| Replicas | 1 | 1 | 2 (HPA min) |
| HPA | disabled | disabled | enabled (2-6) |
| PDB | disabled | disabled | enabled |
| NetworkPolicy | disabled | enabled | enabled |
| ServiceMonitor | disabled | disabled | enabled |
| CPU limit | 1000m | 1000m | 2000m |

### Common issues

**`authentication required: No anonymous write access`**

The `flux-system-staging` GitRepository was using an HTTPS URL. Deploy keys are SSH-only — change to `ssh://git@github.com/...`.

**`staging → main rejected (fetch first)`**

fluxbot already pushed a commit to the staging branch. Do `git pull origin staging` before merging.

---

## Repository Structure

**clients-api repo:**
```
clients-api/
├── src/
├── Dockerfile
├── .github/workflows/ci.yml
└── helm/
    └── clients-api/
        ├── Chart.yaml      (placeholder — CI sets version/appVersion)
        ├── values.yaml     (production defaults)
        └── templates/
```

**k3s-homelab repo:**
```
apps/
├── base/clients-api/    production
├── dev/                 dev environment
└── staging/             staging environment (on staging branch)

clusters/k3s-homelab/
├── apps.yaml                             → apps/base (prod, main branch)
├── apps-dev.yaml                         → apps/dev (dev, main branch)
├── apps-staging.yaml                     → apps/staging (staging, staging branch)
├── gitrepository-staging.yaml            → staging branch GitRepository
├── image-update-automation.yaml          → dev automation
└── image-update-automation-staging.yaml  → staging automation
```

---

## Useful Commands

```bash
# Git tagging
git tag v1.5.0 && git push origin v1.5.0

# Helm
helm lint helm/clients-api
helm template clients-api helm/clients-api | grep "^kind:\|^  name:"
helm install clients-api helm/clients-api -n clients --dry-run
helm test clients-api -n clients --logs
helm history clients-api -n clients
helm get values clients-api -n clients
helm diff upgrade clients-api helm/clients-api -n clients  # requires helm-diff plugin

# Flux environments
kubectl get pods -n clients-dev
kubectl get pods -n clients-staging
kubectl get pods -n clients
flux reconcile kustomization apps-dev --with-source
flux reconcile kustomization apps-staging --with-source

# API testing
curl -s -u user:user https://clients-api-dev.cluster.kcn333.com/api/clients
curl -s -u user:user https://clients-api-staging.cluster.kcn333.com/api/clients
curl -s -u user:user https://clients-api.cluster.kcn333.com/api/clients

# HPA status
watch -n 5 kubectl get hpa,pods -n clients

# Load testing
hey -n 1000 -c 20 -H 'Authorization: Basic dXNlcjp1c2Vy' https://HOST/PATH
```
