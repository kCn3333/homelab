# Observability

## Stack

| Component          | Purpose                                 |
| ------------------ | --------------------------------------- |
| Prometheus         | Metrics collection and alert evaluation |
| Grafana            | Dashboards and queries                  |
| Alertmanager       | Alert grouping and delivery             |
| node-exporter      | Node metrics                            |
| kube-state-metrics | Kubernetes object metrics               |
| Loki               | Log storage and querying                |
| Promtail           | Log collection                          |
| Hubble             | Cilium network-flow visibility          |

`kube-prometheus-stack` is currently deployed as chart version `82.10.1` through Flux.

## Prometheus

Prometheus uses `hostNetwork: true` and `hostPID: true` so it can scrape kubelet and
node-exporter endpoints on node addresses. UFW permits the required traffic inside the
cluster subnet.

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

Current unresolved issue: dashboards display `An error occurred within the plugin`.
The cause has not been established. Diagnose it separately by checking:

1. Grafana Pod status and logs;
2. data source health and query errors;
3. browser developer-console errors;
4. affected panel plugins and their versions;
5. whether the problem affects built-in and imported dashboards alike.

```bash
kubectl logs -n monitoring deployment/kube-prometheus-stack-grafana --since=30m
kubectl get ingress,service,endpointslices -n monitoring
```

Do not treat the visible plugin message as proof of a Prometheus, network or storage
failure until the corresponding requests and logs are checked.

## Loki

Loki stores logs in the Garage S3-compatible backend on Logos at
`http://192.168.0.56:3900`. Credentials are delivered through a SealedSecret.

```bash
kubectl get pods -n monitoring | grep -E 'loki|promtail'
kubectl logs -n monitoring <loki-pod> --since=30m
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
