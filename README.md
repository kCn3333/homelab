# 🏠 [kCn3333/homelab] Documentation



<div align="center">

[![Documentation](https://img.shields.io/badge/docs-live-4CAF50?style=flat-square)](https://kcn3333.github.io/homelab/)
[![GitHub](https://img.shields.io/badge/github-333333?style=flat-square&logo=github&logoColor=white)](https://github.com/kCn3333/homelab)
[![License](https://img.shields.io/badge/license-MIT-4CAF50?style=flat-square)](LICENSE)

</div>


> My personal infrastructure playground – where containers run wild and networking should just work smoothly ™

## 📚 What's This?

This repo contains my homelab documentation, configs, and infrastructure notes. Think of it as a digital garden where I document everything I learn while breaking and fixing things in my lab.

**📖 [Read the full documentation →](https://kcn3333.github.io/homelab/)**

**🟢 [Check what is up →](https://status.kcn333.pl/)**


## 🛠️ The Stack

### Hardware

<details>
<summary><b>🖥️ Main Server</b> (click to expand)</summary>

- ![DELL](https://img.shields.io/badge/Dell_Wyse_5070-555555?style=flat-square&logo=dell&logoColor=white&labelColor=007bff)
  - **CPU:** Intel Silver J5005 (4C/4T) Burst 2.80 GHz, Base 1.50 GHz, 4MB Cache, TDP 10 W
  - **RAM:** Samsung 16GB DDR4 2666Mhz
  - **Storage:** 
    - 1x 256GB SSD M.2 SATA
    - 2x 1TB HDD 2,5" WD Blue
  - **Network:** 1GbE
  - **OS:** Debian 13 
</details>

<details>
<summary><b>🔧 Cluster Nodes (x3)</b></summary>

- ![HP](https://img.shields.io/badge/HP_T630-555555?style=flat-square&logo=hp&logoColor=white&labelColor=0096D6)
  - **CPU:** AMD GX-420GI (4C/4T), Burst 2.2 GHz, 15 W TDP
  - **RAM:** 8GB RAM 
  - **Storage:** 128 SSD
- **Purpose:** Kubernetes worker nodes
</details>

<details>
<summary><b>🌐 Network</b></summary>

- ![UniFi](https://img.shields.io/badge/UniFi-555555?style=flat-square&logo=ubiquiti&logoColor=white&labelColor=0556C9)
  - **Router:** UniFi Cloud Gateway Ultra
  - **Core Switch:** Ubiquiti USW-Lite-8-PoE
  - **WiFi:** UniFi AP U6+, Ubiquiti Loco M2
</details>

### 🚀 Services Running

### Core Infrastructure
---
| Service | Role in Lab | 
| :--- | :--- |
| ![Docker](https://img.shields.io/badge/Docker-2496ED?style=flat-square&logo=docker&logoColor=white) | Containerization & Runtime |
| ![Pi-Hole](https://img.shields.io/badge/Pi--hole-96060C?style=flat-square&logo=pi-hole&logoColor=white) | Network-wide Ad Blocking & DNS |
| ![Nginx Proxy Manager](https://img.shields.io/badge/Nginx_Proxy_Manager-232F3E?style=flat-square&logo=nginx&logoColor=white) | Reverse Proxy Management |
| ![Cloudflare](https://img.shields.io/badge/Cloudflare-F38020?style=flat-square&logo=cloudflare&logoColor=white) | Secure Tunnels & DNS |
| ![Twingate](https://img.shields.io/badge/Twingate-1C1C1C?style=flat-square&logo=twingate&logoColor=white) | Zero-trust Network Access |
| ![Watchtower](https://img.shields.io/badge/Watchtower-5E60CE?style=flat-square&logo=watchtower&logoColor=white) | Auto-update Docker Containers |

### Applications
---
| Application | Role in Lab | 
| :--- | :--- |
| ![Portainer](https://img.shields.io/badge/Portainer-13BEF9?style=flat-square&logo=portainer&logoColor=white) | Docker Management GUI |
| ![n8n](https://img.shields.io/badge/n8n-FF6584?style=flat-square&logo=n8n&logoColor=white) | Workflow Automation |
| ![Duplicati](https://img.shields.io/badge/Duplicati-4ea2e0?style=flat-square&logo=duplicati&logoColor=white) | Backup Solution |
| ![Nextcloud](https://img.shields.io/badge/Nextcloud-0082C9?style=flat-square&logo=nextcloud&logoColor=white) | Personal Cloud & Collaboration |
| ![Gitea](https://img.shields.io/badge/Gitea-609926?style=flat-square&logo=gitea&logoColor=white) | Self-hosted Git Service |
| ![Vaultwarden](https://img.shields.io/badge/Vaultwarden-175DDC?style=flat-square&logo=bitwarden&logoColor=white) | Password Manager (Bitwarden) |

### Monitoring
---
| Application | Role in Lab |
| :--- | :--- |
| ![Grafana](https://img.shields.io/badge/Grafana-F46800?style=flat-square&logo=grafana&logoColor=white) | Metrics Visualization |
| ![Prometheus](https://img.shields.io/badge/Prometheus-E6522C?style=flat-square&logo=prometheus&logoColor=white) | Metrics Collection |
| ![Uptime Kuma](https://img.shields.io/badge/Uptime_Kuma-58D68D?style=flat-square&logo=uptime-kuma&logoColor=white) | Service Uptime Monitoring |

## 📝 Documentation Structure

```
docs/
├── infrastructure/     # Server & network setup
├── provisioning        # Setup & System hardening
├── applications/       # App deploying & configurations
├── automation/         # Scripts & workflows
└── troubleshooting/    # War stories & fixes
```

## 🎯 Goals

- Build a stable, production-ready homelab
- Learn container orchestration
- Implement proper monitoring
- Set up automated backups
- Migrate to Kubernetes
- Add CI/CD pipeline
- Implement GitOps workflow

## 🤝 Contributing

This is my personal documentation, but feel free to:
- Open issues if you spot errors
- Submit PRs for typos or improvements
- Fork for your own homelab setup

## 📜 License

MIT License - do whatever you want with this!

## 🔗 Links

- 📖 **[Full Documentation](https://kcn3333.github.io/homelab/)**
- 💬 **[Discussions](https://github.com/kCn3333/homelab/discussions)**
- 🐛 **[Report Issues](https://github.com/kCn3333/homelab/issues)**

---

<div align="center">
  
**Built with** [MkDocs Material](https://squidfunk.github.io/mkdocs-material/) • **Hosted on** GitHub Pages

</div>