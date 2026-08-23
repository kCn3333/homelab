# :simple-wireguard: WireGuard relay troubleshooting

This runbook checks the Relay-to-Logos path from the public service towards the backend. Do not restart the tunnel or change firewall rules before identifying the failed layer.

```mermaid
flowchart LR
    dns["Public DNS"] --> caddy["Relay Caddy"]
    caddy --> tunnel["WireGuard"]
    tunnel --> routing["Routing"]
    routing --> nat["Logos firewall + NAT"]
    nat --> backend["Backend"]
```

## :material-shield-lock-outline: 1. Preserve access

Before changing WireGuard:

- keep the current administrative session open;
- prepare the cloud provider console as the out-of-band recovery path;
- confirm that an encrypted backup of the active configuration exists;
- change one peer at a time;
- do not restart both peers together.

If a local pre-change copy is required, keep it root-only:

```bash
sudo install \
    --mode=0600 \
    /etc/wireguard/wg0.conf \
    /root/wg0.conf.prechange
```

Do not publish raw output from `wg show`, `ip address`, `tcpdump` or firewall commands. It may contain endpoints, public keys and private network details.

## :material-vpn: 2. Check WireGuard

Run on both peers:

```bash
sudo systemctl is-active wg-quick@wg0
sudo wg show wg0
ip -brief address show wg0
ip link show wg0
```

Confirm:

- `wg0` exists and is `UP`;
- the expected peer is loaded;
- the handshake is recent;
- receive and transmit counters increase during a test;
- both peers use the intended MTU.

No recent handshake points to the public UDP path, peer configuration or host firewall. A current handshake with failed application traffic points to routing, forwarding, NAT or the backend.

## :material-router-network: 3. Validate routes

On Relay:

```bash
ip -4 -brief address show ens3
ip -4 -brief address show wg0
ip -4 route show table main
ip -4 route get <LOGOS_WG_IP>
ip -4 route get <APPROVED_BACKEND_IP>
```

The peer and approved backend routes must use `wg0`.

Check for:

- identical prefixes assigned to both `ens3` and `wg0`;
- a WireGuard address that conflicts with the cloud gateway;
- a competing route with the same or longer prefix;
- differences between the active peer configuration and the file on disk.

The `/32` entries in `AllowedIPs` are intentional. They restrict cryptokey routing to approved peers and backend hosts and must not be removed merely to hide an address overlap.

On Logos:

```bash
ip -4 route get <APPROVED_BACKEND_IP>
```

Use the LAN interface returned by this command. Do not copy an interface name from an older host.

## :material-shield-lock-outline: 4. Validate firewalls and NAT

On Relay:

```bash
sudo iptables -L INPUT -n -v --line-numbers
sudo iptables -L OUTPUT -n -v --line-numbers
```

On Logos:

```bash
sysctl net.ipv4.ip_forward
sudo iptables -L FORWARD -n -v --line-numbers
sudo iptables -t nat -L POSTROUTING -n -v --line-numbers
sudo iptables-save
```

Expected state:

1. IPv4 forwarding is enabled on Logos.
2. Established return traffic is accepted.
3. Only approved tunnel-to-backend paths are accepted.
4. Required source NAT uses the current LAN egress interface.
5. Remaining forwarded traffic from `wg0` is dropped.

Do not add broad temporary `ACCEPT` rules. Restrict every test rule to one source, destination, protocol and port.

If a firewall change is required, save the pre-change state before editing:

```bash
sudo sh -c \
    'umask 077; iptables-save > /root/iptables-prechange.rules'
```

Do not run `netfilter-persistent save` yet. Persist the rules only after completing the validation section.

## :material-swap-horizontal: 5. Trace packets

Generate one backend request and observe it at consecutive interfaces:

```bash
sudo tcpdump -ni wg0 host <APPROVED_BACKEND_IP>
sudo tcpdump -ni <LAN_INTERFACE> host <APPROVED_BACKEND_IP>
```

| Observation | Likely cause |
|---|---|
| No packet on Relay `wg0` | Caddy backend, route or Relay firewall |
| Packet on Relay `wg0`, absent on Logos | Tunnel peer or Internet path |
| Packet on Logos `wg0`, absent on the LAN | Forwarding or firewall rule |
| SYN reaches the backend, no SYN-ACK returns | Backend listener, host firewall or missing return NAT |
| Response returns to Logos but not Relay | Reverse forwarding or tunnel route |

## :material-ruler: 6. Validate MTU

Both peers currently use MTU `1420`:

```bash
ping -c 5 -M do -s 1392 <PEER_WG_IP>
ping -c 1 -M do -s 1393 <PEER_WG_IP>
```

The first test should pass. The second should fail locally with `message too long`.

If the Relay returns to a jumbo-derived MTU after restart, confirm that `MTU = 1420` exists in the persistent interface configuration. `wg syncconf` does not change the Linux interface MTU.

## :material-server-network: 7. Validate the backend and Caddy

From Relay, test the backend without printing its response:

```bash
curl \
    --fail \
    --silent \
    --show-error \
    --output /dev/null \
    http://<APPROVED_BACKEND_IP>:<PORT>/
```

Then check Caddy and the public path:

```bash
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl is-active caddy
sudo journalctl \
    --unit=caddy \
    --since='30 minutes ago' \
    --no-pager

curl \
    --fail \
    --silent \
    --show-error \
    --output /dev/null \
    https://<PUBLIC_SERVICE_HOSTNAME>/
```

HTTP `502` means that Caddy could not complete the upstream request. It does not identify which internal layer failed.

## :material-check-decagram: Recovery confirmation

Before persisting a changed firewall, confirm that:

- both peers have a recent handshake;
- peer and backend routes use `wg0`;
- expected forwarding and NAT counters increase;
- the direct backend request succeeds;
- the public request succeeds;
- an unrelated LAN destination remains unreachable from Relay.

Only after these checks pass:

```bash
sudo netfilter-persistent save
```

Finally, perform a controlled service or host restart and repeat the checks. Remove the root-only pre-change copies after the configuration has remained stable.