# :material-power-plug: PXE TFTP 

## 📋 Overview

This guide covers setting up a TFTP server for PXE (Preboot Execution Environment) network booting on Debian.

**Use Case:**

Useful when PXE boot only works in **Legacy BIOS mode** and you need a dedicated TFTP server isolated from your main network.

**Environment:**

- Server: Debian-based system
- TFTP Service: `tftpd-hpa` (most stable and widely used for PXE)
- Network: VLAN 5 (`192.168.55.0/24`)
- TFTP Server IP: `192.168.55.254`

---

## 1. Install TFTP Server

Install `tftpd-hpa`, the most stable and commonly used TFTP daemon for PXE:

```bash
sudo apt update
sudo apt install tftpd-hpa
```

---

## 2. Configure TFTP Server

Edit the TFTP configuration file:

```bash
sudo nano /etc/default/tftpd-hpa
```

Set the following configuration:

```bash
TFTP_USERNAME="tftp"
TFTP_DIRECTORY="/srv/tftp"
TFTP_ADDRESS="192.168.55.254:69"
TFTP_OPTIONS="--secure --create"
```

**Configuration explanation:**

|Parameter|Value|Description|
|---|---|---|
|`TFTP_USERNAME`|`tftp`|User account running the TFTP service|
|`TFTP_DIRECTORY`|`/srv/tftp`|Root directory for PXE boot files|
|`TFTP_ADDRESS`|`192.168.55.254:69`|IP and port to bind (VLAN 5 only)|
|`TFTP_OPTIONS`|`--secure --create`|Security flags and file creation permission|

**Important:**

`TFTP_ADDRESS` must be set to `192.168.55.254` (not `0.0.0.0`) to ensure the service only listens on VLAN 5, preventing any interference with your main LAN (`192.168.0.0/24`).

---

## 3. Create TFTP Directory

Create the TFTP root directory and set proper ownership:

```bash
sudo mkdir -p /srv/tftp
sudo chown -R tftp:tftp /srv/tftp
```

---

## 4. Restart and Verify Service

Restart the TFTP service and check its status:

```bash
sudo systemctl restart tftpd-hpa
sudo systemctl enable tftpd-hpa
sudo systemctl status tftpd-hpa
```

**Expected output:**

```
● tftpd-hpa.service - LSB: HPA's tftp server
   Loaded: loaded (/etc/init.d/tftpd-hpa; generated)
   Active: active (running)
```

---

## 5. Verify TFTP Server

Test if the TFTP server is listening on the correct interface:

```bash
sudo ss -ulnp | grep :69
```

**Expected output:**

```
UNCONN 0  0  192.168.55.254:69  0.0.0.0:*  users:(("in.tftpd",pid=1234,fd=3))
```

This confirms TFTP is only listening on VLAN 5 (`192.168.55.254`).

---

## 6. Test TFTP Connection

From a client machine on the same VLAN, test the TFTP connection:

```bash
# Install tftp client (if not already installed)
sudo apt install tftp-hpa

# Test connection
tftp 192.168.55.254
tftp> status
tftp> quit
```

---

## 7. Populate PXE Boot Files

### 7.1. Download PXELinux Files

Download the Syslinux bootloader files needed for PXE:

```bash
cd /srv/tftp
sudo wget https://mirrors.edge.kernel.org/pub/linux/utils/boot/syslinux/syslinux-6.03.tar.gz
sudo tar -xzf syslinux-6.03.tar.gz
sudo cp syslinux-6.03/bios/core/pxelinux.0 .
sudo cp syslinux-6.03/bios/com32/elflink/ldlinux/ldlinux.c32 .
sudo cp syslinux-6.03/bios/com32/lib/libcom32.c32 .
sudo cp syslinux-6.03/bios/com32/libutil/libutil.c32 .
sudo cp syslinux-6.03/bios/com32/menu/vesamenu.c32 .
```

### 7.2. Create PXELinux Configuration

Create the PXE boot menu configuration:

