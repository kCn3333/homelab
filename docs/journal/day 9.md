# K3s Homelab — Sesja 09

**Data:** 2026-03-08  
**Środowisko:** 3x HP T630, k3s v1.34.4, Flux v2.8.1, Cilium v1.19.1

---

## Co zbudowaliśmy

1. **AlertManager + ntfy** — powiadomienia push przez własny webhook adapter
2. **Garage v2.2.0 na Debianie** — self-hosted S3 storage (25GB)
3. **Longhorn backup na Garage** — automatyczne backupy wolumenów do S3
4. **Loki + Promtail** — centralny stack logów dla całego klastra
5. **NTP synchronizacja** — poprawka zegarów na workerach

---

## Czego się nauczyłem

### 1. AlertManager + ntfy przez webhook adapter

**Problem:** AlertManager wysyła JSON, ntfy oczekuje prostego tekstu z nagłówkami HTTP. Nie ma natywnej integracji.

**Rozwiązanie:** Własny Python webhook adapter jako ConfigMap + Deployment.

**Ważne lekcje:**

- `url` w `webhook_configs` nie obsługuje `_file` — nie można ukryć URL przez Secret
- Właściwe rozwiązanie: cała konfiguracja AlertManagera jako SealedSecret
- Nazwa Secretu musi być dokładnie `alertmanager-kube-prometheus-stack-alertmanager` — kube-prometheus-stack go automatycznie wykrywa
- Jeśli Secret o tej nazwie już istnieje (tworzony przez Helm) — usuń go przed zastosowaniem SealedSecreta

```bash
# Usuń istniejący Secret żeby SealedSecret mógł go przejąć
kubectl delete secret alertmanager-kube-prometheus-stack-alertmanager -n monitoring

# Stwórz config AlertManagera jako SealedSecret
cat <<EOF > /tmp/alertmanager.yaml
global:
  resolve_timeout: 5m
route:
  group_by: ['alertname', 'namespace']
  group_wait: 30s
  group_interval: 5m
  repeat_interval: 12h
  receiver: ntfy
receivers:
  - name: ntfy
    webhook_configs:
      - url: 'http://ntfy-webhook:8080'
        send_resolved: true
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

**ntfy-webhook adapter — kluczowe rzeczy:**

- `User-Agent: Mozilla/5.0` — **wymagane** gdy ntfy jest za Cloudflare Tunnel (error 1010 bez tego)
- `flush=True` w print() — wymagane do logów w Kubernetes
- `HTTPServer.allow_reuse_address = True` — zapobiega `Address already in use` przy restarcie
- `python -u` w command — wyłącza buforowanie stdout

```yaml
# ConfigMap z adapterem
data:
  app.py: |
    import json, os, urllib.request, base64
    from http.server import HTTPServer, BaseHTTPRequestHandler

    NTFY_URL = os.environ["NTFY_URL"]
    NTFY_USER = os.environ["NTFY_USER"]
    NTFY_PASS = os.environ["NTFY_PASS"]

    PRIORITY_MAP = {"critical": "urgent", "warning": "high", "info": "default"}
    TAGS_MAP = {"critical": "rotating_light", "warning": "warning", "info": "information_source"}

    def send_ntfy(title, message, priority, tags):
        credentials = base64.b64encode(f"{NTFY_USER}:{NTFY_PASS}".encode()).decode()
        req = urllib.request.Request(NTFY_URL, data=message.encode(), method="POST")
        req.add_header("Authorization", f"Basic {credentials}")
        req.add_header("Title", title)
        req.add_header("Priority", priority)
        req.add_header("Tags", tags)
        req.add_header("Content-Type", "text/plain")
        req.add_header("User-Agent", "Mozilla/5.0")  # ← wymagane dla Cloudflare!
        urllib.request.urlopen(req, timeout=5)

    # ... reszta handlera
    HTTPServer.allow_reuse_address = True
    HTTPServer(("0.0.0.0", 8080), Handler).serve_forever()
```

**Deployment:**

```yaml
command: ["python", "-u", "/app/app.py"]  # -u = unbuffered
```

**SealedSecret z credentials ntfy:**

```bash
kubectl create secret generic alertmanager-ntfy-secret \
  --namespace monitoring \
  --from-literal=username=kCn \
  --from-literal=password=HASLO \
  --from-literal=url=https://ntfy.kcn333.com/TOPIC \
  --dry-run=client -o yaml | \
