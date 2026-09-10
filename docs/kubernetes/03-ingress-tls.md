# Ingress and TLS

## Roles

* `Ingress` is a Kubernetes API object that declares HTTP routing.
* Traefik is the Ingress Controller that implements those rules.
* cert-manager issues and renews TLS certificates.
* HAProxy is the external L4 entry point running in an LXC container on Proxmox.
* K3s ServiceLB exposes Traefik on ports 80 and 443 of every node.

## Application traffic path

```text
client -> HAProxy -> node:80/443 -> ServiceLB -> Service/traefik
       -> Traefik Pod -> application backend
```

HAProxy chooses a node. ServiceLB does not balance traffic between nodes; it makes the
Traefik `LoadBalancer` Service reachable on each node. The Kubernetes API on port
`6443` follows a separate path and does not pass through ServiceLB or Traefik.

The HAProxy LXC uses `192.168.0.45`; the application and API forwarding configuration
remained unchanged after moving HAProxy into the container.

## Traefik Service

| Field                   | Value              |
| ----------------------- | ------------------ |
| Type                    | `LoadBalancer`     |
| ClusterIP               | `10.43.164.47`     |
| HTTP NodePort           | `30367`            |
| HTTPS NodePort          | `31427`            |
| `externalTrafficPolicy` | `Cluster`          |
| Published addresses     | all three node IPs |

K3s ServiceLB creates `DaemonSet/svclb-traefik-*`. Each Pod runs
`rancher/klipper-lb:v0.4.14`, reserves host ports `80` and `443`, and forwards traffic
to the Traefik Service ClusterIP. `klipper-lb` is the implementation of ServiceLB, not
another independent load balancer tier.

```bash
kubectl get service traefik -n kube-system -o wide
kubectl get daemonset,pods -n kube-system -o wide | grep -E 'svclb-traefik|traefik-'
kubectl get endpointslices -n kube-system \
  -l kubernetes.io/service-name=traefik
```

## Routing to application backends

Grafana currently uses:

| Object          | Value                              |
| --------------- | ---------------------------------- |
| Ingress class   | `traefik`                          |
| Host            | `grafana.cluster.kcn333.com`       |
| Backend Service | `kube-prometheus-stack-grafana:80` |
| TLS Secret      | `grafana-tls`                      |

Traefik watches Ingress, Service and EndpointSlice objects. With the current default
configuration (`nativeLB` not enabled), it forwards directly to ready Pod endpoints.
The Service still supplies the selector, port mapping and discovery relationship.

If a Pod is replaced, EndpointSlice receives its new address. Traefik must observe
that update before it can use the new backend.

```bash
kubectl get ingress -A
kubectl get service kube-prometheus-stack-grafana -n monitoring
kubectl get endpointslices -n monitoring \
  -l kubernetes.io/service-name=kube-prometheus-stack-grafana
```

## Traefik configuration

Traefik is packaged by K3s. Persistent changes belong in a `HelmChartConfig` named
`traefik` in `kube-system`, not in the generated Deployment or HelmChart.

Current customizations include HTTP-to-HTTPS redirection and the dashboard. The
dashboard is exposed through an authenticated `IngressRoute` using `api@internal`.

## TLS

cert-manager uses a cluster-scoped Let's Encrypt issuer and DNS-01 validation through
Cloudflare. DNS-01 does not require the cluster to be reachable from the public
internet.

1. A `Certificate` requests a certificate from the `ClusterIssuer`.
2. cert-manager creates the DNS challenge record.
3. Let's Encrypt validates the record.
4. cert-manager writes the certificate to a Secret.
5. Traefik terminates TLS using that Secret.

The TLS Secret must be in the same namespace as the Ingress that references it.

```bash
kubectl get clusterissuer
kubectl get certificate,certificaterequest,challenge -A
kubectl describe certificate grafana-tls -n monitoring
```

## Troubleshooting order

1. Confirm that DNS resolves to the HAProxy address.
2. Check HAProxy access to node ports `80` and `443`.
3. Check the Traefik Service and `svclb-traefik` Pods.
4. Check the Ingress host, path and TLS Secret.
5. Check the backend Service selector and ready EndpointSlice entries.
6. Check Traefik logs.

`kubectl port-forward` is a temporary API-server tunnel. It is useful for diagnostics,
but it does not test HAProxy, ServiceLB or the normal Ingress path.
