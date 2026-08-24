# :material-swap-horizontal: Migration from Oracle Legacy to Zion

This journal records the migration from the original Dell Wyse server, now called Oracle Legacy, to the current Zion and Logos platform.

It is intentionally separate from the current-state documentation. The other Zion pages describe how the platform works now; this page preserves the decisions, sequencing, failures, and lessons that may be useful during a future rebuild.

## :fontawesome-solid-hand-point-right: Starting point

Oracle Legacy began as a low-power Debian server running most homelab workloads together:

- Docker applications;
- internal reverse proxy and DNS-related services;
- Home Assistant and ESPHome with a directly attached Zigbee coordinator;
- HAProxy for the K3s cluster;
- Garage object storage;
- monitoring, automation, and backup tooling.

## :material-target: Why migrate?

The old server had reached the point where adding another container made the system harder to manage rather than more useful.

| Oracle Legacy | Zion and Logos |
|---|---|
| One Debian installation for almost everything | Separate operating environments for infrastructure and applications |
| One Docker restart affected unrelated services | Critical services have independent lifecycles |
| CPU, memory and storage were shared without clear boundaries | Proxmox assigns resources per VM or LXC |
| Recovery depended mainly on files and Compose data | Complete guests can be backed up and restored through PBS |
| Experiments ran next to normal services | Test workloads have separate guests |
| Limited room for new hardware and storage | Zion provides NVMe workloads, HDD data and future expansion |

The move also provided a practical reason to learn Proxmox, VM, LXC, virtual networking and image-level recovery.

## :material-server-network: Dedicated LXC containers

PatchMon and PBS were added as part of the new platform rather than copied from Oracle Legacy.

| Source or change | Destination |
|---|---|
| HAProxy container | HAProxy LXC |
| Home Assistant and ESPHome containers | Home Assistant LXC |
| Jellyfin and the Arr stack | Docker Media LXC |
| New update-monitoring service | PatchMon LXC |
| New image-backup service | PBS LXC |

Garage remained a Docker service but moved to Logos. Its data and logical node identity were preserved, then every S3 consumer was updated and tested against the new endpoint.

## :simple-ubuntu: Logos decision

Logos was created as a virtual machine and became the main general-purpose Linux server.

| Property | Choice |
|---|---|
| System | Ubuntu 26.04 LTS |
| Memory | 16 GB |
| CPU | 4 vCPU |
| Virtual storage | 1 TB |
| Role | Main operational server |

Ubuntu 26.04 LTS was selected for a fresh support window, familiar Debian-based administration and straightforward support for Docker, WireGuard and automation tools.

A VM was chosen instead of another LXC because Logos needed a normal Linux environment for Docker, WireGuard, automation and general administration. Its current responsibilities are documented in [Logos operations server](logos.md); the VM/LXC rules belong to [Zion platform](platform.md).

## :material-swap-horizontal-bold: Service replacements

Three old components were deliberately replaced rather than copied:

| On Oracle Legacy | Replacement | Destination |
|---|---|---|
| Nginx Proxy Manager | Caddy | Dedicated LXC |
| Pi-hole | AdGuard Home | Dedicated LXC |
| Duplicati | Kopia | Logos |

Caddy and AdGuard were separated because proxying and DNS are needed by many other services. They can be updated, restarted and restored without touching the main Docker VM.

The detailed cutovers are documented in [Caddy](caddy.md), [Supporting LXC services](supporting-services.md) and [Backup and recovery](backup-and-recovery.md).

## :material-package-variant-closed: Services moved without replacement

Most applications kept the same software and Compose-based deployment. Their containers and persistent data moved from Oracle Legacy to Logos:

- Nextcloud
- Immich
- Homepage
- Gitea
- Vaultwarden
- Uptime Kuma
- PostgreSQL
- Semaphore
- Portainer
- ...

Stateful stacks were stopped for the final data copy. Compose definitions, bind mounts, ownership, scheduled jobs, proxy settings and external consumers were checked before the old containers were retired.

## :material-package-variant-closed: Services moved without replacement

Most applications kept the same software and Compose-based deployment. Their containers and persistent data moved from Oracle Legacy to Logos:

- Nextcloud;
- Immich;
- Mealie;
- Homepage;
- Gitea and its database;
- Vaultwarden;
- Uptime Kuma;
- Semaphore;
- Portainer;
- Watchtower;
- Hikvision Manager and server-stats;
- supporting PostgreSQL and utility containers.

Simple stateless containers could be recreated directly from Compose. Databases and Nextcloud required a controlled cutover.

## :material-database-sync: Stateful cutovers

### :simple-postgresql: PostgreSQL

A live PostgreSQL data directory was never treated as an ordinary bind mount. Copying it while the database is writing can produce a dataset that looks complete but cannot be restored safely.

Two migration paths were acceptable:

1. stop every application writing to the database, stop PostgreSQL, and copy the complete data directory with ownership and modes preserved; or
2. create a logical export with `pg_dump` or `pg_dumpall`, then import it into a clean destination database.

The destination had to use a compatible PostgreSQL major version. After startup, roles, databases, extensions and application access were checked before the source stack was retired.

### :simple-nextcloud: Nextcloud

