# Arch Linux Installation Guide

This guide covers everything from initial disk encryption with LUKS through to a fully functional desktop environment with i3 window manager, audio, Bluetooth, power management, and media playback inhibitors. 

This is a minimalist configuration tailored for my laptop, designed to use as little RAM as possible — full operational under 400MB after boot. Everything is systemd-based, including WiFi management (iwd), ensuring a lean and efficient system.

![archi](../img/archi.png)

- ✅ Full disk encryption (LUKS) and automatic decryption with keyfiles
- ✅ i3 window manager
- ✅ Alacritty terminal
- ✅ Brave with GPU acceleration
- ✅ Audio (PipeWire)
- ✅ Bluetooth
- ✅ WiFi
- ✅ Power management
- ✅ Few modern tools and utilities
---

## Pre-Installation

### Identify Current Mounts
```bash
findmnt /
findmnt /boot/efi
```

### Partition Disk
```bash
sudo cfdisk /dev/sda
```

### Verify Disk Layout
```bash
lsblk -f
```

---

## Arch ISO Environment

### Connect to WiFi
```bash
iwctl 
device list
station wlan0 connect [your_wifi_name]
exit
```

### Verify Network Connection
```bash
ip a
ping 192.168.0.1
```

### Set Root Password
```bash
passwd
```

### Enable SSH Server
```bash
systemctl status sshd
```

---

## SSH Connection (Optional)

Connect from another machine for easier copy-paste:
```bash
ssh root@<IP-ADDRESS>
```

---

## Disk Partitioning

### Partition Scheme
```bash
cfdisk

sda 8:0 0 119.2G 0 disk  
├─sda1 8:1 0 100M 0 part /boot/efi  
├─sda2 8:2 0 21G 0 part  /
├─sda3 8:3 0 25.6G 0 part /home
```

### Load Encryption Modules
```bash
modprobe dm-crypt  
modprobe dm-mod
```

### Encrypt Partitions with LUKS
```bash
# Encrypt root partition
cryptsetup luksFormat -v -s 512 -h sha512 /dev/sda2

# Encrypt home partition
cryptsetup luksFormat -v -s 512 -h sha512 /dev/sda3
```

### Open and Format Encrypted Partitions
```bash
# Open the root partition
cryptsetup open /dev/sda2 cryptroot

# Open the home partition
cryptsetup open /dev/sda3 crypthome

# Format root partition
mkfs.ext4 /dev/mapper/cryptroot

# Format home partition
mkfs.ext4 /dev/mapper/crypthome
```

### Mount Partitions
```bash
# Mount root to /mnt
mount /dev/mapper/cryptroot /mnt

# Create and mount home directory
mkdir /mnt/home
mount /dev/mapper/crypthome /mnt/home

# Create and mount EFI boot partition
mkdir -p /mnt/boot/efi
mount /dev/sda1 /mnt/boot/efi
```

---

## Base System Installation

### Install Base Packages
```bash
pacstrap -K /mnt base linux-lts linux-firmware intel-ucode
```

### Generate Filesystem Table (FSTAB)
```bash
genfstab -U /mnt >> /mnt/etc/fstab
```

### Enter New System (Chroot)
```bash
arch-chroot /mnt /bin/bash
```

---

## System Configuration

### Install Text Editor
```bash
pacman -S neovim
```

### Configure Initramfs for Encryption

Edit mkinitcpio configuration:
```bash
nvim /etc/mkinitcpio.conf
```

Find the `HOOKS=(...)` line and change it to:
```
HOOKS=(base systemd autodetect modconf kms keyboard sd-vconsole block sd-encrypt filesystems fsck)
```

**Key hooks explained:**
- `systemd` – replaces `udev`, orchestrates boot process in RAM
- `sd-vconsole` – replaces `keymap` and `consolefont`, reads `/etc/vconsole.conf` for keyboard layout
- `sd-encrypt` – systemd-based LUKS encryption support

### Set Keyboard Layout
```bash
echo "KEYMAP=pl" > /etc/vconsole.conf
```

### Generate Kernel Image
```bash
mkinitcpio -P
```

---

## Bootloader (GRUB)

### Install GRUB
```bash
pacman -S grub efibootmgr os-prober
```

### Get Root Partition UUID
```bash
blkid -s UUID -o value /dev/sda2
```

### Configure GRUB

Edit `/etc/default/grub`:
```bash
nvim /etc/default/grub
```

Set the following lines:
```
GRUB_CMDLINE_LINUX_DEFAULT="loglevel=3 quiet rd.luks.name=YOUR-UUID-SDA2=cryptroot root=/dev/mapper/cryptroot rw"
GRUB_DISABLE_OS_PROBER=false
```