```bash
sudo mkdir -p /srv/tftp/pxelinux.cfg
sudo nano /srv/tftp/pxelinux.cfg/default
```

**Example configuration:**

```
DEFAULT menu.c32
PROMPT 0
TIMEOUT 300
MENU TITLE PXE Boot Menu

LABEL local
    MENU LABEL Boot from local disk
    LOCALBOOT 0

LABEL ubuntu
    MENU LABEL Install Ubuntu Server
    KERNEL ubuntu/vmlinuz
    APPEND initrd=ubuntu/initrd.img
```

### 7.3. Add OS Images (Example: Ubuntu)

Download and place Ubuntu netboot files:

```bash
sudo mkdir -p /srv/tftp/ubuntu
cd /srv/tftp/ubuntu
sudo wget http://archive.ubuntu.com/ubuntu/dists/jammy/main/installer-amd64/current/legacy-images/netboot/ubuntu-installer/amd64/linux
sudo wget http://archive.ubuntu.com/ubuntu/dists/jammy/main/installer-amd64/current/legacy-images/netboot/ubuntu-installer/amd64/initrd.gz
sudo mv linux vmlinuz
sudo mv initrd.gz initrd.img
```

---

## 8. DHCP Configuration (TFTP Boot Options)

Configure your DHCP server to point clients to the TFTP server.

**Example DHCP options (for dnsmasq):**

```bash
# /etc/dnsmasq.conf
dhcp-boot=pxelinux.0,192.168.55.254
```

**Example DHCP options (for ISC DHCP Server):**

```bash
# /etc/dhcp/dhcpd.conf
next-server 192.168.55.254;
filename "pxelinux.0";
```

Restart your DHCP service after configuration.

---

## 9. Firewall Configuration (Optional)

If you have a firewall enabled, allow TFTP traffic:

```bash
# UFW
sudo ufw allow 69/udp

# iptables
sudo iptables -A INPUT -p udp --dport 69 -j ACCEPT
```

---

## ✅ Verification Checklist

- [ ] TFTP service is running: `systemctl status tftpd-hpa`
- [ ] TFTP listens on VLAN 5 only: `ss -ulnp | grep :69`
- [ ] TFTP directory has correct permissions: `ls -ld /srv/tftp`
- [ ] PXE boot files are in place: `ls /srv/tftp/pxelinux.0`
- [ ] DHCP is configured with TFTP server options
- [ ] Test PXE boot from a client machine

---

## 🐛 Troubleshooting

### TFTP Service Won't Start

**Check logs:**

```bash
sudo journalctl -u tftpd-hpa -n 50
```

**Common issue:** Permission denied on `/srv/tftp`

**Solution:**

```bash
sudo chown -R tftp:tftp /srv/tftp
sudo chmod 755 /srv/tftp
```

### PXE Client Can't Connect

**Symptom:** Client shows "PXE-E32: TFTP open timeout"

**Verify:**

1. TFTP service is running on correct IP
2. Firewall allows UDP port 69
3. DHCP is providing correct `next-server` option

**Test from client network:**

```bash
tftp 192.168.55.254
tftp> get pxelinux.0
```

### Files Not Found (TFTP Error)

**Symptom:** "File not found" errors during PXE boot

**Solution:**

Verify file paths and permissions:

```bash
ls -la /srv/tftp/
ls -la /srv/tftp/pxelinux.cfg/
```

All files must be readable by `tftp` user:

```bash
sudo chmod -R 644 /srv/tftp/*
sudo chmod 755 /srv/tftp
sudo chmod 755 /srv/tftp/pxelinux.cfg
```

---

## 📚 Additional Resources

- [TFTP-HPA Documentation](https://git.kernel.org/pub/scm/network/tftp/tftp-hpa.git)
- [Syslinux PXELinux Guide](https://wiki.syslinux.org/wiki/index.php?title=PXELINUX)
- [Ubuntu PXE Installation Guide](https://help.ubuntu.com/community/PXEInstallMultiDistro)