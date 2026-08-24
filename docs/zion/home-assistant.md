# :material-home-assistant: Home Assistant and ESPHome

Home Assistant, ESPHome and the Portainer Agent run in Docker inside a dedicated LXC on Zion. The Zigbee coordinator is passed from Proxmox to that LXC and then into the Home Assistant container.

***

## :simple-linuxcontainers: LXC

| Property | Value |
|---|---|
| System | Debian 13, privileged LXC |
| CPU | 2 vCPU |
| Memory | 3 GB |
| Root disk | 30 GB |
| Features | `nesting=1` |
| USB device | Zigbee coordinator through `dev0` |

The privileged LXC is a deliberate exception for the current USB passthrough model. It runs only the home-automation stack and is not exposed to untrusted networks.

## :material-docker: Containers

- **Home Assistant** uses host networking and stores its state under `/home/kcn/docker/homeassistant`.
- **ESPHome** stores its configuration under `/home/kcn/docker/esphome` and publishes its required service port.
- **Portainer Agent** provides remote stack management from Logos.

Stack definition is kept in the [Home Assistant Compose file](https://github.com/kCn3333/docker-compose/blob/main/homeassistant/docker-compose.yaml). Secrets and application state are not stored in that repository.

## :material-usb-port: Zigbee passthrough

The coordinator uses a Silicon Labs CP210x USB-to-UART bridge and appears on Zion as `/dev/ttyUSB0`.

The current Proxmox configuration passes it to the LXC explicitly:

```bash
pct set <home-assistant-vmid> --dev0 path=/dev/ttyUSB0
```

Inside the LXC, the Home Assistant container receives the same device:

```yaml
devices:
  - /dev/ttyUSB0:/dev/ttyUSB0
```

The application uses `/dev/ttyUSB0`. Host-side `/dev/serial/by-id/` symlinks are not assumed to exist inside the LXC.

After a host reboot or USB reconnect, confirm that the coordinator still uses the expected device before restarting Home Assistant.

## :material-swap-horizontal: Migration history

### Oracle Legacy to Zion

Home Assistant and ESPHome originally ran in Docker on Oracle Legacy with the Zigbee coordinator attached directly to that server.

The first move used this order:

1. Create a dedicated LXC and enable Docker nesting.
2. Configure and test the USB passthrough.
3. Stop Home Assistant and ESPHome on Oracle Legacy.
4. Copy both application directories while preserving ownership and modes.
5. Change the saved Zigbee path from the old alias to `/dev/ttyUSB0`.
6. Start the stack in the LXC.
7. Move proxy traffic to the new address.
8. Verify ZHA, ESPHome, logins and backups.
9. Leave the old stack stopped until the new environment is proven.

Home Assistant must be stopped for the final copy. Copying its SQLite database while the container is writing can produce an inconsistent restore.

## :material-security-network: Proxy and access

Home Assistant accepts forwarded client addresses only from the reverse proxies that connect to it directly.

The setting is stored in:

```text
/home/kcn/docker/homeassistant/configuration.yaml
```

The directory is mounted inside the container as `/config`.

```yaml
http:
  use_x_forwarded_for: true
  trusted_proxies:
    - 192.168.X.X   # used for local access through Caddy
    - 192.168.X.X   # Logos / cloudflare tunnel for external access
```

## :material-check-decagram: Validation

```bash
test -c /dev/ttyUSB0
systemctl is-active docker containerd ssh
systemctl --failed --no-legend --plain --no-pager
docker compose ps
docker logs homeassistant --since 10m
docker logs esphome --since 10m
```

Then confirm:

- Home Assistant UI opens through the expected proxy path;
- ZHA is connected and Zigbee devices are available;
- ESPHome is healthy and reaches managed devices;
- Portainer Agent is reachable from Logos;
- key-only SSH and the Ansible account work;
- both application directories are present in the latest configuration backup.

## :material-wrench-outline: Quick diagnosis

| Symptom | Check |
|---|---|
| `/dev/ttyUSB0` is missing | Proxmox `dev0`, host USB enumeration and LXC state |
| ZHA uses the old device path | Saved ZHA configuration |
| Proxy request is rejected | Exact `trusted_proxies` entries |
| Package or systemd errors mention ownership | Privileged/unprivileged UID mapping |