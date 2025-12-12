# :octicons-terminal-16: SSH Configuration

## 🔐 Generate SSH Keys

### For Windows (PowerShell)

Generate a new SSH key pair:

```powershell
# Generate ED25519 key (recommended)
ssh-keygen -t ed25519 -C "your_email@example.com"

# Or RSA key (if ED25519 is not supported)
ssh-keygen -t rsa -b 4096 -C "your_email@example.com"
```

**Default location:** `C:\Users\USER\.ssh\id_ed25519` (or `id_rsa`)

**Steps:**

1. Press **Enter** to accept the default file location
2. Enter a passphrase (recommended) or leave empty for no passphrase
3. Confirm the passphrase

### For Linux / WSL

Generate a new SSH key pair:

```bash
# Generate ED25519 key (recommended)
ssh-keygen -t ed25519 -C "your_email@example.com"

# Or RSA key (if ED25519 is not supported)
ssh-keygen -t rsa -b 4096 -C "your_email@example.com"
```

**Default location:** `~/.ssh/id_ed25519` (or `id_rsa`)

**Steps:**

1. Press **Enter** to accept the default file location
2. Enter a passphrase (recommended) or leave empty for no passphrase
3. Confirm the passphrase

Set correct permissions:

```bash
chmod 700 ~/.ssh
chmod 600 ~/.ssh/id_ed25519
chmod 644 ~/.ssh/id_ed25519.pub
```

---

## 🔑 Configure SSH Agent

### For Windows 10/11

Set up SSH Agent to auto-start and load your key:

```powershell
# Set SSH Agent to start automatically
Get-Service ssh-agent | Set-Service -StartupType Automatic

# Start the SSH Agent service
Start-Service ssh-agent

# Add your SSH key
ssh-add C:\Users\USER\.ssh\id_rsa
```

### For WSL or Linux

**Note:** Windows SSH Agent doesn't work for WSL, so use `keychain` instead.

Install and configure keychain:

```bash
# Install keychain
sudo apt install keychain
```

Add keychain setup to your shell profile (`~/.bashrc` or `~/.zshrc`):

```bash
# Add this line to ~/.bashrc or ~/.zshrc
eval $(keychain --eval --quiet id_rsa)
```

Reload your shell configuration:

```bash
source ~/.bashrc
# or
source ~/.zshrc
```

---

## ⚙️ Configure Local SSH Aliases

Works the same for Windows and Linux/WSL.

Edit your SSH config file:

- **Windows:** `C:\Users\USER\.ssh\config`
- **Linux/WSL:** `~/.ssh/config`

Add the following configuration:

```bash
# --- HOMELAB NODES ---
Host master-00
    HostName 192.168.55.10
    User admin
    IdentityFile ~/.ssh/id_rsa
    ForwardAgent yes

Host worker-01
    HostName 192.168.55.11
    User admin
    IdentityFile ~/.ssh/id_rsa
    ForwardAgent yes

Host worker-02
    HostName 192.168.55.12
    User admin
    IdentityFile ~/.ssh/id_rsa
    ForwardAgent yes
```

Make sure the permissions are correct:

```bash
chmod 600 ~/.ssh/config
```

**Usage:**

Now you can simply SSH using hostnames:

```bash
ssh master-00
ssh worker-01
ssh worker-02
```

---

## 📝 Configure Hostnames

### For Windows

Open **as Administrator:** `C:\Windows\System32\drivers\etc\hosts`

Add the following entries:

```
192.168.55.10    master-00
192.168.55.11    worker-01
192.168.55.12    worker-02
```

### For Linux or WSL

Edit `/etc/hosts`:

```bash
sudo nano /etc/hosts
```

Add the following entries:

```
192.168.55.10    master-00
192.168.55.11    worker-01
192.168.55.12    worker-02
```

Save and exit (`Ctrl+X`, `Y`, `Enter` in nano).

---

## 🚀 Copy SSH Key to Remote Hosts

### Using ssh-copy-id (Linux/WSL)

```bash
# Copy key to remote host
ssh-copy-id admin@192.168.55.10
ssh-copy-id admin@192.168.55.11
ssh-copy-id admin@192.168.55.12
```

### Manual Method (Windows/Linux)

If `ssh-copy-id` is not available:

```bash
# Display your public key
cat ~/.ssh/id_rsa.pub

# SSH to the remote host
ssh admin@192.168.55.10

# On the remote host, add the key
mkdir -p ~/.ssh
echo "YOUR_PUBLIC_KEY" >> ~/.ssh/authorized_keys
chmod 700 ~/.ssh
chmod 600 ~/.ssh/authorized_keys
exit
```

---

## ✅ Verify SSH Connection

Test passwordless SSH:

```bash
ssh master-00
ssh worker-01
ssh worker-02
```

If configured correctly, you should connect without entering a password!