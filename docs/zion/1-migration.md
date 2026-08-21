# Migration from Oracle Legacy to Zion

This journal records the migration from the original Dell Wyse server, now called Oracle Legacy, to the current Zion and Logos platform.

It is intentionally separate from the current-state documentation. The other Zion pages describe how the platform works now; this page preserves the decisions, sequencing, failures, and lessons that may be useful during a future rebuild.

## Starting point

Oracle Legacy began as a low-power Debian server running most homelab workloads together:

- Docker applications;
- internal reverse proxy and DNS-related services;
- Home Assistant and ESPHome with a directly attached Zigbee coordinator;
- HAProxy for the K3s cluster;
- Garage object storage;
- monitoring, automation, and backup tooling.

The system was useful and inexpensive, but unrelated services shared one operating system, one maintenance window, and one failure domain.

## Target design

The migration introduced two main layers:

- **Zion** provides Proxmox VE, storage, and isolated VM/LXC lifecycle;
- **Logos** provides the general-purpose Ubuntu environment, Docker workloads, automation, backups, Garage, and the home-side WireGuard gateway.

Services that benefit from clear infrastructure boundaries were moved to dedicated LXC containers.

## Workload placement

| Workload | Destination | Reason |
|---|---|---|
| General Docker applications | Logos VM | Shared operational environment and easier Compose management |
| Semaphore, Kopia, and Garage | Logos VM | Close to automation, collected configuration, and backup storage |
| Caddy | Dedicated LXC | Internal HTTPS remains independent of application workloads |
| AdGuard Home | Dedicated LXC | DNS remains small, stable, and independently recoverable |
| HAProxy | Dedicated LXC | Stable network identity for K3s API and ingress traffic |
| PatchMon | Dedicated LXC | Patch visibility separated from managed application hosts |
| Jellyfin and Arr stack | Docker Media LXC | Media storage and application state isolated from Logos |
| Home Assistant and ESPHome | Dedicated LXC | USB Zigbee passthrough and home automation isolated together |
| Proxmox Backup Server | Dedicated LXC | Backup datastore attached independently from guest root disks |

Oracle Legacy was retained after migration as a fallback and historical system rather than being immediately erased.

## Migration method

The migration used the same repeatable pattern for stateful workloads:

1. inventory the current service, dependencies, storage, ports, and external consumers;
2. prepare the destination without changing production routing;
3. verify SSH, filesystem ownership, and required devices;
4. stop the source application before copying mutable state;
5. transfer data while preserving ownership and permissions;
6. start the destination on an internal test path;
7. update DNS, proxy, GitOps, or tunnel consumers;
8. validate application behaviour and backups;
9. leave the source stopped but recoverable until the new service is proven stable.

## Important migrations

### Logos and Docker workloads

Most general Docker stacks moved to Logos. Compose definitions, persistent data, proxy awareness, scheduled tasks, and Docker networks were reviewed during the move rather than copied blindly.

Nextcloud was stopped before transferring its application and database state. Its trusted proxy configuration and background job execution were updated on the destination. Similar stateful services followed the same stop-copy-validate approach.

### Home Assistant and Zigbee

Home Assistant and ESPHome moved to a dedicated LXC. The Zigbee coordinator required explicit Proxmox device passthrough and a new serial path inside the container.

An early ownership mismatch in the LXC also demonstrated that successful file transfer does not guarantee usable SSH or application permissions. Ownership and modes became mandatory migration checks.

### HAProxy

HAProxy previously ran in Docker and depended on an additional address attached to Oracle Legacy. The replacement runs natively in a dedicated LXC that owns its network identity directly.

This reduced the number of layers involved in K3s API and ingress routing and made the service easier to start and recover independently.

### Garage

Garage moved to Logos while preserving its data, metadata, and logical node identity. The container itself started successfully, but consumers still referenced the old S3 endpoint.

The final migration therefore included Git changes, Flux reconciliation, Longhorn target validation, Loki recovery, and a fresh backup test. This became a useful reminder that service migration is complete only when its consumers are also verified.

### Internal Caddy

The internal reverse proxy moved into a dedicated LXC. Its configuration was reorganized into a main file plus one site file per backend. Internal DNS rewrites point clients to Caddy, allowing backend locations to change without reconfiguring every client.

### Proxmox Backup Server

PBS was introduced as a dedicated LXC with its datastore on the IronWolf disk. Configuration collection and Kopia were then added as independent layers so that recovery would not depend solely on complete guest images.

## Problems discovered

| Problem | Lesson |
|---|---|
| Docker route overlapped another homelab network | Validate every container address pool against LAN, VPN, cloud, and Kubernetes routes |
| A persisted NAT rule referenced the old interface name | Derive interface assumptions from the active route and verify after reboot |
| Proxmox physical link did not recover reliably | Configure hotplug behaviour and disable problematic EEE settings persistently |
| Home Assistant retained the old Zigbee path | Hardware identifiers and guest-visible paths must be validated separately |
| LXC ownership prevented key authentication | Check ownership after privileged/unprivileged container changes |
| Garage consumers retained the old endpoint | Validate downstream consumers, not only the migrated service |
| Caddy reported a failed systemd unit despite serving traffic | Investigate service/socket activation and runtime-directory state before clearing failures |
| PBS loaded ZFS services without using ZFS | Disable irrelevant services and validate the actual datastore mount |

## Outcome

The migration separated the original all-in-one host into clearer operational domains:

- Zion owns virtualization and local storage;
- Logos owns general operations and Docker workloads;
- dedicated LXC containers own infrastructure and hardware-specific services;
- the Relay provides the external edge without inbound forwarding on the home router;
- Oracle Legacy remains available as a fallback rather than a hidden production dependency.

The main improvement is not simply more virtual machines. It is a clearer boundary between platform, network, application, automation, and recovery responsibilities.

## Follow-up work

- continue testing restores rather than validating only backup creation;
- move remaining manual maintenance into narrowly scoped Ansible workflows;
- document the Relay and WireGuard topology separately;
- create dedicated troubleshooting pages from the verified network and routing incidents;
- periodically confirm that Oracle Legacy is not still required by an undocumented dependency.