### Install GRUB to EFI
```bash
grub-install --target=x86_64-efi --efi-directory=/boot/efi --bootloader-id=ARCH --recheck
```

### Generate GRUB Configuration
```bash
grub-mkconfig -o /boot/grub/grub.cfg
```

---

## Automatic Decryption (Keyfiles)

### Set Permissions and Generate Keys
```bash
chmod 700 /etc/cryptsetup-keys.d

# Generate key for ROOT (sda2)
dd if=/dev/urandom of=/etc/cryptsetup-keys.d/root.key bs=512 count=4
chmod 600 /etc/cryptsetup-keys.d/root.key
cryptsetup luksAddKey /dev/sda2 /etc/cryptsetup-keys.d/root.key

# Generate key for HOME (sda3)
dd if=/dev/urandom of=/etc/cryptsetup-keys.d/home.key bs=512 count=4
chmod 600 /etc/cryptsetup-keys.d/home.key
cryptsetup luksAddKey /dev/sda3 /etc/cryptsetup-keys.d/home.key
```

### Add Root Key to Initramfs

Edit `/etc/mkinitcpio.conf`:
```bash
nvim /etc/mkinitcpio.conf
```

Add:
```
FILES=(/etc/cryptsetup-keys.d/root.key)
```

### Add Home Key to Crypttab
```bash
echo "crypthome UUID=$(blkid -s UUID -o value /dev/sda3) /etc/cryptsetup-keys.d/home.key luks" >> /etc/crypttab
```

### Rebuild Initramfs
```bash
mkinitcpio -P
```

### Add Root Key to GRUB
```bash
sed -i 's|GRUB_CMDLINE_LINUX_DEFAULT=.*|GRUB_CMDLINE_LINUX_DEFAULT="loglevel=3 quiet rd.luks.name=07ce5469-d3fb-4ad6-9e1c-e149570664f9=cryptroot root=/dev/mapper/cryptroot rd.luks.key=07ce5469-d3fb-4ad6-9e1c-e149570664f9=/etc/cryptsetup-keys.d/root.key rw"|' /etc/default/grub
```

**Tip:** Use this nvim command to insert UUID:
1. Position cursor where UUID should go
2. Type: `:r !blkid -s UUID -o value /dev/sda2`
3. UUID will be inserted at cursor position

---

## Final System Configuration

### Set Timezone
```bash
ln -sf /usr/share/zoneinfo/Europe/Warsaw /etc/localtime
```

### Configure NTP (Time Synchronization)

Edit `/etc/systemd/timesyncd.conf`:
```
NTP=0.arch.pool.ntp.org 1.arch.pool.ntp.org 2.arch.pool.ntp.org 3.arch.pool.ntp.org 
FallbackNTP=0.pool.ntp.org 1.pool.ntp.org
```

Enable time synchronization:
```bash
systemctl enable systemd-timesyncd
```

### Set Locale

Edit `/etc/locale.gen` and uncomment:
```
en_US.UTF-8 UTF-8
```

Generate locale files:
```bash
locale-gen 
```

Set system language:
```bash
echo "LANG=en_US.UTF-8" > /etc/locale.conf
```

### Set Hostname
```bash
echo "archi" > /etc/hostname
```

### Create User

Create user with home directory and add to wheel group for sudo:
```bash
useradd -m -G wheel kcn
```

Set user password:
```bash
passwd kcn
```

### Install and Configure Sudo

```bash
pacman -S sudo
```

Set system editor:
```bash
export EDITOR=nvim
```

Edit sudoers file:
```bash
visudo
```

Uncomment this line:
```
%wheel ALL=(ALL:ALL) ALL
```

---

## Essential System Tools

### iwd (WiFi Management)

```bash
pacman -S iwd
systemctl enable iwd
systemctl enable systemd-resolved
```

Create DNS symlink:
```bash
ln -sf /run/systemd/resolve/stub-resolv.conf /etc/resolv.conf
```

Configure iwd:
```bash
sudo nvim /etc/iwd/main.conf
```

```ini
[General]
EnableNetworkConfiguration=true
NameResolvingService=systemd
```

### SSH Server
```bash
pacman -S openssh
sudo systemctl enable sshd
```

### zRAM (Compressed Swap in RAM)

```bash
sudo pacman -S zram-generator
```

Configure zRAM:
```bash
sudo nvim /etc/systemd/zram-generator.conf
```

```ini
[zram0]
zram-size = ram / 2
compression-algorithm = zstd
swap-priority = 100
```

### Reboot into New System
```bash
exit
umount -R /mnt
reboot now
```

---

## Desktop Environment Setup

### Xorg Display Server

