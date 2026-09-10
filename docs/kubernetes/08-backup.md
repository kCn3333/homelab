# Backup

The recovery plan has two independent data sets:

| Backup            | Protects                | Does not protect     |
| ----------------- | ----------------------- | -------------------- |
| K3s etcd snapshot | Kubernetes object state | PVC contents         |
| Longhorn backup   | Persistent volume data  | Cluster object state |

Both are needed for full recovery.

## K3s etcd snapshots

K3s creates scheduled snapshots in:

```text
/var/lib/rancher/k3s/server/db/snapshots/
```

```bash
sudo k3s etcd-snapshot ls
sudo k3s etcd-snapshot save --name pre-change
```

Create a manual snapshot before K3s upgrades, CNI changes, etcd work and other
cluster-wide operations. Verify that snapshots are copied away from the cluster node.
A copy on another machine in the same home location is a separate host copy, not a
true off-site backup.

Snapshot restoration recovers Kubernetes objects. Repository state must still be
consistent with the intended post-restore state because Flux will resume reconciliation.

## Garage

Garage runs on Logos and provides the S3-compatible backend used by Longhorn and Loki.

| Endpoint  | Address             |
| --------- | ------------------- |
| S3 API    | `192.168.0.56:3900` |
| RPC       | `192.168.0.56:3901` |
| Admin API | `192.168.0.56:3902` |

Current buckets include `longhorn-backup` and `loki-logs`. Garage has a single storage
node and replication factor one, so it is a backup target but not itself highly
available. Its data directory must also be backed up independently.

Credentials and endpoint settings used by Kubernetes are stored as SealedSecrets, not
as plaintext manifests.

## Longhorn volume backups

Longhorn `v1.11` uses a `BackupTarget` object:

```yaml
apiVersion: longhorn.io/v1beta2
kind: BackupTarget
metadata:
  name: default
  namespace: longhorn-system
spec:
  backupTargetURL: s3://longhorn-backup@garage/
  credentialSecret: longhorn-s3-secret
  pollInterval: 300s
```

The daily recurring job keeps two backups per volume and runs with concurrency one.
Retention controls the number of usable restore points; it does not replace a second
copy of the Garage data.

```bash
kubectl get backuptarget -n longhorn-system
kubectl get recurringjob -n longhorn-system
kubectl get backupvolume,backup -n longhorn-system
```

## Verification

A scheduled Job with `Completed` status confirms only that the Job exited successfully.
Also verify that:

* the BackupTarget is available;
* recent backups exist for every protected volume;
* objects are present in Garage;
* etcd snapshots exist both locally and on the secondary host;
* the restore procedure is tested periodically.

## Recovery order

For a complete cluster loss:

1. Restore the K3s control-plane state from an etcd snapshot.
2. Confirm node membership and core controllers.
3. Restore or reconnect Longhorn backups for required PVCs.
4. Resume Flux only when Git contains the desired configuration.
5. Verify applications and backup schedules.

Exact restore commands depend on whether the failure affects one node, the etcd
cluster, Longhorn data or the Garage host. Do not use a single generic recovery command
for all cases.
