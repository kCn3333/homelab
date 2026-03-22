# 15 - Helm Chart

# K3s Homelab — Sesja 15 (Helm Chart dla clients-api)

**Data:** 2026-03-19  
**Środowisko:** 3x HP T630, k3s v1.34.4, Flux v2.8.1, Helm v3.14.0

---

## Co zbudowaliśmy

Własny Helm chart dla aplikacji clients-api w repozytorium aplikacji (opcja mono-repo), podłączony do klastra przez Flux GitOps.

---

## Czego się nauczyłem

### 1. Struktura Helm chart

Helm chart to paczka szablonów YAML + konfiguracja. Generujemy szkielet:

```bash
helm create helm/clients-api
```

Struktura plików:

```
helm/clients-api/
├── Chart.yaml          ← metadane charta (nazwa, wersja, appVersion)
├── values.yaml         ← domyślne wartości konfiguracyjne
├── .helmignore         ← co ignorować przy pakowaniu
└── templates/
    ├── _helpers.tpl    ← reużywalne fragmenty (jak funkcje)
    ├── NOTES.txt       ← tekst wyświetlany po instalacji
    ├── deployment.yaml
    ├── service.yaml
    ├── ingress.yaml
    ├── hpa.yaml
    ├── pdb.yaml            ← dodane ręcznie
    ├── servicemonitor.yaml ← dodane ręcznie
    └── networkpolicy.yaml  ← dodane ręcznie
```

### 2. Chart.yaml — metadane

```yaml
apiVersion: v2
name: clients-api
description: Spring Boot REST API for client management
type: application
version: 0.1.0      # ← wersja charta (templates + values)
appVersion: "1.4.0" # ← wersja aplikacji (informacyjne)
```

**Kluczowe rozróżnienie:**

- `version` — zmienia się gdy modyfikujesz templates lub values
- `appVersion` — zmienia się gdy wypuszczasz nową wersję aplikacji

**Konwencja wersjonowania charta:**

```
0.1.x  → bugfixy (zła nazwa secretu, port)
0.x.0  → nowe features (nowy zasób, nowy parametr w values)
x.0.0  → breaking changes (zmiana struktury values)
```

### 3. values.yaml — serce charta

Wszystko co może się różnić między środowiskami trafia do `values.yaml`. Grupujemy logicznie:

