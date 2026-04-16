# Cluster Architecture

## Overview

The cluster runs k3s in HA mode — all three nodes are control-plane members and etcd peers simultaneously. There's no dedicated "worker-only" node. This is a deliberate choice: with only 3 machines, dedicating one purely to workers would waste the etcd quorum capacity.

```
[PC / kubectl]
      │
      ▼
HAProxy :6443 (TCP passthrough)
      │
      ├── master  192.168.55.10  (control-plane + etcd)
      ├── worker1 192.168.55.11  (control-plane + etcd)
      └── worker2 192.168.55.12  (control-plane + etcd)
```

---

## HA Control Plane

HA has two distinct dimensions that are easy to mix up:

- **Control-plane HA** — the scheduler, controller-manager, and API server need to be up for the cluster to react to failures (evict pods from a dead node, scale deployments, etc.)
- **Application HA** — pods keep running even if the control plane goes down, but the cluster is "blind" — it can't reschedule, scale, or repair anything

In practice: if a node dies, k8s detects it after `node-monitor-grace-period` (~40s by default) and starts evicting pods. You need a working control plane for that eviction to happen.

### etcd quorum

k3s uses embedded etcd for HA. With 3 nodes, the cluster tolerates 1 node failure — the formula is `(n-1)/2` nodes can fail while maintaining quorum.

### Tested behavior

With the master node powered off:

- After ~2-3 minutes, pods from the dead node were rescheduled on the remaining nodes
- API access was uninterrupted (HAProxy routed to surviving control-plane nodes)
- `node-monitor-grace-period` is the key timer; pods stuck in `Terminating` require `--force` if kubelet can't confirm shutdown

---

## Initial Cluster Setup

### Step 0 — Uninstall existing k3s

k3s HA must be bootstrapped from scratch. You can't "upgrade" a single-node install to HA.

On all control-plane nodes:
```bash
sudo /usr/local/bin/k3s-uninstall.sh
```

On workers (if any):
```bash
sudo /usr/local/bin/k3s-agent-uninstall.sh
```

Clean up any leftover data:
```bash
sudo rm -rf /var/lib/rancher
```

### Step 1 — Bootstrap the first control-plane

On `192.168.55.10`:

```bash
curl -sfL https://get.k3s.io | INSTALL_K3S_EXEC="
server \
--cluster-init \
--tls-san 192.168.0.45 \
--tls-san cluster.kcn333.com
" sh -
```

- `--cluster-init` — creates a new HA cluster with embedded etcd
- `--tls-san` — adds IPs/domains to the API server's TLS certificate SAN. Without this, kubectl via HAProxy gets a TLS error. Add both the LB IP and your domain.

### Step 2 — Grab the cluster token

```bash
sudo cat /var/lib/rancher/k3s/server/node-token
```

### Step 3 — Join the second and third control-plane nodes

On `192.168.55.11` and `192.168.55.12`:

```bash
curl -sfL https://get.k3s.io | INSTALL_K3S_EXEC="
server \
--server https://192.168.55.10:6443 \
--token <TOKEN> \
--tls-san 192.168.0.45 \
--tls-san cluster.kcn333.com
" sh -
```

`--server` points to the first node — this means "join the existing etcd cluster" rather than creating a new one.

---

## TLS SAN Management

The Subject Alternative Name is the list of IPs and domains the API server certificate is valid for. When kubectl connects through HAProxy, it checks that the IP it's talking to is listed in the cert's SAN. If it's not — TLS error.

### Where the config lives

```
/etc/systemd/system/k3s.service
```

Look for the `ExecStart` block:

```
ExecStart=/usr/local/bin/k3s \
    server \
        '--cluster-init' \
        '--tls-san' \
        '192.168.0.45' \
        '--tls-san' \
        'cluster.kcn333.com' \
```

### Updating SAN

```bash
# 1. Snapshot etcd first (always!)
sudo k3s etcd-snapshot save --name pre-tls-san-change

# 2. Edit the service file
sudo vi /etc/systemd/system/k3s.service

# 3. Reload and restart
sudo systemctl daemon-reload
sudo systemctl restart k3s

# 4. Verify the new SAN is in the cert
echo | openssl s_client -connect <IP>:6443 2>/dev/null | \
  openssl x509 -text -noout | grep -A10 "Subject Alternative Name"
```

### k3s SAN behavior

k3s manages the API server cert via a dynamic listener stored as a Secret `k3s-serving` in `kube-system`. The SAN list comes from:

- `--tls-san` flags in `k3s.service`
- All node IPs in the cluster
- Node hostnames
- Standard k8s names (`kubernetes`, `kubernetes.default`, etc.)
- **History from etcd** — addresses from previous configurations

Removing a `--tls-san` and restarting isn't always enough — k3s can rebuild the cert from etcd history. In practice, if the old IP isn't accessible anyway, it's not a security risk.

### SAN sync in HA

Changing SAN on one control-plane node is automatically synced via etcd to the other nodes. You don't need to manually edit `k3s.service` on every node for SAN changes.

---

## Accessing the Cluster

### kubeconfig

The kubeconfig lives at `/etc/rancher/k3s/k3s.yaml` on any control-plane node. It contains admin-level credentials — treat it like a root password.

```bash
# Copy to your local machine
ssh user@master "sudo cat /etc/rancher/k3s/k3s.yaml" | Out-File -Encoding ascii k3s.yaml

# Change the server address to HAProxy
# server: https://127.0.0.1:6443 → https://192.168.0.45:6443
```

### Merging kubeconfigs

```bash
KUBECONFIG=~/.kube/config:~/.kube/k3s.yaml kubectl config view --flatten > ~/.kube/config_new
```

---

## Useful Commands

```bash
# Cluster state
kubectl get nodes -o wide
kubectl get pods -A -o wide

# etcd operations
sudo k3s etcd-snapshot save --name <name>
sudo k3s etcd-snapshot ls

# Certificate rotation
sudo k3s certificate rotate
sudo systemctl daemon-reload
sudo systemctl restart k3s

# k3s service logs
sudo journalctl -u k3s -n 100 --no-pager
```
