# Observability

## kube-prometheus-stack

### What it is

A single Helm chart that installs the complete monitoring stack:

| Component | Role |
|-----------|------|
| **Prometheus** | Time-series metrics collection and storage |
| **Grafana** | Visualization dashboards |
| **AlertManager** | Alert routing and notifications |
| **node-exporter** | Per-node system metrics (DaemonSet) |
| **kube-state-metrics** | Kubernetes object state metrics |

### Installation via Flux

```yaml
# HelmRepository
apiVersion: source.toolkit.fluxcd.io/v1
kind: HelmRepository
metadata:
  name: prometheus-community
  namespace: flux-system
spec:
  interval: 1h
  url: https://prometheus-community.github.io/helm-charts
```

```yaml
# HelmRelease (key values)
apiVersion: helm.toolkit.fluxcd.io/v2
kind: HelmRelease
metadata:
  name: kube-prometheus-stack
  namespace: monitoring
spec:
  interval: 30m
  chart:
    spec:
      chart: kube-prometheus-stack
      version: "82.10.1"
      sourceRef:
        kind: HelmRepository
        name: prometheus-community
        namespace: flux-system
  install:
    createNamespace: true
  values:
    # Disable components k3s doesn't expose in standard form
    kubeControllerManager:
      enabled: false
    kubeScheduler:
      enabled: false
    kubeEtcd:
      enabled: false
    kubeProxy:
      enabled: false   # Cilium replaced kube-proxy

    kubelet:
      enabled: true
      serviceMonitor:
        https: true
        insecureSkipVerify: true
        cAdvisor: true

    grafana:
      enabled: true
      admin:
        existingSecret: grafana-admin-secret
        userKey: admin-user
        passwordKey: admin-password
      ingress:
        enabled: true
        ingressClassName: traefik
        annotations:
          traefik.ingress.kubernetes.io/ssl-redirect: "true"
        hosts:
          - grafana.cluster.kcn333.com
        tls:
          - secretName: grafana-tls
            hosts:
              - grafana.cluster.kcn333.com

    prometheus:
      prometheusSpec:
        hostNetwork: true    # critical for k3s — see below
        hostPID: true
        retention: 7d
        storageSpec:
          volumeClaimTemplate:
            spec:
              storageClassName: longhorn
              accessModes: ["ReadWriteOnce"]
              resources:
                requests:
                  storage: 10Gi
```

### Why disabled components?

k3s embeds some control-plane components and doesn't expose them on standard ports. Trying to scrape them causes persistent errors in Prometheus:

| Component | Why disabled |
|-----------|-------------|
| `kubeControllerManager` | k3s embeds it, non-standard endpoint |
| `kubeScheduler` | Same |
| `kubeEtcd` | Embedded etcd, different port |
| `kubeProxy` | Replaced by Cilium eBPF |

### Problem: no data in Grafana — Cilium blocking pod→nodeIP traffic

**Symptom:** "No data" on Kubernetes Compute Resources dashboards for CPU/Memory.

**Root cause:** Cilium in VXLAN mode doesn't route traffic from pods to node IPs (`192.168.55.x`). Prometheus running as a regular pod couldn't reach kubelet on port 10250 or node-exporter on port 9100 on other nodes.

**Diagnosis:**
```bash
# From Prometheus pod — this failed
kubectl -n monitoring exec -it prometheus-kube-prometheus-stack-prometheus-0 -- \
  wget -qO- --no-check-certificate https://192.168.55.10:10250/healthz

# Internet worked fine — confirming the issue is node IP routing, not network in general
kubectl -n monitoring exec -it prometheus-kube-prometheus-stack-prometheus-0 -- \
  wget -qO- https://8.8.8.8 | head -3
```

