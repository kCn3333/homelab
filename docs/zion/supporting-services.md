# :material-server-network: Supporting LXC Services

This page records few smaller service boundaries that complete the Zion platform.

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

## :material-movie-open-star: Docker Media

The Docker Media LXC contains the complete media pipeline. It is separated from Logos so that media mounts, transcoding, downloads and frequently changed containers do not share the failure domain of the main operations server.

### :material-view-grid-outline: Workload

| Service | Role | Published port |
|---|---|---:|
| :simple-jellyfin: Jellyfin | Media server and hardware-assisted playback | `8096` |
| :material-eye-refresh: Seerr | Movie and series requests | `5055` |
| :simple-radarr: Radarr | Movie library automation | `7878` |
| :simple-sonarr: Sonarr | Series library automation | `8989` |
| :simple-bittorrent: Prowlarr | Indexer management for Radarr and Sonarr | `9696` |
| :material-subtitles: Bazarr | Subtitle discovery and download | `6767` |
| :simple-qbittorrent: qBittorrent | Download client | `8080`, `6881/tcp`, `6881/udp` |
| :material-cube-outline: FlareSolverr | Browser challenge helper used by selected indexers | `8191` |
| :simple-youtube: MeTube | Standalone video downloads | `8081` |
| :material-subtitles: Subtitle Agent | Preparation and inspection of subtitle | `8181` |
| :simple-portainer: Portainer Agent | Remote stack management from Logos | `9001` |
| :simple-watchtower: Watchtower | Container image updates and cleanup | none |

Portainer deploys and manages the active [Arr stack](https://github.com/kCn3333/docker-compose/blob/main/arr-stack/docker-compose.yaml). Configuration and application state live under `/opt/appdata`; media and download directories are mounted separately.

### :simple-intel: Intel Quick Sync passthrough

Jellyfin uses the Intel UHD Graphics integrated into Zion's Core i5-8400 for hardware-accelerated transcoding through Intel Quick Sync Video.

The GPU remains managed by the Proxmox host. Only its DRM device nodes are passed through to the Docker Media LXC. This is LXC device passthrough, not full PCI passthrough.

On Zion, first verify the available devices:

```bash
ls -l /dev/dri
```

The expected nodes are:

```text
/dev/dri/card0
/dev/dri/renderD128
```

Before assigning them, check which Proxmox device slots are already used by LXC:

```bash
pct config <LXC> |
grep -E '^dev[0-9]+:' || true
```

If `dev0` and `dev1` are free, pass both devices to the LXC:

```bash
pct set <LXC> \
    --dev0 path=/dev/dri/card0

pct set <LXC> \
    --dev1 path=/dev/dri/renderD128
```

Use the next free `devN` numbers if either slot is already occupied. Restart the LXC after changing its device configuration:

```bash
pct reboot <LXC>
```

Verify the devices inside Docker Media:

```bash
pct exec <LXC> -- ls -l /dev/dri
```

The Jellyfin Compose service passes the same devices into its container:

```yaml
services:
  jellyfin:
    devices:
      - /dev/dri/card0:/dev/dri/card0
      - /dev/dri/renderD128:/dev/dri/renderD128
```

After redeploying the stack, verify the container view:

```bash
docker exec jellyfin \
    ls -l /dev/dri
```

The render device can be tested with the Jellyfin FFmpeg build:

```bash
docker exec jellyfin \
    /usr/lib/jellyfin-ffmpeg/vainfo \
    --display drm \
    --device /dev/dri/renderD128
```

Hardware acceleration is configured in the Jellyfin administration panel as **Intel Quick Sync (QSV)**. During an active transcode, the Jellyfin playback information should report hardware decoding or encoding instead of a fully software-based FFmpeg process.

If Jellyfin reports `Permission denied`, do not make `/dev/dri` world-writable. Check the numeric `video` and `render` group IDs inside the LXC and grant the Jellyfin container access to those groups.


### :material-web: External Jellyfin access

Jellyfin is the only media service exposed through the external Relay path:

1. the Relay VPS accepts public HTTPS traffic and terminates TLS in Caddy;
2. Caddy forwards the request through WireGuard;
3. Logos routes only the explicitly allowed Jellyfin traffic into the LAN;

The Relay does not receive access to the complete Docker Media host or the remaining Arr interfaces. Its setup is described in [Relay VPS](../relay/relay.md), with failure recovery in [WireGuard relay troubleshooting](../troubleshooting/wireguard-relay.md).

Downloaded media and reproducible caches are treated differently from application configuration. Image-level backups and configuration collection therefore use explicit inclusions and exclusions rather than copying every media-related file.

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