kubeseal --format yaml \
  --cert ~/.config/kubeseal/pub-sealed-secrets.pem \
  > apps/base/monitoring/alertmanager-ntfy-sealed.yaml
```

**Test end-to-end:**

```bash
kubectl port-forward -n monitoring svc/kube-prometheus-stack-alertmanager 9093:9093 &
sleep 2
curl -X POST http://localhost:9093/api/v2/alerts \
  -H "Content-Type: application/json" \
  -d '[{
    "labels": {"alertname": "Test", "severity": "critical", "namespace": "monitoring"},
    "annotations": {"summary": "Test", "description": "Dziala?"},
    "generatorURL": "http://localhost"
  }]'
```

**Aktywne alerty które znaleźliśmy:**

- `NodeClockNotSynchronising` — NTP nie działa (naprawione)
- `Watchdog` — heartbeat, powinien być zawsze aktywny ✅
- `KubeAggregatedAPIDown` — metrics-server ma problemy
- `KubeDeploymentReplicasMismatch` — przejściowe, samo się naprawiło

---

### 2. NTP synchronizacja klastra

**Problem:** Worker1 i Worker2 miały `System clock synchronized: no`. Wskazywały na `192.168.55.12` (worker2) jako serwer NTP — ale worker2 nie jest serwerem NTP!

**Root cause:** Błędna konfiguracja timesyncd na workerach.

**Rozwiązanie — Ansible playbook:**

```yaml
- name: Sync time across cluster
  hosts: workers
  become: true
  tasks:
    - name: Configure timesyncd
      ansible.builtin.copy:
        dest: /etc/systemd/timesyncd.conf
        content: |
          [Time]
          NTP=192.168.55.10
          FallbackNTP=ntp.ubuntu.com
          RootDistanceMaxSec=5
          PollIntervalMinSec=32
          PollIntervalMaxSec=2048

    - name: Enable and restart timesyncd
      ansible.builtin.systemd:
        name: systemd-timesyncd
        state: restarted
        enabled: true

    - name: Wait for sync
      ansible.builtin.shell: |
        for i in $(seq 1 10); do
          timedatectl status | grep -q "synchronized: yes" && exit 0
          sleep 3
        done
        exit 1
      changed_when: false
```

**Ważne:** Master używa **chrony** (nie timesyncd) — nie ruszaj go! Dodaj regułę UFW na masterze:

```bash
ufw allow from 192.168.55.0/24 to any port 123 proto udp
```

---

### 3. Garage v2.2.0 — self-hosted S3

**Garage** — lekki rozproszony S3, napisany w Rust, idealny na homelab.

**docker-compose.yml:**

```yaml
services:
  garage:
    image: dxflrs/garage:v2.2.0
    restart: unless-stopped
    ports:
      - "3900:3900"   # S3 API
      - "3901:3901"   # RPC
      - "3902:3902"   # Admin API
    volumes:
      - /home/kcn/k8s/garage/data:/var/lib/garage/data
      - /home/kcn/k8s/garage/meta:/var/lib/garage/meta
      - /home/kcn/k8s/garage.toml:/etc/garage.toml:ro
    environment:
      - RUST_LOG=garage=info
```

**garage.toml (v2.x):**

```toml
metadata_dir = "/var/lib/garage/meta"
data_dir = "/var/lib/garage/data"
db_engine = "lmdb"
replication_factor = 1

rpc_secret = "WYGENERUJ_openssl_rand_hex_32"
rpc_bind_addr = "[::]:3901"
rpc_public_addr = "192.168.0.46:3901"

[s3_api]
api_bind_addr = "[::]:3900"
s3_region = "garage"

[s3_web]
bind_addr = "[::]:3903"
root_domain = ".s3.cluster.kcn333.com"

[admin]
api_bind_addr = "0.0.0.0:3902"
admin_token = "WYGENERUJ_LOSOWY_TOKEN"
```

**Inicjalizacja:**

```bash
# Pobierz Node ID
docker exec -it garage-garage-1 /garage node id

# Przydziel pojemność
docker exec -it garage-garage-1 /garage layout assign \
  NODE_ID -z dc1 -c 25G

# Zatwierdź
docker exec -it garage-garage-1 /garage layout apply --version 1

# Stwórz klucz
docker exec -it garage-garage-1 /garage key create k3s-homelab