**The wrong approach** (tried, don't do this):
```yaml
# Don't — this opens too much
hostServices:
  enabled: true
autoDirectNodeRoutes: true
bpf:
  hostLegacyRouting: true
```

**The right approach — `hostNetwork: true` for Prometheus:**
```yaml
prometheus:
  prometheusSpec:
    hostNetwork: true
    hostPID: true
```

Prometheus runs on the host network, has direct access to kubelet (:10250) and node-exporter (:9100). No Cilium config changes needed. This is the documented approach for k3s + kube-prometheus-stack.

### Problem: UFW blocking port 9100 between nodes

**Symptom:** Only 1 node visible in the "Nodes" Grafana dashboard (the one where Prometheus was scheduled).

Prometheus with `hostNetwork: true` exits with the node's IP (`192.168.55.x`) and tries to reach other nodes. UFW on those nodes didn't have a rule for port 9100.

**Fix:**
```bash
ansible all -m shell -a "ufw allow from 192.168.55.0/24 to any port 9100" -b
```

Add permanently to Ansible playbook:
```yaml
- { port: '9100', proto: 'tcp' }   # node-exporter
```

### Helm subchart keys — gotcha

kube-prometheus-stack is built from subcharts. Each subchart has two key paths — one for the wrapper and one for the actual subchart. Getting these mixed up is a common source of confusion:

```yaml
# WRAPPER — enable/disable and dashboard config
nodeExporter:
  enabled: true

# SUBCHART — resources, affinity, tolerations
prometheus-node-exporter:    # note the hyphen in the key name
  resources:
    requests:
      cpu: 10m
      memory: 32Mi
```

Always verify key names with `helm show values`:
```bash
helm show values prometheus-community/kube-prometheus-stack | grep "prometheus-node-exporter"
```

### Resource requests/limits

After a few days of observing actual usage in Grafana, these were set:

| Component | CPU req | CPU lim | Mem req | Mem lim |
|-----------|---------|---------|---------|---------|
| Prometheus | 200m | 1000m | 1024Mi | 2048Mi |
| Grafana | 50m | 200m | 256Mi | 512Mi |
| AlertManager | 10m | 100m | 64Mi | 128Mi |
| node-exporter | 10m | 100m | 32Mi | 64Mi |
| kube-state-metrics | 10m | 100m | 64Mi | 128Mi |

QoS class: `Burstable` for all — requests < limits, which is appropriate for most workloads.

### Grafana admin password via SealedSecret

```bash
kubectl create secret generic grafana-admin-secret \
  --namespace monitoring \
  --from-literal=admin-user=admin \
  --from-literal=admin-password=YOUR-PASSWORD \
  --dry-run=client -o yaml | \
kubeseal --format yaml \
  --cert ~/.config/kubeseal/pub-sealed-secrets.pem \
  > apps/base/monitoring/grafana-secret-sealed.yaml
```

Reference in HelmRelease:
```yaml
grafana:
  admin:
    existingSecret: grafana-admin-secret
    userKey: admin-user
    passwordKey: admin-password
```

### TLS certificate for Grafana

```yaml
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: grafana-tls
  namespace: monitoring      # must be in same namespace as Ingress
spec:
  secretName: grafana-tls   # name used in Ingress tls.secretName
  dnsNames:
    - grafana.cluster.kcn333.com
  issuerRef:
    name: letsencrypt-prod-cluster-issuer
    kind: ClusterIssuer
```

### Useful Grafana dashboards

| Dashboard | What it shows |
|-----------|--------------|
| Kubernetes / Compute Resources / Cluster | CPU/RAM across the whole cluster |
| Node Exporter / Nodes | Per-node: CPU, RAM, disk, network |
| Kubernetes / Compute Resources / Namespace | Usage per namespace |
| Kubernetes / Compute Resources / Pod | Usage per pod |

---

## AlertManager

### Configuration as SealedSecret

The AlertManager config Secret must be named exactly `alertmanager-kube-prometheus-stack-alertmanager` — kube-prometheus-stack auto-detects it by name.

```bash
cat <<EOF > /tmp/alertmanager.yaml
global:
  resolve_timeout: 5m
route:
  group_by: ['alertname', 'namespace']
  group_wait: 30s
  group_interval: 5m
  repeat_interval: 12h
  receiver: ntfy
  routes:
    - receiver: "null"       # silence noisy startup alerts
      matchers:
        - alertname = "InfoInhibitor"
receivers:
  - name: ntfy
    webhook_configs:
      - url: 'http://ntfy-webhook:8080'
        send_resolved: true
  - name: "null"
EOF

kubectl create secret generic alertmanager-kube-prometheus-stack-alertmanager \
  --namespace monitoring \
  --from-file=alertmanager.yaml=/tmp/alertmanager.yaml \
  --dry-run=client -o yaml | \
kubeseal --format yaml \
  --cert ~/.config/kubeseal/pub-sealed-secrets.pem \
  > apps/base/monitoring/alertmanager-config-sealed.yaml

rm /tmp/alertmanager.yaml
```

**Route ordering matters!** AlertManager uses the **first matching route**. The `null` receiver must come before the default `ntfy` route.

### ntfy webhook adapter

AlertManager sends JSON payloads, but ntfy expects plain text with HTTP headers. There's no native integration — a small Python adapter runs as a Deployment and translates between the two.

Key implementation details:
- `User-Agent: Mozilla/5.0` header is **required** when ntfy is behind Cloudflare Tunnel (returns HTTP 1010 without it)
- `python -u` in the container command disables stdout buffering (required for k8s logs)
- `HTTPServer.allow_reuse_address = True` prevents `Address already in use` on pod restart
- The URL (`NTFY_URL`) can't use `_file` in AlertManager's `webhook_configs` — the whole config must be a SealedSecret

```yaml
# Deployment snippet
command: ["python", "-u", "/app/app.py"]  # -u = unbuffered stdout
env:
  - name: NTFY_URL
    valueFrom:
      secretKeyRef:
        name: alertmanager-ntfy-secret
        key: url
  - name: NTFY_USER
    valueFrom:
      secretKeyRef:
        name: alertmanager-ntfy-secret
        key: username
  - name: NTFY_PASS
    valueFrom:
      secretKeyRef:
        name: alertmanager-ntfy-secret
        key: password
```

### Custom PrometheusRule

Custom alerts as a CRD, managed by Flux. The `release: kube-prometheus-stack` label is mandatory — Prometheus ignores PrometheusRules without it.

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: homelab-custom-rules
  namespace: monitoring
  labels:
    release: kube-prometheus-stack    # required!
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

        - alert: NodeHighMemory
          expr: |
            (1 - (node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes)) * 100 > 85
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "High memory on {{ $labels.instance }}"

        - alert: PodCrashLooping
          expr: |
            increase(kube_pod_container_status_restarts_total[10m]) >= 5
          for: 0m
          labels:
            severity: critical
          annotations:
            summary: "Pod crash-looping: {{ $labels.pod }}"
```

### Alert states

```
inactive → pending → firing
           (expr true)  (for: elapsed)
```

`for: 0m` means fire immediately when the expression is true — useful for critical alerts where every second matters.

### Testing alerts end-to-end

```bash
kubectl port-forward -n monitoring svc/kube-prometheus-stack-alertmanager 9093:9093 &
sleep 2
curl -X POST http://localhost:9093/api/v2/alerts \
  -H "Content-Type: application/json" \
  -d '[{
    "labels": {"alertname": "Test", "severity": "critical", "namespace": "monitoring"},
    "annotations": {"summary": "Test", "description": "Does it work?"},
    "generatorURL": "http://localhost"
  }]'
