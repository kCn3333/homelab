# GitOps with Flux

## Source of truth

The [k3s-homelab repository](https://github.com/kCn3333/k3s-homelab) defines the desired
Kubernetes state. Flux pulls the repository, resolves Kustomize and Helm resources,
and reconciles the cluster.

Manual changes are useful for diagnostics but are not persistent. A change that should
remain must be represented in Git and applied by the existing resource owner.

## Repository layout

```text
clusters/k3s-homelab/       Flux entry points and dependency order
infrastructure/operators/   controllers and operators
infrastructure/config/      configuration for those operators
apps/base/                  applications enabled on main
apps/dev/                   development overlay
apps/staging/               staging overlay
tests/manual/               reusable manifests not reconciled by Flux
```

The active application set in `apps/base/kustomization.yaml` contains `clients-api`
and `k8s-badge`. A directory may remain in Git without being deployed when no active
Kustomization references it.

The old nginx test was removed from the active resource list. With `prune: true`, Flux
removed its Deployment, Service, Ingress, PVC and namespace. The associated PV and
Longhorn volume were also deleted.

## Two Kustomization objects

| API group                     | Purpose                      |
| ----------------------------- | ---------------------------- |
| `kustomize.config.k8s.io`     | Assembles manifests          |
| `kustomize.toolkit.fluxcd.io` | Reconciles a repository path |

The main dependency chain is:

```text
infrastructure-operators -> infrastructure-config -> apps
```

CRDs and controllers are therefore available before their configuration and workloads.

## Helm releases

Flux manages charts through source objects and `HelmRelease`. Direct `helm upgrade`
changes the live release but not Git and may be reverted by reconciliation.

```bash
flux get sources all -A
flux get helmreleases -A
flux reconcile helmrelease <name> -n <namespace> --with-source
```

## Image automation

* `ImageRepository` scans a registry.
* `ImagePolicy` selects an allowed tag.
* `ImageUpdateAutomation` commits the selected tag to Git.

`clients-api` uses semantic versions so promotion remains deterministic. A Deployment
must not declare `spec.replicas` when HPA owns that field.

## Safe change sequence

1. Change manifests on a branch.
2. Validate YAML and render Kustomize output.
3. Review and merge to the branch watched by Flux.
4. Reconcile the source and relevant Kustomization.
5. Verify the applied revision and workload state.

```bash
kustomize build apps/base >/dev/null
flux reconcile kustomization apps -n flux-system --with-source --timeout 10m
flux get kustomizations -n flux-system
```

When a Kustomization is suspended for maintenance, merge the intended configuration
to its watched branch before resuming it. Otherwise Flux can restore the previous
declarative state.

## Pruning and deletion

Removing a resource from an active Kustomization is a deletion request when
`prune: true`. Before merging, check whether it owns persistent data and whether its
reclaim policy will delete the underlying volume.

```bash
kubectl get all,pvc,ingress -n <namespace>
kubectl get pv
kubectl get volumes.longhorn.io -n longhorn-system
```

## Routine checks

```bash
flux check
flux get all -A
flux get kustomizations -n flux-system
flux get helmreleases -A
flux get image repositories,policies,update -A
```