# Stwórz buckety
docker exec -it garage-garage-1 /garage bucket create longhorn-backup
docker exec -it garage-garage-1 /garage bucket create loki-logs

# Nadaj uprawnienia
docker exec -it garage-garage-1 /garage bucket allow longhorn-backup \
  --read --write --owner --key k3s-homelab
docker exec -it garage-garage-1 /garage bucket allow loki-logs \
  --read --write --owner --key k3s-homelab
```

**Test z klastra:**

```bash
kubectl run s3-test --image=amazon/aws-cli --rm -it --restart=Never \
  --env="AWS_ACCESS_KEY_ID=KEY_ID" \
  --env="AWS_SECRET_ACCESS_KEY=SECRET_KEY" \
  -- s3 ls --endpoint-url http://192.168.0.46:3900 --region garage
```

---

### 4. Longhorn backup na Garage S3

**Longhorn v1.11 używa `BackupTarget` CRD** (nie `Setting`!):

```yaml
# apps/base/longhorn/backuptarget.yaml
apiVersion: longhorn.io/v1beta2
kind: BackupTarget
metadata:
  name: default
  namespace: longhorn-system
spec:
  backupTargetURL: s3://longhorn-backup@garage/
  credentialSecret: longhorn-s3-secret
  pollInterval: 300s    # ← musi być "s" na końcu!
```

**SealedSecret z credentials:**

```bash
kubectl create secret generic longhorn-s3-secret \
  --namespace longhorn-system \
  --from-literal=AWS_ACCESS_KEY_ID=KEY_ID \
  --from-literal=AWS_SECRET_ACCESS_KEY=SECRET_KEY \
  --from-literal=AWS_ENDPOINTS=http://192.168.0.46:3900 \
  --from-literal=AWS_CERT="" \
  --dry-run=client -o yaml | \
kubeseal --format yaml \
  --cert ~/.config/kubeseal/pub-sealed-secrets.pem \
  > apps/base/longhorn/longhorn-s3-secret-sealed.yaml
```

**RecurringJob — automatyczne backupy:**

```yaml
# apps/base/longhorn/recurringjob.yaml
apiVersion: longhorn.io/v1beta2
kind: RecurringJob
metadata:
  name: daily-backup
  namespace: longhorn-system
spec:
  cron: "0 11 * * *"
  task: backup
  groups:
    - default
  retain: 2
  concurrency: 1
  labels:
    backup: daily
```

**Weryfikacja:**

```bash
kubectl -n longhorn-system describe backuptarget default
# Status.Available: true ← sukces!

docker exec -it garage-garage-1 /garage bucket info longhorn-backup
# Size > 0 ← dane trafiają do Garage
```

---

### 5. Loki + Promtail stack

**Loki v6.53.0 w trybie SingleBinary** — wszystko w jednym podzie, idealne dla homelaba.

**Kluczowe ustawienia values:**

```yaml
deploymentMode: SingleBinary

loki:
  auth_enabled: false
  commonConfig:
    replication_factor: 1
  storage:
    type: s3
    s3:
      endpoint: http://192.168.0.46:3900
      region: garage
      s3ForcePathStyle: true
      insecure: true
    bucketNames:
      chunks: loki-logs
      ruler: loki-logs    # ← wymagane! bez tego błąd
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
    delete_request_store: s3    # ← wymagane gdy retention_enabled: true!

singleBinary:
  replicas: 1
  extraEnv:
    - name: AWS_ACCESS_KEY_ID
      valueFrom:
        secretKeyRef:
          name: loki-s3-secret
          key: AWS_ACCESS_KEY_ID
    - name: AWS_SECRET_ACCESS_KEY
      valueFrom:
        secretKeyRef:
          name: loki-s3-secret
          key: AWS_SECRET_ACCESS_KEY

# Wyłącz dla SingleBinary
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

# Wyłącz memcached — za mało RAM na homelabie!
chunksCache:
  enabled: false
resultsCache:
  enabled: false
```

**Typowe błędy przy instalacji Loki:**

|Błąd|Rozwiązanie|
|---|---|
|`Please define loki.storage.bucketNames.ruler`|Dodaj `bucketNames.ruler: loki-logs`|
|`compactor.delete-request-store should be configured`|Dodaj `delete_request_store: s3`|
|`Insufficient memory`|Wyłącz `chunksCache` i `resultsCache`|

**Promtail values:**

```yaml
config:
  clients:
    - url: http://loki.loki.svc.cluster.local:3100/loki/api/v1/push
