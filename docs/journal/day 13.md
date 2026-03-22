# 13 - Alerts 

# K3s Homelab — Sesja 13

**Data:** 2026-03-13  
**Środowisko:** 3x HP T630, k3s v1.34.4, Flux v2.8.1, Cilium v1.19.1

---

## Co zbudowaliśmy

1. **AlertManager — wyciszenie InfoInhibitor** — null receiver dla szumów przy starcie klastra
2. **PrometheusRule dla clients-api** — 3 własne alerty aplikacyjne
3. **Pod Disruption Budget** — ochrona dostępności podczas maintenance
4. **Hubble UI** — częściowo (ingress + certyfikat działają, relay niestabilny — do dokończenia)
5. **Naprawka UFW** — port 4240 (Cilium health), 4244 (Hubble), CIDR `/8` zamiast `/16`

---

## Czego się nauczyłem

### 1. AlertManager — null receiver (wyciszanie szumów)

**Problem:** Przy każdym starcie klastra przychodziły dziesiątki powiadomień `InfoInhibitor` — normalny stan przejściowy, nie błąd.

**Rozwiązanie:** Route z `receiver: "null"` — AlertManager porzuca alerty bez wysyłania.

```yaml
route:
  receiver: ntfy
  routes:
    - receiver: "null"          # musi być przed domyślnym routem
      matchers:
        - alertname = "InfoInhibitor"
receivers:
  - name: ntfy
    webhook_configs:
      - url: 'http://ntfy-webhook:8080'
        send_resolved: true
  - name: "null"                # pusty receiver — porzuca alerty
```

**Ważna zasada:** AlertManager stosuje **pierwszy pasujący route**. `null` musi być wyżej niż domyślny `ntfy`.

**Weryfikacja:**

```bash
kubectl port-forward -n monitoring svc/kube-prometheus-stack-alertmanager 9093:9093
curl -s http://localhost:9093/api/v2/status | python3 -m json.tool | grep -A30 "config"
```

---

### 2. PrometheusRule — własne alerty aplikacyjne

**Krytyczny label — bez niego Prometheus ignoruje regułę:**

```yaml
metadata:
  labels:
    release: kube-prometheus-stack
```

**Trzy alerty dla clients-api:**

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: clients-api-rules
  namespace: monitoring
  labels:
    release: kube-prometheus-stack
spec:
  groups:
    - name: clients-api
      interval: 1m
      rules:

        - alert: ClientsApiHighErrorRate
          expr: |
            (
              sum(rate(http_server_requests_seconds_count{application="clients-api", status=~"5.."}[5m]))
              or vector(0)
            )
            /
            sum(rate(http_server_requests_seconds_count{application="clients-api"}[5m]))
            * 100 > 1
          for: 5m
          labels:
            severity: warning
            namespace: clients
          annotations:
            summary: "clients-api high error rate"
            description: "Error rate is {{ printf \"%.2f\" $value }}% (threshold: 1%)"

        - alert: ClientsApiHighLatency
          expr: |
            histogram_quantile(0.99,
              sum by(le) (
                rate(http_server_requests_seconds_bucket{application="clients-api", uri="/api/clients"}[5m])
              )
            ) * 1000 > 2000
          for: 5m
          labels:
            severity: warning
            namespace: clients
          annotations:
            summary: "clients-api high p99 latency"
            description: "p99 latency is {{ printf \"%.0f\" $value }}ms (threshold: 2000ms)"

        - alert: ClientsApiPodRestarting
          expr: |
            increase(kube_pod_container_status_restarts_total{
              namespace="clients",
              container="clients-api"
            }[1h]) > 3
          for: 0m
          labels:
            severity: critical
            namespace: clients
          annotations:
            summary: "clients-api pod restarting"
            description: "Pod {{ $labels.pod }} restarted {{ printf \"%.0f\" $value }} times in the last hour"
```

**Kluczowe parametry:**

|Parametr|Znaczenie|
|:--|:--|
|`for: 5m`|Alert musi być aktywny 5 min przed wysłaniem — ochrona przed spikami|
|`for: 0m`|Alert wysyłany natychmiast — każda sekunda ważna (pod restarty)|
|`or vector(0)`|Gdy zero błędów — pokaż 0 zamiast "No data"|

**Stany alertu:**

```
inactive → pending → firing
          (expr=true)  (for: upłynął)
```

**Weryfikacja:**

```bash
curl -s http://localhost:9090/api/v1/rules?type=alert | python3 -c "
import sys, json
data = json.load(sys.stdin)
for group in data['data']['groups']:
    if group['name'] == 'clients-api':
        for rule in group['rules']:
            print(f\"{rule['name']}: {rule['state']}\")
"
# ClientsApiHighErrorRate: inactive
# ClientsApiHighLatency: inactive
# ClientsApiPodRestarting: inactive
```

**Test end-to-end — sztuczny alert:**

```bash
curl -X POST http://localhost:9093/api/v2/alerts \
  -H "Content-Type: application/json" \
  -d '[{
    "labels": {"alertname": "ClientsApiHighErrorRate", "severity": "warning", "namespace": "clients"},
    "annotations": {"summary": "clients-api high error rate", "description": "Error rate is 5.23%"},
    "generatorURL": "http://localhost:9090"
  }]'
