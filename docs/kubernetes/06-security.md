# Security

## UFW Firewall

### Why UFW on the nodes

By default, k3s nodes accept connections on all ports from anywhere. Without a firewall, anything on the local network can hit the API server, Longhorn UI, or any NodePort service directly — bypassing HAProxy and Traefik entirely.

The goal: all external traffic goes through HAProxy (`192.168.0.45`). Direct access to node ports is blocked for everything else.

### Managed via Ansible

UFW rules are managed as code through an Ansible playbook. This ensures consistency across all nodes and makes rule changes auditable and reproducible.

```bash
# Test on a single node first
ansible-playbook ufw.yml --limit master

# Apply to all nodes
ansible-playbook ufw.yml
```

### Full UFW Playbook

```yaml
---
- name: Prepare UFW firewall for K3s
  hosts: all
  become: true

  tasks:
    - name: Install UFW
      ansible.builtin.apt:
        name: ufw
        state: present

    - name: Set default deny incoming
      community.general.ufw:
        policy: deny
        direction: incoming

    - name: Allow all outgoing
      community.general.ufw:
        policy: allow
        direction: outgoing

    - name: Allow SSH from local network
      community.general.ufw:
        rule: allow
        from_ip: 192.168.0.0/24
        port: '22'
        proto: tcp

    - name: Allow API and Web from LB (virtual IP)
      community.general.ufw:
        rule: allow
        from_ip: 192.168.0.45    # HAProxy virtual IP
        port: "{{ item }}"
        proto: tcp
      loop: ['6443', '80', '443']

    - name: Allow API and Web from LB (physical host)
      community.general.ufw:
        rule: allow
        from_ip: 192.168.0.46    # HAProxy host IP — both needed!
        port: "{{ item }}"
        proto: tcp
      loop: ['6443', '80', '443']

    - name: Allow K3s cluster internal traffic
      community.general.ufw:
        rule: allow
        from_ip: 192.168.55.0/24
        port: "{{ item.port }}"
        proto: "{{ item.proto }}"
      loop:
        - { port: '6443', proto: 'tcp' }   # API server
        - { port: '8472', proto: 'udp' }   # Flannel VXLAN (if applicable)
        - { port: '10250', proto: 'tcp' }  # Kubelet
        - { port: '2379', proto: 'tcp' }   # etcd client
        - { port: '2380', proto: 'tcp' }   # etcd peer
        - { port: '9100', proto: 'tcp' }   # node-exporter (Prometheus scraping)
        - { port: '4443', proto: 'tcp' }   # metrics-server (hostNetwork)
        - { port: '4244', proto: 'tcp' }   # Hubble gRPC
        - { port: '4240', proto: 'tcp' }   # Cilium health checks
        - { port: '123', proto: 'udp' }    # NTP (master serves time to workers)

    - name: Allow pod network traffic
      community.general.ufw:
        rule: allow
        from_ip: 10.0.0.0/8     # Cilium uses /8 cluster-pool

    - name: Enable UFW
      community.general.ufw:
        state: enabled

    - name: Enable logging
      community.general.ufw:
        logging: 'on'

    - name: Limit SSH connections
      community.general.ufw:
        rule: limit
        port: ssh
        proto: tcp
```

### Important: HAProxy has two IPs

HAProxy runs on host `192.168.0.46` but listens on virtual IP `192.168.0.45`. UFW rules must allow **both** addresses — traffic originating from the host goes with the source IP of the physical interface, not the virtual one.

### Important: Cilium pod CIDR

Check the actual CIDR before writing UFW rules:
```bash
kubectl get configmap -n kube-system cilium-config -o yaml | grep cluster-pool-ipv4-cidr
# cluster-pool-ipv4-cidr: 10.0.0.0/8
```

Cilium uses `10.0.0.0/8` — not the narrower `10.42.0.0/16` that Flannel used. Using `/16` would block traffic from pod subnets outside that range.

### Debugging UFW issues

A common pattern when adding new components: a new service starts with `hostNetwork: true`, binds on a port, and UFW silently drops cross-node traffic to that port.

When something works from the local node but fails from other nodes — UFW is almost always the culprit.

```bash
# Check current rules
sudo ufw status verbose

# Ansible: check specific ports across all nodes
ansible all -m shell -a "ufw status | grep -E '4240|4244|9100'" -b

# Watch UFW logs for drops
sudo tail -f /var/log/ufw.log
```

**Rule to remember**: whenever you add a component with `hostNetwork: true`, ask yourself: _what port does it bind on, and does anyone outside this node need to reach it?_

---

## Sealed Secrets

### The problem with plain Kubernetes Secrets

Kubernetes Secrets are base64-encoded, not encrypted. Committing them to a Git repo — even a private one — is a bad practice. You need a way to store secrets safely in Git.

### How Sealed Secrets works

```
Cluster private key → stays in the cluster (Secret in flux-system)
Cluster public key  → you download locally, use for encryption

SealedSecret → encrypted blob (safe to commit to Git)
      │
      ▼
Sealed Secrets controller decrypts → creates a real Kubernetes Secret
```

The encrypted `SealedSecret` can only be decrypted by the cluster that holds the matching private key.

### Installation via Flux

