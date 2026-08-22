# Zion platform

Zion replaced Oracle Legacy, the original bare-metal Debian server. Oracle worked well for years, but almost every service shared the same operating system, Docker daemon, network stack, storage layout, and maintenance window. A broken package update, firewall mistake, or Docker networking problem could affect the whole homelab at once.


:SiProxmox: Moving to Proxmox VE solved that practical problem and added room for experiments:

- infrastructure services can be separated from applications;
- each guest has its own lifecycle, resource limits, network interface, and backup policy;
- risky tools such as Kali can stay powered off and isolated until needed;
- complete VMs and LXC containers can be backed up and restored;
- a failed service can be rebuilt without reinstalling the whole server;
- KVM and LXC can be used where each one makes sense;
- the platform provides a useful place to learn virtualization instead of running another large Docker host.

This is still one physical server, so Proxmox does not make the homelab highly available. A Zion hardware failure affects every running guest. The improvement is separation, recovery, and easier maintenance—not physical redundancy.

Hardware selection and the build history are documented separately under **Infrastructure**. This page covers the working platform.

## :fontawesome-solid-layer-group: Virtualization layout

| Guest | Type | Main role |
|---|---|---|
| Logos | KVM VM | Main operations server, Docker workloads, Semaphore, Kopia, Garage, WireGuard, and shared administration tools |
| Kali | KVM VM | On-demand security testing and network diagnostics |
| AdGuard Home | LXC | Local DNS filtering and internal DNS rewrites |
| Caddy | LXC | Internal HTTPS reverse proxy and certificate management |
| HAProxy | LXC | Load balancing for the K3s API and ingress traffic |
| PatchMon | LXC | Patch visibility and host maintenance reporting |
| Docker Media | LXC | Jellyfin and the Arr media stack |
| Home Assistant | LXC | Home Assistant, ESPHome, and the Zigbee USB device |
| Proxmox Backup Server | LXC | Image-level backups of Proxmox guests |

### Why two VMs?

Logos is a full VM because it is the main general-purpose Linux system. It runs Docker, network forwarding, automation, backup tools, and several supporting services. A separate kernel and normal VM networking make this easier to operate than Docker inside an LXC and keep Logos independent from Proxmox userspace.

Kali is also a VM because security tooling may require its own kernel features, USB devices, unusual network modes, or software that should not share a container with normal infrastructure. It remains powered off when it is not needed.

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

Zion uses two storage tiers with different jobs.

| Storage | Proxmox use | What belongs there |
|---|---|---|
| Kingston KC3000 NVMe | `local` and `local-lvm` | Proxmox system, ISO images, LXC templates, guest root filesystems, virtual disks, container data, and other active operational state |
| Seagate IronWolf HDD | `wolfie1-4tb` and the PBS datastore exposed as `PBS-IronWolf` | Proxmox backups and capacity-oriented data such as the media library |

### NVMe: active workloads

VMs and LXC containers run from the NVMe disk. This includes their system disks and normal application state. The point is simple: boot, package operations, databases, Docker metadata, and everyday guest I/O should not wait for a mechanical disk.

`local-lvm` provides the thin-provisioned virtual disks and LXC root filesystems. `local` keeps Proxmox-side files such as ISO images and container templates. Both are part of the NVMe-backed system tier.

### IronWolf: capacity and backups

The IronWolf disk is not used as the normal system disk for guests. It holds data where capacity matters more than latency:

- the Proxmox Backup Server datastore;
- image-level backups of VMs and LXC containers;
- large persistent datasets such as the media library;
- selected local backup repositories.

PBS runs inside an LXC, but its datastore is not stored inside that container's root filesystem. Zion bind-mounts a directory from the IronWolf filesystem into PBS. Rebuilding the PBS container therefore does not require recreating the backup data.

Proxmox also connects to that datastore as `PBS-IronWolf`, so guest backups are managed through the normal Proxmox backup workflow.

### What this model protects against

Separating active guest disks from the backup disk makes recovery from an NVMe failure practical: reinstall Proxmox, reconnect the surviving IronWolf filesystem, recreate or restore PBS, and then restore the guests.

It does **not** protect against loss of the complete server, theft, fire, filesystem damage on the IronWolf disk, or operator error affecting both tiers. Configuration collection and Kopia provide additional local and off-site layers for those cases. The complete recovery model is described in [Backup and recovery](backup-and-recovery.md).

## :fontawesome-solid-network-wired: Networking

Zion uses a standard Proxmox bridge model:

- the physical NIC is a port of `vmbr0` and has no management address of its own;
- the Zion management address is assigned to `vmbr0`;
- VMs and LXC containers attach virtual interfaces to the bridge;
- each guest receives its own MAC address and network configuration.

This keeps the host and guests on the normal LAN without routing traffic through the Proxmox userspace. From the network's point of view, every guest behaves like a separate machine connected to the same switch.

### Why guests have separate interfaces

Proxmox creates a dedicated virtual interface for each guest instead of sharing the host address. This gives each system:

- its own firewall scope;
- independent addressing and DNS;
- separate traffic counters and troubleshooting;
- the option to use a different VLAN or bridge;
- network changes that do not require rebuilding the whole host.

Critical services such as DNS, internal HTTPS, and K3s load balancing therefore remain separate network endpoints even though they run on the same physical server.

### Logos and the K3s Wake-on-LAN path

Logos has two virtual network interfaces:

1. the primary interface carries normal LAN traffic, Docker services, management, backups, and the WireGuard path;
2. the secondary interface is reserved for the K3s network used by Semaphore to send Wake-on-LAN packets to the three physical cluster nodes.

The second interface carries the tagged cluster VLAN through a dedicated VLAN interface inside Logos. It exists because Wake-on-LAN uses a layer-2 broadcast. Routing a UDP packet toward another subnet was not enough: the router forwarded the IP packet, but did not recreate the Ethernet broadcast required by the powered-off machines.

Giving Semaphore a direct presence in the cluster VLAN solved that problem without moving the rest of Logos into the cluster network. Normal server traffic stays on the primary interface; only the cluster lifecycle path uses the secondary one.

### Link recovery on Zion

The physical NIC uses `allow-hotplug` so it returns after the switch or upstream link disappears and comes back. Energy Efficient Ethernet is disabled on this interface because it previously left the link unusable after an interruption even though the interface appeared to return.

The settings are applied in `/etc/network/interfaces`, including the tested speed, duplex, and autonegotiation parameters. They are not repaired by an external cron job after every failure.

Network changes on Zion are treated as maintenance work. Restarting the host networking service remotely can disconnect Proxmox and every guest attached to `vmbr0`. Changes are validated first and normally activated during a controlled reboot with console access available.

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