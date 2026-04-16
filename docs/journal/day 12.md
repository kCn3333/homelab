# 12 - Grafana + HPA

# K3s Homelab — Sesja 12

**Data:** 2026-02-15  
**Środowisko:** 3x HP T630, k3s v1.34.4, Flux v2.8.1, Cilium v1.19.1

---

### Cel sesji:

1. **HTTP request logging** — CommonsRequestLoggingFilter w Spring Boot
2. **Grafana dashboard** — Request Rate, Error Rate, p99 Latency, JVM Heap, DB Connection Pool, Loki logs
3. **HPA** — automatyczne skalowanie 2-6 replik na podstawie CPU
4. **ReadinessProbe + LivenessProbe** — ochrona przed ruchem na zimne JVM pody
5. **NetworkPolicy** — izolacja sieciowa: DB dostępna tylko dla clients-api

---


### 1. HTTP Request Logging w Spring Boot

Spring Boot domyślnie nie loguje requestów HTTP. Potrzebujesz dwóch rzeczy:

**Bean w kodzie Java:**

```java
@Configuration
public class RequestLoggingConfig {
    @Bean
    public CommonsRequestLoggingFilter requestLoggingFilter() {
        CommonsRequestLoggingFilter filter = new CommonsRequestLoggingFilter();
        filter.setIncludeClientInfo(true);    // IP klienta
        filter.setIncludeQueryString(true);   // ?param=value
        filter.setIncludePayload(false);      // nie loguj body (dane wrażliwe!)
        filter.setIncludeHeaders(false);      // nie loguj headerów (tokeny auth!)
        return filter;
    }
}
```

**Poziom logowania w application-prod.properties:**

```properties
logging.level.org.springframework.web.filter.CommonsRequestLoggingFilter=DEBUG
```

**Ważne:** konfiguracja musi być w profilu który jest aktywny na klastrze (`application-prod.properties`), nie tylko w lokalnym (`application-local.properties`).

---

### 2. LogQL — podstawy i pułapki

**Składnia:**

```
{selektor} | operator "tekst"
```

**Operatory filtrowania:**

```
|=  "tekst"    ← zawiera (case-sensitive!)
!=  "tekst"    ← nie zawiera
|~  "regex"    ← pasuje do regex
!~  "regex"    ← nie pasuje do regex
```

**Regex w Loki:**

```logql
# ŹLE — * bez kropki to "zero lub więcej poprzedniego znaku"
{pod=~"clients-api*"}     ← matches: clients-ap, clients-api, clients-apii

# DOBRZE — .* to "dowolny znak zero lub więcej razy"
{pod=~"clients-api.*"}    ← matches: clients-api-6598449f4c-7wfrj
```

**Case-sensitivity:**

```logql
# Logi zawierają "After request" (mała litera r)
|= "REQUEST"   ← nie znajdzie nic!
|= "request"   ← znajdzie
|~ "(?i)request"  ← case-insensitive przez flagę regex
```

**Praktyczne zapytania dla Spring Boot:**

```logql
# Tylko HTTP requesty, bez scrapowania Prometheusa
{namespace="clients", pod=~"clients-api.*"} |= "request" != "/actuator"

# JSON parser + formatowanie
{namespace="clients", pod=~"clients-api.*"}
| json
| message =~ "After request.*"
| line_format "{{.level}} | {{.thread_name}} | {{.message}}"
```

---

### 3. Prometheus — metryki Spring Boot Actuator

**Histogramy muszą być jawnie włączone:**

Domyślnie Spring Boot eksportuje tylko `_count` i `_sum` dla HTTP metrics. Bez histogramów nie można liczyć percentyli (p50/p95/p99).

```properties
# application-prod.properties
management.metrics.distribution.percentiles-histogram.http.server.requests=true
```

Po włączeniu pojawia się `http_server_requests_seconds_bucket` z dziesiątkami serii (różne wartości `le` — upper bound bucketu).

**Co to jest `le` w histogramie:**

