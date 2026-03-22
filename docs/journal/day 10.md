# K3s Homelab — Sesja 10

**Data:** 2026-03-10  
**Środowisko:** 3x HP T630, k3s v1.34.4, Flux v2.8.1, Cilium v1.19.1

---

## Co zbudowaliśmy

1. **metrics-server** — diagnostyka i naprawa intermittent timeouts
2. **Flux image automation** — upgrade v1beta2 → v1 (deprecation fix)
3. **Resource Requests/Limits** — wszystkie pody z `BestEffort` → `Burstable`
4. **Custom AlertManager rules** — CPU, Memory, Disk, PodCrashLoop, Longhorn

---

## Czego się nauczyłem

### 1. Debugowanie przez eliminację warstw — metrics-server

**Objaw:**

```
kubectl top nodes  → timeout ~60s lub "Metrics API not available"
kubectl get --raw /apis/metrics.k8s.io/v1beta1/nodes → działa natychmiast
```

**Metodologia diagnozy:**

```
kubectl top (timeout)  ←→  kubectl get --raw (działa)
         ↓
Oba używają aggregation layer → problem nie w metrics-server samym w sobie
         ↓
kubectl top sprawdza APIService health check → trafia na losowy pod przez Service
         ↓
3 repliki z hostNetwork → endpoints na wszystkich nodach (192.168.55.x:4443)
         ↓
Cilium DNAT cross-node → ruch z mastera do worker1:4443
         ↓
UFW na worker1 nie ma reguły dla 4443 → DROP → TCP timeout 60s
```

**Dlaczego `kubectl get --raw` działało?** Cilium preferuje lokalny endpoint gdy źródło i cel są na tym samym hoście. Testy zawsze trafiały na lokalny pod — stąd pozorna spójność.

**Fix — UFW:**

```yaml
# ansible/ufw.yml
- { port: '4443', proto: 'tcp' }  # metrics-server hostNetwork
```

**Reguła którą warto zapamiętać:** przy każdym nowym komponencie z `hostNetwork: true` zadaj pytanie:

> _Na jakim porcie binduje? Czy ktokolwiek spoza tego noda musi się z nim połączyć?_

**Uproszczenie metrics-server:** 3 repliki bez leader election dawały 3x obciążenie kubeletów bez realnego HA benefitu. Zredukowano do 1 repliki. Zmieniono też `metric-resolution` z `55s` na domyślne `15s` — przy 55s margines do 60s timeout `kubectl top` był zbyt mały.

---

### 2. Flux image automation — API versioning

**Dlaczego robimy upgrade:**

```
v1alpha1 → v1beta1 → v1beta2 → v1 (stable)
```

`v1beta2` zostanie usunięte z przyszłych wersji Fluxa. Po upgrade Fluxa zasoby na starym API przestałyby działać.

**Co się zmieniło:** tylko `apiVersion` — spec jest identyczny. Czysta zmiana bez ryzyka.

**Zasoby po migracji:**

```yaml
# ImagePolicy
apiVersion: image.toolkit.fluxcd.io/v1   # było: v1beta2

# ImageUpdateAutomation  
apiVersion: image.toolkit.fluxcd.io/v1   # było: v1beta2

# ImageRepository → zostaje v1beta2 (nie był jeszcze promowany do v1)
```

**Jak sprawdzić aktualny status image automation:**

```bash
flux get images all -n flux-system
# Zwraca:
# imagerepository/nginx  → skanuje registry, znalazł 1049 tagów
# imagepolicy/nginx      → wybrał tag 1.29.5 (semver range 1.29.x)
# imageupdateautomation  → commituje zmiany tagów do repo
```

**Jak sprawdzić historię zmian tagu konkretnej aplikacji:**

```bash
git log --oneline -- apps/base/nginx/nginx-deploy.yaml
git log -p -- apps/base/nginx/nginx-deploy.yaml
git log --oneline --author="fluxbot"  # tylko automatyczne commity
```

---

### 3. Resource Requests/Limits — fundamenty

**Dwa różne pojęcia:**

