# Storage

## Longhorn

### What it does

Longhorn is a distributed block storage system for Kubernetes. It creates volume replicas across multiple nodes, so if one node fails, the data remains accessible on the remaining nodes.

Without Longhorn (or similar), you'd be limited to `local-path` storage — data lives on a single node. If that node dies, the pod can't be rescheduled anywhere else (the data isn't there). For anything stateful in a HA cluster, that's not acceptable.

```
Developer creates PVC
        │
        ▼
StorageClass (Longhorn) automatically creates PV
        │
        ▼
Longhorn creates physical volume with replicas across nodes
```

### Prerequisites — system packages

Install on all nodes before Longhorn:

```yaml
# ansible playbook
- name: Install Longhorn prerequisites
  ansible.builtin.apt:
    name:
      - open-iscsi    # iSCSI initiator
      - nfs-common    # NFS client (needed for RWX volumes)
      - util-linux
    state: present

- name: Enable iscsid
  ansible.builtin.systemd:
    name: iscsid
    enabled: true
    state: started
```

### Installation via Flux

```yaml
# HelmRepository
apiVersion: source.toolkit.fluxcd.io/v1
kind: HelmRepository
metadata:
  name: longhorn-repo
  namespace: flux-system
spec:
  interval: 1m0s
  url: https://charts.longhorn.io

# HelmRelease
apiVersion: helm.toolkit.fluxcd.io/v2
kind: HelmRelease
metadata:
  name: longhorn-release
  namespace: longhorn-system
spec:
  chart:
    spec:
      chart: longhorn
      sourceRef:
        kind: HelmRepository
        name: longhorn-repo
        namespace: flux-system
      version: v1.11.0
  interval: 1m0s
  values:
    persistence:
      defaultClassReplicaCount: 2
      rwoPolicy: cluster-scope
    nfsOptions: "vers=4.1,noresvport"
```

### StorageClass for RWX (ReadWriteMany)

The default Longhorn StorageClass provides RWO (ReadWriteOnce — one pod, one node). For RWX (multiple pods across multiple nodes), you need a separate StorageClass. Longhorn creates an internal NFS share manager pod for RWX volumes.

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: longhorn-rwx
provisioner: driver.longhorn.io
allowVolumeExpansion: true
reclaimPolicy: Delete
volumeBindingMode: Immediate
parameters:
  numberOfReplicas: "2"
  staleReplicaTimeout: "30"
  fsType: "ext4"
  dataEngine: "v1"
  accessMode: "ReadWriteMany"
  nfsOptions: "vers=4.1,noresvport"
```

### Removing the default StorageClass annotation from local-path

k3s ships with `local-path` as the default StorageClass. After installing Longhorn, you'll have two defaults — which causes issues with dynamic provisioning. Fix it:

```bash
kubectl patch storageclass local-path \
  -p '{"metadata": {"annotations":{"storageclass.kubernetes.io/is-default-class":"false"}}}'
```

To make this persistent in Git (so Flux doesn't revert it), commit it as a manifest:

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: local-path
  annotations:
    storageclass.kubernetes.io/is-default-class: "false"
provisioner: rancher.io/local-path
reclaimPolicy: Delete
volumeBindingMode: WaitForFirstConsumer
```

### AccessModes

| Mode | Description |
|------|-------------|
| `ReadWriteOnce` (RWO) | Single pod, single node |
| `ReadWriteMany` (RWX) | Multiple pods, multiple nodes (via NFS share) |

### Using PVC in a Deployment

```yaml
# PVC definition
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: nginx-pvc
  namespace: my-app
spec:
  storageClassName: longhorn-rwx
  accessModes:
    - ReadWriteMany
  resources:
    requests:
      storage: 10Mi

# Mount in Deployment
spec:
  template:
    spec:
      volumes:
      - name: nginx-data
        persistentVolumeClaim:
          claimName: nginx-pvc
      containers:
      - name: nginx
        volumeMounts:
          - name: nginx-data
            mountPath: /usr/share/nginx/html
```

### Ways to populate a PVC

| Method | When to use |
|--------|-------------|
| `kubectl cp` | Debugging, one-off tests |
| InitContainer | Static files bundled in a Docker image |
| Job | DB migrations, data seeding |
| App directly | Dynamic data (uploads, databases) |
| CI/CD pipeline | Automated content updates |

**InitContainer example (production approach):**
```yaml
initContainers:
- name: copy-content
  image: your-image-with-html:1.0
  command: ['cp', '-r', '/app/html/.', '/usr/share/nginx/html/']
  volumeMounts:
  - name: nginx-data
    mountPath: /usr/share/nginx/html
```

---

## Longhorn S3 Backup

See [backup/longhorn-s3.md](../08-backup/longhorn-s3.md) for setting up automated volume backups to Garage (self-hosted S3).

---

## Useful Commands

```bash
# Check storage classes
kubectl get storageclass

# Check PVCs and PVs
kubectl get pvc -A
kubectl get pv

# Flux
flux get helmreleases -A
flux reconcile helmrelease longhorn-release -n longhorn-system
```
