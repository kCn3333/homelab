# GitOps with Flux

## Why GitOps

The classic approach (`kubectl apply -f`) has problems at scale:
- No single source of truth about what's running in the cluster
- Hard rollbacks (you have to figure out the previous state)
- No audit trail of who changed what and when
- Chaos in team environments

GitOps solves this by making the Git repo the only source of truth. An agent running inside the cluster (Flux) continuously compares the desired state (Git) against the actual state (cluster) and reconciles any differences.

### Pull model vs Push model

| | Push (classic CI/CD) | Pull (GitOps / Flux) |
|-|---------------------|---------------------|
| How changes get applied | Pipeline pushes to cluster | Agent inside cluster pulls from Git |
| Cluster access from CI | Required | Not needed |
| Security | Cluster exposed to CI system | Cluster stays behind firewall |

---

## Flux Components

### Core controllers

| Controller | Role |
|-----------|------|
| `source-controller` | Watches GitHub, fetches repo every 1 min |
| `kustomize-controller` | Applies YAML manifests |
| `helm-controller` | Handles Helm releases |
| `notification-controller` | Sends notifications (Slack, webhook) |

### Image Automation (optional, installed separately)

| Controller | Role |
|-----------|------|
| `image-reflector-controller` | Scans registries for new image tags |
| `image-automation-controller` | Commits updated tags back to Git repo |

These are not installed by default — add `--components-extra` to the bootstrap command.

---

## Bootstrap

```bash
# Pre-flight check
flux check --pre

# Bootstrap with GitHub
flux bootstrap github \
  --owner=<your-github-username> \
  --repository=k3s-homelab \
  --private=false \
  --personal=true \
  --path=clusters/k3s-homelab \
  --components-extra=image-reflector-controller,image-automation-controller \
  --read-write-key
```

`--read-write-key` is required for Image Automation — Flux needs write access to commit tag updates back to the repo. The default bootstrap creates a read-only deploy key.

If you forgot `--read-write-key`:
1. Delete the old key on GitHub (Settings → Deploy keys → Delete)
2. Get the new key: `kubectl get secret flux-system -n flux-system -o jsonpath='{.data.identity\.pub}' | base64 -d`
3. Add it on GitHub with **Allow write access** checked

---

## Repository Structure

```
k3s-homelab/
├── apps/
│   ├── base/                          # actual manifests
│   │   ├── kustomization.yaml         # lists all apps
│   │   ├── nginx/
│   │   │   ├── kustomization.yaml
│   │   │   ├── namespace.yaml
│   │   │   ├── nginx-deploy.yaml
│   │   │   ├── imagerepository.yaml
│   │   │   └── imagepolicy.yaml
│   │   └── ...
│   └── kustomization.yaml
└── clusters/
    └── k3s-homelab/
        ├── apps.yaml                  # Flux Kustomization → ./apps/base
        └── flux-system/
            ├── gotk-components.yaml
            ├── gotk-sync.yaml
            └── kustomization.yaml
```

The separation between `clusters/k3s-homelab/` (what to deploy on this cluster) and `apps/base/` (how applications look) is intentional — one app definition can be deployed to multiple clusters by having different `clusters/` directories point to the same `apps/base/`.

---

## Two Types of Kustomization

This is a common source of confusion — there are two completely different `Kustomization` kinds:

```yaml
# 1. kustomize.config.k8s.io — native Kustomize, assembles YAML files
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - nginx
```

```yaml
# 2. kustomize.toolkit.fluxcd.io — Flux CRD, tells Flux what to deploy
apiVersion: kustomize.toolkit.fluxcd.io/v1
kind: Kustomization
metadata:
  name: apps
  namespace: flux-system
spec:
  interval: 1m0s
  path: ./apps/base
  prune: true           # delete resources removed from Git
  sourceRef:
    kind: GitRepository
    name: flux-system
```

`prune: true` means if you delete a file from Git, Flux will delete the corresponding resource from the cluster. Very useful for keeping things clean.

---

## Helm in Flux

Flux manages Helm releases through `HelmRepository` + `HelmRelease` resources.

```yaml
# Source — where to find the chart
apiVersion: source.toolkit.fluxcd.io/v1
kind: HelmRepository
metadata:
  name: jetstack
  namespace: flux-system     # always flux-system!
spec:
  interval: 1h
  url: https://charts.jetstack.io

# Release — how to install it
apiVersion: helm.toolkit.fluxcd.io/v2
kind: HelmRelease
metadata:
  name: cert-manager
  namespace: cert-manager
spec:
  interval: 30m
  chart:
    spec:
      chart: cert-manager
      version: ">=1.0.0"
      sourceRef:
        kind: HelmRepository
        name: jetstack
        namespace: flux-system  # always reference the namespace!
  install:
    createNamespace: true
  values:
    crds:
      enabled: true
```