```
le="0.001"  → ile requestów odpowiedziało w < 1ms
le="0.005"  → ile requestów odpowiedziało w < 5ms
le="+Inf"   → wszystkie requesty
```

`histogram_quantile(0.99, ...)` interpoluje z tych bucketów 99. percentyl.

**Przydatne PromQL queries:**

```promql
# Request rate (req/s)
sum(rate(http_server_requests_seconds_count{application="clients-api"}[5m]))

# Error rate (%)
sum(rate(http_server_requests_seconds_count{application="clients-api",status=~"5.."}[5m]))
  or vector(0)
/
sum(rate(http_server_requests_seconds_count{application="clients-api"}[5m]))
* 100

# p99 latency (ms) — tylko /api/clients, bez actuatora
histogram_quantile(0.99,
  sum by(le) (
    rate(http_server_requests_seconds_bucket{
      application="clients-api",
      uri="/api/clients"
    }[5m])
  )
) * 1000

# JVM Heap — tylko aktywne pody
jvm_memory_used_bytes{application="clients-api", area="heap"}
* on(pod) group_left() kube_pod_info{namespace="clients"}

# DB Connection Pool
hikaricp_connections_active{application="clients-api"}
hikaricp_connections_pending{application="clients-api"}
```

**`or vector(0)` — dlaczego ważne:** Gdy nie ma błędów, `rate()` zwraca `No data`. `or vector(0)` sprawia że panel pokazuje `0` zamiast pustego wykresu.

**Stare pody w Grafanie:** Prometheus przechowuje dane przez 7 dni — wykresy pokazują serie z usuniętych podów. Rozwiązania:

- Zmień Time range na `Last 1 hour` lub `Last 15 minutes`
- Join z `kube_pod_info`: `* on(pod) group_left() kube_pod_info{namespace="clients"}`

---

### 4. Diagnoza bottlenecka — CPU throttling

**Jak wykryć CPU throttling:**

```bash
kubectl top pods -n clients
# clients-api-xxx   499m/500m  ← prawie dokładnie limit = throttling
```

Gdy pod stale pokazuje ~100% limitu CPU — jest **throttlowany przez cgroups**. Requesty czekają w kolejce na wątek CPU → dramatyczny wzrost latency.

**Różnica między requests a limits:**

```
requests = ile scheduler rezerwuje (minimum gwarantowane)
limits   = ile maksymalnie może użyć (twarda granica)

CPU limit przekroczony → throttling (spowolnienie, nie zabicie)
Memory limit przekroczony → OOMKilled (natychmiastowe zabicie)
```

**Wniosek:** JVM pod obciążeniem potrzebuje headroom powyżej requests. Limit `500m` był za mały — JVM był throttlowany przy każdym request.

```yaml
# Przed — za mały limit
limits:
  cpu: "500m"    # JVM dobijał do 100% i był throttlowany

# Po — odpowiedni headroom
limits:
  cpu: "2000m"   # JVM może używać do 2 cores podczas GC i pików
```

---

### 5. Load testing z `hey`

```bash
# Instalacja
wget https://hey-release.s3.us-east-2.amazonaws.com/hey_linux_amd64
chmod +x hey_linux_amd64
sudo mv hey_linux_amd64 /usr/local/bin/hey

# Użycie
hey -n 1000 -c 20 \           # 1000 requestów, 20 równoległych
  -H 'Authorization: Basic ...' \
  https://endpoint/path
```

**Dlaczego `curl` w pętli jest złym testem:**

```bash
# ŹLE — sekwencyjne, nigdy nie ma > 1 aktywnego połączenia
for i in {1..20}; do curl ...; done

# DOBRZE — równoległe
hey -n 200 -c 20 ...
```

**Co czytać w wynikach `hey`:**

```
Requests/sec — przepustowość
p50 latency  — typowy użytkownik
p99 latency  — najgorsze doświadczenie (zwykle to co optymalizujesz)
[502] responses — Traefik timeout (aplikacja za wolna)
context deadline exceeded — klient timeout (aplikacja za wolna)
```

