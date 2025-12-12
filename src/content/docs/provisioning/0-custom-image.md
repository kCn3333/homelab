---
title: Custom Image with Packer
icon: document
order: 1
tableOfContents: true
prev: false
next: false
---

# 📝 Custom Image with Packer

## 🎯 Goal

To build a clean `debian-custom-cloudimg.tar.gz` image for MAAS deployment.

---

## 🛠️ Environment & Tools

**Host Environment:**

- Windows 11 / WSL2 (Ubuntu)
- Builder: Packer with QEMU builder

**Repository:**

Clone Canonical's MAAS Image Builder (based on HCL format):

```bash
git clone https://github.com/canonical/packer-maas.git
cd packer-maas
```

---

## 1. Packer Configuration (WSL2/QEMU)

The default configuration required modifications primarily due to the Nested Virtualization environment (QEMU running inside WSL2/Hyper-V).

### 1.1. KVM Acceleration Fix (Crucial for WSL2)

The main build may fail because QEMU attempts to use KVM acceleration (`accel=kvm`), which is inaccessible from within WSL2, resulting in a **"Permission denied"** error.

**File Modified:** `debian-cloudimg.pkr.hcl`

**Original configuration:**

```hcl
# Original (doesn't work in WSL2)
qemu_machine = { "amd64" = "accel=kvm" }
qemu_cpu = { "amd64" = "host" }
```

**Fixed configuration for WSL2 emulation:**

```hcl
locals {
    qemu_machine = { "amd64" = "q35" }   # Use standard machine without KVM flag
    qemu_cpu = { "amd64" = "max" }       # Use safe CPU setting
}
```

**Explanation:**

- Removed hardcoded KVM flags in the `locals` block
- Forces pure software emulation (slower but works in WSL2)
- Uses `q35` machine type (standard x86_64 chipset)
- Uses `max` CPU model (safe fallback without host-passthrough)

### 1.2. Boot Mode Configuration

Switched the boot mode to **BIOS** (`BOOT=bios`) to avoid potential conflicts with UEFI/OVMF firmware copying and usage within the QEMU environment.

### 1.3. Build the Image

Run the build command:

```bash
make debian SERIES=trixie BOOT=bios
```

**Build process:**

1. Packer downloads the Debian Trixie ISO
2. QEMU starts the VM in software emulation mode
3. Automated installation proceeds via preseed
4. Image is packaged as `debian-custom-cloudimg.tar.gz`

**Expected output:**

```
==> Builds finished. The artifacts of successful builds are:
--> qemu.debian: debian-custom-cloudimg.tar.gz
```

---

## 2. MAAS Deployment Steps

After a successful build, the image is ready for deployment.

### 2.1. File Transfer

Copy the image to the MAAS server:

```bash
scp debian-custom-cloudimg.tar.gz user@maas_server_ip:/home/user/
```

### 2.2. Upload Image to MAAS

SSH to the MAAS server and upload the custom image:

```bash
ssh user@maas_server_ip

# Upload the custom image
maas admin boot-resources create \
    name='custom/debian-trixie' \
    title='Debian 13 Trixie Custom' \
    architecture='amd64/generic' \
    filetype='tgz' \
    content@=debian-custom-cloudimg.tar.gz
```

### 2.3. Verify Image Upload

Check if the image was uploaded successfully:

```bash
maas admin boot-resources read
```

Look for your custom image in the list:

```
custom/debian-trixie (amd64/generic)
```

### 2.4. Deploy to Nodes

**Via MAAS UI:**

1. Navigate to **Machines**
2. Select a node in **Ready** state
3. Click **Deploy**
4. Choose **custom/debian-trixie** from the OS dropdown
5. Confirm deployment

**Via CLI:**

```bash
maas admin machine deploy <system_id> \
    distro_series='custom/debian-trixie'
```

---

## 🐛 Troubleshooting

### Build Fails with "Permission denied" (KVM)

**Symptom:**

```
qemu-system-x86_64: failed to initialize kvm: Permission denied
```

**Solution:**

Apply the KVM fix in section 1.1 - force software emulation by removing `accel=kvm`.

### Build is Very Slow

**Cause:**

Software emulation (no KVM) is significantly slower than hardware acceleration.

**Expected time:**

- With KVM: 5-10 minutes
- Without KVM (WSL2): 30-60 minutes

**Solution:**

Be patient. Consider building on native Linux with KVM support for faster builds.

### OVMF/UEFI Boot Issues

**Symptom:**

```
Could not find firmware for UEFI boot
```

**Solution:**

Use `BOOT=bios` flag as shown in section 1.2.

---

## 📚 Additional Resources

- [Packer QEMU Builder Docs](https://developer.hashicorp.com/packer/plugins/builders/qemu)
- [MAAS Image Builder Repository](https://github.com/canonical/packer-maas)
- [MAAS Custom Images Documentation](https://maas.io/docs/custom-images)