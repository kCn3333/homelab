# Networking

This section covers everything network-related: the external load balancer, the CNI (Cilium), and network isolation via NetworkPolicy.

---

## HAProxy — External Load Balancer

### What it does

HAProxy runs on a separate Debian server and serves as the single entry point for all cluster traffic. It load-balances across all three nodes and handles TLS passthrough for both the API server and Traefik.

```
Internet / LAN
      │
      ▼
HAProxy (192.168.0.45)
  :6443 → k3s API Server   (mode tcp, TLS passthrough)
  :80   → Traefik HTTP     (mode http)
  :443  → Traefik HTTPS    (mode tcp, TLS passthrough)
```

### IP alias setup on Debian

HAProxy listens on a virtual IP `192.168.0.45`, separate from the host's main IP `192.168.0.46`. This is done via an interface alias in `/etc/network/interfaces`:

```
auto enp1s0:0
iface enp1s0:0 inet static
    address 192.168.0.45
    netmask 255.255.255.0
```

Apply without full network restart:
```bash
sudo ifup enp1s0:0
```

Don't use `systemctl restart networking` over SSH — you'll lose the connection.

### HAProxy config

```haproxy
frontend k8s-api
    bind 192.168.0.45:6443
    mode tcp          # TLS passthrough — HAProxy doesn't see the content

frontend ingress-http
    bind 192.168.0.45:80
    mode http         # HTTP — Traefik handles redirects

frontend ingress-https
    bind 192.168.0.45:443
    mode tcp          # TLS passthrough — Traefik terminates TLS
```

### mode tcp vs mode http

- `mode tcp` — HAProxy passes raw bytes through, never sees packet content. TLS is terminated by the backend (API server / Traefik). HAProxy doesn't need a certificate.
- `mode http` — HAProxy understands HTTP, can modify headers, but requires decrypting TLS (needs the private key).

For k8s API and HTTPS ingress → always `mode tcp`.

### Health check pitfall

`option httpchk GET /healthz` doesn't work with `mode tcp` — HAProxy can't parse HTTP in TCP mode. Also, Traefik returns `404` on unknown paths, which HAProxy considers unhealthy by default.

Solutions:
- Remove `check` from backends entirely (simplest for homelab)
- Use `http-check expect status 200,301,302,404`

The debugging lesson: remove health checks first to confirm routing works, then fix health checks separately.

---

## Cilium CNI

### Why Cilium (and why we migrated from Flannel)

Flannel was the default CNI in k3s and worked fine — until a hard power-off. Flannel stores its `subnet.env` in `/run/flannel/` which is a `tmpfs` (lives in RAM). After a hard shutdown, that file disappears and Flannel can't initialize the network on restart, leaving all pods stuck in `ContainerCreating`.

Cilium doesn't have this problem. It also brings:
- eBPF instead of iptables — better performance, lower overhead
- Built-in NetworkPolicy support
- Hubble for network observability
- Production standard in enterprise environments

### Migration from Flannel to Cilium

**Step 1 — Snapshot etcd first**
```bash
ssh master "sudo k3s etcd-snapshot save --name pre-cilium-migration"
```

**Step 2 — Stop k3s on all nodes**
```bash
ansible all -m systemd -a "name=k3s state=stopped" -b
```

**Step 3 — Clean up Flannel**
```bash
ansible all -m shell -a "
rm -rf /run/flannel
rm -rf /var/lib/cni
rm -rf /etc/cni/net.d/*
ip link delete flannel.1 2>/dev/null || true
ip link delete cni0 2>/dev/null || true
" -b
```

**Step 4 — Update k3s.service flags** (on each node)

Add to the `ExecStart` block:
```
'--flannel-backend=none'
'--disable-network-policy'
```

**Step 5 — Start the cluster (HA quorum matters!)**

In a 3-node HA cluster, etcd needs quorum (2/3 nodes) before it can elect a leader. Don't wait too long between starting master and workers.

```bash
# Start master
ssh master "sudo systemctl daemon-reload && sudo systemctl start k3s"

# Start workers in parallel soon after
ssh worker1 "sudo systemctl daemon-reload && sudo systemctl start k3s" &
ssh worker2 "sudo systemctl daemon-reload && sudo systemctl start k3s" &
```

Watch for `prober detected unhealthy status` in etcd logs — that's your cue to start the workers.

**Step 6 — Install Cilium via Helm**

```bash
helm repo add cilium https://helm.cilium.io/
helm repo update

helm install cilium cilium/cilium \
  --version 1.19.1 \
  --namespace kube-system \
  --set k8sServiceHost=192.168.55.10 \
  --set k8sServicePort=6443 \
  --set operator.replicas=1
```

**Why a direct IP instead of hostname?** Cilium during bootstrap can't use DNS because:
- DNS runs as CoreDNS pods
- Pods can't start without CNI
- CNI (Cilium) can't connect without DNS → deadlock

Direct IP breaks the cycle.

**Step 7 — Move to Flux as HelmRelease**

```yaml
apiVersion: helm.toolkit.fluxcd.io/v2
kind: HelmRelease
metadata:
  name: cilium
  namespace: kube-system
  annotations:
    meta.helm.sh/release-name: cilium
    meta.helm.sh/release-namespace: kube-system
spec:
  interval: 30m
  chart:
    spec:
      chart: cilium
      version: "1.19.1"
      sourceRef:
        kind: HelmRepository
        name: cilium
        namespace: flux-system
      interval: 12h
  install:
    createNamespace: false
  upgrade:
    remediation:
      retries: 3
  values:
    k8sServiceHost: 192.168.55.10
    k8sServicePort: 6443
    operator:
      replicas: 1
```

### Verifying Cilium

