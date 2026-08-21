# Logos operations server

Logos is the main operational Linux server in the homelab. It runs as an Ubuntu KVM virtual machine on Zion and replaced the Docker and automation responsibilities previously hosted on Oracle Legacy.

Calling Logos only a Docker host would miss most of its role. It also coordinates automation and backups, provides the local side of the WireGuard relay, and acts as the shared operational environment for the rest of the platform.

## Responsibilities

| Area | Responsibilities |
|---|---|
| Containers | Docker Engine, Docker Compose, Portainer, and application stacks |
| Automation | Semaphore controller and supporting maintenance tooling |
| Backups | Kopia, remote configuration collection target, and access to local backup storage |
| Object storage | Garage S3 for selected cluster and application backups |
| Networking | Local WireGuard peer, forwarding, NAT, and narrowly scoped access to selected services |
| Operations | Shared administration tools, logs, scripts, and service validation |

## Workload groups

The Docker workloads are grouped by function instead of being documented as independent servers.

### Platform services

- Portainer for container and stack management;
- Semaphore for Ansible execution;
- Uptime Kuma for availability monitoring;
- ntfy for operational notifications;
- Garage for S3-compatible object storage;
- Kopia for local and off-site file backups.

### Self-hosted applications

- Nextcloud;
- Immich;
- Mealie;
- Gitea and supporting database services;
- personal notes, dashboards, and small utility applications.

Media workloads are not hosted directly on Logos. Jellyfin and the Arr stack run in the dedicated Docker Media LXC so that media storage, hardware access, and application data remain separated from the operations VM.

## Container management

Compose definitions are maintained in the dedicated Docker Compose repository. Portainer provides the operational interface, but the repository remains the preferred description of how a stack is built.

Persistent application data is stored outside container writable layers. Containers can therefore be recreated without treating the running container as a backup source.

The Docker address pools are intentionally constrained. A previous broad Docker network allocation overlapped with homelab routes and caused traffic to be sent to a local bridge instead of the correct gateway. New networks must be checked against LAN, VPN, Kubernetes, and cloud address spaces before deployment.

## WireGuard gateway

Logos is the home-side peer for the external Relay VPS. The tunnel is used to carry selected traffic from the public reverse proxy to explicitly approved local services.

The forwarding model is deliberately narrow:

1. the Relay terminates the public connection;
2. WireGuard carries the request to Logos;
3. Logos forwards only the approved destination and port;
4. source NAT is applied where the internal service requires a return path through Logos;
5. unrelated traffic from the tunnel is rejected.

This design avoids inbound port forwarding on the home router. It does not make the exposed application private, so authentication, patching, rate limiting, and application-level security remain necessary.

Firewall rules are persisted and validated after Docker or host restarts. Interface names are derived from the active route instead of being assumed from a previous machine.

## Garage object storage

Garage was migrated from Oracle Legacy to Logos while preserving its application data and node identity. It provides an S3-compatible endpoint used by selected Kubernetes components and backup workflows.

The migration required more than moving the container:

- application data and metadata were transferred while Garage was stopped;
- the advertised endpoint was updated;
- Flux-managed consumers were changed in Git rather than patched manually in the cluster;
- Longhorn and Loki were validated after reconciliation;
- a fresh Longhorn backup was executed to confirm end-to-end access.

## Backup participation

Logos receives configuration snapshots collected from other hosts. Kopia then protects the selected parts of the Logos filesystem using both local and off-site repositories.

Large application datasets and reproducible caches use separate policies. The exact inclusion lists, schedules, repository credentials, and recovery keys are kept in private operational documentation.

## Update model

Host package updates are executed through the shared Ansible maintenance workflow. Container image updates are handled separately from operating-system packages so that application upgrades do not silently change host state.

An update may create a reboot-required marker, but it does not reboot Logos automatically. Reboot approval and post-reboot verification remain separate operations.

## Validation checklist

After a major change to Logos, the following areas are checked:

- SSH key-only administration and non-interactive automation access;
- Docker daemon and expected containers;
- WireGuard handshake and approved routes;
- forwarding and NAT counters for the allowed paths;
- Garage health and S3 consumers;
- Kopia repository access and recent snapshots;
- absence of unexpected failed systemd units.

