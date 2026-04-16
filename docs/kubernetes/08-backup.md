# Backup

Two independent backup strategies:

1. **etcd snapshots** — cluster state (all k8s objects, Flux config, etc.)
2. **Longhorn volume backups** — persistent data (application data stored in PVCs)

Both use Garage (self-hosted S3) as the remote storage destination, plus rsync to the Debian server for etcd.

---

## etcd Snapshots

### What gets backed up

The etcd database contains all Kubernetes object state — every Deployment, Secret, ConfigMap, Service, etc. Restoring from an etcd snapshot brings the cluster back to the exact state it was in when the snapshot was taken.

What it **doesn't** cover: the actual data in PVCs (that's Longhorn's job).

### Automatic snapshots (k3s built-in)

k3s takes etcd snapshots automatically:
- Default schedule: daily at 12:00 UTC
- Default retention: 5 snapshots
- Location: `/var/lib/rancher/k3s/server/db/snapshots/`
- Typical size: ~5-7 MB (grows with cluster size)

```bash
# List existing snapshots
sudo k3s etcd-snapshot ls

# Manual snapshot (before risky operations)
sudo k3s etcd-snapshot save --name pre-cilium-migration
```

### Automated offsite backup via rsync

A daily cron job on the Debian server pulls the latest snapshots from the master node via rsync.

**SSH key setup:** The backup user on the Debian server needs passwordless SSH access to master. Use a dedicated key:
```bash
ssh-keygen -t rsa -b 4096 -f ~/.ssh/id_for_master_rsa -N ""
ssh-copy-id -i ~/.ssh/id_for_master_rsa.pub user@master
```

**sudoers on master** (allow rsync without full sudo):
```
kcn ALL=(ALL) NOPASSWD: /usr/bin/rsync --server *
```

The `--server` flag limits rsync to server mode only — it can't run arbitrary commands.

**Backup script on Debian server:**
```bash
#!/bin/bash
BACKUP_BASE_DIR="/home/kcn/k3s_etcd_backup"
CURRENT_DATE=$(date +%Y-%m-%d_%H%M)
TARGET_DIR="$BACKUP_BASE_DIR/$CURRENT_DATE"
REMOTE_NODE="master"
REMOTE_PATH="/var/lib/rancher/k3s/server/db/snapshots/"

mkdir -p "$TARGET_DIR"

if ! rsync -avz \
  -e "ssh -i /home/kcn/.ssh/id_for_master_rsa" \
  --rsync-path="sudo rsync" \
  "$REMOTE_NODE:$REMOTE_PATH/" "$TARGET_DIR"; then
    echo "ERROR: rsync failed!" | logger -t etcd-backup
    exit 1
fi

echo "Backup finished: $CURRENT_DATE" | logger -t etcd-backup

# Retention — remove directories older than 30 days
find "$BACKUP_BASE_DIR" -mindepth 1 -maxdepth 1 -type d -mtime +30 -exec rm -rf {} +
```

**Cron job** (runs 1 hour after k3s auto-snapshot at 12:00 UTC):
```
0 13 * * * /home/kcn/backup.sh >> /home/kcn/k3s_etcd_backup/backup.log 2>&1
```

**Important:** always use an explicit SSH key path in cron — cron has a minimal environment and won't read `~/.ssh/config`.

Verify logs:
```bash
journalctl -t etcd-backup
```

### Snapshot before risky operations

Always take a manual snapshot before:

- Changing TLS SAN configuration
- Migrating CNI (Flannel → Cilium)
- Upgrading k3s or any core component
- Making changes to etcd-level configuration

```bash
ssh master "sudo k3s etcd-snapshot save --name pre-<description>"
ssh master "sudo k3s etcd-snapshot ls"
```

### 3-2-1 rule

| Copy | Location |
|------|----------|
| 1 | Live in k3s (etcd) |
| 2 | Local on master node (`/var/lib/rancher/k3s/server/db/snapshots/`) |
| 3 | Offsite on Debian server (`/home/kcn/k3s_etcd_backup/`) |

---

## Garage — Self-Hosted S3

### What it is

Garage is a lightweight distributed S3-compatible object store written in Rust. It runs on the Debian server and serves as the S3 backend for both Longhorn volume backups and Loki log storage.

It's designed exactly for homelab/small-deployment use cases — minimal resource footprint, single-node deployment with optional clustering.

### docker-compose.yml

