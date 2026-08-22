# :material-server-network: Supporting LXC Services

This page records few smaller service boundaries that complete the Zion platform.

---

## :simple-adguard: AdGuard 

| Property | Value |
|---|---|
| System | Dedicated Debian LXC |
| CPU | 1 vCPU |
| Memory | 1 GB |
| Swap | 512 MB |
| Runtime | Native AdGuard service |

AdGuard replaced the previous [:material-pi-hole: Pi-hole](https://github.com/kCn3333/docker-compose/blob/main/pihole/docker-compose.yaml) deployment and provides:

- DNS filtering for LAN clients;
- local host records;
- internal DNS rewrites to Caddy;
- the cluster wildcard rewrite to HAProxy;
- one central place to change a service destination after migration.

Clients use AdGuard as their LAN DNS resolver. Stable frontend services resolve to Caddy or HAProxy instead of directly to application containers.

The container was created with the [AdGuard Home Proxmox VE Community Script](https://community-scripts.org/scripts/adguard), then adjusted to the final resource limits and network configuration.

## :material-pac-man: PatchMon

| Property | Value |
|---|---|
| System | Dedicated Debian LXC |
| CPU | 2 vCPU |
| Memory | 2 GB |
| Swap | 512 MB |
| Runtime | Native PatchMon service |

PatchMon provides visibility into pending package updates and reboot requirements across managed hosts. It complements Ansible rather than replacing it:

- PatchMon reports state;
- Semaphore runs approved maintenance;
- ntfy identifies the affected inventory host;
- reboot remains an explicitly approved Ansible operation.

PatchMon is not given authority to restart hosts automatically.

The container was created with the [PatchMon Proxmox Community Script](https://community-scripts.github.io/ProxmoxVE/scripts?id=patchmon). PatchMon's server and agent run as native systemd services rather than as part of a shared Docker host.

---

## :material-cog-sync-outline: Common operating model

These LXC containers follow the same baseline:

- key-only SSH for personal and automation access where SSH is enabled;
- password authentication disabled after access validation;
- dedicated Ansible automation identity;
- safe APT updates without automatic reboot;
- host-aware ntfy reporting;
- explicit service and failed-unit checks;
- image-level PBS backup plus selected configuration collection.
