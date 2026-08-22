# Zion platform

Zion replaced Oracle Legacy, the original bare-metal Debian server. Oracle worked well for years, but almost every service shared the same operating system, Docker daemon, network stack, storage layout, and maintenance window. A broken package update, firewall mistake, or Docker networking problem could affect the whole homelab at once.


:simple-proxmox: Why Proxmox?

| Oracle Legacy limitation | What changed on Zion |
|---|---|
| Most services shared one Debian installation | Services have separate operating environments |
| System maintenance affected the whole server | Guests can be updated or restarted independently |
| Docker, networking, and applications shared one failure domain | DNS, proxies, media, automation, and Home Assistant are separated |
| Recovery was mostly file- and configuration-based | Complete VMs and LXC containers can be backed up and restored |
| Experiments ran close to production services | Kali and test workloads run in isolated VMs |
| Resource use was difficult to control per service | CPU, RAM, storage, startup order, and network interfaces are assigned per guest |

This is still one physical server, so Proxmox does not make the homelab highly available. A Zion hardware failure affects every running guest. The improvement is separation, recovery, and easier maintenance—not physical redundancy.

Hardware selection and the build history are documented separately under **Infrastructure**. This page covers the working platform.

## :fontawesome-solid-layer-group: Virtualization layout

| System | Type | Main role | Why this type? |
|---|---|---|---|
| **:simple-ubuntu: Logos** | KVM VM | Docker, Semaphore, Kopia, Garage, WireGuard, and administration tools | Needs a normal Linux kernel and works as the main general-purpose server |
| **:simple-kalilinux: Kali** | KVM VM | Security testing and network diagnostics | Keeps testing tools and custom network modes outside normal infrastructure |
| **:simple-adguard: AdGuard Home** | LXC | Local DNS filtering and DNS rewrites | Small, dedicated Linux service with low resource use |
| **:simple-caddy: Caddy** | LXC | Internal HTTPS reverse proxy and certificates | Independent network service that should not depend on Logos |
| **:simple-haproxy: HAProxy** | LXC | K3s API and ingress load balancing | Small critical service with a separate lifecycle |
| **:material-update: PatchMon** | LXC | Patch visibility and maintenance reporting | Lightweight service that remains separate from monitored hosts |
| **:simple-docker: Docker Media** | LXC | Jellyfin and the Arr stack | Groups related media services and their storage access |
| **:simple-homeassistant: Home Assistant** | LXC | Home Assistant, ESPHome, and Zigbee | Separate Docker environment with direct USB device access |
| **:simple-proxmox: Proxmox Backup Server** | LXC | Image-level guest backups | Low overhead; the backup datastore remains outside the container rootfs |

### Why dedicated LXC containers?

Small Linux services do not need a complete virtual machine. LXC keeps their overhead low while still giving them separate filesystems, package databases, service managers, network interfaces, and backup units.

The split follows operational boundaries rather than a rule of one application per container:

- DNS and reverse proxies stay independent from the main Docker server;
- failure of the media stack does not take Home Assistant or internal DNS with it;
- HAProxy can be maintained without touching the K3s nodes;
- Home Assistant has its own Docker environment and direct Zigbee device access;
- PBS can be rebuilt separately from the backup datastore;
- PatchMon does not depend on the host it is expected to report on.

This layout also limits maintenance scope. Updating Caddy means working on the Caddy LXC, not restarting a shared Docker host that carries unrelated services.

## :fontawesome-solid-hard-drive: Storage model

Zion uses two storage tiers:

| Storage | Proxmox storage | Contents |
|---|---|---|
| **:material-memory: Kingston KC3000 NVMe** | `local`, `local-lvm` | Proxmox system, ISO images, LXC templates, guest rootfs, virtual disks, container data, and other active state |
| **:fontawesome-solid-hard-drive: Seagate IronWolf HDD** | `wolfie1-4tb`, `PBS-IronWolf` | PBS datastore, VM/LXC backups, media library, and other capacity-oriented data |

### :material-lightning-bolt: NVMe — active workloads

- VMs and LXC containers run from NVMe.
- `local-lvm` holds their virtual disks and root filesystems.
- `local` holds Proxmox-side files such as ISO images and LXC templates.
- Databases, Docker metadata, package operations, and normal guest I/O stay off the mechanical disk.

