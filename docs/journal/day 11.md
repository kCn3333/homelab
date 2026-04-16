# 11 - CI/CD 

# K3s Homelab — Sesja 11

**Data:** 2026-02-12  
**Środowisko:** 3x HP T630, k3s v1.34.4, Flux v2.8.1, Cilium v1.19.1

---

### Cel sesji:

1. **GitHub Actions CI/CD pipeline** — automatyczny build i push do DockerHub z semver tagowaniem
2. **clients-api deployment** — Spring Boot + CloudNativePG na klastrze przez GitOps
3. **ServiceMonitor** — integracja z Prometheus, metryki aplikacji widoczne w Grafanie

---

### 1. GitHub Actions — semver tagging

**Problem z tagowaniem SHA:**

Tagi w formacie `sha-<short-commit>` nie są sortowalny chronologicznie. Flux używa porównania alfabetycznego — `sha-e984bdc` > `sha-9cb3301` literowo, ale `e984bdc` był starszym commitem. Flux wybierałby losowo "najnowszy" obraz.

**Prawidłowe podejście — semver:**

```yaml
# .github/workflows/ci.yml
tags: |
  type=semver,pattern={{version}}           # v1.1.0 → 1.1.0
  type=semver,pattern={{major}}.{{minor}}   # v1.1.0 → 1.1
  type=sha,prefix=sha-,format=short         # każdy push → sha-XXXXXXX
  type=raw,value=latest,enable={{is_default_branch}}
```

**Krytyczna pułapka — warunek `if` na job:**

```yaml
# ŹLE — job pomijany gdy github.ref = refs/tags/v1.1.0
if: github.ref == 'refs/heads/main'

# DOBRZE — buduj też na tagach
if: github.ref == 'refs/heads/main' || startsWith(github.ref, 'refs/tags/v')
```

Gdy pushujesz `git tag v1.1.0`, `github.ref` ma wartość `refs/tags/v1.1.0` — nie `refs/heads/main`. Job z samym warunkiem `main` jest w całości pomijany, semver tagi nigdy nie powstają.

**Workflow po pushu taga:**

```
git tag v1.1.0 && git push origin v1.1.0
       ↓
GitHub Actions: test → build-and-push (if: main OR tags/v*)
       ↓
DockerHub:
  kcn333/clients-api:1.1.0   ← semver
  kcn333/clients-api:1.1     ← semver major.minor
  kcn333/clients-api:sha-f7e2680  ← SHA tego commita
  kcn333/clients-api:latest  ← raw
```

**Konwencja semver:**

```
v1.0.0  ← major: breaking changes
v1.1.0  ← minor: nowa funkcjonalność, backwards compatible
v1.1.1  ← patch: bugfix
```

---

### 2. Flux ImagePolicy — semver vs alphabetical

**Kiedy używać semver:**

```yaml
# Tagi: 1.1.0, 1.0.5, 1.0.4 → wybierze 1.1.0
policy:
  semver:
    range: ">=1.0.0"
```

**Kiedy NIE używać alphabetical dla SHA:**

SHA nie ma gwarancji porządku chronologicznego — `sha-e984bdc` może być starszy od `sha-9cb3301` mimo że alphabetycznie jest "większy". Semver jest deterministyczny i jednoznaczny.

**Weryfikacja że ImagePolicy widzi nowy tag:**

```bash
flux get images policy clients-api -n flux-system
# NAME         IMAGE                  TAG    READY  MESSAGE
# clients-api  kcn333/clients-api     1.1.0  True   Latest image tag resolved to 1.1.0
```

---

### 3. Deploy aplikacji Spring Boot na k3s

**Minimalne zasoby do działającego deploymentu:**

```
Namespace → Deployment → Service → Ingress
```

**Kluczowe env vars dla Spring Boot:**

```yaml
env:
  - name: SPRING_PROFILES_ACTIVE
    value: "prod"          # ← aktywuje application-prod.properties
  - name: DB_USERNAME
    valueFrom:
      secretKeyRef:
        name: clients-db-secret
        key: username
  - name: DB_PASSWORD
    valueFrom:
      secretKeyRef:
        name: clients-db-secret
        key: password
```

