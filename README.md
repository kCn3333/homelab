# 🏠 kCn Homelab

<div align="center">

[![Documentation](https://img.shields.io/badge/docs-live-4CAF50?style=flat-square&logo=materialformkdocs&logoColor=white)](https://homelab.kcn333.com/)
[![GitHub Pages](https://github.com/kCn3333/homelab/actions/workflows/main.yml/badge.svg)](https://github.com/kCn3333/homelab/actions/workflows/main.yml)
[![Service Status](https://img.shields.io/badge/services-status-4CAF50?style=flat-square&logo=statuspage&logoColor=white)](https://status.kcn333.com/)

</div>

> A personal infrastructure playground where containers run wild, backups are tested, and networking eventually works™.

This repository contains the documentation for my homelab: the hardware, provisioning notes, service architecture, automation, migrations, and the occasional troubleshooting story that was too useful to forget.

The lab started as a single low-power Debian server and gradually evolved into a Proxmox-based platform with dedicated VMs and LXC containers, a small K3s learning cluster, layered backups, and an external WireGuard relay. It is built primarily for learning and everyday self-hosting—not for pretending that three thin clients are a hyperscale datacenter.

**[Read the full documentation](https://homelab.kcn333.com/)** · **[Check service status](https://status.kcn333.com/)**

## Current Architecture

```text
Internet
   │
   ├── Oracle Relay
   │     ├── Caddy public reverse proxy
   │     └── WireGuard endpoint
   │              │
   │              ▼
   │           Logos
   │     main operations server
   │
LAN ── Zion (Proxmox VE)
       ├── Logos VM
       ├── AdGuard Home LXC
       ├── Caddy LXC
       ├── HAProxy LXC
       ├── Docker Media LXC
       ├── Home Assistant LXC
       └── Proxmox Backup Server LXC

Separate learning environment:
3 × HP T630 ── K3s HA cluster with embedded etcd
```

Zion provides the virtualization layer. Logos is the main operational server and runs more than Docker alone: it is also the automation controller, backup coordinator, WireGuard gateway, and home for several supporting services. Dedicated LXC containers isolate network, media, home-automation, and backup workloads.

## Hardware

### Zion — main virtualization server

| Component | Specification |
|---|---|
| Motherboard | Gigabyte Z370 HD3, LGA 1151 |
| CPU | Intel Core i5-8400, 6 cores at 2.8 GHz |
| Memory | Kingston DDR4-2666 |
| CPU cooler | be quiet! Pure Rock |
| Power supply | be quiet! Pure Power 13 850 W |
| System storage | Kingston KC3000 2 TB NVMe |
| Backup storage | Seagate IronWolf 4 TB SATA |
| Hypervisor | Proxmox VE |

The platform is tuned for low idle power consumption while retaining enough headroom for virtualization, storage, and future hardware expansion.

### K3s learning cluster

| Quantity | Hardware | Role |
|---:|---|---|
| 3 | HP T630 thin client, 8 GB RAM, 128 GB SSD | K3s control plane and embedded etcd |

All three nodes participate in the control plane and etcd quorum. The cluster is powered on when needed and is used mainly for learning Kubernetes, GitOps, storage, networking, and observability.

### Network

- UniFi Cloud Gateway Ultra
- UniFi USW-Lite-8-PoE
- UniFi U6+ access point
- Separate network segments for trusted devices, IoT, and the K3s lab
- AdGuard Home for local DNS and filtering

## What Runs Where

| System | Main responsibilities |
|---|---|
| **Zion** | Proxmox VE, VM/LXC lifecycle, local storage and hardware management |
| **Logos** | Main operational server, Docker workloads, Semaphore, Kopia, Garage, WireGuard gateway and supporting automation |
| **Caddy LXC** | Internal HTTPS reverse proxy and certificate automation |
| **AdGuard Home LXC** | Local DNS, filtering and internal DNS rewrites |
| **HAProxy LXC** | Load balancing for the K3s API and ingress traffic |
| **Docker Media LXC** | Jellyfin and the Arr media automation stack |
| **Home Assistant LXC** | Home Assistant, ESPHome and Zigbee device access |
| **PBS LXC** | Proxmox VM and container backups |
| **Oracle Relay** | Public Caddy endpoint and WireGuard relay into explicitly allowed local services |
| **K3s cluster** | Flux-managed Kubernetes learning environment with Cilium, Traefik, Longhorn and observability tooling |

## Main Building Blocks

| Area | Tools and services |
|---|---|
| Virtualization | Proxmox VE, LXC, KVM |
| Containers | Docker, Docker Compose, Portainer |
| Kubernetes | K3s, Flux, Cilium, Traefik, Longhorn, CloudNativePG |
| Networking | UniFi, AdGuard Home, Caddy, HAProxy, WireGuard |
| Automation | Ansible, Semaphore, GitHub Actions, Flux GitOps |
| Backups | Proxmox Backup Server, Kopia, Garage S3 and configuration collection |
| Monitoring | Uptime Kuma, PatchMon, Prometheus, Grafana and ntfy notifications |
| Home automation | Home Assistant, ESPHome and Zigbee |

## Documentation Map

The documentation is organized around how the homelab was designed, built, and operated:

```text
docs/
├── infrastructure/   physical hardware and network design
├── provisioning/     system deployment and platform configuration
├── applications/     apps, configs 
├── automations/      playbooks, workflows, infrastructure as a code
└── troubleshooting/  incidents, root causes and verified fixes
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