Nextcloud used MariaDB and required one coordinated outage. The application files, configuration, user data and database directory had to represent the same point in time.

#### 1. Stop the source stack

```bash
cd /home/kcn/docker/nextcloud
docker compose down
docker compose ps
```

The final copy starts only after the application and MariaDB containers have stopped. The destination must use a compatible MariaDB image before the copied database directory is mounted.

#### 2. Copy the complete stack data

```bash
sudo rsync \
    -aHAXx \
    --numeric-ids \
    --info=progress2 \
    --rsync-path="sudo rsync" \
    /home/kcn/docker/nextcloud/ \
    <DESTINATION_USER>@<LOGOS_HOST>:/home/kcn/docker/nextcloud/
```

The trailing slash copies the contents of `nextcloud/` into the destination directory. `-aHAXx` preserves normal metadata, hard links, ACLs and extended attributes without crossing into another filesystem. `--numeric-ids` prevents account-name differences from silently changing ownership.

#### 3. Recreate the external Docker network

If the Compose file references an external `proxy` network, create it before starting the stack:

```bash
docker network inspect proxy >/dev/null 2>&1 || docker network create proxy
```

#### 4. Update the trusted proxy

Edit the migrated configuration:

```bash
nvim /home/kcn/docker/nextcloud/data/config/config.php
```

Add the address of the proxy that now forwards requests to Nextcloud:

```php
'trusted_proxies' =>
array (
  0 => '<EXISTING_PROXY_ADDRESS>',
  1 => '<INTERNAL_CADDY_ADDRESS>',
),
```

This is only an example of the array layout; use the next free numeric index. Existing required entries remain in place. Only actual proxy addresses should be trusted; adding a broad Docker or LAN range is unnecessary.

#### 5. Start and validate the destination

```bash
cd /home/kcn/docker/nextcloud
docker compose up -d
docker compose ps
docker exec -u www-data nextcloud-app-1 php occ status
```

Before changing normal traffic, verify login, file listing, one upload and download, application logs and the database connection.

#### 6. Restore background jobs

Add the job to the crontab of the account allowed to run Docker:

```cron
*/5 * * * * flock -n /tmp/nextcloud_cron.lock docker exec -u www-data nextcloud-app-1 php -f /var/www/html/cron.php
```

Run the command once manually and confirm that it exits successfully before relying on the schedule.

#### 7. Switch traffic

Update the proxy route only after direct validation succeeds. Keep the source stack stopped but intact during the observation period.

Running both copies against diverging data was not an acceptable rollback method. Rollback meant stopping the destination and starting the unchanged source, not synchronizing two active Nextcloud instances.

## :material-format-list-numbered: Migration plan

The move was performed in stages. Oracle Legacy stayed available until each replacement passed its own checks.

### 1. Inventory and backup

- list containers, ports, volumes, databases, scheduled jobs and proxy routes;
- identify which data changes while a service is running;
- create a recoverable backup before the final copy;
- record dependencies outside Docker, including DNS, tunnels and hardware devices.

### 2. Build the platform

- install Proxmox on Zion;
- create Logos with Ubuntu 26.04 LTS;
- create the dedicated infrastructure LXC containers;
- verify networking and backups before moving production data.

### 3. Move general applications

- prepare the Compose stack on Logos;
- copy an initial dataset while the source is still running where safe;
- stop stateful source containers;
- perform the final synchronized copy;
- start and test the destination before changing normal traffic.

### 4. Replace shared infrastructure

- recreate proxy routes in Caddy;
- recreate DNS filtering and rewrites in AdGuard Home;
- switch DNS only after direct backend tests pass;
- keep NPM and Pi-hole stopped but recoverable during the observation period.

### 5. Move special workloads

- migrate Home Assistant only after Zigbee passthrough works in the new LXC;
- move HAProxy and verify the K3s API and ingress paths;
- move the media stack with its mounts and Quick Sync access;
- move Garage, update every consumer and run a real backup test.

### 6. Finish operations and recovery

- move Semaphore and validate key-only automation access;
- replace Duplicati with Kopia;
- add PBS image backups and configuration collection;
- verify updates, controlled reboots and post-reboot service checks;
- leave Oracle Legacy available until the new backup and restore paths are proven.

## :material-alert-outline: Problems worth keeping

The migration exposed several issues that deserve their own runbooks:

- [Docker route collision](../../troubleshooting/docker-route-collision.md);
- [Proxmox link recovery](../../troubleshooting/proxmox-link-recovery.md);
- [WireGuard relay troubleshooting](../../troubleshooting/wireguard-relay.md);
- incorrect UID/GID ownership after changing an LXC between unprivileged and privileged operation;
- old Garage endpoints left in Longhorn and Loki after the container itself had moved.

The rule that survived every stage was simple: moving a container is only half of the migration. DNS, proxy routes, scheduled jobs, hardware access, backups and downstream consumers must also be checked.

## :material-flag-checkered: Result

The main migration is complete. Logos is the operational server, infrastructure services have their own guests and Oracle Legacy is no longer the all-in-one production host.

The remaining work is routine documentation cleanup, restore testing and removal of old guests only after they are no longer useful as recovery references.

