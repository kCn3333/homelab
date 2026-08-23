# WireGuard relay troubleshooting

This runbook diagnoses the external Relay-to-Logos path without immediately restarting the tunnel or changing firewall rules.

## Failure layers

```text
public DNS
└── Relay Caddy
    └── WireGuard handshake
        └── route to backend
            └── Logos forwarding and NAT
                └── backend listener
```

Work from the outside inward. A successful handshake proves only that the two WireGuard peers can exchange encrypted packets; it does not prove that Relay has a route to the backend or that Logos will forward the traffic.

## 1. Preserve access

Before changing WireGuard remotely:

- confirm that SSH does not depend exclusively on the tunnel being modified;
- keep the existing terminal open;
- copy the active configuration to a protected temporary location;
- validate generated configuration before applying it;
- avoid restarting both peers simultaneously.

If the tunnel is the only administration path, defer disruptive changes until an out-of-band recovery method is available.

## 2. Check service state

Run on both peers:

```bash
sudo systemctl is-active wg-quick@wg0
sudo wg show wg0
ip -brief address show wg0
ip link show wg0
```

Check:

- interface is present and `UP`;
- peer configuration is loaded;
- latest handshake is recent;
- receive and transmit counters increase during a test;
- both peers use the intended MTU.

No recent handshake points to the public endpoint, UDP reachability, peer keys, or host firewall. A recent handshake with no application traffic points further inside the route and forwarding path.

## 3. Validate routes

On Relay:

```bash
ip route get <approved-backend-address>
```

The selected route must use `wg0`. If it does not:

- inspect the peer's `AllowedIPs`;
- check for a more specific competing route;
- check for an overlapping cloud or local subnet;
- confirm that the active configuration matches the file on disk.

On Logos, verify the return path and LAN egress interface:

```bash
ip route get <approved-backend-address>
```

Do not copy an interface name from an older host. Use the interface selected by the current route.

## 4. Validate forwarding

```bash
sysctl net.ipv4.ip_forward
sudo iptables -L FORWARD -n -v --line-numbers
sudo iptables -t nat -L POSTROUTING -n -v --line-numbers
```

Expected behaviour:

1. established return traffic is accepted;
2. the approved tunnel-to-backend path is accepted;
3. any required source NAT uses the actual LAN egress interface;
4. remaining traffic arriving from the tunnel is dropped.

Packet counters are more useful than visually inspecting rule text. If a request does not increment the expected rule, it is not reaching that rule or an earlier rule is taking precedence.

After correcting a verified rule, persist and compare the active and saved rulesets:

```bash
sudo netfilter-persistent save
sudo iptables-save
```

Do not insert broad temporary accepts into a production ruleset merely to make the request work. Narrow the test to one source, destination, protocol, and port.

## 5. Trace packets

Observe the same request at consecutive interfaces:

```bash
sudo tcpdump -ni wg0 host <approved-backend-address>
sudo tcpdump -ni <lan-interface> host <approved-backend-address>
```

Interpretation:

| Observation | Likely cause |
|---|---|
| No packet on Relay `wg0` | Caddy backend, route, or Relay firewall |
| Packet on Relay `wg0`, absent on Logos | Tunnel peer or Internet path |
| Packet on Logos `wg0`, absent on LAN interface | Forwarding or firewall rule |
| SYN reaches backend, no SYN-ACK returns | Backend listener, host firewall, or missing return NAT |
| Response returns to Logos but not Relay | Reverse forwarding or tunnel route |

## 6. Validate MTU

Both peers currently use MTU `1420`. Test the largest non-fragmented ICMP payload appropriate for that MTU:

```bash
ping -c 5 -M do -s 1392 <peer-tunnel-address>
ping -c 1 -M do -s 1393 <peer-tunnel-address>
```

The first test should pass. The second should fail locally with `message too long` when MTU `1420` is active.

If Relay returns to a jumbo-derived MTU after restart, ensure the MTU is declared in the persistent WireGuard interface configuration. `wg syncconf` does not update the Linux interface MTU.

## 7. Validate the backend and Caddy

From Relay, test the approved backend directly through its tunnel route before testing the public hostname:

```bash
curl --fail --head --connect-timeout 5 http://<approved-backend-address>:<port>
```

Then validate and inspect Caddy:

```bash
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl is-active caddy
sudo journalctl -u caddy --since '30 minutes ago' --no-pager
```

An HTTP 502 normally means Caddy could not complete the upstream request. It does not by itself identify WireGuard, routing, firewall, or backend failure.

## Recovery confirmation

The incident is resolved only after:

- both peers have a recent handshake;
- the backend route uses `wg0`;
- the intended forwarding and NAT counters increase;
- the direct backend request succeeds;
- the public request succeeds;
- an unrelated LAN destination remains unreachable from Relay;
- the active configuration survives a controlled service or host restart.
