# Backup

The recovery plan has three independent data sets:

| Backup                    | Protects                                | Does not protect                 |
| ------------------------- | --------------------------------------- | -------------------------------- |
| K3s etcd snapshot         | Kubernetes object state                 | PVC contents                     |
| Longhorn backup           | Persistent volume data                  | Cluster object state             |
| Sealed Secrets key export | Decryption of Git-managed SealedSecrets | etcd state or persistent volumes |

All three are required for a rebuild that does not rely on the original etcd state.

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

## Sealed Secrets recovery keys

The controller rotates sealing keys and retains older active keys so that manifests
created in earlier periods remain decryptable. Export every Secret selected by:

```bash
kubectl get secrets \
  --namespace flux-system \
  --selector sealedsecrets.bitnami.com/sealed-secrets-key=active
```

Stream the minimized result directly into encryption; do not persist plaintext YAML or
JSON. The verified September 2026 export used symmetric GPG AES-256 and contained four
`kubernetes.io/tls` Secrets with both `tls.crt` and `tls.key`. Decryption and a
portable SHA-256 checksum were validated without displaying private material.

Keep the encrypted payload and checksum outside the cluster, with at least one copy
outside the workstation. Store the passphrase separately. Repeat the export after each
key rotation and periodically test decryption without restoring into production.

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
* the Sealed Secrets recovery export decrypts and contains every active key;
* the restore procedure is tested periodically.

## Recovery order

For a complete cluster loss:

1. Restore the K3s control-plane state from an etcd snapshot when one is available.
2. Confirm node membership and core controllers.
3. Before applying SealedSecrets to a rebuilt cluster, restore all exported sealing-key Secrets.
4. Start or restart the controller and confirm that it registers every key.
5. Restore or reconnect Longhorn backups for required PVCs.
6. Resume Flux only when Git contains the desired configuration.
7. Verify SealedSecret synchronization, applications and backup schedules.

Exact restore commands depend on whether the failure affects one node, the etcd
cluster, Longhorn data or the Garage host. Do not use a single generic recovery command
for all cases.