```

**Dodanie Loki jako datasource w Grafanie:**

- URL: `http://loki.loki.svc.cluster.local:3100`

**Przykładowe query w Explore:**

```
{namespace="kube-system"}
{namespace="monitoring"}
{app="ntfy-webhook"}
{namespace="loki"} |= "error"
```

---

### 6. Problemy które napotkaliśmy

**Problem: metrics-server nie działa**

- metrics-server zarządzany przez k3s Addon — nie można go edytować przez Deployment (k3s nadpisuje)
- `hostNetwork: true` koliduje z `--secure-port=10250` (port zajęty przez kubelet)
- **Decyzja:** Zostawiamy — Grafana ma pełne metryki przez node-exporter, `kubectl top` nie jest krytyczne

**Problem: UFW blokuje port 9100 dla node-exporter**

- Prometheus z `hostNetwork: true` wychodzi z IP noda
- UFW na innych nodach blokował port 9100
- **Rozwiązanie:** `ufw allow from 192.168.55.0/24 to any port 9100`

**Problem: Stary Ingress `minimal-ingress` w flux-test**

- Traefik logował błąd `secret flux-test/local-prod-kcn333-tls does not exist`
- Odkryty dzięki Loki!
- **Rozwiązanie:** `kubectl delete ingress minimal-ingress -n flux-test`

---

## Finalna struktura repo

```
k3s-homelab/
├── apps/
│   └── base/
│       ├── kustomization.yaml
│       ├── cilium/
│       ├── longhorn/
│       │   ├── backuptarget.yaml          # ← NOWE
│       │   ├── longhorn-s3-secret-sealed.yaml  # ← NOWE
│       │   ├── recurringjob.yaml          # ← NOWE
│       │   └── ...
│       ├── loki/                          # ← NOWE
│       │   ├── helmrelease.yaml
│       │   ├── kustomization.yaml
│       │   ├── loki-s3-secret-sealed.yaml
│       │   └── namespace.yaml
│       ├── monitoring/
│       │   ├── alertmanager-config-sealed.yaml  # ← NOWE
│       │   ├── alertmanager-ntfy-sealed.yaml    # ← NOWE
│       │   ├── ntfy-webhook.yaml                # ← NOWE
│       │   └── ...
│       ├── nginx/
│       ├── promtail/                      # ← NOWE
│       │   ├── helmrelease.yaml
│       │   └── kustomization.yaml
│       ├── sealed-secrets/
│       └── traefik-dashboard/
```

---

## Backlog

- [ ] **AlertManager rules** — własne reguły alertów (high CPU/RAM threshold)
- [ ] Hubble UI — Cilium network observability
- [ ] NetworkPolicy — izolacja między podami
- [ ] Własna aplikacja (Spring Boot) + CI/CD pipeline
- [ ] HashiCorp Vault
- [ ] External-dns
- [ ] Progressive delivery (staging/production)
- [ ] RBAC
- [ ] Upgrade ImageUpdateAutomation v1beta2 → v1 (Flux deprecation warning)
- [ ] Upgrade ImagePolicy v1beta2 → v1 (Flux deprecation warning)

---

## Przydatne komendy

```bash
# AlertManager test
kubectl port-forward -n monitoring svc/kube-prometheus-stack-alertmanager 9093:9093 &
sleep 2
curl -X POST http://localhost:9093/api/v2/alerts \
  -H "Content-Type: application/json" \
  -d '[{"labels":{"alertname":"Test","severity":"critical"},"annotations":{"summary":"Test"},"generatorURL":"http://localhost"}]'

# Sprawdź aktywne alerty
curl -s http://localhost:9093/api/v2/alerts | python3 -m json.tool | grep -E "alertname|severity|state"

# Garage
docker exec -it garage-garage-1 /garage status
docker exec -it garage-garage-1 /garage bucket info longhorn-backup
docker exec -it garage-garage-1 /garage bucket info loki-logs

# Loki query przez CLI
kubectl port-forward -n loki svc/loki 3100:3100 &
curl -s "http://localhost:3100/loki/api/v1/query_range" \
  --data-urlencode 'query={namespace="kube-system"}' | python3 -m json.tool | head -50

# NTP status
ansible all -m shell -a "timedatectl status | grep sync" -b
```