```
Requests                          Limits
────────────────────              ────────────────────
"Ile scheduler rezerwuje"         "Ile maksymalnie może zużyć"
Wpływa na GDZIE pod wyląduje      Wpływa na co się dzieje
Gwarancja minimum                 gdy pod przekroczy próg

CPU limit przekroczony → throttling (spowolnienie, nie zabicie)
Memory limit przekroczony → OOMKilled (natychmiastowe zabicie)
```

**Trzy klasy QoS:**

```
BestEffort          Burstable           Guaranteed
──────────────      ──────────────      ──────────────
Brak requests       Requests < Limits   Requests == Limits
i limits            lub częściowo       (oba ustawione
                    ustawione           i równe)

Zabijany 1.         Zabijany 2.         Zabijany ostatni
przy pressure       przy pressure

Domyślny stan       Target dla          Krytyczne komponenty
bez konfiguracji    większości app      (bazy danych)
```

**Jednostki:**

```
CPU:    1000m = 1 core, 100m = 0.1 core
Memory: zawsze Mi/Gi (nie M/G) — 256Mi, 512Mi, 1Gi, 2Gi
```

**Jak dobierać wartości:**

```bash
kubectl top pods -n <namespace>   # obserwuj przez kilka dni w Grafanie
# Request ≈ średnie zużycie
# Limit   ≈ 2-3x request (headroom na piki)
```

---

### 4. Helm values — gotcha z subchartami

kube-prometheus-stack składa się z subchartów. Każdy subchart ma **dwa klucze** — wrapper kube-prometheus-stack i bezpośredni klucz subchartu:

```yaml
# WRAPPER — tylko włącz/wyłącz, dashboardy
nodeExporter:
  enabled: true

# SUBCHART — resources, affinity, tolerations
prometheus-node-exporter:    # ← nazwa z myślnikiem!
  resources:
    requests:
      cpu: 10m
      memory: 32Mi
```

**Zasada:** zawsze weryfikuj nazwy kluczy przez `helm show values` — nie zgaduj:

```bash
helm show values prometheus-community/kube-prometheus-stack | grep -A20 "^nodeExporter:"
helm show values prometheus-community/kube-prometheus-stack | grep "prometheus-node-exporter"
```

**Resources w różnych typach zasobów:**

```yaml
# HelmRelease (Prometheus)
prometheusSpec:
  resources: { ... }

# HelmRelease (Grafana)
grafana:
  resources: { ... }       # poziom wyżej niż admin/ingress

# HelmRelease (AlertManager)
alertmanagerSpec:
  resources: { ... }

# HelmRelease (Loki SingleBinary)
singleBinary:
  replicas: 1
  resources: { ... }       # obok replicas

# HelmRelease (Promtail)
values:
  resources: { ... }       # główny poziom

# Deployment (własny manifest)
containers:
  - name: nginx
    resources: { ... }     # poziom kontenera
```

---

### 5. Custom PrometheusRule — własne alerty

Własne reguły alertów jako CRD zarządzany przez Flux:

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: homelab-custom-rules
  namespace: monitoring
  labels:
    release: kube-prometheus-stack   # ← wymagane! Prometheus szuka tej etykiety
spec:
  groups:
    - name: homelab.nodes
      interval: 1m
      rules:
        - alert: NodeHighCPU
          expr: |
            (1 - avg by(instance) (rate(node_cpu_seconds_total{mode="idle"}[5m]))) * 100 > 90
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "High CPU on {{ $labels.instance }}"
            description: "CPU usage is {{ $value | humanize }}% (threshold 90%)"
```

**Zaimplementowane alerty:**

|Alert|Próg|Czas|Severity|
|---|---|---|---|
|NodeHighCPU|>90%|5m|warning|
|NodeHighMemory|>85%|5m|warning|
|NodeDiskPressure|>85%|5m|warning|
|PodCrashLooping|≥5 restartów/10m|0m|critical|
|PodNotReady|not ready|10m|warning|
|LonghornVolumeUnhealthy|robustness==3|5m|critical|

**Ważne:** etykieta `release: kube-prometheus-stack` musi być obecna — bez niej Prometheus ignoruje PrometheusRule.

---

### 6. Finalne QoS klastra po sesji

```bash
for ns in flux-test monitoring loki; do
  kubectl get pods -n $ns -o jsonpath='{range .items[*]}{.metadata.name}{" → "}{.status.qosClass}{"\n"}{end}'
