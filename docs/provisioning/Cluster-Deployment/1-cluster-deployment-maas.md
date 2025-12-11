
# Cluster Deployment using MAAS

Used Prerequisites:
- Ubuntu Server: for MAAS Installation
- Nodes: Three machines (Master, Worker 1, Worker 2) configured for PXE boot.
---

### MAAS Deployment & Initial Configuration

#### 1. 💾 MAAS Core Installation

Install the MAAS packages and the required database components.

```bash
# 1. Add repository for latest MaaS version
sudo apt install software-properties-common
sudo add-apt-repository ppa:maas/3.7

# 2. Update and install the MaaS package
sudo apt update
sudo apt install maas
```

#### 2. ⚙️ Initial Configuration

Initialize the MAAS region controller. You will be prompted to choose a user (create a new one) .

```bash
sudo maas init
```

#### 3. 🌐 Access UI

Open a web browser and navigate to:

***`http://<MAAS_SERVER_IP>:5240/MAAS`***

Login: Use the administrator account credentials set during maas init

---

### MAAS Networking & Domain Configuration

#### 1. 🛑 Disable DHCP on the VLAN

By default, MAAS provides DHCP. To avoid conflicts with your router, you must disable the dynamic range and only use MAAS for IP reservations.

1. Navigate to Subnets in the MAAS UI.

2. Select your primary subnet (e.g., 192.168.55.0/24).

3. In the DHCP section, delete the dynamic IP range.

4. Ensure the DHCP mode for the VLAN is set to "Unmanaged" or that the DHCP range is empty.

#### 2. 📝 Configure Domain and Hostnames

Set a cleaner domain name and ensure MAAS uses consistent naming conventions.

1. Navigate to Settings -> General -> Default DNS suffix. Change the default (e.g., maas) to something cleaner (e.g., homelab).

2. In the DNS tab, verify that MAAS is configured to manage DNS records for your domain.

#### 3. 🔑 SSH Key Registration

You can securely import your keys directly from GitHub, which is faster than pasting them manually.

1. Go to User Account -> My Account.

2. In the SSH keys section, choose "Import from GitHub".

3. Enter your GitHub username. MAAS will automatically fetch and register all your public keys.

#### 4. ⚙️ Commissioning and IP Assignment

1. Start Nodes: Power on your bare-metal nodes configured for PXE boot.

2. Commissioning: MAAS will discover them and perform hardware testing. Once complete, they will transition to the Ready state.

3. Static IP Reservation: For each Node, go to its configuration page and set a Static IP Reservation corresponding to its MAC address.

for me it was :

| Node          | hostname  | target        |
| ------------- | --------- | ------------- |
| Control Plane | master-00 | 192.168.55.10 |
| Agent 1       | worker-01 | 192.168.55.11 |
| Agent 2       | worker-02 | 192.168.55.12 |

#### 5. 🚀 Deploying the Nodes

Select Ubuntu 24.04 LTS or your custom image for each node, ensure the static IP from the table above is assigned during deployment. After that remember to change boot sequence from PXE to External Disk.

#### 2. 🧹 Post-Deployment Cleanup 

After deployment, the nodes are running Ubuntu 24.04 with the user `ubuntu` by default and some MAAS settings. 

##### Perform SSH login (using `ssh ubuntu@<IP_ADDRESS>`) and clean up:

1. User Account Migration (ubuntu -> admin)
```bash
# Add new user
sudo adduser admin
# Grant sudo rights to the new user
sudo usermod -aG sudo admin

# Enable password-less sudo (required for Ansible)
sudo visudo
# Add to the end of a file
admin ALL=(ALL) NOPASSWD: ALL

# Copy SSH key to new user and fix ownership/permissions
sudo cp -r /home/ubuntu/.ssh /home/admin/
sudo chown -R admin:admin /home/admin/.ssh
sudo chmod 700 /home/admin/.ssh
sudo chmod 600 /home/admin/.ssh/authorized_keys
```

3. Log out and log back in as the new user
```bash
exit
ssh admin@<IP_ADDRESS>

# If works fine, delete ubuntu user
sudo deluser --remove-home ubuntu
   ```

4. If you want to change the hostname
```bash
sudo hostnamectl set-hostname master-00
   ```
---

##### Remove MAAS APT Proxy configuration

```bash
sudo rm -f /etc/apt/apt.conf.d/90curtin-aptproxy
# global proxy environment variables (HTTP_PROXY, HTTPS_PROXY)
sudo sed -i '/maas/d' /etc/environment
sudo sed -i '/maas/d' /etc/bash.bashrc

sudo apt update --fix-missing
# Optionally remove duplicate source warnings
sudo mv /etc/apt/sources.list /etc/apt/sources.list.bak
```

and Update system packages
```bash
sudo apt update && sudo apt upgrade -y
```
