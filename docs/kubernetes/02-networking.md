# Networking

## Addressing

| Network         | Range             | Purpose                                      |
| --------------- | ----------------- | -------------------------------------------- |
| Node network    | `192.168.55.0/24` | Node, API, etcd and overlay underlay traffic |
| Pod network     | `10.42.0.0/16`    | Addresses assigned to Pods                   |
| Service network | `10.43.0.0/16`    | Virtual Service addresses                    |

Per-node PodCIDRs:

```text
master:  10.42.0.0/24
worker1: 10.42.1.0/24
worker2: 10.42.2.0/24
```

The current Cilium configuration uses Kubernetes IPAM:

```text
version=1.19.7
ipam=kubernetes
k8s-require-ipv4-pod-cidr=true
routing=VXLAN
kubeProxyReplacement=false
```

k3s assigns each node a PodCIDR. Cilium consumes that CIDR instead of allocating addresses from a separate cluster pool.

Verify:

```bash
kubectl get nodes \
  -o custom-columns='NAME:.metadata.name,PODCIDR:.spec.podCIDR'

kubectl get configmap cilium-config \
  --namespace kube-system \
  -o jsonpath='ipam={.data.ipam}{"\n"}require-pod-cidr={.data.k8s-require-ipv4-pod-cidr}{"\n"}'
```

---

## Cilium and kube-proxy

Cilium and kube-proxy coexist.

| Component  | Current responsibility                                                                |
| ---------- | ------------------------------------------------------------------------------------- |
| Cilium     | Pod interfaces, routing, NetworkPolicy, Service eBPF for tested Pod traffic and VXLAN |
| kube-proxy | iptables Service rules for traffic that reaches the host netfilter dataplane          |

`kubeProxyReplacement=false` means kube-proxy remains part of the cluster. It does not mean Cilium performs no Service translation.

The tested `kube-dns` paths were:

| Source              | ClusterIP translation | Remote Pod transport |
| ------------------- | --------------------- | -------------------- |
| Process on `master` | kube-proxy / iptables | Cilium VXLAN         |
| Pod on `master`     | Cilium eBPF           | Cilium VXLAN         |

These results apply to the tested UDP/53 ClusterIP traffic. NodePort and LoadBalancer use separate paths.

---

## Service and EndpointSlice

A Service provides a stable virtual frontend. EndpointSlice stores the current backend addresses and readiness conditions.

```text
Service/kube-dns: 10.43.0.10:53
EndpointSlice:    Pod CoreDNS address, ready=true
```

EndpointSlice belongs to the control path:

1. Kubernetes records ready backends.
2. kube-proxy and Cilium observe Service and EndpointSlice objects.
3. They update local iptables rules or eBPF maps.
4. Packets use the programmed dataplane; they do not query EndpointSlice directly.

Inspect the current state:

```bash
kubectl get service kube-dns \
  --namespace kube-system \
  --output wide

kubectl get endpointslices \
  --namespace kube-system \
  --selector kubernetes.io/service-name=kube-dns \
  --output wide
```

---

## kube-proxy iptables path

For tested traffic originating from a node process, kube-proxy used:

```text
KUBE-SERVICES
→ KUBE-SVC-*
→ KUBE-SEP-*
→ DNAT to Pod IP
```

The ClusterIP is not assigned to a network interface and does not require a route in the regular routing table. Netfilter intercepts the destination and performs DNAT.

Inspect counters:

```bash
sudo iptables-save -c -t nat | \
grep 'kube-system/kube-dns:dns' | \
grep -v 'dns-tcp'
```

---

## Cilium VXLAN path

After Service translation selects a Pod on another node, Cilium routes the packet through `cilium_host` and encapsulates it in VXLAN.

Example observed during a DNS query:

```text
outer: 192.168.55.10 → 192.168.55.11:8472/UDP
inner: 10.42.0.161 → 10.42.1.113:53/UDP
```

The inner destination was already the CoreDNS Pod address. Service translation therefore happened before VXLAN encapsulation.

`cilium_host` is the host-side entry into the Cilium datapath. `cilium_vxlan` implements the overlay between nodes.

Useful checks:

