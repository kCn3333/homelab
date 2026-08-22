# :material-home-assistant: Home Assistant and ESPHome

Home Assistant, ESPHome and the Portainer Agent run in Docker inside a dedicated LXC on Zion. The Zigbee coordinator is passed from Proxmox to that LXC and then into the Home Assistant container.

Keeping home automation in one guest isolates its USB device, updates and restarts from Logos and the media stack.

***

## :simple-linuxcontainers: LXC

| Property | Value |
|---|---|
| System | Debian 13, privileged LXC |
| CPU | 2 vCPU |
| Memory | 3 GB |
| Root disk | 20 GB |
| Features | `nesting=1` |
| USB device | Zigbee coordinator through `dev0` |

The privileged LXC is a deliberate exception for the current USB passthrough model. It runs only the home-automation stack and is not exposed to untrusted networks.

## :material-docker: Containers

- **Home Assistant** uses host networking and stores its state under `/home/kcn/docker/homeassistant`.
- **ESPHome** stores its configuration under `/home/kcn/docker/esphome` and publishes its required service port.
- **Portainer Agent** provides remote stack management from Logos.

The production definition is kept in the [Home Assistant Compose file](https://github.com/kCn3333/docker-compose/blob/main/homeassistant/docker-compose.yaml). Secrets and application state are not stored in that repository.

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

### Rebuild of the destination LXC

The first LXC had been changed from unprivileged to privileged without correcting its UID/GID mapping. System files retained mapped owners, causing SSH, package and systemd errors.

A recursive `chown` was rejected because the system contained service accounts, setuid files and Docker data with different ownership requirements. The safer fix was a clean privileged Debian 13 LXC.

Only these application directories were migrated:

```text
/home/kcn/docker/homeassistant
/home/kcn/docker/esphome
```

The final synchronization used `rsync -aHAXx --delete-delay --chown=1000:1000` after stopping both containers. System directories from the damaged LXC were not copied.

### Final cutover

1. Create a stop-mode backup of the old LXC and verify the archive.
2. Perform an initial application-data copy.
3. Stop Home Assistant and ESPHome.
4. Run the final `rsync` and confirm a zero dry-run diff.
5. Stop both LXC containers.
6. Assign the production address and Zigbee device to the new LXC.
7. Start the new LXC and its Docker stack.
8. Update the SSH host key in the administrator and Semaphore `known_hosts`.
9. Test the UI, ZHA, ESPHome, proxy path, automation SSH and backup.
10. Keep the old LXC and its backup offline until the new host completes a normal maintenance and backup cycle.

## :material-restore: Rollback

If the new LXC fails during cutover:

1. Stop it before changing addresses or USB assignments.
2. Restore the production address and Zigbee passthrough to the old LXC.
3. Start the old LXC and its containers.
4. Check Home Assistant, ZHA and ESPHome.
5. Do not synchronize data backwards until the newest valid dataset is identified.

Only one LXC may own the production address and Zigbee coordinator at a time.

## :material-security-network: Proxy and access

Home Assistant trusts only the proxy addresses that actually forward requests to it. Adding a broad Docker subnet merely to silence an `untrusted proxy` message would enlarge the trust boundary unnecessarily.

External access requires multi-factor authentication. Tunnel and public-edge configuration are documented separately from this LXC.

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
| SSH key is rejected after restore | Ownership of `.ssh` and `authorized_keys` |
| Proxy request is rejected | Exact `trusted_proxies` entries |
| Package or systemd errors mention ownership | Privileged/unprivileged UID mapping |