```

---

## Loki + Promtail

### What it does

Loki is a log aggregation system. Promtail is a log collector that runs as a DaemonSet on each node, scraping pod logs and shipping them to Loki. All logs are then queryable in Grafana alongside metrics.

### Architecture

```
All pods → stdout/stderr
               │
               ▼ (Promtail DaemonSet reads /var/log/pods/)
          Promtail
               │
               ▼
           Loki (SingleBinary mode)
               │
               ▼ S3 (Garage)
               │
           Grafana Explore
```

### Loki installation (SingleBinary mode)

SingleBinary = all Loki components in one pod. Perfect for homelab — low resource overhead.

Key values in HelmRelease:

```yaml
deploymentMode: SingleBinary

loki:
  auth_enabled: false
  commonConfig:
    replication_factor: 1
  storage:
    type: s3
    s3:
      endpoint: http://192.168.0.46:3900    # Garage S3
      region: garage
      s3ForcePathStyle: true
      insecure: true
    bucketNames:
      chunks: loki-logs
      ruler: loki-logs      # required! causes error if missing
      admin: loki-logs
  schemaConfig:
    configs:
      - from: "2024-01-01"
        store: tsdb
        object_store: s3
        schema: v13
        index:
          prefix: loki_index_
          period: 24h
  limits_config:
    retention_period: 7d
  compactor:
    retention_enabled: true
    delete_request_store: s3    # required when retention_enabled: true!

singleBinary:
  replicas: 1

# Disable for homelab — not enough RAM
chunksCache:
  enabled: false
resultsCache:
  enabled: false

# Disable unused components in SingleBinary mode
read:
  replicas: 0
write:
  replicas: 0
backend:
  replicas: 0
gateway:
  enabled: false
test:
  enabled: false
lokiCanary:
  enabled: false
