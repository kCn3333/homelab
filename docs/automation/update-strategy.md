# Update Strategy

The homelab uses a staged maintenance process rather than applying every available update to every system in the same way. Routine Debian package maintenance is automated where the failure domain is small and recovery is straightforward. Hypervisors, backup systems, the main operations server, security tooling, and the K3s cluster remain under separate, explicitly controlled procedures.

The automation is implemented in the public [`homelab-ansible`](https://github.com/kCn3333/homelab-ansible) repository and executed by Semaphore. Inventory, host addresses, SSH credentials, notification credentials, and environment-specific policy remain outside the repository.

## Design principles

- inspect the proposed package transaction before applying it;
- update one managed host at a time;
- never reboot a host as an implicit part of package maintenance;
- treat failed systemd units as real failures unless a specific stale state is proven safe to clear;
- keep container-image updates, operating-system updates, and reboots as separate operations;
- preserve enough time between backups and maintenance jobs;
- test new hosts individually before adding them to an automated group;
- report failures without exposing credentials or private topology.

## Maintenance layers

| Layer | Mechanism | Policy |
|---|---|---|
| Application containers | Watchtower or an application-specific workflow | Runs separately from host package maintenance |
| Debian service hosts | Ansible APT playbooks through Semaphore | Preview, safe upgrade, or approved automatic maintenance |
| Reboots | Dedicated Ansible playbook | Explicit target and approval; never scheduled implicitly by APT |
| Proxmox VE | Manual maintenance window | Validate guests, storage, backups, and platform services |
| Proxmox Backup Server | Manual maintenance window | Confirm datastore accessibility and backup activity first |
| Logos operations server | Manually supervised | Protect Semaphore, backup coordination, WireGuard, and Docker workloads |
| Kali | On-demand | Updated when the security-testing VM is in use |
| K3s cluster | Dedicated cluster lifecycle workflow | Kept separate from general homelab APT automation |
| Relay VPS | Automatic packages with special reboot handling | Preserve the WireGuard management path and cloud-console fallback |

## APT operating modes

### Preview

Preview is read-only and intended to show whether a normal upgrade is safe to attempt. It does not refresh the package cache or modify the host.

Conceptually, it performs:

```text
apt-get --simulate --no-remove upgrade
```

The run fails if the simulation fails or if the proposed transaction would remove packages. Preview is the default first step for a newly onboarded host or an unfamiliar update set.

### Safe upgrade

Safe upgrade refreshes APT metadata, repeats the simulation, and applies a conservative package upgrade. It does not perform autoremove and does not reboot the host. Held packages and existing configuration files remain protected by the playbook policy.

This mode is useful for manually supervised maintenance of hosts that should not yet participate in full automation.

### Automatic maintenance

Automatic maintenance is restricted to an explicitly approved inventory group. It:

- processes hosts sequentially in inventory order;
- supports Debian-family systems only;
- refreshes APT metadata;
- performs the approved distribution upgrade;
- removes packages that APT identifies as no longer required;
- purges obsolete package configuration where appropriate;
- cleans the package cache;
- checks systemd health after package operations;
- reports a pending reboot without performing it;
- sends a notification when maintenance fails or a reboot is required.

A failure on one host is recorded and does not prevent the playbook from assessing later hosts. The overall job still ends in a failed state so that a partially unsuccessful run cannot appear healthy.

## Inventory policy

The public playbooks refer to functional groups rather than embedding the real topology:

| Group | Purpose |
|---|---|
| `homelab_managed` | Hosts available to connectivity and preflight audits |
| `update_standard` | Hosts eligible for preview and manually approved safe upgrade |
| `update_automatic` | Hosts approved for sequential automatic APT maintenance |
| `reboot_approved` | Hosts that may be selected by the dedicated reboot workflow |

Group membership is maintained in Semaphore's private inventory. A host can be available for audits without being approved for automatic updates.

## systemd health handling

Package changes can leave stale failed-state records for units that no longer exist. The maintenance workflow distinguishes these records from genuine service failures.

After APT operations it:

1. performs one systemd daemon reload;
2. reads all failed units;
3. identifies only entries whose unit is both `not-found` and `failed`;
4. resets each confirmed orphaned state individually;
5. reads failed units again;
6. fails the host if any unit remains failed.

The playbook deliberately does not execute a global `systemctl reset-failed`. Clearing every failed state would hide real faults and make the maintenance result unreliable.

Platform-specific systemd exceptions are handled only after a separate audit proves that the underlying facility is not used. Such exceptions belong to host documentation or private policy, not to a generic public allowlist.

## Notifications

Semaphore provides the notification endpoint and bearer token through a private variable group. The playbooks consume them from the environment and suppress sensitive task output.

Notifications distinguish at least:

- maintenance failure;
- reboot required;
- successful completion of a separately approved reboot.

No endpoint, topic, token, server response, or private host address is written to the repository or ordinary job output.

## Scheduling and ordering

Maintenance follows this dependency order:

```text
configuration collection
        ↓
data and platform backups
        ↓
container image maintenance
        ↓
automatic APT maintenance
        ↓
manually approved reboots
```

The schedule must include a measured safety buffer between stages. Automatic APT must not overlap:

- Proxmox VM or LXC backups;
- off-host data copies;
- repository maintenance;
- Watchtower container restarts;
- a planned network, firewall, or WireGuard change.

Semaphore and the container-update system use different cron formats, so their expressions must not be copied between tools without conversion. Both are configured for the same local timezone to avoid daylight-saving surprises.

Exact execution times remain environment-specific and are intentionally not part of the public documentation.

## Reboot policy

APT maintenance never reboots a system automatically. A reboot is a separate operation with its own approval and validation.

The managed reboot workflow requires:

- exactly one selected host;
- membership in the approved reboot group;
- an explicit target matching the selected inventory host;
- a pending reboot marker before the operation;
- no failed systemd units before reboot;
- successful SSH recovery afterward;
- removal of the reboot-required marker;
- no failed systemd units after startup.

Infrastructure hosts require additional checks appropriate to their role. For example, a hypervisor must not be treated like a stateless service container, and a backup server must not reboot during an active job.

### Relay special case

The Relay VPS is part of the remote management path. Rebooting it temporarily removes the WireGuard tunnel used for administration.

A Relay reboot is performed only when:

- the cloud-provider console is available as an independent recovery path;
- WireGuard, firewall, SSH, and reverse-proxy changes are not being made in the same window;
- public services can tolerate a short interruption;
- post-reboot validation includes the WireGuard handshake, restricted SSH path, and reverse proxy.

Public SSH is not opened as a routine reboot fallback.

## Onboarding a host

A new system progresses through increasingly invasive stages:

1. create or verify the dedicated automation account;
2. verify its SSH host key through a trusted second channel;
3. add the host only to the general managed group;
4. run connectivity checks;
5. run the read-only preflight audit;
6. run APT preview;
7. perform one supervised safe or automatic upgrade;
8. validate systemd and the host's essential services;
9. add the host to automatic maintenance only after a successful pilot.

A replacement system is treated as a new host even when it reuses the previous name or address. Its SSH host key must be verified again rather than bypassing strict checking.

## Post-maintenance validation

After every automatic run, review:

- the recap for every selected host;
- whether any host was unreachable or rescued;
- the number and identity of remaining failed units;
- reboot-required notifications;
- DNS and reverse-proxy availability;
- essential application containers;
- unexpected inventory membership;
- the completion state of the preceding backup jobs.

`changed: true` alone is not proof that packages were upgraded. Cache refresh and cache cleanup can report changes independently, so the final report should distinguish package upgrades, autoremove activity, stale-unit cleanup, and reboot requirements.

## Failure handling

If maintenance fails on a host:

1. do not hide the state with a global reset;
2. inspect the APT transaction and systemd failures;
3. validate the host's essential service directly;
4. leave automatic reboot disabled;
5. remove the host from automatic maintenance if its recovery is not routine;
6. rerun preview or a limited pilot only after correcting the cause;
7. document reusable root causes as troubleshooting notes.

If Semaphore itself is being restored, the safe order is notification test, single-host connectivity, preflight, preview, one pilot upgrade, and only then the complete automatic group.

## Public/private boundary

The public repository may contain:

- generic playbooks and tests;
- functional inventory group names;
- maintenance logic and safety invariants;
- placeholder values and reproducible validation commands.

It must not contain:

- the real inventory or host variables;
- private or public infrastructure addresses;
- SSH keys, host fingerprints, or `known_hosts` entries;
- notification endpoints, topics, or tokens;
- cloud-console identifiers or recovery credentials;
- detailed schedules that reveal operational windows;
- logs containing private topology.

## Current direction

- keep routine Debian maintenance sequential and observable;
- continue separating package updates, container updates, and reboots;
- add host classes to automation only after a successful pilot;
- develop dedicated maintenance procedures for Proxmox, PBS, Logos, and K3s;
- measure real backup duration before finalizing maintenance windows;
- regularly test recovery paths instead of relying only on successful job status.
