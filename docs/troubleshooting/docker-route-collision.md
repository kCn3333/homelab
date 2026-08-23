# :simple-docker: Docker route collision

Docker can create a bridge whose subnet overlaps a LAN, VPN, Kubernetes or cloud network. The host then treats the remote destination as locally connected and sends traffic to the Docker bridge instead of the correct gateway.

## :material-alert-outline: Symptoms

- the destination is unreachable only from the Docker host;
- other LAN machines can still reach it;
- `ping` reports an unreachable host from a Docker bridge address;
- Semaphore cannot reach managed hosts even though its key and inventory are correct;
- `ip route get` selects a `br-*` interface.

## :material-magnify: Diagnosis

Check the route selected by the kernel:

```bash
ip route get <DESTINATION_IP>
```

A conflicting Docker route looks like:

```text
<DESTINATION_IP> dev br-<DOCKER_NETWORK_ID> src <DOCKER_BRIDGE_IP>
```

List Docker networks and their subnets:

```bash
docker network ls

for network in $(docker network ls -q); do
    docker network inspect "$network" \
        --format '{{.Name}} {{range .IPAM.Config}}{{.Subnet}} {{end}}'
done
```

After identifying the suspected network, inspect every attached container, including stopped ones:

```bash
docker network inspect <NETWORK_NAME>
docker ps --all --filter network=<NETWORK_NAME>
```

Compare its subnet with every range routed by the host:

- trusted, IoT and lab VLANs;
- WireGuard networks;
- cloud VCN ranges;
- Kubernetes pod and service ranges;
- other remote networks.

A private RFC 1918 range is not automatically free for Docker.

## :material-wrench-outline: Controlled remediation

1. Confirm the exact Docker network that owns the conflicting route.
2. Identify every container and Compose project attached to it.
3. Verify that persistent data is stored outside container writable layers.
4. Prepare a non-overlapping replacement network.
5. Stop only the affected stack.
6. Remove only the confirmed conflicting network.
7. Recreate the stack and its network.
8. Verify the kernel route before testing SSH or the application.

Do not use `docker network prune` during incident response. A network that appears unused may belong to a stopped stack.

## :material-check-decagram: Validation

```bash
ip route get <DESTINATION_IP>
docker network inspect <REPLACEMENT_NETWORK>
docker ps --all --filter network=<REPLACEMENT_NETWORK>
```

Confirm that:

- the destination uses the intended LAN, VLAN or VPN route;
- no `br-*` interface owns the remote destination;
- TCP and SSH connectivity work;
- strict SSH host-key verification still succeeds;
- every container attached to the recreated network is healthy;
- the route remains correct after the next planned Docker restart.

## :material-shield-check-outline: Prevention

Logos uses a reviewed private address pool with small `/28` allocations for new Docker networks. The exact base range remains part of the private address plan.

Before setting `default-address-pools` in `/etc/docker/daemon.json`, compare the complete pool with every local and routed network visible from that host.

Changing `default-address-pools` affects only networks created afterwards. Existing bridges must be recreated deliberately.