```yaml
services:
  garage:
    image: dxflrs/garage:v2.2.0
    restart: unless-stopped
    ports:
      - "3900:3900"    # S3 API
      - "3901:3901"    # RPC
      - "3902:3902"    # Admin API
    volumes:
      - /home/kcn/k8s/garage/data:/var/lib/garage/data
      - /home/kcn/k8s/garage/meta:/var/lib/garage/meta
      - /home/kcn/k8s/garage.toml:/etc/garage.toml:ro
    environment:
      - RUST_LOG=garage=info
```

### garage.toml (v2.x)

```toml
metadata_dir = "/var/lib/garage/meta"
data_dir = "/var/lib/garage/data"
db_engine = "lmdb"
replication_factor = 1

rpc_secret = "GENERATE_WITH: openssl rand -hex 32"
rpc_bind_addr = "[::]:3901"
rpc_public_addr = "192.168.0.46:3901"

[s3_api]
api_bind_addr = "[::]:3900"
s3_region = "garage"

[admin]
api_bind_addr = "0.0.0.0:3902"
admin_token = "GENERATE_A_RANDOM_TOKEN"
```

### Initial setup

```bash
# Get node ID
docker exec -it garage-garage-1 /garage node id

# Assign capacity (25GB)
docker exec -it garage-garage-1 /garage layout assign \
  <NODE_ID> -z dc1 -c 25G

# Apply layout
docker exec -it garage-garage-1 /garage layout apply --version 1

# Create access key
docker exec -it garage-garage-1 /garage key create k3s-homelab

# Create buckets
docker exec -it garage-garage-1 /garage bucket create longhorn-backup
docker exec -it garage-garage-1 /garage bucket create loki-logs

# Grant permissions
docker exec -it garage-garage-1 /garage bucket allow longhorn-backup \
  --read --write --owner --key k3s-homelab
docker exec -it garage-garage-1 /garage bucket allow loki-logs \
  --read --write --owner --key k3s-homelab
```

### Test S3 access from the cluster

```bash
kubectl run s3-test --image=amazon/aws-cli --rm -it --restart=Never \
  --env="AWS_ACCESS_KEY_ID=YOUR_KEY_ID" \
  --env="AWS_SECRET_ACCESS_KEY=YOUR_SECRET" \
  -- s3 ls --endpoint-url http://192.168.0.46:3900 --region garage
```

---

## Longhorn Volume Backups

### BackupTarget (Longhorn v1.11+)

In Longhorn v1.11, the backup target configuration moved from a `Setting` to a proper CRD:

```yaml
apiVersion: longhorn.io/v1beta2
kind: BackupTarget
metadata:
  name: default
  namespace: longhorn-system
spec:
  backupTargetURL: s3://longhorn-backup@garage/
  credentialSecret: longhorn-s3-secret
  pollInterval: 300s    # note: must end with "s"
```

### S3 credentials as SealedSecret

```bash
kubectl create secret generic longhorn-s3-secret \
  --namespace longhorn-system \
  --from-literal=AWS_ACCESS_KEY_ID=YOUR_KEY_ID \
  --from-literal=AWS_SECRET_ACCESS_KEY=YOUR_SECRET \
  --from-literal=AWS_ENDPOINTS=http://192.168.0.46:3900 \
  --from-literal=AWS_CERT="" \
  --dry-run=client -o yaml | \
kubeseal --format yaml \
  --cert ~/.config/kubeseal/pub-sealed-secrets.pem \
  > apps/base/longhorn/longhorn-s3-secret-sealed.yaml
```

### RecurringJob — automated daily backups

```yaml
apiVersion: longhorn.io/v1beta2
kind: RecurringJob
metadata:
  name: daily-backup
  namespace: longhorn-system
spec:
  cron: "0 11 * * *"    # 11:00 UTC daily
  task: backup
  groups:
    - default           # applies to all volumes in the default group
  retain: 2             # keep last 2 backups per volume
  concurrency: 1
  labels:
    backup: daily
```

### Verifying backup target status

```bash
kubectl -n longhorn-system describe backuptarget default
# Look for: Status.Available: true

# Verify data in Garage
docker exec -it garage-garage-1 /garage bucket info longhorn-backup
# Size > 0 means data is flowing
```

---

## Useful Commands

```bash
# etcd
sudo k3s etcd-snapshot ls
sudo k3s etcd-snapshot save --name <name>
journalctl -t etcd-backup              # backup script logs

# Garage
docker exec -it garage-garage-1 /garage status
docker exec -it garage-garage-1 /garage bucket info longhorn-backup
docker exec -it garage-garage-1 /garage bucket info loki-logs

# Longhorn
kubectl -n longhorn-system describe backuptarget default
kubectl get recurringjob -n longhorn-system
```