**Important:** `HelmRepository` must always be in `flux-system` namespace — that's where `source-controller` runs and looks for sources.

**Generating boilerplate with Flux CLI:**
```bash
flux create source helm <n> \
  --url=<url> \
  --namespace=flux-system \
  --export > helmrepo.yaml

flux create helmrelease <n> \
  --chart=<chart> \
  --source=HelmRepository/<n> \
  --chart-version=<version> \
  --namespace=<namespace> \
  --export > helmrelease.yaml
```

---

## Image Automation

Flux can automatically detect new image tags and commit updated tag references back to your Git repo, which then triggers a rolling deploy.

### Three resources needed

**ImageRepository** — watches a container registry:
```yaml
apiVersion: image.toolkit.fluxcd.io/v1beta2
kind: ImageRepository
metadata:
  name: nginx
  namespace: flux-system
spec:
  image: nginx
  interval: 1m0s
```

**ImagePolicy** — picks which tag to use:
```yaml
apiVersion: image.toolkit.fluxcd.io/v1   # v1 (was v1beta2, promoted to stable)
kind: ImagePolicy
metadata:
  name: nginx
  namespace: flux-system
spec:
  imageRepositoryRef:
    name: nginx
  policy:
    semver:
      range: 1.29.x
```

**ImageUpdateAutomation** — commits tag updates to Git:
```yaml
apiVersion: image.toolkit.fluxcd.io/v1
kind: ImageUpdateAutomation
metadata:
  name: flux-system
  namespace: flux-system
spec:
  interval: 1m0s
  sourceRef:
    kind: GitRepository
    name: flux-system
  git:
    checkout:
      ref:
        branch: main
    commit:
      author:
        email: fluxbot@kcn333.com
        name: fluxbot
      messageTemplate: 'chore(flux): update image tags'
    push:
      branch: main
  update:
    path: ./apps
    strategy: Setters
```

### Marker comment in deployment

Flux needs to know which field in which file to update:
```yaml
image: nginx:1.29.5 # {"$imagepolicy": "flux-system:nginx"}
```

### Why semver instead of SHA tags

SHA tags (`sha-e984bdc`) are not sortable chronologically — `sha-e984bdc` may alphabetically be "greater than" `sha-9cb3301` even though it's an older commit. Flux uses alphabetical comparison for non-semver tags, so you'd get unpredictable results.

Semver is deterministic and unambiguous — `1.2.0 > 1.1.0 > 1.0.5`.

### API versioning note

`ImagePolicy` and `ImageUpdateAutomation` were promoted from `v1beta2` to `v1`. Update your manifests:

```yaml
# Old
apiVersion: image.toolkit.fluxcd.io/v1beta2

# New
apiVersion: image.toolkit.fluxcd.io/v1
```

`ImageRepository` remains at `v1beta2` — it hasn't been promoted yet.

---

## Git Workflow with Flux

Flux commits automatically to your repo. When you push changes simultaneously, you get a conflict. Configure pull with rebase to avoid messy merge commits:

```bash
git config pull.rebase true
git pull && git push
```

### Conventional Commits

Flux uses conventional commits for its auto-commits. It's good practice to follow the same standard for your own commits:

| Type | When |
|------|------|
| `feat` | New functionality |
| `fix` | Bug fix |
| `chore` | Maintenance, config |
| `docs` | Documentation |

---

## Useful Commands

```bash
# Status overview
flux get all -n flux-system
flux get kustomizations
flux get sources git -n flux-system
flux get helmreleases -A

# Force reconciliation
flux reconcile kustomization apps
flux reconcile image update flux-system
flux reconcile source git flux-system
flux reconcile helmrelease <n> -n <namespace>

# Image automation
flux get images all -n flux-system
flux get images repository -n flux-system
flux get images policy -n flux-system
flux get images update -n flux-system

# Suspend / resume (useful when debugging)
flux suspend helmrelease <n> -n <namespace>
flux resume helmrelease <n> -n <namespace>

# Git
git log --oneline --author="fluxbot"   # only auto-commits
git log -p -- apps/base/nginx/nginx-deploy.yaml  # history of a specific file
```