### :fontawesome-solid-box-archive: IronWolf — backups and large data

- PBS stores image-level backups on the IronWolf filesystem.
- Large data such as the media library uses HDD capacity instead of NVMe space.
- The PBS datastore is bind-mounted into the PBS LXC; it is not part of the container rootfs.
- Proxmox accesses the datastore as `PBS-IronWolf` through the normal backup workflow.

If the NVMe fails, the intended path is: reinstall Proxmox, reconnect the IronWolf filesystem, recreate PBS, attach the existing datastore, and restore the guests.

This does not protect against loss of the complete Zion machine or damage to the IronWolf disk. Configuration collection and Kopia provide separate local and off-site layers. See [Backup and recovery](backup-and-recovery.md).

## :fontawesome-solid-network-wired: Networking

| Component | Purpose |
|---|---|
| Physical NIC | Port of `vmbr0`; it has no management address |
| `vmbr0` | Main Linux bridge and Zion management interface |
| Guest virtual NICs | Connect VMs and LXC containers to the LAN through `vmbr0` |

Each guest gets its own MAC address, IP configuration, firewall scope, and traffic counters. A guest can later be moved to another VLAN or bridge without redesigning the entire host network.

### :simple-ubuntu: Logos interfaces

Logos has two virtual NICs with separate jobs:

| Interface | Traffic |
|---|---|
| Primary NIC | LAN, Docker services, management, backups, and WireGuard |
| Secondary NIC | K3s VLAN used by Semaphore for Wake-on-LAN |

The secondary NIC carries the tagged cluster VLAN through a dedicated VLAN interface inside Logos.

This was required because Wake-on-LAN is a layer-2 broadcast. Sending a directed broadcast through the normal router did not recreate the Ethernet broadcast inside the K3s VLAN. With a direct VLAN interface, Semaphore sends the magic packet from the same broadcast domain as the powered-off nodes.

Normal Logos traffic stays on the primary NIC. The second interface exists only for the cluster lifecycle path.

### :material-ethernet: Link recovery

Zion's physical NIC uses `allow-hotplug`, so it returns after a switch or upstream link interruption. Energy Efficient Ethernet is disabled because it previously left the link unusable after connectivity returned.

The tested link settings are applied through `/etc/network/interfaces`, not by a repair cron job.

!!! warning
    Restarting networking remotely can disconnect Zion and every guest attached to `vmbr0`. Network changes are applied during a controlled maintenance window with console access available.

## :fontawesome-solid-bolt: Power management

Zion is expected to remain online, so reducing idle consumption matters more than implementing aggressive suspend behaviour.

The current setup uses deeper CPU package states, PCIe power management, disabled unused onboard devices, HDD spindown, and PowerTOP tunables applied at boot. Integrated graphics remains enabled for emergency console access and hardware-accelerated media workloads.

The exact firmware values, disk commands, measured result, and the ErP versus Wake-on-LAN trade-off are documented in [Energy optimization](0-power-management.md).

## :fontawesome-solid-screwdriver-wrench: Operating rules

- Proxmox manages guest lifecycle, virtual disks, interfaces, and image backups.
- Applications are managed inside their VM or LXC, not from the Proxmox host.
- DNS and reverse-proxy services are kept separate from Logos.
- Package maintenance does not reboot Zion automatically.
- Host reboots require a maintenance window and validation of guests, storage, networking, and backups.
- Kali stays powered off unless it is being used.
- The PBS container root filesystem and the backup datastore are treated as separate components.
- A successful backup job is not a restore test.
- Exact addresses, credentials, recovery keys, and full configuration files stay outside the public repository.

## :fontawesome-solid-book: Related documents

- [Energy optimization](0-power-management.md)
- [Logos operations server](4-logos.md)
- [Internal Caddy](caddy.md)
- [HAProxy for the K3s cluster](haproxy.md)
- [Supporting LXC services](supporting-services.md)
- [Home Assistant and Zigbee](home-assistant.md)
- [Backup and recovery](3-backup-and-recovery.md)
- [Maintenance and updates](../automation/update-strategy.md)
- [Migration journal](1-migration.md)