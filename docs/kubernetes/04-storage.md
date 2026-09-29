# Storage

## Longhorn

Longhorn `v1.12.1` provides replicated persistent storage. The default replica count is
two, so a healthy volume has copies on two eligible nodes.

Required node packages are `open-iscsi`, `nfs-common` and `util-linux`. The `iscsid`
service must be enabled. Longhorn is installed and configured through Flux and Helm.

## Persistent volumes

The cluster uses six Longhorn volumes with engine `v1.12.1` and two data replicas
per volume.

| Namespace | PVCs | Purpose |
|---|---|---|
| `loki` | `storage-loki-0` (`10Gi`) | Local Loki storage |
| `monitoring` | Prometheus database PVC | Metrics storage |
| `clients` | `clients-db-1`, `clients-db-2` | Production PostgreSQL instances |
| `clients-staging` | `clients-db-staging-1`, `clients-db-staging-2` | Staging PostgreSQL instances |

Data replicas reside on `worker1` and `worker2`. Volume attachment
(`currentNodeID`) identifies the node using the volume; replica placement
(`spec.nodeID`) identifies the node storing a copy of its data.

Loki uses a `10Gi` PVC. Its StatefulSet uses `Retain` for both
`whenDeleted` and `whenScaled`, set through
`singleBinary.persistence.enableStatefulSetAutoDeletePVC: false`. This protects
against automatic PVC deletion with the StatefulSet; it is not a backup.

## StorageClasses

| StorageClass   | Access pattern | Implementation                            |
| -------------- | -------------- | ----------------------------------------- |
| `longhorn`     | RWO            | Longhorn block volume                     |
| `longhorn-rwx` | RWX            | Longhorn volume with an NFS share manager |

RWO permits a read-write mount from one node. Multiple Pods on that node may still
share it. RWX supports read-write mounts from multiple nodes.

`local-path` remains available but is not the default StorageClass.

```bash
kubectl get storageclass
kubectl get pvc,pv -A
kubectl get volumes.longhorn.io -n longhorn-system
```

## Network dependency

Longhorn engines, replicas, Instance Managers and RWX share managers communicate over
the cluster network. A ready node is not sufficient if those components still refer
to stale Pod addresses.

For network changes or node restarts:

1. Work on one node at a time.
2. Wait for the node and its Cilium Pod to become ready.
3. Wait for every attached Longhorn volume to become healthy.
4. Continue with the next node only after rebuilding finishes.

```bash
kubectl get volumes.longhorn.io -n longhorn-system \
  -o custom-columns='NAME:.metadata.name,STATE:.status.state,ROBUSTNESS:.status.robustness,NODE:.status.currentNodeID'
```

`degraded` means redundancy is reduced; it does not necessarily mean the volume is
unavailable. Do not start another disruptive operation in that state.

## Node maintenance

`kubectl cordon` prevents new scheduling but does not evict existing workloads.
`kubectl drain` evicts ordinary Pods and exercises PDBs. Drain is appropriate for
planned maintenance, but it can trigger Longhorn detach, attach and replica rebuild
work. Check workload redundancy and volume health first.

## Backups

Longhorn volume backups are stored in Garage. They protect PVC data; etcd snapshots
protect Kubernetes object state. Both are required for a full recovery plan. See
[Backup](08-backup.md).

```bash
kubectl get backuptarget,recurringjob -n longhorn-system
kubectl get backupvolume,backup -n longhorn-system
```