```yaml
# Liczba replik — nadpisywana przez HPA
replicaCount: 2

image:
  repository: kcn333/clients-api
  pullPolicy: IfNotPresent
  tag: ""  # pusty = użyj appVersion z Chart.yaml

# Spring Boot profile
springProfile: prod

# Konfiguracja bazy danych
database:
  host: clients-db-rw
  port: 5432
  name: clients_db
  credentialsSecret: clients-db-secret  # nazwa Kubernetes Secret

service:
  type: ClusterIP
  port: 80
  targetPort: 8080
  name: http  # named port — wymagany przez ServiceMonitor

ingress:
  enabled: true
  className: traefik
  host: clients-api.cluster.kcn333.com
  tlsSecret: local-prod-kcn333-tls

resources:
  requests:
    cpu: 100m
    memory: 256Mi
  limits:
    cpu: 2000m
    memory: 512Mi

livenessProbe:
  httpGet:
    path: /actuator/health/liveness
    port: 8080
  initialDelaySeconds: 60
  periodSeconds: 10
  failureThreshold: 3

readinessProbe:
  httpGet:
    path: /actuator/health/readiness
    port: 8080
  initialDelaySeconds: 30
  periodSeconds: 10
  failureThreshold: 3

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

### 4. Go templates — składnia

Helm używa Go templates do generowania YAML:

|Składnia|Znaczenie|
|:--|:--|
|`{{ .Values.image.repository }}`|Wartość z values.yaml|
|`{{ .Chart.AppVersion }}`|Wartość z Chart.yaml|
|`{{ .Release.Namespace }}`|Namespace w którym instalujemy|
|`{{ .Release.Name }}`|Nazwa release (helm install **clients-api** ...)|
|`{{ include "clients-api.fullname" . }}`|Wywołanie helpera z _helpers.tpl|
|`{{- if .Values.ingress.enabled }}`|Warunkowe renderowanie|
|`{{- toYaml .Values.resources \| nindent 12 }}`|Konwersja obiektu na YAML z wcięciem|
|`{{ .Values.image.tag \| default .Chart.AppVersion }}`|Wartość z fallbackiem|

**Ważna zasada:** nigdy nie wpisuj nazwy zasobu na twardo — zawsze przez helper:

```yaml
name: {{ include "clients-api.fullname" . }}
```

### 5. deployment.yaml — kluczowe elementy

```yaml
containers:
  - name: {{ .Chart.Name }}
    image: "{{ .Values.image.repository }}:{{ .Values.image.tag | default .Chart.AppVersion }}"
    env:
      - name: SPRING_PROFILES_ACTIVE
        value: {{ .Values.springProfile | quote }}
      - name: SPRING_DATASOURCE_URL
        value: "jdbc:postgresql://{{ .Values.database.host }}:{{ .Values.database.port }}/{{ .Values.database.name }}"
      - name: SPRING_DATASOURCE_USERNAME
        valueFrom:
          secretKeyRef:
            name: {{ .Values.database.credentialsSecret }}
            key: username
      - name: SPRING_DATASOURCE_PASSWORD
        valueFrom:
          secretKeyRef:
            name: {{ .Values.database.credentialsSecret }}
            key: password
    livenessProbe:
      {{- toYaml .Values.livenessProbe | nindent 12 }}
    readinessProbe:
      {{- toYaml .Values.readinessProbe | nindent 12 }}
    resources:
      {{- toYaml .Values.resources | nindent 12 }}
```

### 6. Walidacja charta

```bash
# Sprawdź poprawność składni
helm lint helm/clients-api

# Wygeneruj YAML bez instalacji
helm template clients-api helm/clients-api

# Sprawdź jakie zasoby zostaną utworzone
helm template clients-api helm/clients-api | grep "^kind:\|^  name:"

# Dry-run z klastra (walidacja przez API server)
helm install clients-api helm/clients-api -n clients --dry-run
```

### 7. Podłączenie do Flux — GitRepository + HelmRelease

W k3s-homelab repo:

**GitRepository** — mówi Fluxowi skąd pobrać chart:

```yaml
apiVersion: source.toolkit.fluxcd.io/v1
kind: GitRepository
metadata:
  name: clients-api
  namespace: flux-system
spec:
  interval: 1m
  url: https://github.com/kCn3333/clients-api
  ref:
    branch: main
```

**HelmRelease** — mówi Fluxowi jak zainstalować chart:

```yaml
apiVersion: helm.toolkit.fluxcd.io/v2
kind: HelmRelease
metadata:
  name: clients-api
  namespace: clients
spec:
  interval: 5m
  chart:
    spec:
      chart: helm/clients-api
      reconcileStrategy: Revision  # ← re-fetch przy każdym nowym commicie
      sourceRef:
        kind: GitRepository
        name: clients-api
        namespace: flux-system
      interval: 1m
  install:
    remediation:
      retries: 3
  upgrade:
    remediation:
      retries: 3
  values:
    image:
      tag: "1.4.0" # {"$imagepolicy": "flux-system:clients-api:tag"}
```

**Marker dla image automation** — `# {"$imagepolicy": "flux-system:clients-api:tag"}` mówi Fluxowi żeby automatycznie aktualizował tag gdy pojawi się nowy image.

### 8. reconcileStrategy — krytyczna lekcja

Domyślna strategia to `ChartVersion` — Flux pobiera nowy chart **tylko gdy zmieni się `version`** w Chart.yaml.

`Revision` — Flux pobiera chart **przy każdym nowym commicie** do repo.

Dla developmentu `Revision` jest wygodniejsze. W produkcji `ChartVersion` daje lepszą kontrolę.