```bash
ip route get <pod-ip>
```

```bash
sudo timeout 15 tcpdump \
  -ni <node-interface> \
  -nn -vv \
  udp port 8472
```

---

## Hubble network path

Each Cilium agent exposes the Hubble observer API on its node address at TCP port `4244`.

Users reach Hubble UI through its normal Ingress at `https://hubble.cluster.kcn333.com`. Traefik routes this request to `Service/hubble-ui`; no manual port-forward is required.

The `hubble-peer` Service uses `internalTrafficPolicy: Local`. Hubble Relay first connects through the Service to the local Cilium agent and obtains the peer list. It then opens a direct TLS connection to every advertised node endpoint:

```text
Hubble Relay Pod
  -> hubble-peer ClusterIP:443
  -> local Cilium agent:4244
  -> peer list
  -> 192.168.55.10:4244
  -> 192.168.55.11:4244
  -> 192.168.55.12:4244
```

The internal Relay-to-agent path requires Pod-to-NodeIP connectivity on TCP `4244`. This is cluster-internal traffic and is separate from browser access through Traefik. It was verified after upgrading Cilium from `1.19.1` to `1.19.7`; no `hostNetwork` workaround, manual port-forward or additional UFW route rule is required.

Useful checks:

```bash
kubectl get service hubble-peer \
  --namespace kube-system \
  --output wide

kubectl get endpointslices \
  --namespace kube-system \
  --selector kubernetes.io/service-name=hubble-peer \
  --output wide
```

---

## HAProxy and node access

HAProxy is the intended external entry point:

```text
HAProxy:6443 → kube-apiserver
HAProxy:80   → Traefik HTTP
HAProxy:443  → Traefik HTTPS
```

Direct node addresses are still valid technical endpoints for NodePort and ServiceLB. Router and UFW rules decide which source networks may use them. HAProxy does not make those paths disappear.

Application traffic through ServiceLB is described in [Ingress and TLS](03-ingress-tls.md).

---

## NetworkPolicy

Without a policy, Pods can communicate across namespaces. A NetworkPolicy selects Pods and restricts ingress, egress or both.

Example: allow PostgreSQL traffic only from `clients-api` Pods in the same namespace:

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: clients-db-allow-only-api
  namespace: clients
spec:
  podSelector:
    matchLabels:
      cnpg.io/cluster: clients-db
  policyTypes:
    - Ingress
  ingress:
    - from:
        - podSelector:
            matchLabels:
              app: clients-api
      ports:
        - protocol: TCP
          port: 5432
```

Cilium drops traffic denied by policy. A timeout can therefore indicate a policy drop; it does not prove a routing failure.

Inspect policies and drops:

```bash
kubectl get networkpolicy -A
kubectl describe networkpolicy <name> -n <namespace>
kubectl -n kube-system exec ds/cilium -- cilium-dbg monitor --type drop
```

---

## Required node ports

|  Port | Protocol | Purpose                       |
| ----: | :------: | ----------------------------- |
|  6443 |    TCP   | Kubernetes API                |
|  8472 |    UDP   | Cilium VXLAN                  |
| 10250 |    TCP   | kubelet API                   |
|  2379 |    TCP   | etcd client traffic           |
|  2380 |    TCP   | etcd peer traffic             |
|  9100 |    TCP   | node-exporter                 |
|  4443 |    TCP   | metrics-server webhook        |
|  4244 |    TCP   | Hubble Relay to Cilium agents |
|  4240 |    TCP   | Cilium health                 |
|   123 |    UDP   | NTP inside the node network   |

The firewall source ranges and active rules are documented in [Security](06-security.md)
and implemented by the [cluster Ansible playbooks](https://github.com/kCn3333/homelab-ansible/tree/main/cluster/playbooks).

---

## Useful commands

```bash
kubectl -n kube-system exec ds/cilium -- cilium-dbg status
kubectl get ciliumnodes
kubectl get pods -n kube-system -l k8s-app=cilium -o wide
```

```bash
kubectl get service,endpointslice -A
sudo iptables-save -c -t nat | grep KUBE-SERVICES
ip -4 route show table all
```
