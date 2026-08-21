# Docker route collision

Docker networks can silently take ownership of an address range that belongs to the LAN, VPN, Kubernetes lab, or a cloud network. When this happens, the host sends traffic to a local Docker bridge instead of the real gateway.

## Symptoms

- SSH or API access to another homelab network fails only from the Docker host;
- other LAN machines can still reach the destination;
- `ping` reports an unreachable host from a Docker bridge address;
- Semaphore cannot reach managed hosts even though its SSH key and inventory are correct;
- `ip route get` selects a `br-*` interface.

The decisive check is:

```bash
ip route get <destination-address>
```

Incorrect result:

```text
<destination-address> dev br-<docker-network-id> src <docker-bridge-address>
```

The kernel considers the destination locally connected to Docker and never sends it to the LAN gateway.

## Confirm the owning network

List Docker networks and their subnets:

```bash
docker network ls

for network in $(docker network ls -q); do
    docker network inspect "$network" \
        --format '{{.Name}} {{range .IPAM.Config}}{{.Subnet}} {{end}}'
done
```

Compare every subnet with:

- trusted and IoT LANs;
- the K3s lab network;
- WireGuard networks;
- Oracle VCN ranges;
- Kubernetes pod and service ranges;
- any routed remote network.

Do not assume that a private RFC 1918 range is free merely because it is not assigned directly to the host.

## Prevent new collisions

Logos uses a reviewed private address pool with small `/28` allocations for newly created Docker networks. The exact base range is part of the private address plan and is not published here.

The important setting in `/etc/docker/daemon.json` is the relationship between the reviewed base pool and the per-network prefix size. A range that is safe on Logos is not automatically safe on another host. Before defining it, compare it with every routed network visible from that host.

Changing `default-address-pools` affects newly created networks. It does not renumber an existing Docker bridge.

## Controlled remediation

1. Identify the exact Docker network owning the conflicting route.
2. Identify every container or Compose project attached to it.
3. Verify that persistent application data is outside the container writable layers.
4. Define a non-overlapping replacement subnet or allow Docker to allocate from the reviewed pool.
5. Stop only the affected stack.
6. Remove only the confirmed conflicting network.
7. Recreate the stack and its network.
8. verify the kernel route before testing SSH or the application.

Useful inspection commands:

```bash
docker network inspect <network-name>
docker ps --filter network=<network-name>
ip route get <destination-address>
```

Avoid broad cleanup commands such as `docker network prune` during incident response. An unused-looking network may belong to a stopped stack that still depends on its name or subnet.

## Validation

After recreation:

```bash
ip route get <destination-address>
docker network inspect <replacement-network>
```

The destination route must use the intended LAN/VLAN route, not a Docker bridge. Then validate:

- TCP reachability to the managed host;
- SSH with strict host-key verification;
- Semaphore connectivity using its dedicated automation key;
- all containers attached to the recreated network;
- Docker service restart persistence.

## Lessons

- Routing must be checked before debugging SSH authentication.
- Docker network configuration is part of the infrastructure address plan.
- A controller using host networking still inherits the host's incorrect routes.
- Small default pools reduce waste but do not replace collision analysis.
- Existing networks must be recreated deliberately; changing `daemon.json` alone is not a repair.
