# [ k C n ]  :material-home:  homelab  
<p align="center">
  <a href="https://github.com/kCn3333/homelab">
    <img src="https://img.shields.io/badge/version-0.3.3.3-4CAF50?style=flat-square&logo=github&logoColor=white" alt="Version">
  </a>
  <img src="https://status.kcn333.com/api/badge/3/status?upColor=4CAF50&downColor=f38ba8" alt="Server Status">
  <img src="https://status.kcn333.com/api/badge/3/uptime?color=4CAF50" alt="Uptime">
  <img src="https://status.kcn333.com/api/badge/3/response?color=4CAF50" alt="Response">
</p>
> "The cloud is just someone else's computer" – Ancient IT Proverb


## :material-link: Quick Links

* [:fontawesome-solid-chart-line: **Service Status**](https://status.kcn333.com)
* [:fontawesome-brands-github: **HomeLab K3S Cluster Repository**](https://github.com/kCn3333/k3s-homelab)
* [:material-web: **My Home Page**](https://kcn333.com)

---

## :material-information-outline: What's This All About?

Hello and welcome! This is my personal homelab documentation – a living knowledge base where I'm trying to document everything from infrastructure setup to those 3 AM debugging sessions that teach you *way* too much about Docker networking.


![homelab](img/homelab1.png)

## :material-help-circle-outline: Why Self-Host?

**Reasons I run a homelab:**


1. **Fun** – Because it's actually so enjoyable
2. **Curiosity** - It's amazing to see how things work
3. **Learning** – Best way to understand infrastructure
4. **Privacy** – My data stays on my hardware
5. **Control** – I decide when things update (or break)
6. **Cost** – Cloud bills add up fast, even faster than electricity ones


---

## :material-server-network: My Setup


<span class="color-green">**:simple-proxmox: Hypervisor**</span> — <span class="color-grey">Proxmox VE server running LXC containers and VMs (with Docker)</span>
<span class="color-green">**:simple-kubernetes: Kubernetes**</span> — <span class="color-grey">3-node HA K3s with embedded etcd, Cilium and Flux GitOps, bare-metal provisioning via PXE and MAAS</span>
<span class="color-green">**:material-source-branch: CI/CD**</span> — <span class="color-grey">Spring Boot → Git → GitHub Actions → Flux  → Helm deployment</span>
<span class="color-green">**:material-chart-line: Observability**</span> — <span class="color-grey">Grafana, Prometheus, Loki and Alloy</span>
<span class="color-green">**:material-code-braces: IaC**</span> — <span class="color-grey">Ansible + Semaphore, Terraform (for cloud)</span>
<span class="color-green">**:material-backup-restore: Backup**</span> — <span class="color-grey">Proxmox Backup Server, Kopia, Garage (S3) and MEGA</span>

<div class="retro-image-frame" markdown="1">
  ![homelab](img/homelab0.png)
</div>

## :material-folder-open-outline: Documentation Sections


- <span class="color-green">**:material-server-network: Infrastructure**</span> - <span class="color-grey">:material-server: Hardware setup, :material-server-network-outline: network configuration</span>
- <span class="color-green">**:material-package-down: Provisioning**</span> - <span class="color-grey">:simple-virtualbox: VM and :simple-linux: bare-metal deployment workflows</span>
- <span class="color-green">**:material-shield-search: Pentesting**</span> - <span class="color-grey">:material-shield-search: Lab building and :simple-hackthebox: Hack The Box write-ups</span>
- <span class="color-green">**:material-apps: Applications**</span> - <span class="color-grey">:simple-docker: Docker compose, :simple-kubernetes: k8s manifests, :material-cog: service configs</span>
- <span class="color-green">**:material-cog-sync-outline: Automation**</span> - <span class="color-grey">:material-ansible: Playbooks, :simple-n8n: workflows, infrastructure as code</span>
- <span class="color-green">**:material-wrench-outline: Troubleshooting**</span> - <span class="color-grey">:material-head-lightbulb: Common issues and their solutions</span>

<br>

---  



