# Energy Optimization

Zion is designed to remain available as the main virtualization platform without wasting power while idle. The optimization work therefore focuses on reducing the baseline consumption of the motherboard, CPU, storage, and unused peripherals while preserving stability, remote administration, and the ability to expand the platform later.

The settings documented here describe the configuration validated on Zion's Gigabyte Z370 HD3 and Intel Core i5-8400 platform. They are not universal recommendations for unrelated hardware.

!!! warning "Stability comes first"
    Power-saving options can affect PCIe devices, storage latency, USB peripherals, network adapters, and wake behaviour. Apply changes in small groups, keep local console access available, and validate the platform under both idle and normal workload conditions.

## Optimization goals

- allow the CPU package to enter deeper idle states;
- reduce unnecessary activity on PCIe and chipset links;
- stop the mechanical data disk during sufficiently long idle periods;
- disable unused onboard devices;
- reapply safe operating-system tunables after every boot;
- retain integrated graphics for emergency console access and Intel Quick Sync;
- keep virtualization, networking, backups, and storage reliable.

## Firmware configuration

### CPU power management

The following UEFI settings allow the processor and the complete CPU package to enter deeper idle states and return to full performance when work arrives.

| Setting | Value | Purpose |
|---|---|---|
| Intel CPU C-States Control | Enabled | Enables processor idle states |
| Package C-State Limit | C10 | Allows the deepest supported package state |
| Intel Speed Shift Technology | Enabled | Lets the CPU adjust performance states quickly |
| Enhanced Halt State (C1E) | Enabled | Reduces power use during light idle periods |
| C3, C6/C7, C8 and C10 support | Enabled | Enables progressively deeper idle states |
| Enhanced Intel SpeedStep (EIST) | Enabled | Allows dynamic frequency and voltage scaling |
| Race to Halt | Enabled | Completes short workloads quickly and returns to idle |
| Energy Efficient Turbo | Enabled | Favors efficient turbo behaviour |
| Voltage Optimization | Enabled | Enables platform-managed voltage reduction |

Prefetchers and ring-to-core offset controls remain on `Auto`. They were not changed without a workload-specific reason.

### Chipset and PCIe power management

| Setting | Value | Purpose |
|---|---|---|
| PEG ASPM | Enabled | Saves power on the graphics PCIe link |
| PCH ASPM | Enabled | Enables chipset link power management |
| DMI ASPM | Enabled | Enables power management between CPU and chipset |
| CEC 2019 Ready | Enabled | Applies stricter platform idle-power behaviour |
| RC6 / Render Standby | Enabled | Powers down the integrated GPU when idle |
| Power Loading | Auto | Retains the board's low-load stability protection |

The integrated GPU remains enabled. It provides an emergency local console and can be used for hardware-accelerated media processing.

### ErP and Wake-on-LAN

ErP reduces the server's consumption while powered off, but on this platform it also disables Wake-on-LAN.

This is an explicit trade-off:

- use `ErP: Enabled` when minimum soft-off consumption is more important and Zion is expected to remain online;
- use `ErP: Disabled` if remote Wake-on-LAN for Zion becomes an operational requirement.

After changing ErP, test cold boot, orderly shutdown, power-loss recovery, and Wake-on-LAN rather than relying only on the firmware description.

### Unused onboard devices

| Device or feature | Setting |
|---|---|
| SATA Aggressive Link Power Management | Enabled |
| Serial port | Disabled |
| Parallel port | Disabled |
| Onboard audio | Disabled |
| Integrated graphics | Enabled |

Only devices confirmed as unused should be disabled. Future PCIe passthrough, local troubleshooting, or media workloads may change that decision.

## Mechanical disk spindown

The IronWolf data disk consumes several watts while its platters are spinning and can prevent the platform from reaching deeper package states. It is therefore allowed to spin down after a period without I/O.

Before changing disk power management:

1. confirm the correct disk by model, serial number, filesystem, and mount point;
2. ensure that no backup, scrub, SMART test, media scan, or guest workload is active;
3. use a stable `/dev/disk/by-id/` path in persistent configuration;
4. observe whether recurring services wake the disk too frequently.

Read the current power state without intentionally performing filesystem I/O:

```bash
sudo hdparm -C /dev/disk/by-id/<IRONWOLF_DISK>
```

Request an immediate standby transition during a controlled test:

```bash
sudo hdparm -y /dev/disk/by-id/<IRONWOLF_DISK>
```

Configure a ten-minute idle timeout for testing:

```bash
sudo hdparm -S 120 /dev/disk/by-id/<IRONWOLF_DISK>
```

The disk wakes automatically when it receives I/O. The timeout should be reconsidered if logs show frequent start/stop cycles: repeated spin-up can be worse for latency and drive wear than leaving the disk running during an active period.

!!! note
    An interactive `hdparm -S` setting may not survive a reboot. Persistent configuration should reference the stable disk identifier and must be verified after restarting Zion.

## PowerTOP at boot

PowerTOP is used to apply the set of operating-system tunables already validated on Zion. A small systemd unit reapplies them after boot:

```ini
[Unit]
Description=Apply validated PowerTOP tunables
After=multi-user.target
ConditionPathExists=/usr/sbin/powertop

[Service]
Type=oneshot
ExecStart=/usr/sbin/powertop --auto-tune
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
```

Install the file as `/etc/systemd/system/powertop.service`, then validate and enable it:

```bash
sudo systemd-analyze verify /etc/systemd/system/powertop.service
sudo systemctl daemon-reload
sudo systemctl enable --now powertop.service
sudo systemctl status powertop.service --no-pager
```

`powertop --auto-tune` should not be treated as universally safe. After kernel, hardware, or passthrough changes, verify networking, storage, USB devices, and guest operation. If one tunable causes instability, replace the blanket auto-tune policy with explicit, individually tested settings.

## Validation

The configuration is accepted only after checking both power behaviour and normal platform operation.

Recommended checks include:

- CPU package C-state residency during a representative idle window;
- system load and CPU activity with guests idle;
- network connectivity and link stability;
- VM and LXC startup, shutdown, and storage access;
- backup execution and restore readability;
- SMART state and disk start/stop behaviour;
- absence of unexpected failed systemd units;
- successful reboot and recovery after simulated power loss.

Useful read-only commands:

```bash
sudo powertop
sudo systemctl --failed --no-legend --plain --no-pager
sudo journalctl -b -u powertop.service --no-pager
sudo smartctl -a /dev/disk/by-id/<IRONWOLF_DISK>
```

## Observed result

During the original tuning session:

- package idle states became active instead of remaining at zero residency;
- CPU active time at idle fell from roughly 11% to approximately 3%;
- measured idle consumption of the motherboard and CPU platform fell by about 5.5 W, approximately 25% of that part of the baseline.

These values are measurements from one hardware and workload state, not guaranteed savings. They should be measured again after adding PCIe devices, changing storage, enabling passthrough, or substantially altering the guest workload.

## Operational policy

- Backups and data integrity take priority over spindown targets.
- Zion is optimized for low idle consumption, not minimum benchmark power.
- Firmware changes are documented and tested individually.
- Wake-on-LAN expectations are reviewed whenever ErP is changed.
- PowerTOP is revalidated after kernel or hardware changes.
- Energy measurements are compared using the same guest and storage state.
