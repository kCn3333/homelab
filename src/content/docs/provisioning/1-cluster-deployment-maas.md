---
title: MAAS Deployment
icon: document
order: 3
tableOfContents: true
prev: false
next: false
---

# 🛢️ MAAS Deployment

**Used Prerequisites:**

- Ubuntu Server: for MAAS Installation
- Nodes: Three machines (Master, Worker 1, Worker 2) configured for PXE boot

---

## MAAS Deployment & Initial Configuration

### 1. 💾 MAAS Core Installation

Install the MAAS packages and the required database components.

```bash
# Add repository for latest MaaS version
sudo apt install software-properties-common
sudo add-apt-repository ppa:maas/3.7

# Update and install the MaaS package
sudo apt update
sudo apt install maas
```

### 2. ⚙️ Initial Configuration

Initialize the MAAS region controller. You will be prompted to choose a user (create a new one).

```bash
sudo maas init
```

### 3. 🌐 Access UI

Open a web browser and navigate to:

**`http://<MAAS_SERVER_IP>:5240/MAAS`**

**Login:** Use the administrator account credentials set during `maas init`

---

## MAAS Networking & Domain Configuration

### 1. 🛑 Disable DHCP on the VLAN

By default, MAAS provides DHCP. To avoid conflicts with your router, you must disable the dynamic range and only use MAAS for IP reservations.

**Steps:**

1. Navigate to **Subnets** in the MAAS UI
2. Select your primary subnet (e.g., `192.168.55.0/24`)
3. In the DHCP section, delete the dynamic IP range
4. Ensure the DHCP mode for the VLAN is set to **"Unmanaged"** or that the DHCP range is empty

### 2. 📝 Configure Domain and Hostnames

Set a cleaner domain name and ensure MAAS uses consistent naming conventions.

**Steps:**

1. Navigate to **Settings → General → Default DNS suffix**
2. Change the default (e.g., `maas`) to something cleaner (e.g., `homelab`)
3. In the **DNS** tab, verify that MAAS is configured to manage DNS records for your domain

### 3. 🔑 SSH Key Registration

You can securely import your keys directly from GitHub, which is faster than pasting them manually.

**Steps:**

1. Go to **User Account → My Account**
2. In the **SSH keys** section, choose **"Import from GitHub"**
3. Enter your GitHub username - MAAS will automatically fetch and register all your public keys

### 4. ⚙️ Commissioning and IP Assignment

**Steps:**

1. **Start Nodes:** Power on your bare-metal nodes configured for PXE boot
2. **Commissioning:** MAAS will discover them and perform hardware testing. Once complete, they will transition to the **Ready** state
3. **Static IP Reservation:** For each Node, go to its configuration page and set a Static IP Reservation corresponding to its MAC address

**My configuration:**

|Node|Hostname|Target IP|
|---|---|---|
|Control Plane|master-00|192.168.55.10|
|Agent 1|worker-01|192.168.55.11|
|Agent 2|worker-02|192.168.55.12|

### 5. 🚀 Deploying the Nodes

1. Select **Ubuntu 24.04 LTS** or your custom image for each node
2. Ensure the static IP from the table above is assigned during deployment
3. After deployment, remember to **change boot sequence from PXE to External Disk**

### 6. 🧹 Post-Deployment Cleanup

After deployment, the nodes are running Ubuntu 24.04 with the user `ubuntu` by default and some MAAS settings.

#### User Account Migration (ubuntu → admin)

Perform SSH login using `ssh ubuntu@<IP_ADDRESS>` and execute:

```bash
# Add new user
sudo adduser admin

# Grant sudo rights to the new user
sudo usermod -aG sudo admin
```

Enable password-less sudo (required for Ansible):

```bash
sudo visudo
```

Add to the end of the file:

```bash
admin ALL=(ALL) NOPASSWD: ALL
```

Copy SSH key to new user and fix ownership/permissions:

```bash
sudo cp -r /home/ubuntu/.ssh /home/admin/
sudo chown -R admin:admin /home/admin/.ssh
sudo chmod 700 /home/admin/.ssh
sudo chmod 600 /home/admin/.ssh/authorized_keys
```

#### Switch to New User

Log out and log back in as the new user:

```bash
exit
ssh admin@<IP_ADDRESS>
```

If everything works fine, delete the ubuntu user:

```bash
sudo deluser --remove-home ubuntu
```

#### Change Hostname (Optional)

```bash
sudo hostnamectl set-hostname master-00
```

#### Remove MAAS APT Proxy Configuration

```bash
# Remove APT proxy config
sudo rm -f /etc/apt/apt.conf.d/90curtin-aptproxy

# Remove global proxy environment variables
sudo sed -i '/maas/d' /etc/environment
sudo sed -i '/maas/d' /etc/bash.bashrc

# Fix missing packages
sudo apt update --fix-missing
```

Optionally remove duplicate source warnings:

```bash
sudo mv /etc/apt/sources.list /etc/apt/sources.list.bak
```

#### Final System Update

```bash
sudo apt update && sudo apt upgrade -y
```