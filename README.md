# 🏠 [kCn3333/homelab] Documentation



<div align="center">

[![GitHub Pages](https://img.shields.io/github/actions/workflow/status/kCn3333/homelab/main.yml?style=flat-square&logo=github&label=Pages%20Build&color=4CAF50)](https://homelab.kcn333.com)
[![Live](https://img.shields.io/badge/docs-live-4CAF50?style=flat-square)](https://homelab.kcn333.com)
[![License](https://img.shields.io/badge/license-MIT-4CAF50?style=flat-square)](LICENSE)


</div>


> A personal infrastructure playground where containers run wild, backups are tested, and networking eventually works™.

This repository contains the documentation for my homelab: the hardware, provisioning notes, service architecture, automation, migrations, and the occasional troubleshooting story that was too useful to forget.

The lab started as a single low-power Debian server and gradually evolved into a Proxmox-based platform with dedicated VMs and LXC containers, a small K3s learning cluster, layered backups, and an external WireGuard relay. It is built primarily for learning and everyday self-hosting—not for pretending that three thin clients are a hyperscale datacenter.

**[Read the full documentation](https://homelab.kcn333.com/)** · **[Check service status](https://status.kcn333.com/)**

## Current Architecture

```text
Internet
└── Relay VPS
    ├── Caddy public reverse proxy
    └── WireGuard endpoint
            │
            │ encrypted tunnel
            ▼
LAN
├── Zion (Proxmox VE)
│   ├── Logos VM ← WireGuard peer
│   ├── Kali VM
│   ├── AdGuard Home LXC
│   ├── Caddy LXC
│   ├── HAProxy LXC
│   ├── PatchMon LXC
│   ├── Docker Media LXC
│   ├── Home Assistant LXC
│   └── Proxmox Backup Server LXC
│
├── Oracle Legacy
│
└── K3s cluster
    ├── master
    ├── worker1
    └── worker2
```


## Infrastructure

### Zion — main virtualization server

| Component | Specification |
|---|---|
| Motherboard | Gigabyte Z370 HD3, LGA 1151 |
| CPU | Intel Core i5-8400, 6 cores at 2.8 GHz |
| Memory | 32GB Kingston DDR4-2666 |
| CPU cooler | be quiet! Pure Rock |
| Power supply | be quiet! Pure Power 13 850 W |
| System storage | Kingston KC3000 2 TB NVMe |
| Data storage | Seagate IronWolf 4 TB SATA |
| Hypervisor | Proxmox VE |

The platform is tuned for low idle power consumption while retaining enough headroom for virtualization, storage, and future hardware expansion.

### Oracle Legacy — former main server

| Component | Specification |
|---|---|
| Platform | Dell Wyse 5070 thin client |
| CPU | Intel Pentium Silver J5005 |
| Memory | 16 GB DDR4 |
| Storage | 256GB SSD |

### Relay VPS — external edge server

| Component | Specification |
|---|---|
| Provider | Oracle Cloud Infrastructure  |
| Shape | VM.Standard.E2.1.Micro |
| CPU | 1 OCPU |
| Memory | 1 GB RAM with 1 GB swap |
| Network bandwidth | 0.5 Gbps |

### K3s cluster

| Quantity | Hardware | Role |
|---:|---|---|
| 3 | HP T630 thin client, 8 GB RAM, 128 GB SSD | K3s control plane and embedded etcd |

The cluster is powered on when needed and is used mainly for learning Kubernetes, GitOps, storage, networking, and observability.

### Network

- UniFi Cloud Gateway Ultra
- UniFi USW-Lite-8-PoE
- UniFi U6+ access point
- Separate network segments for trusted devices, IoT, and the K3s lab
- AdGuard Home for local DNS and filtering

### Core platforms

| System | Type | Operating system | Primary role |
|---|---|---|---|
| **Zion** | Physical server | Proxmox VE | Virtualization, VM/LXC lifecycle and local storage |
| **Logos** | KVM virtual machine | Ubuntu 26.04 LTS | Main operations server, Docker workloads, automation, backups and WireGuard gateway |
| **Kali** | KVM virtual machine | Kali Linux | On-demand security testing and network diagnostics |
| **Oracle Legacy** | Physical thin client | Debian 13 | Former main server retained as a fallback and legacy system |
| **Relay** | Oracle Cloud Free Tier VM | Ubuntu 24.04 LTS | Public Caddy endpoint and WireGuard relay |
| **K3s cluster** | Three physical thin clients | Ubuntu 24.04 LTS | On-demand Kubernetes and GitOps learning environment |

## Technology Stack

| Area | Tools and services |
|---|---|
| Virtualization | Proxmox VE, KVM, and LXC |
| Containers | Docker, Docker Compose, and Portainer |
| Kubernetes | K3s, Flux, Cilium, Traefik, Longhorn, and CloudNativePG |
| Networking | UniFi, AdGuard Home, Caddy, HAProxy, and WireGuard |
| Automation | Ansible, Semaphore, GitHub Actions, and Flux GitOps |
| Backups | Proxmox Backup Server, Kopia, Garage S3, and configuration collection |
| Monitoring | Uptime Kuma, PatchMon, Prometheus, Grafana, and ntfy |
| Home automation | Home Assistant, ESPHome, and Zigbee |
| Security testing | Kali Linux and isolated, on-demand diagnostic tooling |

## Documentation Map

The documentation is organized around how the homelab was designed, built, and operated:

```text
docs/
├── infrastructure/   physical infrastructure and network design
├── provisioning/     system deployment and platform configuration
├── applications/     applications and reusable configurations
├── automation/       playbooks, workflows, and infrastructure as code
└── troubleshooting/  incidents, root causes, and verified fixes
```

The site navigation also links to dedicated application, configuration, and automation repositories where the implementations themselves are maintained. This repository focuses on architecture, decisions, operational knowledge, and lessons learned.

## Related Repositories

- [k3s-homelab](https://github.com/kCn3333/k3s-homelab) — Flux source of truth for the K3s cluster
- [homelab-ansible](https://github.com/kCn3333/homelab-ansible) — host maintenance and cluster lifecycle automation
- [docker-compose](https://github.com/kCn3333/docker-compose) — Docker Compose definitions
- [homelab-terraform](https://github.com/kCn3333/homelab-terraform) — Terraform experiments and infrastructure code
- [rack-fan-controller](https://github.com/kCn3333/rack-fan-controller) — custom rack temperature and fan controller

## Documentation Principles

- Document the current state separately from migration history.
- Keep commands reproducible and explain why they are used.
- Record failures as troubleshooting notes instead of quietly deleting them.
- Prefer automation, but keep emergency procedures understandable without it.
- Test backups and recovery paths rather than trusting a green status icon.
- Keep secrets, credentials, public IP addresses, administrative endpoints, and private recovery details out of this public repository.

## Current Direction

- Finish documenting the migration from the legacy server to Zion and Logos
- Improve recovery documentation and regularly validate backup restores
- Continue moving routine maintenance into Ansible and Semaphore
- Develop the K3s cluster as an occasional, power-efficient learning platform
- Keep the homelab useful, understandable, and fun to operate

## Contributing

This is a personal knowledge base, but corrections and suggestions are welcome. If you find an error, feel free to open an issue or submit a pull request.

---

<div align="center">

Built with curiosity, coffee, and a very reasonable number of containers.<br>
Documentation powered by [MkDocs Material](https://squidfunk.github.io/mkdocs-material/) and published with GitHub Pages.

</div>