```bash
sudo pacman -S xorg-server xorg-xinit xorg-xrandr
```

- `xorg-server` – core display server
- `xorg-xinit` – manual start capability (startx)
- `xorg-xrandr` – resolution and monitor management

**Note:** We don't install `xorg-drivers` meta-package (too much bloat)

### Auto-start X on Login

Edit bash profile:
```bash
nvim ~/.bash_profile
```

```bash
if [[ -z $DISPLAY ]] && [[ $(tty) = /dev/tty1 ]]; then
    exec startx
fi
```

Create xinitrc:
```bash
nvim ~/.xinitrc
```

```bash
exec i3
```

### Intel GPU Driver

```bash
sudo pacman -S xf86-video-intel mesa
```

### i3 (Window Manager)

```bash
sudo pacman -S i3-wm i3status dmenu
```

### Picom (Compositor)

```bash
sudo pacman -S picom
```

Create config directory:
```bash
mkdir -p ~/.config/picom
```

Configure picom:
```bash
nvim ~/.config/picom/picom.conf
```

```
backend = "glx";
vsync = true;

shadow = true;
shadow-radius = 8;
shadow-offset-x = -4;
shadow-offset-y = -4;

opacity-rule = [
  "90:class_g = 'Alacritty'"
];
```

Auto-start in i3:
```bash
nvim ~/.config/i3/config
```

```
exec_always --no-startup-id picom
```

---

## Fonts

### Install Fonts

```bash
sudo pacman -S ttf-jetbrains-mono  
sudo pacman -S ttf-jetbrains-mono-nerd  
sudo pacman -S ttf-font-awesome
sudo pacman -S fontconfig
```

### Configure Font Rendering

```bash
nvim ~/.config/fontconfig/fonts.conf
```

```xml
<?xml version="1.0"?> 
<!DOCTYPE fontconfig SYSTEM "fonts.dtd"> 
<fontconfig> 
	<match target="font"> 
		<edit name="hinting" mode="assign"><bool>true</bool></edit> 
		<edit name="hintstyle" mode="assign"><const>hintslight</const></edit> 
		<edit name="antialias" mode="assign"><bool>true</bool></edit> 
		<edit name="rgba" mode="assign"><const>rgb</const></edit> 
	</match> 
</fontconfig>
```

### Refresh Font Cache

```bash
fc-cache -fv
```

### Set i3 Font

Edit i3 config:
```bash
nvim ~/.config/i3/config
```

```
font pango:JetBrainsMono Nerd Font 7
```

---

## Terminal Emulator (Alacritty)

### Install Alacritty

```bash
sudo pacman -S alacritty
```

### Configure Alacritty

```bash
nvim ~/.config/alacritty/alacritty.toml
```

```toml
[font]  
size = 8.5  
  
[font.normal]  
family = "JetBrainsMono Nerd Font Mono"  
style = "Regular"  
  
[font.bold]  
family = "JetBrainsMono Nerd Font Mono"  
style = "Bold"  
  
[font.italic]  
family = "JetBrainsMono Nerd Font Mono"  
style = "Italic"  
  
[window]  
padding = { x = 6, y = 6 }  
  
[env]  
TERM = "xterm-256color"
```

### Add Terminal Keybinding to i3

```bash
nvim ~/.config/i3/config
```

```
bindsym $mod+Return exec alacritty
```

---

## Audio (PipeWire)

### Install PipeWire

```bash
sudo pacman -S pipewire pipewire-pulse wireplumber pavucontrol brightnessctl
```

### Enable Audio Services

**Important:** Use `--user` flag (user service, not system-wide):
```bash
systemctl --user enable --now pipewire pipewire-pulse wireplumber
```

### Verify Audio Works

```bash
pactl info
```

### Volume Control Keybindings

Edit i3 config:
```bash
nvim ~/.config/i3/config
```

```
# Auto-start audio services
exec --no-startup-id /usr/bin/pipewire 
exec --no-startup-id /usr/bin/wireplumber

# Volume keybindings
bindsym XF86AudioRaiseVolume exec --no-startup-id pactl set-sink-volume @DEFAULT_SINK@ +5% 
bindsym XF86AudioLowerVolume exec --no-startup-id pactl set-sink-volume @DEFAULT_SINK@ -5% 
bindsym XF86AudioMute exec --no-startup-id pactl set-sink-mute @DEFAULT_SINK@ toggle
```

---

## Screen Brightness

### Install Brightness Control

```bash
sudo pacman -S brightnessctl

# Add user to video group (allows control without sudo)
sudo usermod -aG video $USER
```

### Brightness Keybindings

Edit i3 config:
```bash
nvim ~/.config/i3/config
```