```

### Common Loki errors

| Error | Fix |
|-------|-----|
| `Please define loki.storage.bucketNames.ruler` | Add `bucketNames.ruler: loki-logs` |
| `compactor.delete-request-store should be configured` | Add `delete_request_store: s3` |
| OOM / pod restarts | Disable `chunksCache` and `resultsCache` |

### Promtail config

```yaml
# HelmRelease values
config:
  clients:
    - url: http://loki.loki.svc.cluster.local:3100/loki/api/v1/push
```

### Loki as Grafana datasource

URL: `http://loki.loki.svc.cluster.local:3100`

### LogQL basics

```logql
# Filter by namespace
{namespace="kube-system"}

# Filter by pod name (note: .* not just *)
{namespace="clients", pod=~"clients-api.*"}

# Filter by content
{namespace="clients"} |= "request"

# Exclude specific path
{namespace="clients"} |= "request" != "/actuator"

# Case-insensitive match
{namespace="clients"} |~ "(?i)error"
```

**Common LogQL mistake:** `{pod=~"clients-api*"}` matches `clients-ap`, `clients-api`, `clients-apii`, etc. The `*` in regex means "zero or more of the preceding character". Use `clients-api.*` for "clients-api followed by anything".

---

## Hubble UI (WIP)

### What it is

Hubble is Cilium's built-in network observability layer. It provides a real-time view of all network flows in the cluster — which pods are talking to which, what's being allowed/dropped, latency, etc.

### Architecture

```
Cilium Agent (per node) → port 4244 (gRPC)
         ↑
Hubble Relay (collects flows from all agents)
         ↑
Hubble UI → https://hubble.cluster.kcn333.com
```

### Why it doesn't work in VXLAN mode

The relay pod has an IP from the pod pool (`10.0.x.x`). It tries to connect to Cilium agents on node IPs (`192.168.55.x:4244`). In VXLAN mode, Cilium doesn't route pod→nodeIP traffic — packets disappear in the BPF datapath before reaching the physical interface.

Verified with tcpdump: SYN packets visible on the veth interface but never reaching `enp1s0`.

**Fix requires native routing:**
```yaml
kubeProxyReplacement: true
routingMode: native
autoDirectNodeRoutes: true
ipv4NativeRoutingCIDR: "10.0.0.0/8"
```

Combined with `--disable-kube-proxy` in `k3s.service`.

> ⚠️ This migration **must be done during a full cluster restart** — not as a rolling DaemonSet update. Mixed VXLAN/native routing breaks network connectivity entirely.

### Current Cilium config (VXLAN, Hubble enabled but relay broken)

```yaml
values:
  k8sServiceHost: 192.168.55.10
  k8sServicePort: 6443
  operator:
    replicas: 1
  hubble:
    enabled: true
    tls:
      auto:
        enabled: true
        method: helm
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

The UI and cert are deployed; relay is the blocker.

### Lessons from the debugging marathon

- Check network connectivity before assuming TLS issues — `openssl s_client` from node to node showed TLS was fine; the packets just never arrived
- Switching `kubeProxyReplacement: true` without also setting `routingMode: native` causes instability — Cilium tries to take over services but doesn't have full native routing
- `--disable-kube-proxy` in k3s only makes sense when Cilium is in full `kubeProxyReplacement: true` mode
- Rolling update of the Cilium DaemonSet is not safe for routing mode changes — one node ends up with a different mode, traffic breaks

---

## Useful Commands

```bash
# Prometheus targets
kubectl port-forward -n monitoring svc/kube-prometheus-stack-prometheus 9090:9090 &
# → http://localhost:9090/targets

# AlertManager status
kubectl port-forward -n monitoring svc/kube-prometheus-stack-alertmanager 9093:9093 &
curl -s http://localhost:9093/api/v2/status | python3 -m json.tool | grep -A5 "routes"

# Check active alerts
curl -s http://localhost:9093/api/v2/alerts | python3 -m json.tool | grep -E "alertname|severity|state"

# PrometheusRules
kubectl get prometheusrule -A
kubectl describe prometheusrule homelab-custom-rules -n monitoring

# Loki query via CLI
kubectl port-forward -n loki svc/loki 3100:3100 &
curl -s "http://localhost:3100/loki/api/v1/query_range" \
  --data-urlencode 'query={namespace="kube-system"}' | python3 -m json.tool | head -50

# Hubble / Cilium
kubectl -n kube-system exec ds/cilium -- cilium status | grep -E "Hubble|Cluster health"
kubectl logs -n kube-system deployment/hubble-relay --tail=20

# Flux
flux get helmrelease kube-prometheus-stack -n monitoring
flux reconcile helmrelease kube-prometheus-stack -n monitoring
```
