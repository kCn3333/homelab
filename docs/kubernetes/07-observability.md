# Observability

## Stack

| Component | Purpose |
|---|---|
| Prometheus | Metrics collection and alert evaluation |
| Grafana | Dashboards and queries |
| Alertmanager | Alert grouping and delivery |
| node-exporter | Node metrics |
| kube-state-metrics | Kubernetes object metrics |
| Loki | Log storage and querying |
| Promtail | Log collection |
| Hubble | Cilium network-flow visibility |

`kube-prometheus-stack` is currently deployed as chart version `82.10.1` through Flux.
The stack includes Grafana `12.4.0` and `kiwigrid/k8s-sidecar:2.5.0`.

## Prometheus

Prometheus uses `hostNetwork: true` and `hostPID: true` so it can scrape kubelet and
node-exporter endpoints on node addresses. It therefore listens on TCP port `9090` in
the network namespace of its node instead of using only a Pod IP.

UFW must allow `9090/tcp` from the cluster-node subnet on every K3s node. This rule is
managed by the
[K3s UFW playbook](https://github.com/kCn3333/homelab-ansible/blob/main/cluster/playbooks/power/k3s-ufw.yml)
and is intentionally not open to the entire LAN or the Internet.

Some kube-prometheus-stack integrations for embedded K3s control-plane components are
disabled because their expected upstream endpoints are not exposed in the standard
form.

`kubeProxy.enabled: false` in chart values disables kube-proxy monitoring objects. It
does not disable the kube-proxy process; kube-proxy still handles parts of the Service
datapath in this cluster.

```bash
kubectl get prometheus,servicemonitor,podmonitor -A
kubectl get pods -n monitoring -o wide
kubectl top nodes
kubectl top pods -A
```

## Grafana

Grafana is exposed through Traefik at `grafana.cluster.kcn333.com`. Its Ingress points
to the Grafana ClusterIP Service, while Traefik currently forwards to the ready Pod
endpoint learned from EndpointSlice.

The default Prometheus datasource uses:

```text
http://kube-prometheus-stack-prometheus.monitoring:9090/
```

The earlier `An error occurred within the plugin` failure was caused by UFW blocking
traffic from the Grafana node to the Prometheus `hostNetwork` endpoint on
`9090/tcp`. Grafana logs showed a timeout to the Prometheus ClusterIP, while packet
capture on the Prometheus node showed incoming SYN packets without a SYN-ACK. Adding
the cluster-scoped UFW rule restored queries immediately.

Grafana currently stores `/var/lib/grafana` in `emptyDir`. Local users, sessions and
objects created only through the UI do not survive Pod replacement. Required objects
must therefore be provisioned from Git:

- the `clients-api` dashboard is stored in
  [`grafana-dashboard-clients-api.yaml`](https://github.com/kCn3333/k3s-homelab/blob/main/infrastructure/operators/monitoring/grafana-dashboard-clients-api.yaml);
- the Loki datasource is stored in
  [`grafana-datasource-loki.yaml`](https://github.com/kCn3333/k3s-homelab/blob/main/infrastructure/operators/monitoring/grafana-datasource-loki.yaml).

Both objects are loaded by Grafana sidecars. Their runtime settings are declared in
the
[`kube-prometheus-stack` HelmRelease](https://github.com/kCn3333/k3s-homelab/blob/main/infrastructure/operators/monitoring/helmrelease.yaml):

| Sidecar | Health port | Reload retries |
|---|---:|---:|
| dashboards | `8081` | `8` |
| datasources | `8082` | `8` |

Separate health ports prevent the sidecars from competing for port `8080` in the
shared Pod network namespace. The extended retry window covers Grafana startup and
provisioning before its API begins listening on port `3000`.

```bash
kubectl logs -n monitoring deployment/kube-prometheus-stack-grafana --since=30m
kubectl get ingress,service,endpointslices -n monitoring
```

## Loki

Loki stores logs in the Garage S3-compatible backend on Logos at
`http://192.168.0.56:3900`. Credentials are delivered through a SealedSecret.

```bash
kubectl get pods -n loki -o wide
kubectl logs -n loki loki-0 -c loki --since=30m
```

## Alertmanager

Alertmanager groups Prometheus alerts and sends notifications through ntfy. Its
configuration is stored as an encrypted secret in Git.

```bash
kubectl get alertmanager -n monitoring
kubectl get prometheusrule -A
kubectl logs -n monitoring alertmanager-kube-prometheus-stack-alertmanager-0 --since=30m
```

## Hubble

Hubble is enabled through the Flux-managed Cilium HelmRelease and is exposed at
`https://hubble.cluster.kcn333.com`.

Traefik routes browser traffic through the Hubble UI Ingress to `Service/hubble-ui`.
This is the normal operational path and does not require a manual port-forward.

| Component | Version |
|---|---|
| Cilium agent and operator | `1.19.7` |
| Hubble Relay | `1.19.7` |
| Hubble UI and backend | `0.13.5` |

Hubble Relay uses the local-backend `hubble-peer` Service for peer discovery, then
connects directly over TLS to every Cilium agent at its NodeIP on TCP `4244`.

The UI, live flows and service map were verified through the public Hubble URL after
upgrading Cilium from `1.19.1` to `1.19.7`. The repair did not require `hostNetwork`,
a manual port-forward, an additional UFW route rule, or changes to Traefik.

```bash
kubectl exec \
  --namespace kube-system \
  daemonset/cilium \
  -- cilium-dbg status

kubectl get ingress,service,endpointslices \
  --namespace kube-system
```

For optional CLI diagnosis only, temporarily expose Hubble Relay locally. This does
not replace the Hubble UI Ingress and is not required for normal use:

```bash
kubectl port-forward \
  --namespace kube-system \
  service/hubble-relay \
  4245:80

hubble status --server 127.0.0.1:4245
hubble list nodes --server 127.0.0.1:4245

kubectl get pods -n kube-system -l k8s-app=hubble-relay -o wide
kubectl logs -n kube-system deployment/hubble-relay --since=30m
```

The diagnosis and repair are documented in
[Hubble data streams reconnecting](../troubleshooting/hubble-data-streams-reconnecting.md).

## Routine checks

```bash
kubectl get pods -n monitoring
kubectl get pvc -n monitoring
flux get helmreleases -n monitoring
kubectl get events -n monitoring --sort-by=.lastTimestamp | tail -n 30
```