```
bindsym XF86MonBrightnessUp exec --no-startup-id brightnessctl set +10%
bindsym XF86MonBrightnessDown exec --no-startup-id brightnessctl set 10%-
```

---

## Bluetooth

### Install Bluetooth Stack

```bash
# Install bluetooth backend
sudo pacman -S bluez bluez-utils

# Enable bluetooth service
sudo systemctl enable --now bluetooth
```

### Manage Bluetooth Devices

Use `bluetoothctl` command-line tool:
```bash
bluetoothctl
```

Commands inside `bluetoothctl`:
```
power on
scan on
pair XX:XX:XX:XX:XX:XX
connect XX:XX:XX:XX:XX:XX
trust XX:XX:XX:XX:XX:XX
exit
```

### Optional: Blueman GUI

```bash
sudo pacman -S blueman
```

Auto-start in i3:
```bash
nvim ~/.config/i3/config
```

```
exec --no-startup-id blueman-applet
```

---

## Web Browser (Brave)

### Install AUR Helper (yay)

```bash
sudo pacman -S --needed base-devel git  
git clone https://aur.archlinux.org/yay-bin.git  
cd yay-bin  
makepkg -si
```

### Install Brave Browser

```bash
yay -S --noconfirm brave-bin

# Clean up
cd .. 
rm -rf yay-bin
```

### Enable GPU Acceleration in Brave

1. Open Brave and navigate to: `brave://flags`
2. Find and set to **Enabled**:
   - **Override software rendering list** (forces GPU usage)
   - **Hardware-accelerated video decode** (offloads video to GPU)
   - **GPU Rasterization**

3. Verify GPU acceleration: `brave://gpu`
   - Look for green **"Hardware accelerated"** entries

### Brave Keybindings

Edit i3 config:
```bash
nvim ~/.config/i3/config
```

```
# Launch YouTube as web app
bindsym $mod+y exec brave --app=https://youtube.com --class=YoutubeApp

# Launch full Brave browser
bindsym $mod+Shift+y exec brave
```

---

## Additional Tools

### System Utilities

```bash
sudo pacman -S btop screenfetch bat eza fzf fd ripgrep tmux yazi
```

- `btop` – system monitor
- `screenfetch` – system info display
- `bat` – cat replacement with syntax highlighting
- `eza` – ls replacement with colors
- `fzf` – fuzzy finder
- `fd` – find replacement
- `ripgrep` – grep replacement

### Starship Prompt

```bash
sudo pacman -S starship

echo 'eval "$(starship init bash)"' >> ~/.bashrc
```

---

## Laptop Hardware Keys

### Unblock Wireless Devices

```bash
# Check blocked devices
rfkill list

# Unblock WiFi
sudo rfkill unblock wifi

# Unblock Bluetooth
sudo rfkill unblock bluetooth

# Or unblock everything
sudo rfkill unblock all
```

### Suspend on Lid Close

Check if hardware detects lid state:
```bash
cat /proc/acpi/button/lid/LID*/state
```

If you see `open`/`closed` → hardware works correctly.

### Configure Lid Switch Behavior

Edit logind configuration:
```bash
sudo nvim /etc/systemd/logind.conf
```

```
HandleLidSwitch=suspend
HandleLidSwitchExternalPower=suspend
HandleLidSwitchDocked=ignore
```

Apply changes:
```bash
sudo systemctl restart systemd-logind
```

### Suspend After Idle Time

Edit logind configuration:
```bash
sudo nvim /etc/systemd/logind.conf
```

```
IdleAction=suspend
IdleActionSec=1h
```

---

## Prevent Suspend During Media Playback

### Install PlayerCTL

```bash
sudo pacman -S playerctl
```

### Create Inhibitor Script

```bash
nvim ~/.local/bin/media-inhibit.sh
```

```bash
#!/bin/bash

while true; do
    if playerctl status 2>/dev/null | grep -q Playing; then
        systemd-inhibit \
          --what=sleep \
          --why="Media playback" \
          --mode=block \
          sleep 30
    else
        sleep 30
    fi
done
```

Make executable:
```bash
chmod +x ~/.local/bin/media-inhibit.sh
```

### Create systemd User Service

```bash
nvim ~/.config/systemd/user/media-inhibit.service
```

```ini
[Unit]
Description=Block suspend while media is playing

[Service]
ExecStart=%h/.local/bin/media-inhibit.sh
Restart=always

[Install]
WantedBy=default.target
```

### Enable Service

```bash
systemctl --user daemon-reexec
systemctl --user enable --now media-inhibit.service
```

### Test Inhibitor

Check if inhibitor is active during media playback:
```bash
systemd-inhibit --list
```

---



