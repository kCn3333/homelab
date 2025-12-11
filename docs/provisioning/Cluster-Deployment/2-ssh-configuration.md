
# SSH Configuration

### 🔑 Configure SSH Agent

- for Windows 10/11

   ```bash
    # Autostart for SSH Agent
    Get-Service ssh-agent | Set-Service -StartupType Automatic
    # 
    Start-Service ssh-agent
    # Add your SSH key
    ssh-add C:\Users\USER\.ssh\id_rsa
    ```

- for WSL or Linux (Windows SSH Agent doesn't work for WSL)
```bash
# Install keychain
sudo apt install keychain 

# Add keychain setup to your shell profile ~/.bashrc or ~/.zshrc 
eval $(keychain --eval --quiet id_rsa)
```

### ⚙️ Configure Local SSH Aliases

works the same for Windows and Linux/WSL

modify your `C:\Users\USER\.ssh\config` or `./ssh/config`

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

```bash
chmod 600 ~/.ssh/config
```

### 📝 Hostnames

- For Windows open as Administrator `C:\Windows\System32\drivers\etc\hosts` and add:
```
192.168.55.10    master-00
192.168.55.11    worker-01
192.168.55.12    worker-02
```

- For Linux or WSL `/etc/hosts`
