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

`Node Ready` confirms kubelet heartbeats and node conditions. It does not prove that every application, storage volume or network path is healthy. It also does not prove that every local API server can proxy requests to every kubelet.

Verify the complete API server to kubelet matrix after a cold start or K3s upgrade:

```bash
for api_server in master worker1 worker2; do
  for kubelet_node in master worker1 worker2; do
    ssh "$api_server" \
      sudo k3s kubectl \
        --request-timeout=5s \
        get \
        "--raw=/api/v1/nodes/${kubelet_node}/proxy/healthz"
  done
done
```

The expected result is nine successful requests.

---

## Controlled K3s upgrade

K3s upgrades use the `K3S | 40 Controlled Upgrade` Semaphore template backed by:

```text
cluster/playbooks/maintenance/k3s-upgrade.yml
```

The target must be an explicit complete release:

```text
k3s_target_version=v1.35.8+k3s1
```

The playbook requires the complete inventory and rejects `--limit`, downgrades and
unsupported version jumps. It performs:

1. binary, architecture, version, service, API and etcd preflight checks;
2. one embedded-etcd snapshot before binary replacement;
3. official SHA-256 verification of the target binary;
4. atomic replacement with a backup of the previous binary;
5. sequential upgrade in `worker1 -> worker2 -> master` order;
6. service, API, etcd, version and `Node Ready` checks after each node;
7. exact node-membership and full `3x3` kubelet-proxy validation.

Use normal execution, not Semaphore Dry Run. Check mode skips command tasks whose
output is required by later assertions.

---

## etcd operations

List snapshots:

```bash
sudo k3s etcd-snapshot ls
```

For control-plane, CNI or storage work not covered by the controlled upgrade playbook,
create a snapshot before the change:

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
