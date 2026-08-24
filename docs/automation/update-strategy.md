# :material-update: Update Strategy

Package updates, container updates and reboots are separate operations. Routine APT maintenance may be automated for approved Debian hosts; infrastructure with a larger failure domain remains manually supervised.

The playbooks live in [`homelab-ansible`](https://github.com/kCn3333/homelab-ansible) and run through Semaphore. Inventory, addresses, SSH material, notification credentials and exact schedules remain private.

## :material-layers-triple: Scope

| Target | Update method |
|---|---|
| Application containers | Watchtower or an application-specific workflow |
| Debian service LXC | Ansible APT playbooks through Semaphore |
| Zion, PBS and Logos | Supervised maintenance window |
| K3s cluster | Dedicated cluster lifecycle workflow |
| Relay VPS | Automatic APT maintenance; supervised reboot with cloud-console access available |
| Reboots | Separate, explicitly approved Ansible workflow |

APT automation never implies a reboot. Container maintenance also runs separately, so an image update cannot be mistaken for a host package update.

## :material-package-up: APT workflows

| Mode | Changes the host? | Use |
|---|---:|---|
| **Preview** | No | Inspect an unfamiliar transaction or a newly managed host |
| **Safe upgrade** | Yes | Run a conservative upgrade under supervision |
| **Automatic maintenance** | Yes | Maintain explicitly approved hosts sequentially |

### Preview

Preview runs the equivalent of:

```text
apt-get --simulate --no-remove upgrade
```

It does not refresh the cache. The run fails when the simulation fails or proposes package removal.

### Safe upgrade

Safe upgrade:

- refreshes APT metadata;
- repeats the simulation;
- applies a conservative upgrade;
- preserves held packages and existing configuration files;
- does not run autoremove;
- does not reboot the host.

### Automatic maintenance

Automatic maintenance:

- supports Debian-family hosts only;
- processes one host at a time in inventory order;
- refreshes APT metadata and validates the transaction;
- performs the approved distribution upgrade;
- removes packages confirmed by APT as no longer required;
- purges obsolete package configuration and cleans the cache;
- checks systemd health;
- reports a reboot marker without acting on it;
- notifies on failure or pending reboot.

A failed host does not prevent checks of later hosts. The complete job still ends as failed, so partial success cannot be mistaken for a healthy run.

## :material-account-check-outline: Inventory gates

| Group | Permission |
|---|---|
| `homelab_managed` | Connectivity and read-only audits |
| `update_standard` | Preview and supervised safe upgrade |
| `update_automatic` | Sequential automatic maintenance |
| `reboot_approved` | Selection by the dedicated reboot workflow |

Group membership is managed in Semaphore. Being reachable by Ansible does not automatically approve a host for updates or reboot.

## :material-format-list-numbered: Execution order

Maintenance follows this order:

1. collect configuration from managed hosts;
2. finish data and platform backups;
3. update application containers;
4. run automatic APT maintenance;
5. review results and perform separately approved reboots.

Each stage has a measured buffer. APT maintenance must not overlap PBS jobs, off-host copies, Kopia maintenance, Watchtower restarts or planned network changes.

Semaphore and container tooling may use different cron formats. Their expressions are configured independently but use the same local timezone.

## :material-alert-outline: systemd health gate

Package changes can leave failed-state records for units that no longer exist. The playbook clears only confirmed stale entries:

1. run one `systemctl daemon-reload`;
2. read all failed units;
3. select units that are both `not-found` and `failed`;
4. reset each selected unit individually;
5. read failed units again;
6. fail the host if any failed unit remains.

A global `systemctl reset-failed` is not used because it could hide a real service failure.

Host-specific exceptions require a separate audit proving that the underlying facility is unused. They do not belong in a generic public allowlist.

## :material-bell-outline: Notifications

Semaphore injects the ntfy endpoint and token from a private variable group. Notifications report maintenance failures, pending reboots and completed approved reboots. Tasks handling credentials suppress their output.

## :material-restart: Reboot policy

The reboot workflow requires:

- exactly one selected host;
- membership in `reboot_approved`;
- an explicit target matching the selected inventory host;
- a pending reboot marker;
- no failed systemd units before reboot;
- successful SSH recovery;
- removal of the reboot marker;
- no failed systemd units after startup.

Role-specific checks remain necessary. Zion requires guest, storage and network validation; PBS must not reboot during an active backup; Logos requires Docker, WireGuard, Garage, Kopia and automation checks.

!!! warning "Relay VPS"
    The Relay carries the remote-management tunnel. Update or reboot it only when the cloud console is available and no WireGuard, firewall, SSH or reverse-proxy change is in progress. Public SSH is not opened as a routine fallback.

## :material-server-plus: Onboarding a host

A new or rebuilt host is introduced in stages:

1. verify the automation account, key-only SSH and host key;
2. add it to `homelab_managed` and run connectivity checks;
3. run Preview;
4. perform one supervised upgrade and validate essential services;
5. add it to `update_automatic` only after a successful pilot.

A rebuilt machine is treated as a new host even when it reuses the previous name or address. Its host key is verified again rather than bypassing strict checking.

## :material-check-decagram: Validation and failure handling

After maintenance, verify:

- every selected host appears in the recap;
- no host is unexpectedly unreachable, rescued or ignored;
- no failed systemd unit remains;
- reboot-required reporting is correct;
- each host's essential service still works;
- the preceding backup stage completed successfully.

`changed: true` is not proof that packages were upgraded. Cache refresh, cleanup and stale-unit handling may also report changes; the final report must distinguish them.

When a host fails:

1. leave automatic reboot disabled;
2. inspect the APT transaction and remaining failed units;
3. validate the affected service directly;
4. remove the host from automatic maintenance if recovery is not routine;
5. rerun Preview or a single-host pilot only after correcting the cause;
6. record reusable failures in troubleshooting documentation.

If Semaphore is restored, rebuild trust gradually: notification test, connectivity, Preview, one pilot upgrade, then the automatic group.

## :material-bookshelf: Related documentation

- [`homelab-ansible`](https://github.com/kCn3333/homelab-ansible) — playbooks, tests and Semaphore setup;
- [`Relay documentation`](../relay/relay.md) — remote access and reboot constraints;
- [`Backup and recovery`](../zion/3-backup-and-recovery.md) — job order and restore validation;
