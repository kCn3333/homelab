# Security

## Network boundaries

The cluster nodes are protected by the router and UFW. Public DNS names resolve to the
HAProxy address; clients should not use node addresses directly.

Expected inbound UFW policy on every cluster node:

| Source                  | Ports                              | Purpose                        |
| ----------------------- | ---------------------------------- | ------------------------------ |
| management LAN          | `22/tcp`                           | SSH administration             |
| HAProxy hosts           | `6443/tcp`, `80/tcp`, `443/tcp`    | API and application entry      |
| cluster node subnet     | `6443/tcp`                         | Kubernetes API between servers |
| cluster node subnet     | `8472/udp`                         | Cilium VXLAN                   |
| cluster node subnet     | `10250/tcp`                        | kubelet API                    |
| cluster node subnet     | `2379-2380/tcp`                    | embedded etcd                  |
| cluster node subnet     | `9100/tcp`                         | node-exporter                  |
| cluster node subnet     | `123/udp`                          | NTP                            |
| cluster node subnet     | `4443/tcp`, `4240/tcp`, `4244/tcp` | Cilium and Hubble components   |
| Pod CIDR `10.42.0.0/16` | required cluster traffic           | Pod-to-node services           |

The exact management and HAProxy addresses belong in inventory variables, not in the
public playbook. The [cluster Ansible playbooks](https://github.com/kCn3333/homelab-ansible/tree/main/cluster/playbooks)
expand them into rules for each node.

The playbook must be idempotent. A second run against a correct cluster should finish
with `changed=0` on every node. It must not reset UFW or delete unrelated rules unless
that destructive policy is explicitly designed and reviewed.

```bash
for node in master worker1 worker2; do
  ssh "$node" 'sudo ufw status numbered'
done
```

## Exposure through Services

A NodePort creates a reachable service path on every node through kube-proxy rules; it
does not require a userspace process bound to the port. Router and UFW policy decide
whether that path is reachable from another network.

The intended paths are:

* Kubernetes API: client -> HAProxy -> node `6443`;
* applications: client -> HAProxy -> node `80/443` -> ServiceLB -> Traefik.

Direct node access may be technically possible from trusted networks. That does not
make it the supported client path.

## Secrets

Plaintext credentials must not be committed. Sealed Secrets are encrypted for the
cluster and may be stored in Git. The controller decrypts them into ordinary Secrets.

```bash
kubeseal --format yaml \
  --cert ~/.config/kubeseal/pub-sealed-secrets.pem \
  < secret.yaml > secret-sealed.yaml
```

The controller runs version `0.40.0` from Helm chart `2.20.0`. The public
certificate is sufficient for creating new SealedSecrets but cannot decrypt existing
data.

Back up every active `sealed-secrets-key*` Secret, not only the newest one. Existing
manifests may have been sealed during different key-rotation periods. The recovery copy
must be encrypted before persistent storage, include both `tls.crt` and `tls.key`,
remain outside the cluster, and be refreshed after a new key is created.

The September 2026 recovery set contains four active key pairs. It was encrypted
symmetrically with GPG AES-256, validated through streaming decryption without printing
private values, protected by a SHA-256 checksum, and copied to removable storage. The
passphrase must remain in a separate password manager.

## TLS

cert-manager uses a restricted Cloudflare API token for DNS-01 challenges. Grant only
DNS edit and zone read permissions for the required zone. Traefik terminates TLS for
application traffic; HAProxy forwards TCP without inspecting certificates.

## Time synchronization

All nodes must have consistent time. TLS, etcd, logs and distributed debugging depend
on it.

```bash
timedatectl status
chronyc tracking
chronyc sources -v
```

## Verification

```bash
kubectl get networkpolicy -A
kubectl get sealedsecret -A
kubectl get certificate -A
kubectl auth can-i --list -n <namespace>
```

