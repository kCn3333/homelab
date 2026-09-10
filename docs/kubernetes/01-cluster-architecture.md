# Cluster Architecture

## Nodes and roles

The cluster contains three k3s server nodes. Every node runs the Kubernetes control plane, an embedded etcd member and regular workloads.

| Node      | Address         | Kubernetes roles               |
| --------- | --------------- | ------------------------------ |
| `master`  | `192.168.55.10` | control-plane, etcd, workloads |
| `worker1` | `192.168.55.11` | control-plane, etcd, workloads |
| `worker2` | `192.168.55.12` | control-plane, etcd, workloads |

There is no dedicated worker-only node. The hostnames do not define scheduling priority or control-plane authority.

---

## Control-plane availability

Embedded etcd uses three voting members. The cluster tolerates the loss of one member while retaining quorum.

Control-plane availability and application availability are separate:

* the control plane schedules, reconciles and replaces workloads;
* already running Pods can continue working during a short control-plane outage;
* application availability still depends on replica count, storage and network state.

One healthy API server and an etcd quorum are required for normal reconciliation.

---

## API access

Clients use a stable HAProxy endpoint:

```text
kubectl
→ cluster.kcn333.com:6443
→ HAProxy
→ one of 192.168.55.10/11/12:6443
```

HAProxy forwards raw TCP. TLS terminates at the selected kube-apiserver.

HAProxy runs in an LXC container on the Proxmox server at `192.168.0.45`. Its
configuration stayed unchanged after the move to LXC.

The API certificate includes `cluster.kcn333.com` as a Subject Alternative Name. The kubeconfig must use that name:

```yaml
clusters:
  - cluster:
      server: https://cluster.kcn333.com:6443
```

The kubeconfig grants administrative access and must be protected like a root credential.

---

## Current k3s service configuration

The initial server uses:

```text
k3s server
--cluster-init
--flannel-backend=none
--disable-network-policy
--tls-san cluster.kcn333.com
```

The other servers join through:

```text
k3s server
--server https://cluster.kcn333.com:6443
--flannel-backend=none
--disable-network-policy
```

`--flannel-backend=none` disables the bundled CNI. `--disable-network-policy` disables the bundled policy controller because Cilium provides both functions.

The effective systemd command can be checked with:

```bash
sudo systemctl show k3s \
  --property=ExecStart \
  --no-pager
```

Do not publish the join token contained in `ExecStart`. Host-level configuration is
managed through the [cluster Ansible playbooks](https://github.com/kCn3333/homelab-ansible/tree/main/cluster/playbooks);
manual edits to generated systemd units are not the source of truth.

---

## Readiness checks

Basic cluster state:

```bash
kubectl get nodes -o wide
kubectl get pods --all-namespaces
```

Local API and etcd readiness on a server:

```bash
sudo k3s kubectl get --raw='/readyz?verbose'
```

Expected output includes:

```text
[+]etcd ok
readyz check passed
```

`Node Ready` confirms kubelet heartbeats and node conditions. It does not prove that every application, storage volume or network path is healthy.

---

## etcd operations

List snapshots:

```bash
sudo k3s etcd-snapshot ls
```

Create a snapshot before a control-plane, CNI or storage change:

```bash
sudo k3s etcd-snapshot save \
  --name pre-change
```

Do not restart two etcd members at the same time. A planned node restart should leave at least two server nodes available.

---

## Node maintenance

Use `cordon` when a short service restart must prevent new Pods from being scheduled:

```bash
kubectl cordon <node>
```

Use `drain` when workloads must be evicted before longer host maintenance:

```bash
kubectl drain <node> \
  --ignore-daemonsets \
  --delete-emptydir-data
```

`drain` is not required for every short k3s restart. It can trigger unnecessary workload movement and Longhorn replica rebuilding.

After maintenance:

```bash
kubectl wait \
  --for=condition=Ready \
  node/<node> \
  --timeout=300s

kubectl uncordon <node>
```

Before restarting another node, verify that Longhorn volumes have returned to `healthy`.

---

## Useful commands

```bash
kubectl get nodes -o wide
kubectl get pods -A -o wide
kubectl get events -A --sort-by='.lastTimestamp'
```

```bash
sudo systemctl status k3s --no-pager
sudo journalctl -u k3s -n 100 --no-pager
sudo k3s kubectl get --raw='/readyz?verbose'
```

```bash
echo | openssl s_client \
  -connect cluster.kcn333.com:6443 \
  -servername cluster.kcn333.com 2>/dev/null | \
openssl x509 -noout -issuer -subject -dates -ext subjectAltName
```