**Diagnoza profilu aplikacji przez logi:**

```
# Zły profil (domyślny):
"url=jdbc:h2:mem:..." ← H2 in-memory
"Exposing 1 endpoint beneath base path '/actuator'"

# Dobry profil (prod):
"The following 1 profile is active: \"prod\""
"HikariPool-1 - Added connection org.postgresql.jdbc.PgConnection..."
"Database version: 17.4"
"Exposing 4 endpoints beneath base path '/actuator'"
```

---

### 4. ServiceMonitor — integracja z Prometheus

**Trzy warunki żeby ServiceMonitor działał:**

1. **Label na Service metadata** (nie tylko spec.selector!) — Prometheus relabeling sprawdza `__meta_kubernetes_service_label_<label>`:

```yaml
metadata:
  name: clients-api
  labels:
    app: clients-api   # ← wymagane dla relabelingu
```

2. **Nazwany port w Service** — ServiceMonitor odwołuje się do portu przez nazwę:

```yaml
# ŹLE — brak nazwy portu
ports:
  - port: 80
    targetPort: 8080

# DOBRZE
ports:
  - name: http        # ← wymagane
    port: 80
    targetPort: 8080
```

3. **Label `release: kube-prometheus-stack`** na ServiceMonitor — Prometheus selector szuka tej etykiety:

```yaml
metadata:
  labels:
    release: kube-prometheus-stack   # ← musi pasować do serviceMonitorSelector
```

**Diagnostyka ServiceMonitor krok po kroku:**

```bash
# Krok 1 — Sprawdź czy Prometheus config zawiera job
kubectl exec -n monitoring prometheus-kube-prometheus-stack-prometheus-0 \
  -- cat /etc/prometheus/config_out/prometheus.env.yaml | grep -A10 "clients"

# Krok 2 — Sprawdź stan targetów (active vs dropped)
curl -s "http://localhost:9090/api/v1/targets?state=any" | \
  python3 -c "
import sys, json
data = json.load(sys.stdin)
for t in data['data']['activeTargets'] + data['data']['droppedTargets']:
  addr = t.get('discoveredLabels', {}).get('__address__', '')
  if '8080' in addr:
    print('ADDRESS:', addr)
    print('HEALTH:', t.get('health', 'DROPPED'))
    print('LAST ERROR:', t.get('lastError', ''))
"

# Krok 3 — Jeśli DROPPED bez błędu → problem z relabelingiem (label na Service)
# Jeśli DROPPED z błędem connection refused → UFW lub zły port
# Jeśli active ale health=unknown → za krótki czas od dodania (czekaj 30s)
```

**Typowy błąd — `DROPPED` bez error message:**

Oznacza że target przeszedł discovery (Prometheus go znalazł) ale został odfiltrowany przez reguły relabelingu. Najczęstsza przyczyna: brak labela `app: clients-api` w `metadata.labels` na Service (nie mylić z `spec.selector`).

```
spec.selector.app = clients-api   ← mówi Service gdzie wysyłać ruch (do podów)
metadata.labels.app = clients-api ← mówi Prometheusowi że to właściwy Service
```

To są dwie niezależne konfiguracje — obie muszą być ustawione.

---

### 5. Prometheus serviceMonitorNamespaceSelector

Sprawdź przed debugowaniem czy Prometheus w ogóle skanuje właściwy namespace:

```bash
kubectl get prometheus -n monitoring -o yaml | grep -A5 serviceMonitorNamespaceSelector
```

- `{}` — skanuje wszystkie namespace ✅
- `matchLabels: ...` — tylko namespace z tym labelem

Przy `{}` i poprawnych labelach na ServiceMonitor — problem zawsze leży w samym Service (brak label w metadata lub brak nazwy portu).

---

### 6. Metryki Spring Boot Actuator w Prometheusie

**Przydatne PromQL queries dla Spring Boot:**