done
```

Wszystkie pody: `Burstable` ✅

**Ustawione resources (obserwowane zużycie → ustawione wartości):**

|Komponent|Observed CPU|Observed Memory|Request CPU|Request Memory|Limit CPU|Limit Memory|
|---|---|---|---|---|---|---|
|Prometheus|333m|1192Mi|200m|1024Mi|1000m|2048Mi|
|Grafana|35m|491Mi|50m|256Mi|200m|512Mi|
|AlertManager|2m|59Mi|10m|64Mi|100m|128Mi|
|node-exporter|5m|25Mi|10m|32Mi|100m|64Mi|
|kube-state-metrics|5m|71Mi|10m|64Mi|100m|128Mi|
|Prometheus Operator|9m|73Mi|10m|64Mi|200m|256Mi|
|Loki|17m|295Mi|50m|256Mi|200m|512Mi|
|Promtail (per pod)|55m|125Mi|50m|128Mi|200m|256Mi|
|nginx|~1m|~10Mi|10m|32Mi|100m|64Mi|
|ntfy-webhook|1m|27Mi|10m|32Mi|50m|64Mi|

---

## Finalna struktura repo (zmiany w sesji 10)

```
k3s-homelab/
├── ansible/
│   └── ufw.yml                              # ← dodano port 4443/tcp
├── apps/
│   └── base/
│       ├── monitoring/
│       │   ├── helmrelease.yaml             # ← resources dla wszystkich komponentów
│       │   └── prometheusrule-custom.yaml   # ← custom alerts
│       ├── loki/
│       │   └── helmrelease.yaml             # ← resources singleBinary
│       ├── promtail/
│       │   └── helmrelease.yaml             # ← resources DaemonSet
│       ├── metrics-server/
│       │   └── helmrelease.yaml             # ← 1 replika, 15s resolution
│       └── nginx/
│           ├── imagepolicy.yaml             # ← v1beta2 → v1
│           └── nginx-deploy.yaml            # ← resources
└── clusters/
    └── k3s-homelab/
        └── image-update-automation.yaml     # ← v1beta2 → v1
```

---

## Backlog (do zrobienia)

- [ ] **Własna aplikacja (Spring Boot) + CI/CD pipeline z GitHub Actions** ← następny krok
- [ ] HPA — Horizontal Pod Autoscaler (mamy działający metrics-server!)
- [ ] Pod Disruption Budget
- [ ] NetworkPolicy — izolacja między podami (Cilium gotowy)
- [ ] Progressive delivery (staging/production branches)
- [ ] RBAC — własni użytkownicy
- [ ] Hubble UI — Cilium network observability
- [ ] HashiCorp Vault
- [ ] External-dns

---

## Przydatne komendy

```bash
# QoS status wszystkich podów
kubectl get pods -n <namespace> -o jsonpath='{range .items[*]}{.metadata.name}{" → "}{.status.qosClass}{"\n"}{end}'

# QoS wszystkich namespace naraz
for ns in flux-test monitoring loki kube-system; do
  echo "=== $ns ==="
  kubectl get pods -n $ns -o jsonpath='{range .items[*]}{.metadata.name}{" → "}{.status.qosClass}{"\n"}{end}'
done

# Sprawdź resources konkretnego poda
kubectl describe pod <nazwa> -n <namespace> | grep -A6 "Limits\|Requests"

# Helm values — weryfikacja nazw kluczy
helm show values <repo>/<chart> | grep -A20 "^<klucz>:"

# Flux image automation
flux get images all -n flux-system
git log --oneline --author="fluxbot"

# metrics-server
kubectl top nodes
kubectl top pods -n <namespace>
kubectl get --raw "/apis/metrics.k8s.io/v1beta1/nodes"

# PrometheusRule
kubectl get prometheusrule -A
kubectl describe prometheusrule homelab-custom-rules -n monitoring
```