```

---

### 3. Pod Disruption Budget (PDB)

**Problem:** Podczas `kubectl drain` (aktualizacja nodów) Kubernetes może ewakuować wszystkie pody jednocześnie. Jeśli HPA zdecydował że wystarczą 2 pody i oba są na tym samym nodzie — aplikacja pada całkowicie.

**PDB gwarantuje:** podczas jakiejkolwiek operacji maintenance zawsze zostanie co najmniej X działających podów.

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

**Weryfikacja:**

```bash
kubectl get pdb -n clients
# NAME              MIN AVAILABLE   MAX UNAVAILABLE   ALLOWED DISRUPTIONS
# clients-api-pdb   1               N/A               1
```

`ALLOWED DISRUPTIONS: 1` = Kubernetes może bezpiecznie usunąć 1 pod przy 2 działających.

**`minAvailable` vs `maxUnavailable`:**

```
minAvailable: 1   → zawsze co najmniej 1 pod DZIAŁA
maxUnavailable: 1 → maksymalnie 1 pod może być NIEDOSTĘPNY jednocześnie
```

---

### 4. Hubble UI — architektura i debugging (WIP)

**Architektura:**

```
Cilium Agent (każdy node) → port 4244 (gRPC)
        ↑
Hubble Relay (zbiera flows ze wszystkich nodów)
        ↑
Hubble UI → https://hubble.cluster.kcn333.com
```

**Porty wymagane w UFW:**

|Port|Protokół|Użycie|
|:--|:--|:--|
|4244|TCP|Hubble gRPC (relay → agent)|
|4240|TCP|Cilium cluster health checks|

**Root causes napotkane dziś:**

1. UFW blokował port 4244 → `No connection to peer`
2. UFW blokował port 4240 → `Cluster health: 1/3 reachable`
3. CIDR podów `/8` zamiast `/16` → część ruchu blokowana
4. Wielokrotna zmiana TLS on/off → niespójny stan certyfikatów relay

**Po naprawach:** `Cluster health: 3/3 reachable` ✅ ale relay nadal niestabilny przez niespójne certyfikaty — wymaga reinstalacji Cilium.

**Lekcja:** Nigdy nie przełączaj TLS Cilium w działającym klastrze bez pełnego restartu — zostawia niespójny stan wewnętrznych certyfikatów.

**Aktualny stan HelmRelease Cilium:**

```yaml
values:
  k8sServiceHost: 192.168.55.10
  k8sServicePort: 6443
  operator:
    replicas: 1
  hubble:
    enabled: true
    relay:
      enabled: true
    ui:
      enabled: true
      ingress:
        enabled: true
        ingressClassName: traefik
        hosts:
          - hubble.cluster.kcn333.com
        tls:
          - secretName: hubble-tls
            hosts:
              - hubble.cluster.kcn333.com
```

---

### 5. UFW — co dodaliśmy dziś

```yaml
# Cilium health checks między nodami
- rule: allow
  from_ip: 192.168.55.0/24
  port: '4240'
  proto: tcp

# Hubble relay → agent
- rule: allow
  from_ip: 192.168.55.0/24
  port: '4244'
  proto: tcp

# Pod network — rozszerzenie z /16 na /8
- name: Allow pod network traffic
  community.general.ufw:
    rule: allow
    from_ip: 10.0.0.0/8    # Cilium cluster-pool używa /8!
```

**Jak sprawdzić CIDR podów przed otwieraniem portów:**

```bash
kubectl get configmap -n kube-system cilium-config -o yaml | grep cluster-pool-ipv4-cidr
# cluster-pool-ipv4-cidr: 10.0.0.0/8
```

---

## Backlog (do zrobienia)

- [ ] **Hubble UI** — reinstalacja Cilium (helm uninstall + reinstall przez Flux) ← następna sesja
- [ ] PrometheusRule — dodatkowe alerty (high CPU/RAM)
- [ ] Grafana dashboard — zapis jako ConfigMap w Git
- [ ] Progressive delivery (staging/production branches)
- [ ] HashiCorp Vault
- [ ] External-dns
- [ ] RBAC — własni użytkownicy
- [ ] Upgrade ImageUpdateAutomation v1beta2 → v1 (Flux deprecation warning)

---

## Przydatne komendy

```bash
# AlertManager
kubectl port-forward -n monitoring svc/kube-prometheus-stack-alertmanager 9093:9093 &
curl -s http://localhost:9093/api/v2/status | python3 -m json.tool | grep -A5 "routes"

# Test alertu
curl -X POST http://localhost:9093/api/v2/alerts \
  -H "Content-Type: application/json" \
  -d '[{"labels":{"alertname":"Test","severity":"critical"},"annotations":{"summary":"Test"},"generatorURL":"http://localhost"}]'

# PrometheusRule
kubectl get prometheusrule -n monitoring
kubectl port-forward -n monitoring svc/kube-prometheus-stack-prometheus 9090:9090 &
curl -s http://localhost:9090/api/v1/rules?type=alert | python3 -m json.tool | grep "clients-api"

# PDB
kubectl get pdb -n clients
kubectl describe pdb clients-api-pdb -n clients

# Hubble / Cilium
kubectl get pod -n kube-system -l app.kubernetes.io/name=hubble-relay
kubectl logs -n kube-system deployment/hubble-relay --tail=20
kubectl exec -n kube-system ds/cilium -- cilium status | grep -E "Hubble|Cluster health"

# UFW weryfikacja
ansible all -m shell -a "ufw status | grep -E '4240|4244|10.0'" -b
```