```promql
# Request rate per endpoint
rate(http_server_requests_seconds_count{application="clients-api"}[5m])

# Error rate (5xx)
rate(http_server_requests_seconds_count{application="clients-api",status=~"5.."}[5m])

# p99 latency
histogram_quantile(0.99, rate(http_server_requests_seconds_bucket{application="clients-api"}[5m]))

# JVM heap usage
jvm_memory_used_bytes{application="clients-api",area="heap"}

# Aktywne połączenia z bazą
hikaricp_connections_active{application="clients-api"}

# Connection pool usage
hikaricp_connections_pending{application="clients-api"}
```

Tag `application="clients-api"` pochodzi z konfiguracji w `application-prod.properties`:

```properties
management.metrics.tags.application=${spring.application.name}
```

---

## Pełna pętla CI/CD → GitOps

```
Developer: git tag v1.2.0 && git push origin v1.2.0
                    ↓
GitHub Actions: mvn test → docker build → docker push
                    ↓
DockerHub: kcn333/clients-api:1.2.0, :1.2, :sha-XXXX, :latest
                    ↓
Flux ImageRepository: skanuje co 1 minutę
                    ↓
Flux ImagePolicy: semver >=1.0.0 → wybiera 1.2.0
                    ↓
Flux ImageUpdateAutomation: commituje do repo
  image: kcn333/clients-api:1.2.0 # {"$imagepolicy": "flux-system:clients-api"}
                    ↓
Flux kustomize-controller: rolling update
                    ↓
Prometheus ServiceMonitor: scrape /actuator/prometheus co 30s
                    ↓
Grafana: metryki aplikacji
```

---

## Finalna struktura plików clients-api

```
apps/base/clients-api/
├── namespace.yaml
├── db-cluster.yaml          ← CloudNativePG cluster
├── db-secret-sealed.yaml    ← SealedSecret z credentials BD
├── deployment.yaml          ← Spring Boot, prod profile, 2 repliki
├── service.yaml             ← port http nazwany (wymagane przez ServiceMonitor)
├── ingress.yaml             ← clients-api.cluster.kcn333.com z TLS
├── imagerepository.yaml     ← skanuje kcn333/clients-api co 1m
├── imagepolicy.yaml         ← semver >=1.0.0
├── servicemonitor.yaml      ← scrape /actuator/prometheus co 30s
└── kustomization.yaml
```

---

## Backlog (do zrobienia)

- [ ] **Grafana dashboard dla clients-api** — HTTP metrics, JVM, HikariCP ← następna sesja
- [ ] **PrometheusRule dla clients-api** — alerty na error rate, latency
- [ ] **NetworkPolicy** — izolacja między podami (Cilium gotowy)
- [ ] **HPA** — Horizontal Pod Autoscaler dla clients-api
- [ ] Pod Disruption Budget
- [ ] Progressive delivery (staging/production branches)
- [ ] RBAC — własni użytkownicy
- [ ] Hubble UI — Cilium network observability
- [ ] HashiCorp Vault
- [ ] External-dns

---

## Przydatne komendy

```bash
# CI/CD — git tagging
git tag v1.x.0
git push origin v1.x.0
git tag -d v1.x.0 && git push origin :refs/tags/v1.x.0  # usuń i puść ponownie

# Flux image automation
flux get images all -n flux-system
flux get images policy clients-api -n flux-system

# Spring Boot diagnostyka
kubectl logs -n clients deploy/clients-api | grep -E "profile|HikariPool|Exposing"
kubectl logs -n clients deploy/clients-api --follow

# ServiceMonitor diagnostyka
kubectl get servicemonitor -n clients
kubectl describe servicemonitor clients-api -n clients

# Prometheus targets
kubectl port-forward -n monitoring svc/kube-prometheus-stack-prometheus 9090:9090 &
curl -s "http://localhost:9090/api/v1/targets?state=any" | python3 -m json.tool | grep -E "clients|health|error"

# Sprawdź config Prometheusa
kubectl exec -n monitoring prometheus-kube-prometheus-stack-prometheus-0 \
  -- cat /etc/prometheus/config_out/prometheus.env.yaml | grep -A15 "clients"

# Sprawdź RBAC Prometheusa
kubectl auth can-i get pods \
  --as=system:serviceaccount:monitoring:kube-prometheus-stack-prometheus \
  -n clients
```