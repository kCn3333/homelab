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

Hubble Relay and the Hubble UI are deployed, but the current Hubble problem is still
unresolved. Earlier hypotheses about VXLAN or routing mode are not confirmed.

Before changing Cilium routing or kube-proxy replacement settings, collect component
status, Relay logs, peer information and connection errors. The diagnosis should be
completed as a separate session.

```bash
cilium status
cilium hubble port-forward &
hubble status
kubectl get pods -n kube-system -l k8s-app=hubble-relay -o wide
kubectl logs -n kube-system deployment/hubble-relay --since=30m
```

## Routine checks

```bash
kubectl get pods -n monitoring
kubectl get pvc -n monitoring
flux get helmreleases -n monitoring
kubectl get events -n monitoring --sort-by=.lastTimestamp | tail -n 30
```
