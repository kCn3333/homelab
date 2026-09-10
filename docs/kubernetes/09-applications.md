# Applications

## Active applications

The main application Kustomization currently includes:

* [clients-api](https://github.com/kCn3333/clients-api);
* [k8s-badge](https://github.com/kCn3333/k8s-badge).

The old nginx test is no longer active. Its files may remain as reference material,
but they are not listed in `apps/base/kustomization.yaml` and Flux does not deploy them.

```bash
kubectl get deployments,statefulsets,services,ingress -A
flux get kustomizations -n flux-system
```

## clients-api

[clients-api](https://github.com/kCn3333/clients-api) is a Spring Boot API backed by
PostgreSQL managed by CloudNativePG. It is used to exercise the complete delivery
path: application CI, container images, Helm, Flux, database lifecycle, autoscaling
and monitoring.

### Environments

| Environment | Git source     | Purpose                   |
| ----------- | -------------- | ------------------------- |
| production  | `main`         | stable release            |
| development | `main` overlay | development configuration |
| staging     | `staging`      | pre-production validation |

Each environment owns separate Kubernetes resources and database state.

### Delivery flow

1. A semantic version tag starts GitHub Actions.
2. CI tests and builds the application image.
3. CI publishes the image and Helm chart.
4. Flux image automation selects an allowed version and updates Git.
5. Flux reconciles the HelmRelease and Kubernetes resources.

Semantic versions are used for release selection. Commit-SHA tags are useful for
traceability but are not the ordering mechanism for production promotion.

### Runtime configuration

The production profile uses the CloudNativePG read-write Service and credentials from
a Kubernetes Secret. No database password is stored in plaintext Git.

Readiness and liveness probes use the Spring Boot Actuator endpoints:

* readiness removes an unready Pod from Service endpoints;
* liveness restarts a process that cannot recover;
* startup timing must allow JVM initialization and database connection setup.

```bash
kubectl get pods,service,endpointslices -n clients
kubectl logs -n clients deployment/clients-api --since=15m
kubectl describe pod -n clients -l app=clients-api
```

### Scaling ownership

HPA is the sole owner of the Deployment replica count. The Deployment manifest does
not set `spec.replicas`, otherwise Flux and HPA would continuously overwrite each
other.

CPU utilization targets are calculated against `requests.cpu`, not the CPU limit.
Resource requests affect scheduling; limits bound runtime use.

```bash
kubectl get hpa -n clients
kubectl top pods -n clients
```

### Availability

A PodDisruptionBudget protects at least one API replica during voluntary disruption.
It does not protect against all simultaneous failures and does not make the database
or ingress path highly available by itself.

CloudNativePG manages PostgreSQL instances, Services, failover and storage claims.
Database health must be checked independently from application readiness.

```bash
kubectl get pdb -n clients
kubectl get clusters.postgresql.cnpg.io -A
kubectl get pods,pvc -n clients
```

### Monitoring

A `ServiceMonitor` selects the application Service and scrapes the Actuator Prometheus
endpoint. Both the Service labels and ServiceMonitor selector must match.

```bash
kubectl get servicemonitor -n clients
kubectl get servicemonitor -n clients -o yaml
```

## k8s-badge

[k8s-badge](https://github.com/kCn3333/k8s-badge) is a small stateless workload that
publishes cluster status as JSON and SVG. It follows the same GitOps rule: changes are
made in Git and verified after Flux applies the expected revision.

## Operational checks

```bash
flux get kustomizations -n flux-system
flux get helmreleases -A
kubectl get pods -A --field-selector=status.phase!=Running
kubectl get events -A --sort-by=.lastTimestamp | tail -n 50
```

Completed Jobs are expected in the non-Running list. Pending, Unknown, CrashLoopBackOff
or repeated restart states require investigation.