```bash
cilium status
cilium connectivity test --test no-policies
```

Expected output:
```
Cilium:          OK
Operator:        OK
Envoy DaemonSet: OK
Cluster Pods:    53/53 managed by Cilium
```

### Routing modes — important context

| Mode | Description | Pod→NodeIP | kube-proxy needed |
|------|-------------|-----------|------------------|
| VXLAN (tunnel) | L3 encapsulation, works everywhere | ❌ | Yes |
| Native routing | Direct L2 routing, same subnet required | ✅ | No |

The cluster currently runs in **VXLAN mode** with k3s kube-proxy. Native routing requires `kubeProxyReplacement: true` + `routingMode: native` + `--disable-kube-proxy` in k3s — and **must be set up from scratch or during a full cluster restart**, not as a rolling update.

> ⚠️ Attempting to switch routing modes via rolling DaemonSet update will break the cluster. One node ends up with native routing while others still use VXLAN — traffic falls apart. Ask me how I know.

### Incident: Cilium crashloop taking down the network

During the initial Cilium install, the DaemonSet entered a crashloop (couldn't connect to the API server) and corrupted network interfaces in the process. Master and worker1 became unreachable even by ping.

Recovery was done from worker2:
```bash
# From worker2 — poll until the API comes back up
while true; do
  kubectl delete daemonset cilium cilium-envoy -n kube-system \
    --force --grace-period=0 2>/dev/null && echo "DONE!" && break
  sleep 2
done
# Then physically restart the affected node
```

Lesson: in a 3-node cluster, always keep at least one node out of dangerous operations. worker2 saved the day here.

### Namespace stuck in Terminating

```bash
kubectl get namespace <name> -o json | \
  python3 -c "import sys,json; d=json.load(sys.stdin); d['spec']['finalizers']=[]; print(json.dumps(d))" | \
  kubectl replace --raw /api/v1/namespaces/<name>/finalize -f -
```

---

## NetworkPolicy

### Default behavior without NetworkPolicy

Every pod can connect to every other pod across all namespaces. Zero isolation.

### How NetworkPolicy works in Cilium

Cilium enforces NetworkPolicy at the eBPF level. When a policy exists for a pod, Cilium uses **DROP** (silently discard) by default — not REJECT. This means blocked connections just time out rather than getting an immediate "connection refused", which leaks less information.

### Example: isolating the database

Only the `clients-api` pods should be able to reach the PostgreSQL database:

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: clients-db-allow-only-api
  namespace: clients
spec:
  podSelector:
    matchLabels:
      cnpg.io/cluster: clients-db   # targets the DB pods
  policyTypes:
    - Ingress
  ingress:
    - from:
        - podSelector:
            matchLabels:
              app: clients-api      # only allow from clients-api
      ports:
        - protocol: TCP
          port: 5432
```

### Example: application ingress policy

Allow traffic only from Traefik (kube-system) and Prometheus (monitoring), plus intra-namespace traffic for helm tests:

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: clients-api-ingress
  namespace: clients
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
              kubernetes.io/metadata.name: kube-system
      ports:
        - protocol: TCP
          port: 8080
    - from:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: monitoring
      ports:
        - protocol: TCP
          port: 8080
    - from:
        - podSelector: {}   # all pods in same namespace (for helm tests)
      ports:
        - protocol: TCP
          port: 8080
```

Note: `podSelector: {}` is an empty selector matching all pods in the namespace where the NetworkPolicy lives.

### Verifying isolation

```bash
# Run a pod without app=clients-api label
kubectl run test-isolation --rm -it \
  --image=postgres:17 \
  --restart=Never \
  -n clients \
  -- psql -h clients-db-rw -U app -d clients_db -c "SELECT 1"

# If it hangs without responding → NetworkPolicy is working ✅
# Cilium DROP = silence, not "connection refused"
```

---

## UFW Port Reference

Ports needed for k3s + Cilium. Managed via Ansible playbook — see [security/ufw.md](../06-security/ufw.md).

| Port | Protocol | Purpose | Source |
|------|----------|---------|--------|
| 22 | TCP | SSH | Management network |
| 6443 | TCP | k8s API Server | HAProxy + cluster nodes |
| 80 | TCP | HTTP Ingress | HAProxy |
| 443 | TCP | HTTPS Ingress | HAProxy |
| 8472 | UDP | Flannel VXLAN (legacy) | Between nodes |
| 10250 | TCP | Kubelet | Between nodes |
| 2379 | TCP | etcd client | Between nodes |
| 2380 | TCP | etcd peer | Between nodes |
| 9100 | TCP | node-exporter | Between nodes (Prometheus) |
| 4443 | TCP | metrics-server | Between nodes |
| 4244 | TCP | Hubble gRPC | Between nodes |
| 4240 | TCP | Cilium health checks | Between nodes |

---

## Useful Commands

```bash
# Cilium
cilium status
cilium status --wait
cilium monitor --type drop

# Force clean pod state after crash
kubectl delete pods -n <ns> --field-selector status.phase=Unknown --force
kubectl delete pods -n <ns> --field-selector status.phase=Failed --force

# NetworkPolicy
kubectl get networkpolicy -n <namespace>
kubectl describe networkpolicy <name> -n <namespace>

# Check Cilium config
kubectl get configmap -n kube-system cilium-config -o yaml | \
  grep -E "routing-mode|kube-proxy|cluster-pool-ipv4-cidr"

# Emergency: revert Cilium to VXLAN
kubectl patch configmap cilium-config -n kube-system \
  --type merge \
  -p '{"data":{"routing-mode":"tunnel","kube-proxy-replacement":"false"}}'
kubectl delete pods -n kube-system -l k8s-app=cilium --force --grace-period=0
```