---

### 6. HPA — Horizontal Pod Autoscaler

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
          averageUtilization: 70   # % od requests (nie limits!)
  behavior:
    scaleUp:
      stabilizationWindowSeconds: 0    # reaguj natychmiast
      policies:
        - type: Pods
          value: 2                      # dodawaj 2 pody na raz
          periodSeconds: 30
    scaleDown:
      stabilizationWindowSeconds: 300  # czekaj 5 minut przed scale down
      policies:
        - type: Pods
          value: 1
          periodSeconds: 120
```

**Jak liczy HPA:**

```
averageUtilization: 70
CPU requests: 250m
Trigger: gdy pod używa > 175m (70% z 250m) → scale up
```

**Krytyczna pułapka — Flux vs HPA:**

Gdy `replicas` jest zdefiniowane w `deployment.yaml`, Flux co minutę nadpisuje liczbę replik z manifestu, cofając zmiany HPA.

```yaml
# ŹLE — Flux resetuje repliki co minutę
spec:
  replicas: 2    # ← usuń tę linię!

# DOBRZE — HPA zarządza replikami, Flux nie ingeruje
spec:
  # brak replicas — HPA jest jedynym właścicielem
  selector:
    matchLabels:
      app: clients-api
```

**Over-provisioning — pułapka zbyt dużej liczby replik:**

```
HP T630 (3 nody) ma fizyczne ograniczenie CPU
20 replik JVM → saturacja wszystkich nodów → paradoksalnie gorsze wyniki
Optymum → 4-6 replik
```

---

### 7. Readiness i Liveness Probes

```yaml
readinessProbe:
  httpGet:
    path: /actuator/health/readiness   # Spring Boot dedykowany endpoint
    port: 8080
  initialDelaySeconds: 90    # JVM warmup trwa ~110s — nie wpuszczaj ruchu wcześniej
  periodSeconds: 10
  failureThreshold: 3

livenessProbe:
  httpGet:
    path: /actuator/health/liveness    # Spring Boot dedykowany endpoint
    port: 8080
  initialDelaySeconds: 120   # zawsze > readiness initialDelay
  periodSeconds: 15
  failureThreshold: 3
```

**Różnica między readiness a liveness:**

```
readinessProbe — czy pod jest gotowy na ruch?
  FAIL → Kubernetes nie wysyła ruchu (pod pozostaje w Running)
  Użycie: warmup JVM, ładowanie cache, oczekiwanie na DB

livenessProbe — czy pod żyje?
  FAIL → Kubernetes restartuje pod
  Użycie: wykrycie deadlocku, zawieszenia aplikacji
```

**Dlaczego `initialDelaySeconds` jest krytyczny dla JVM:** Bez odpowiedniego opóźnienia Kubernetes uznaje pod za gotowy zanim JVM skończy warmup → pierwsze requesty trafiają na zimny pod → wysokie latency lub błędy 500.

---

### 8. NetworkPolicy — izolacja sieciowa

**Domyślne zachowanie bez NetworkPolicy:** Każdy pod może połączyć się z każdym — brak izolacji.

**Dwa typy polityk:**

```
policyTypes:
  - Ingress   ← kto może WYSYŁAĆ do tego poda
  - Egress    ← dokąd ten pod może WYSYŁAĆ
```

**NetworkPolicy dla bazy danych:**

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: clients-db-allow-only-api
  namespace: clients
spec:
  podSelector:
    matchLabels:
      cnpg.io/cluster: clients-db    # ← label CloudNativePG
  policyTypes:
    - Ingress
  ingress:
    - from:
        - podSelector:
            matchLabels:
              app: clients-api       # ← tylko clients-api
      ports:
        - protocol: TCP
          port: 5432
```

**NetworkPolicy dla aplikacji:**