### 9. Błędy które napotkaliśmy i jak je naprawić

**`reconcileStrategy: ChartVersion` blokuje update:**

```bash
# Bump version w Chart.yaml
sed -i 's/version: 0.1.0/version: 0.1.1/' helm/clients-api/Chart.yaml
```

**`terminal error: exceeded maximum retries`:**

```bash
flux suspend helmrelease clients-api -n clients
flux resume helmrelease clients-api -n clients
```

**Helm ma zepsutą historię releasów:**

```bash
helm uninstall clients-api -n clients
flux reconcile helmrelease clients-api -n clients
```

**Stary HelmChart artifact w Flux:**

```bash
flux reconcile source git clients-api -n flux-system
kubectl annotate helmrelease clients-api -n clients \
  reconcile.fluxcd.io/requestedAt="$(date +%s)" --overwrite
```

### 10. Gdzie trzymać chart — mono-repo vs osobne repo

|Opcja|Opis|Kiedy|
|:--|:--|:--|
|Mono-repo (Opcja A)|Chart w repo aplikacji (`helm/clients-api/`)|Mały zespół, jeden właściciel serwisu|
|Osobne repo (Opcja B)|Dedykowane repo dla chartów|Duża platforma, centralny DevOps team|
|OCI Registry|Chart jako image (`ghcr.io/org/charts/app:1.0`)|Dystrybucja między organizacjami|

Wybraliśmy Opcję A — chart i aplikacja wersjonowane razem.

**Opcja B (OCI) — jak to wygląda:**

```bash
helm package helm/clients-api
helm push clients-api-0.1.0.tgz oci://ghcr.io/kcn333/charts
```

W HelmRelease:

```yaml
chart:
  spec:
    chart: clients-api
    version: "0.1.*"
    sourceRef:
      kind: HelmRepository
      name: kcn333-charts
      namespace: flux-system
```

### 11. Przydatne narzędzia

```bash
# helm-diff — podgląd zmian przed upgrade
helm plugin install https://github.com/databus23/helm-diff
helm diff upgrade clients-api helm/clients-api -n clients

# Debugowanie
helm get values clients-api -n clients      # aktualne values
helm get manifest clients-api -n clients    # wygenerowane YAML
helm history clients-api -n clients         # historia releasów
```

---

## Finalna struktura clients-api repo

```
clients-api/
├── src/                      ← kod aplikacji Java
├── Dockerfile
├── .github/workflows/        ← CI/CD pipeline
└── helm/
    └── clients-api/
        ├── Chart.yaml         version: 0.1.2, appVersion: "1.4.0"
        ├── values.yaml        wszystkie defaults
        └── templates/
            ├── _helpers.tpl
            ├── NOTES.txt
            ├── deployment.yaml
            ├── service.yaml
            ├── ingress.yaml
            ├── hpa.yaml
            ├── pdb.yaml
            ├── networkpolicy.yaml
            └── servicemonitor.yaml
```

---

## Backlog

- [ ] Opcja B — opublikować chart jako OCI image na ghcr.io
- [ ] `helm test` — test po deploy sprawdzający endpoint
- [ ] values-staging.yaml — osobne wartości dla środowiska staging
- [ ] Progressive delivery (staging/production branches)
- [ ] Hubble UI — native routing (zaplanować osobną sesję)
- [ ] HashiCorp Vault
- [ ] External-dns
- [ ] RBAC

---

## Przydatne komendy

```bash
# Helm
helm lint helm/clients-api
helm template clients-api helm/clients-api | grep "^kind:\|^  name:"
helm install clients-api helm/clients-api -n clients --dry-run
helm list -n clients
helm history clients-api -n clients
helm get values clients-api -n clients

# Flux
flux reconcile source git clients-api -n flux-system
flux reconcile helmrelease clients-api -n clients
flux suspend helmrelease clients-api -n clients
flux resume helmrelease clients-api -n clients
kubectl get helmrelease clients-api -n clients
kubectl get helmchart -A
```