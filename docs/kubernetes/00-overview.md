# K3s Homelab

This is a documentation of a production-grade Kubernetes homelab built on three HP T630 thin clients. The goal was to replicate a real production setup as closely as possible in a home environment — HA control plane, GitOps, observability, proper storage, automated deployments, the whole thing.

---

## Hardware

| Node | Role | Specs |
|------|------|-------|
| master (192.168.55.10) | control-plane + etcd | HP T630, 8GB RAM, 128GB SSD |
| worker1 (192.168.55.11) | control-plane + etcd | HP T630, 8GB RAM, 128GB SSD |
| worker2 (192.168.55.12) | control-plane + etcd | HP T630, 8GB RAM, 128GB SSD |
| haproxy (192.168.0.45/46) | load balancer | Debian Server |

All three nodes run k3s in HA mode — every node is both control-plane and etcd member.

---

## Architecture Overview

```
Internet / LAN
      │
      ▼
HAProxy (192.168.0.45)
  :80  → Traefik HTTP
  :443 → Traefik HTTPS (TCP passthrough)
  :6443 → k3s API Server (TCP passthrough)
      │
      ▼
3× k3s control-plane (embedded etcd)
  master / worker1 / worker2
      │
      ▼
Traefik Ingress Controller (L7)
      │
      ▼
Workloads (namespaced)
```

---

## What's Running

| Category | Tool | Purpose |
|----------|------|---------|
| Cluster | k3s v1.34.4 | Lightweight Kubernetes |
| Load Balancer | HAProxy | External LB + TLS passthrough |
| CNI | Cilium v1.19.1 | eBPF networking, replaces Flannel |
| Ingress | Traefik v3 | L7 routing, built into k3s |
| TLS | cert-manager + Let's Encrypt | Automatic certificates via DNS-01 |
| Storage | Longhorn v1.11 | Distributed block storage with replication |
| GitOps | Flux v2.8.1 | Pull-based CD, image automation |
| Secrets | Sealed Secrets | Encrypted secrets safe to commit to Git |
| Firewall | UFW + Ansible | Per-node firewall, managed as code |
| Monitoring | kube-prometheus-stack | Prometheus + Grafana + AlertManager |
| Logging | Loki + Promtail | Centralized log aggregation |
| Alerts | AlertManager + ntfy | Push notifications via self-hosted ntfy |
| Object Storage | Garage v2.2.0 | Self-hosted S3 (backups, Loki storage) |
| Backup | etcd snapshots + rsync | Daily etcd backup to Debian server |
| App | clients-api (Spring Boot) | Demo app with full CI/CD |

---

## Documentation Structure

```
01-cluster-architecture/   HA control plane, etcd, node setup
02-networking/             HAProxy, Cilium CNI, NetworkPolicy
03-ingress-tls/            Traefik, cert-manager, Let's Encrypt
04-storage/                Longhorn distributed storage
05-gitops/                 Flux, GitOps workflow, image automation
06-security/               UFW firewall, Sealed Secrets
07-observability/          Prometheus, Grafana, Loki, AlertManager, Hubble
08-backup/                 etcd snapshots, Longhorn S3 backups
09-applications/           CI/CD pipeline, Helm charts, Progressive Delivery
```

---

## Git Repositories

- **k3s-homelab** — cluster config, Flux manifests, GitOps source of truth
- **clients-api** — application code + Helm chart + GitHub Actions pipeline

---

## Key Design Decisions

**Why k3s instead of kubeadm/vanilla k8s?**  
Significantly lower overhead, embedded etcd for HA, ships with Traefik and Flannel out of the box. Production-grade but resource-efficient — important on 8GB RAM nodes.

**Why pull-based GitOps (Flux) instead of push (standard CI)?**  
The cluster doesn't need to be accessible from the internet. Flux pulls changes from Git, which is simpler and more secure in a homelab/firewall setup.

**Why Cilium instead of Flannel?**  
eBPF-based networking with lower overhead, built-in NetworkPolicy support, and Hubble for network observability. Flannel had reliability issues after hard reboots (tmpfs subnet.env loss).

**Why Longhorn instead of local-path?**  
Data replication between nodes — if one node dies, PVCs remain available. Essential for stateful workloads in a 3-node HA setup.