```yaml
spec:
  podSelector:
    matchLabels:
      app: clients-api
  policyTypes:
    - Ingress
  ingress:
    - from:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: kube-system  # Traefik
      ports:
        - protocol: TCP
          port: 8080
    - from:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: monitoring   # Prometheus
      ports:
        - protocol: TCP
          port: 8080
```

**Weryfikacja izolacji:**

```bash
# Pod bez labela app=clients-api → powinien być zablokowany
kubectl run test-isolation --rm -it \
  --image=postgres:17 \
  --restart=Never \
  -n clients \
  -- psql -h clients-db-rw -U app -d clients_db -c "SELECT 1"

# Jeśli pod wisi bez odpowiedzi → NetworkPolicy działa ✅
# DROP (Cilium) = cisza, nie "connection refused"
# Atakujący nie wie czy port w ogóle istnieje
```

**Cilium DROP vs REJECT:**

```
REJECT → natychmiastowy błąd "connection refused" (informuje atakującego)
DROP   → cisza, pakiety porzucane (bezpieczniejsze — brak informacji)
Cilium domyślnie używa DROP
```

---

## Podsumowanie optymalizacji wydajności

|Zmiana|Efekt|
|---|---|
|CPU limit 500m → 2000m|Zero 502, p50: 19s → 0.85s|
|HPA 2-6 replik|Automatyczne skalowanie pod obciążeniem|
|readinessProbe 90s|Brak ruchu na zimne JVM pody|
|Usunięcie replicas z Deployment|HPA może swobodnie zarządzać replikami|

---

## Finalna struktura plików clients-api

```
apps/base/clients-api/
├── namespace.yaml
├── db-cluster.yaml
├── db-secret-sealed.yaml
├── deployment.yaml          ← prod profile, probes, CPU 250m/2000m, brak replicas
├── service.yaml             ← port http nazwany
├── ingress.yaml
├── imagerepository.yaml
├── imagepolicy.yaml         ← semver >=1.0.0
├── servicemonitor.yaml      ← scrape /actuator/prometheus co 30s
├── hpa.yaml                 ← min:2 max:6, CPU 70%, szybki scale-up
├── networkpolicy.yaml       ← DB tylko dla clients-api, app tylko z kube-system+monitoring
└── kustomization.yaml
```

---

## Backlog (do zrobienia)

- [ ] **PrometheusRule dla clients-api** — alerty na error rate, p99 latency ← następna sesja
- [ ] **Grafana dashboard** — zapisać i dopracować panele
- [ ] Pod Disruption Budget
- [ ] Progressive delivery (staging/production branches)
- [ ] RBAC — własni użytkownicy
- [ ] Hubble UI — Cilium network observability
- [ ] HashiCorp Vault
- [ ] External-dns

---

## Przydatne komendy

```bash
# Load testing
hey -n 1000 -c 20 -H 'Authorization: Basic dXNlcjp1c2Vy' https://HOST/PATH

# HPA status
kubectl get hpa -n clients
watch -n 5 kubectl get hpa,pods -n clients

# Metryki bezpośrednio z poda (bez czekania na scrape)
watch -n 2 'kubectl exec -n clients deploy/clients-api -- \
  wget -qO- http://localhost:8080/actuator/prometheus \
  | grep -E "hikaricp_connections_(active|pending|idle|max)"'

# NetworkPolicy
kubectl get networkpolicy -n clients
kubectl describe networkpolicy clients-db-allow-only-api -n clients

# Test izolacji
kubectl run test-isolation --rm -it \
  --image=postgres:17 --restart=Never -n clients \
  -- psql -h clients-db-rw -U app -d clients_db -c "SELECT 1"

# LogQL — HTTP requesty bez actuatora
# {namespace="clients", pod=~"clients-api.*"} |= "request" != "/actuator"

# PromQL — p99 latency
# histogram_quantile(0.99, sum by(le) (rate(http_server_requests_seconds_bucket{application="clients-api",uri="/api/clients"}[5m]))) * 1000
```