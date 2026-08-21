# Supporting LXC services

Not every dedicated LXC needs a long standalone runbook. This page records the smaller service boundaries that complete the Zion platform.

## AdGuard Home

AdGuard Home provides local DNS filtering and internal DNS rewrites. Service names resolve to Caddy or HAProxy rather than directly to application containers whenever a stable frontend exists.

This allows a backend to move without changing every client. Wildcard rewrites are limited to clearly defined namespaces, while administrative interfaces receive explicit records.

The configuration is included in the remote configuration collection and is also protected by the image-level LXC backup.

## PatchMon

PatchMon provides visibility into pending package updates and reboot requirements across managed hosts. It complements Ansible rather than replacing it:

- PatchMon reports state;
- Semaphore runs approved maintenance;
- ntfy identifies the affected inventory host;
- reboot remains an explicitly approved Ansible operation.

PatchMon is not given authority to restart hosts automatically.

## Docker Media

The Docker Media LXC contains Jellyfin and the Arr media automation stack. It is separated from Logos so that media storage, metadata, hardware access, and frequent media-service changes do not share the failure domain of the main operations server.

The workload group includes:

- Jellyfin;
- Radarr and Sonarr;
- Prowlarr;
- qBittorrent and supporting automation services;
- Portainer Agent for remote stack management.

Downloaded media and reproducible caches are treated differently from application configuration. Image-level backups and configuration collection therefore use explicit inclusions and exclusions rather than copying every media-related file.

## Common operating model

These LXC containers follow the same baseline:

- key-only SSH for personal and automation access where SSH is enabled;
- password authentication disabled after access validation;
- dedicated Ansible automation identity;
- safe APT updates without automatic reboot;
- host-aware ntfy reporting;
- explicit service and failed-unit checks;
- image-level PBS backup plus selected configuration collection.

## Validation summary

| Service | Minimum functional check |
|---|---|
| AdGuard Home | Local DNS query and expected internal rewrite |
| PatchMon | Web service health and recent agent reporting |
| Docker Media | Docker state, Jellyfin response, and Arr application health |

The checks intentionally validate the service function rather than only confirming that its process exists.