```yaml
# HelmRepository
apiVersion: source.toolkit.fluxcd.io/v1
kind: HelmRepository
metadata:
  name: sealed-secrets
  namespace: flux-system        # always flux-system!
spec:
  interval: 1h
  url: https://bitnami-labs.github.io/sealed-secrets

# HelmRelease
apiVersion: helm.toolkit.fluxcd.io/v2
kind: HelmRelease
metadata:
  name: sealed-secrets
  namespace: flux-system
spec:
  chart:
    spec:
      chart: sealed-secrets
      sourceRef:
        kind: HelmRepository
        name: sealed-secrets
      version: ">=1.15.0-0"
  interval: 1h0m0s
  releaseName: sealed-secrets-controller
  targetNamespace: flux-system
  install:
    crds: Create
  upgrade:
    crds: CreateReplace
```

### kubeseal CLI

```bash
curl -OL "https://github.com/bitnami-labs/sealed-secrets/releases/download/v0.36.0/kubeseal-0.36.0-linux-amd64.tar.gz"
tar -xvzf kubeseal-0.36.0-linux-amd64.tar.gz kubeseal
sudo install -m 755 kubeseal /usr/local/bin/kubeseal
```

### Fetch the public key

```bash
kubeseal --fetch-cert \
  --controller-name=sealed-secrets-controller \
  --controller-namespace=flux-system \
  > ~/.config/kubeseal/pub-sealed-secrets.pem
```

**Don't commit this file to Git.** Keep it outside the repo directory.

### Sealing a Secret

```bash
# 1. Create a dry-run Secret manifest
kubectl create secret generic my-secret \
  --namespace my-namespace \
  --from-literal=key=value \
  --dry-run=client \
  -o yaml > /tmp/secret.yaml

# 2. Seal it
kubeseal --format yaml \
  --cert ~/.config/kubeseal/pub-sealed-secrets.pem \
  < /tmp/secret.yaml \
  > apps/base/my-app/my-secret-sealed.yaml

# 3. Clean up the plaintext
rm /tmp/secret.yaml

# 4. Commit the SealedSecret
git add apps/base/my-app/my-secret-sealed.yaml
git commit -m "feat(secrets): add sealed secret for my-app"
```

### Sealing the AlertManager config

AlertManager config is a special case — the Secret name must exactly match what kube-prometheus-stack expects:

```bash
cat <<EOF > /tmp/alertmanager.yaml
global:
  resolve_timeout: 5m
route:
  receiver: ntfy
receivers:
  - name: ntfy
    webhook_configs:
      - url: 'http://ntfy-webhook:8080'
        send_resolved: true
EOF

kubectl create secret generic alertmanager-kube-prometheus-stack-alertmanager \
  --namespace monitoring \
  --from-file=alertmanager.yaml=/tmp/alertmanager.yaml \
  --dry-run=client -o yaml | \
kubeseal --format yaml \
  --cert ~/.config/kubeseal/pub-sealed-secrets.pem \
  > apps/base/monitoring/alertmanager-config-sealed.yaml

rm /tmp/alertmanager.yaml
```

If the Secret already exists (created by Helm), delete it so the controller can take over:
```bash
kubectl delete secret alertmanager-kube-prometheus-stack-alertmanager -n monitoring
```

### What to seal vs what not to

| Seal it ✅ | Don't need to ❌ |
|-----------|----------------|
| Cloudflare API token | TLS certs (cert-manager regenerates them) |
| GitHub tokens | |
| Dashboard passwords | |
| Database credentials | |
| ntfy credentials | |

### Controller scope

The Sealed Secrets controller has a `ClusterRole` — it can create Secrets in any namespace. A SealedSecret in namespace `X` will create a Secret in namespace `X`, regardless of where the controller is running.

### Useful commands

```bash
kubectl get sealedsecret -A
kubectl describe sealedsecret <n> -n <namespace>

# Re-fetch cert after cluster rebuild
kubeseal --fetch-cert \
  --controller-name=sealed-secrets-controller \
  --controller-namespace=flux-system \
  > ~/.config/kubeseal/pub-sealed-secrets.pem
```

---

## NTP Time Synchronization

Not strictly a security tool but important for cluster health — AlertManager fires `NodeClockNotSynchronising` if clocks drift.

### Problem

Worker nodes were pointing to `192.168.55.12` (worker2) as their NTP server, but worker2 is not an NTP server. This caused synchronization failures.

### Fix via Ansible

```yaml
- name: Sync time across cluster
  hosts: workers
  become: true
  tasks:
    - name: Configure timesyncd
      ansible.builtin.copy:
        dest: /etc/systemd/timesyncd.conf
        content: |
          [Time]
          NTP=192.168.55.10
          FallbackNTP=ntp.ubuntu.com
          RootDistanceMaxSec=5
          PollIntervalMinSec=32
          PollIntervalMaxSec=2048

    - name: Enable and restart timesyncd
      ansible.builtin.systemd:
        name: systemd-timesyncd
        state: restarted
        enabled: true
```

**Important:** master node uses `chrony` — don't touch it. Add a UFW rule on master to allow NTP from the cluster:
```bash
ufw allow from 192.168.55.0/24 to any port 123 proto udp
```

Verify sync:
```bash
ansible all -m shell -a "timedatectl status | grep sync" -b
```
