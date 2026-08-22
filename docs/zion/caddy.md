# :simple-caddy: Caddy

Caddy is the HTTPS entry point for services available only inside the LAN. It runs natively in a dedicated LXC, independently of Docker and Logos.

It replaced Nginx Proxy Manager, which previously ran in Docker on Oracle Legacy. The old deployment worked, but every internal route depended on the general-purpose Docker host. Caddy keeps the same job with fewer moving parts and configuration stored as plain text.

## :material-server: LXC

| Property | Value |
|---|---|
| VMID | `102` |
| System | Debian 13, unprivileged LXC |
| CPU | 1 vCPU |
| Memory | 1 GB |
| Root disk | 10 GB |
| Runtime | Native `caddy.service` |

The container was created with the [Caddy Proxmox Community Script](https://community-scripts.github.io/ProxmoxVE/scripts?id=caddy). The script installed the operating system and Caddy; the proxy configuration was then added manually.

The previous Nginx Proxy Manager definition remains available as a [migration reference](https://github.com/kCn3333/docker-compose/blob/main/nginx-proxy-manager/docker-compose.yaml).

## :material-arrow-decision: Request path

1. AdGuard Home resolves an internal service name to the Caddy LXC.
2. The client opens HTTPS to Caddy.
3. Caddy presents the certificate and forwards the request to the configured backend.
4. The backend handles authentication and application authorization.

Caddy is not used for public ingress. Public services use the separate Relay path.

## :material-file-tree: Configuration

```text
/etc/caddy/
├── Caddyfile
├── .env
└── sites/
    └── <service>.caddy
```

`Caddyfile` contains global options and imports one file per backend:

```caddy
{
    acme_dns cloudflare {env.CLOUDFLARE_API_TOKEN}
}

import /etc/caddy/sites/*.caddy
```

The Cloudflare token is stored in `/etc/caddy/.env` with restricted permissions and loaded through a systemd override:

```ini
[Service]
EnvironmentFile=/etc/caddy/.env
```

The token is not stored in Git.

## :material-plus-network-outline: Add a service

1. Create `/etc/caddy/sites/<service>.caddy`.
2. Add or update the matching DNS rewrite in AdGuard Home.
3. Format and validate the complete configuration.
4. Reload Caddy without restarting the process.
5. Test DNS, TLS and backend access from a LAN client.

```bash
sudo caddy fmt --overwrite /etc/caddy/Caddyfile
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

A normal HTTP backend needs only:

```caddy
service.internal.example {
    reverse_proxy <backend-address>:<backend-port>
}
```

Caddy handles WebSocket upgrades automatically. Extra forwarded headers are added only when a backend requires them.

### HTTPS backend with a self-signed certificate

```caddy
service.internal.example {
    reverse_proxy https://<backend-address>:<backend-port> {
        transport http {
            tls_insecure_skip_verify
        }
    }
}
```

`tls_insecure_skip_verify` is limited to known internal backends that cannot present a trusted certificate.

## :material-swap-horizontal: Migration from Nginx Proxy Manager

1. Inventory every NPM proxy host, backend, custom header and certificate requirement.
2. Create the matching Caddy site files without changing DNS.
3. Install the Cloudflare DNS module and load its token through systemd.
4. Validate the full Caddy configuration.
5. Test each route against the Caddy LXC using a temporary local DNS override.
6. Change the AdGuard rewrite from Oracle Legacy to the Caddy LXC.
7. Verify certificates, WebSockets and application logins.
8. Stop NPM only after all internal routes work through Caddy.

Moving the DNS target was the cutover. Backend applications did not need to change because their addresses and ports stayed the same.

## :material-check-decagram: Validation

```bash
sudo caddy validate --config /etc/caddy/Caddyfile
systemctl is-active caddy
systemctl is-enabled caddy
systemctl --failed --no-legend --plain --no-pager
journalctl -u caddy --no-pager -n 50
```

Also verify:

- AdGuard returns the Caddy address;
- the expected certificate is presented;
- Caddy can reach the backend;
- the application accepts proxy traffic;
- an ordinary reload does not interrupt existing routes.

## :material-wrench-outline: Quick diagnosis

| Symptom | Check first |
|---|---|
| Name does not resolve | AdGuard rewrite and client DNS cache |
| Certificate is missing | Cloudflare module, token loading and ACME logs |
| HTTP 502 | Backend address, listener and firewall |
| Reload fails | `caddy fmt`, `caddy validate` and journal |
| Application rejects requests | Trusted proxy and forwarded-header settings |

Use reload for normal configuration changes. Restart the service only when a package, module or systemd setting has changed.