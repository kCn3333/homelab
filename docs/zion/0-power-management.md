# :material-power-plug: Power Management

Zion runs continuously, but most of the time it is lightly loaded. The goal is therefore simple: reduce idle power draw without suspending the host or making storage, networking, and guests unreliable.

!!! warning
    This configuration was tested on Gigabyte Z370 HD3 with an Intel Core i5-8400. The same settings may behave differently on another board, controller, or kernel.

## :material-target: What is optimized

- CPU and package idle states;
- PCIe, DMI and chipset link power management;
- unused onboard devices;
- standby behaviour of the mechanical data disk;
- Linux power-saving tunables applied after boot.

Integrated graphics stays enabled for emergency console access and Intel Quick Sync. Zion itself is not suspended automatically.

## :material-chip: UEFI settings

### CPU

| Setting | Value |
|---|---|
| Intel CPU C-States Control | `Enabled` |
| Package C-State Limit | `C10` |
| Intel Speed Shift Technology | `Enabled` |
| Enhanced Halt State (C1E) | `Enabled` |
| C3, C6/C7, C8 and C10 support | `Enabled` |
| Enhanced Intel SpeedStep (EIST) | `Enabled` |
| Race to Halt | `Enabled` |
| Energy Efficient Turbo | `Enabled` |
| Voltage Optimization | `Enabled` |

Prefetchers and ring-to-core offset settings remain on `Auto`. There was no workload-specific reason to change them.

### Chipset and PCIe

| Setting | Value |
|---|---|
| PEG ASPM | `Enabled` |
| PCH ASPM | `Enabled` |
| DMI ASPM | `Enabled` |
| CEC 2019 Ready | `Enabled` |
| RC6 / Render Standby | `Enabled` |
| Power Loading | `Auto` |

ASPM allows idle PCIe and chipset links to enter lower-power states. RC6 does the same for the integrated GPU when it is not processing video or driving a console.

### Onboard devices

| Device or feature | Value |
|---|---|
| SATA Aggressive Link Power Management | `Enabled` |
| Serial port | `Disabled` |
| Parallel port | `Disabled` |
| Onboard audio | `Disabled` |
| Integrated graphics | `Enabled` |

Only confirmed unused devices are disabled.

## :material-power-plug-off: ErP and Wake-on-LAN

`ErP: Enabled` reduces soft-off power consumption below the normal standby level, but disables Wake-on-LAN on this platform.

Zion is expected to remain online, so ErP is enabled. If remote Wake-on-LAN for Zion becomes necessary, ErP must be disabled and WoL tested again after a complete shutdown.

This does not affect Wake-on-LAN for the separate K3s nodes.

## :material-harddisk: HDD spindown

The IronWolf disk stores backups and bulk data such as the media library. When no job or application is using it, stopping the platters saves several watts and allows the platform to reach deeper package states.

Persistent configuration should use the disk's `/dev/disk/by-id/` path. Do not copy `/dev/sdX` names into configuration because they can change after a reboot.

Check the current state:

```bash
sudo hdparm -C /dev/disk/by-id/<IRONWOLF_DISK>
```

Request standby during a controlled test:

```bash
sudo hdparm -y /dev/disk/by-id/<IRONWOLF_DISK>
```

Set a ten-minute idle timeout:

```bash
sudo hdparm -S 120 /dev/disk/by-id/<IRONWOLF_DISK>
```

The disk wakes automatically on I/O. Backup jobs, SMART tests, media scans and filesystem activity can wake it as well.

!!! note
    `hdparm -S` issued from the shell is not persistent. After adding the setting to the system configuration, verify it again after reboot.

Frequent spin-up and spin-down cycles defeat the purpose and add latency. If the disk wakes repeatedly during normal operation, increase the timeout or leave it running during active hours.

## :material-tune-vertical: PowerTOP at boot

The tested PowerTOP tunables are reapplied by `/etc/systemd/system/powertop.service`:

```ini
[Unit]
Description=Apply PowerTOP tunables
After=multi-user.target
ConditionPathExists=/usr/sbin/powertop

[Service]
Type=oneshot
ExecStart=/usr/sbin/powertop --auto-tune
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
```

Validate and enable the unit:

```bash
sudo systemd-analyze verify /etc/systemd/system/powertop.service
sudo systemctl daemon-reload
sudo systemctl enable --now powertop.service
sudo systemctl status powertop.service --no-pager
```

`powertop --auto-tune` changes several device policies at once. After a kernel update or hardware change, check the network interfaces, storage, USB devices and running guests. If one device becomes unstable, replace the blanket auto-tune with explicit settings for the tunables already verified as safe.

## :material-check-decagram: Validation

After changing the configuration, check:

- CPU package C-state residency during a representative idle period;
- network links and access to every VM and LXC;
- NVMe and HDD access;
- VM and container startup and shutdown;
- backup execution and datastore availability;
- HDD start/stop frequency;
- failed systemd units;
- reboot and recovery after power loss.

Useful read-only commands:

```bash
sudo powertop
sudo systemctl --failed --no-legend --plain --no-pager
sudo journalctl -b -u powertop.service --no-pager
sudo smartctl -a /dev/disk/by-id/<IRONWOLF_DISK>
```

## :material-chart-line: Measured result

During the original tuning session:

- CPU package idle states changed from no reported residency to regular `pc2` and `pc3` residency;
- CPU `C0 active` time at idle fell from about **11%** to about **3%**;
- idle draw of the motherboard and CPU platform fell by about **5.5 W**, roughly **25%** of that part of the baseline.

These figures describe one hardware and workload state. Measure again after adding PCIe devices, enabling passthrough, changing disks or moving substantial workloads between guests.

### :material-power-socket-eu: Wall power

Complete-system power was also measured at the wall:

| System state | Measured draw |
|---|---:|
| Zion idle, with the IronWolf HDD spinning | **24–25 W** |
| Zion under heavier workloads | **40–60 W** |
| Dell Wyse 5070 idle, with two 2.5-inch drives | **12–13 W** |

Moving from the Dell Wyse 5070 to Zion roughly doubled idle consumption. In return, Zion provides a six-core CPU, NVMe storage, substantially more memory, hardware expansion and enough capacity to separate workloads into VMs and LXC containers. An idle draw of 24–25 W is a reasonable trade-off for that increase in capability.

## :material-clipboard-check-outline: Operating rules

- Stability and data integrity take priority over the lowest possible idle draw.
- Backup windows take priority over HDD spindown.
- UEFI changes are applied and tested in small groups.
- ErP is reviewed whenever Wake-on-LAN requirements change.
- PowerTOP is revalidated after kernel and hardware changes.
- Measurements are compared with the same guests and storage state.