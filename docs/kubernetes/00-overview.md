# K3s Homelab

Three-node Kubernetes homelab running on physical HP T630 machines. All nodes are k3s servers, control-plane nodes, etcd members and workload nodes.

---

## Hardware

| Node      | Address         | Roles                          | Hardware                      |
| --------- | --------------- | ------------------------------ | ----------------------------- |
| `master`  | `192.168.55.10` | control-plane, etcd, workloads | HP T630, 8 GB RAM, 128 GB SSD |
| `worker1` | `192.168.55.11` | control-plane, etcd, workloads | HP T630, 8 GB RAM, 128 GB SSD |
| `worker2` | `192.168.55.12` | control-plane, etcd, workloads | HP T630, 8 GB RAM, 128 GB SSD |

The node names are historical. `master`, `worker1` and `worker2` have the same Kubernetes roles.

HAProxy runs in an LXC container on the Proxmox server and uses `192.168.0.45`.

---

## Traffic paths

Kubernetes API:

```text
kubectl
→ HAProxy:6443
→ one of the three k3s API servers
```

Application traffic:

```text
client
→ HAProxy:80/443
→ node:80/443
→ K3s ServiceLB / klipper-lb
→ Service/traefik
→ Traefik Pod
→ application Pod
```

HAProxy forwards API and HTTPS traffic in TCP mode. Traefik terminates application TLS and performs HTTP routing.

---

## Current platform

| Area                    | Component                | Current role                                                  |
| ----------------------- | ------------------------ | ------------------------------------------------------------- |
| Kubernetes              | k3s `v1.35.8+k3s1`       | Kubernetes distribution and embedded etcd                     |
| External entry point    | HAProxy                  | Selects an API server or ingress node                         |
| CNI                     | Cilium `v1.20.2`         | Pod networking, NetworkPolicy and VXLAN transport             |
| Service dataplane       | kube-proxy and Cilium    | iptables for tested host traffic; eBPF for tested Pod traffic |
| Ingress                 | Traefik v3               | TLS termination and L7 routing                                |
| Bare-metal LoadBalancer | K3s ServiceLB            | Exposes Traefik on node ports `80/443`                        |
| TLS                     | cert-manager             | Let's Encrypt certificates through DNS-01                     |
| Storage                 | Longhorn `v1.11`         | Replicated persistent volumes                                 |
| GitOps                  | Flux `v2.8.1`            | Reconciliation and image automation                           |
| Secrets                 | Sealed Secrets `v0.40.0` | Encrypted secrets stored in Git                               |
| Resource metrics        | metrics-server `v0.8.1`  | Metrics API for `kubectl top` and HPA                       |
| Monitoring              | kube-prometheus-stack    | Prometheus, Grafana and Alertmanager                          |
| Logging                 | Loki and Alloy `v1.19.2` | Central log collection                                        |
| Object storage          | Garage `v2.2.0` on Logos | S3 storage for Loki and Longhorn backups                      |
| Firewall                | UFW managed with Ansible | Restricts node access and cluster ports                       |

---

## Network state

```text
Node network: 192.168.55.0/24
Service CIDR: 10.43.0.0/16
Pod CIDR:     10.42.0.0/16
```

Cilium uses Kubernetes IPAM:

```text
ipam=kubernetes
k8s-require-ipv4-pod-cidr=true
routing=VXLAN
kubeProxyReplacement=false
```

Each node receives its own `/24` PodCIDR from k3s:

```text
master:  10.42.0.0/24
worker1: 10.42.1.0/24
worker2: 10.42.2.0/24
```

---

## Repositories

* [homelab](https://github.com/kCn3333/homelab) — this documentation and the Polish journal.
* [k3s-homelab](https://github.com/kCn3333/k3s-homelab) — Flux manifests and Kubernetes desired state.
* [homelab-ansible playbooks](https://github.com/kCn3333/homelab-ansible/tree/main/cluster/playbooks) — host configuration, firewall and cluster power lifecycle.
* [clients-api](https://github.com/kCn3333/clients-api) — Spring Boot application, Helm chart and CI pipeline.
* [k8s-badge](https://github.com/kCn3333/k8s-badge) — lightweight cluster-status API and SVG badge.

Flux is the source of truth for Kubernetes resources managed by the repository. Ansible owns host-level configuration. Built-in k3s components remain managed by k3s unless explicitly stated otherwise.

---

## Documentation map

| File                                               | Scope                                                  |
| -------------------------------------------------- | ------------------------------------------------------ |
| [Cluster architecture](01-cluster-architecture.md) | Nodes, control plane, etcd and API access              |
| [Networking](02-networking.md)                     | Cilium, kube-proxy, Service datapath and NetworkPolicy |
| [Ingress and TLS](03-ingress-tls.md)               | HAProxy, ServiceLB, Traefik, Ingress and certificates  |
| [Storage](04-storage.md)                           | Longhorn, StorageClasses and volume operations         |
| [GitOps](05-gitops.md)                             | Flux structure and deployment workflow                 |
| [Security](06-security.md)                         | UFW, Sealed Secrets and time synchronization           |
| [Observability](07-observability.md)               | Metrics, logs, alerts and Hubble                       |
| [Backup](08-backup.md)                             | etcd, volume and sealing-key recovery                  |
| [Applications](09-applications.md)                 | `clients-api`, `k8s-badge` and delivery workflow       |

The files above describe the current state. Migration history, incidents and experiments are kept in the [journal](../journal/).

Each Kubernetes learning session produces a Polish journal entry. A reusable failure
and its verified solution may also become a troubleshooting article. The state
documentation is updated only when the current architecture or operating procedure
changes.
