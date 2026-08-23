# Proxmox link recovery

This runbook documents a failure where Zion remained powered on but did not recover network connectivity after an upstream link interruption. Because every VM and LXC used the same bridge, the incident made the complete virtualized platform appear offline.

## Symptoms

- Zion stops responding over SSH and the Proxmox web interface;
- every VM and LXC attached to the main bridge becomes unreachable;
- the host is still powered on;
- connectivity returns after a reboot or manual interface recovery;
- the problem follows a switch, router, cable, or power interruption.

## Network model

```text
physical interface (nic0)
└── Linux bridge (vmbr0)
    ├── Zion management address
    ├── virtual machines
    └── LXC containers
```

The management address belongs to `vmbr0`, not `nic0`. The physical interface is a port of the bridge.

## Root causes found

Two host-side conditions contributed to unreliable recovery:

1. the physical interface was configured as `manual` without link-hotplug handling;
2. Energy Efficient Ethernet did not recover reliably after link loss on the installed network path.

The upstream interruption was historically triggered by a router firmware problem, but Zion still needed to recover correctly when carrier returned.

## Persistent configuration

The relevant structure in `/etc/network/interfaces` is:

```ini
auto lo
iface lo inet loopback

allow-hotplug nic0
iface nic0 inet manual
    post-up ethtool --set-eee nic0 eee off
    post-up ethtool -s nic0 speed 1000 duplex full autoneg on

auto vmbr0
iface vmbr0 inet static
    address <zion-management-address>/<prefix>
    gateway <lan-gateway>
    bridge-ports nic0
    bridge-stp off
    bridge-fd 0

source /etc/network/interfaces.d/*
```

`allow-hotplug` reacts to carrier changes. The `post-up` commands reapply the validated link settings whenever the interface is brought up.

The speed and duplex values reflect the currently validated link. They must not be copied to different hardware without checking the NIC and switch capabilities.

## Non-disruptive diagnosis

```bash
ip -brief link
ip -brief address
bridge link
ethtool nic0
ethtool --show-eee nic0
ip route
journalctl -u networking --no-pager -n 100
```

Confirm:

- `nic0` has carrier and is enslaved to `vmbr0`;
- the management address exists only on `vmbr0`;
- the default route uses `vmbr0`;
- negotiated speed and duplex match the switch;
- EEE is disabled;
- no duplicate address has been introduced manually.

## Recovery caution

Do not begin with `systemctl restart networking` on a remotely managed Proxmox host. Restarting the complete network stack can interrupt management access and every guest attached to the bridge.

If an out-of-band console is available, the minimum temporary recovery may be:

```bash
ip link set nic0 up
ip link set vmbr0 up
```

Do not add an address or default route blindly. First inspect whether they already exist; duplicate addresses and routes can make recovery harder.

Use Proxmox-supported network reload tooling or a controlled reboot after validating the persistent configuration. Apply one change at a time and retain console access.

## IPv6 timeout distinction

During the original incident, network restart also waited on IPv6-related timeouts. Disabling IPv6 is not a generic fix. It is appropriate only if IPv6 is intentionally unused on that bridge and the timeout has been confirmed in logs.

Do not disable IPv6 globally to shorten an unexplained network restart.

## Validation test

After applying the persistent configuration:

1. keep a local or out-of-band console available;
2. monitor `nic0` and `vmbr0` state;
3. interrupt the physical link for a controlled period;
4. restore the link;
5. verify that carrier, bridge connectivity, management access, and guests return without reboot;
6. confirm the EEE and negotiated-link settings again.

```bash
watch -n1 'ip -brief link show nic0; ip -brief link show vmbr0'
```

The test is successful only when Zion and the expected guests recover without manually reconstructing addresses or routes.

## Related symptoms

| Symptom | Interpretation |
|---|---|
| SSH works but ping does not | Check Proxmox firewall policy before changing the bridge |
| Proxmox UI fails only through the reverse proxy | Test the direct management path and proxy protocol handling |
| Link is up but guests remain unreachable | Inspect bridge membership, forwarding, and guest interfaces |
| Network restart waits for several minutes | Review `ifupdown2`, IPv6, and interface dependency logs |
| Problem returns after every carrier loss | Confirm persistent hotplug and EEE settings were loaded |
