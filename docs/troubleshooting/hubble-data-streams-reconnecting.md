# :material-access-point-network: Hubble data streams reconnecting after Cilium deployment

Hubble UI loaded successfully but could not display flows or service maps. Hubble Relay discovered all three Cilium peers, yet every peer remained unavailable. The failure was isolated to traffic from Pods to the node addresses on `4244/TCP` and was resolved by upgrading Cilium from `1.19.1` to `1.19.7` without changing Helm values, firewall rules or network mode.

## :material-alert-outline: Symptoms

- Hubble UI remained at `Data streams are reconnecting...`;
- selecting a namespace returned `No data found to render a service map` and `No flows found`;
- the problem was reproduced with a temporary diagnostic port-forward that bypassed the normal Ingress path;
- `hubble status` reported `NOT_SERVING`;
- `hubble list nodes` listed all three nodes as `Unavailable`;
- Hubble Relay discovered all three peers but did not obtain usable observer connections;
- every Cilium agent reported its local Hubble instance as `Ok`;
- node-to-node connections to `4244/TCP` succeeded;
- connections from a Pod to every `NodeIP:4244` failed immediately with `ConnectionRefusedError`.

## :material-map-marker-path: Component path

`Service/hubble-peer` uses `internalTrafficPolicy: Local`:

```text
Hubble Relay Pod
→ hubble-peer ClusterIP:443
→ Cilium agent on the same node:4244
→ peer discovery response
→ direct TLS connections to every NodeIP:4244
→ local Hubble observers
```

Users access Hubble UI through Traefik at `https://hubble.cluster.kcn333.com`. No manual port-forward is required for normal operation. Hubble UI talks to Hubble Relay through `Service/hubble-relay`; Traefik and the UI Ingress are outside the internal Relay-to-agent path.

## :material-magnify: Diagnosis

### 1. Check component and endpoint health

```bash
kubectl get \
  daemonset/cilium \
  deployment/hubble-relay \
  deployment/hubble-ui \
  --namespace kube-system \
  --output wide

kubectl get endpointslices \
  --namespace kube-system \
  --selector kubernetes.io/service-name=hubble-peer \
  --output wide
```

All workloads and all three `hubble-peer` endpoints were ready.

### 2. Check Relay peer state

The following port-forward is an optional diagnostic command for the Hubble CLI. It bypasses Traefik and does not form part of the deployed Hubble UI path:

```bash
kubectl port-forward \
  --namespace kube-system \
  service/hubble-relay \
  4245:80
```

Use an explicit IPv4 loopback address:

```bash
hubble status --server 127.0.0.1:4245
hubble list nodes --server 127.0.0.1:4245
```

Using `localhost` can make the CLI try `[::1]:4245` while port-forward listens only on IPv4.

### 3. Verify the Cilium agents

```bash
for pod in $(
  kubectl get pods \
    --namespace kube-system \
    --selector k8s-app=cilium \
    --output name
); do
  printf '\n### %s\n' "$pod"

  kubectl exec \
    --namespace kube-system \
    "$pod" \
    --container cilium-agent \
    -- cilium-dbg status --verbose
done
```

The agents reported:

```text
KubeProxyReplacement: False
Routing: Network: Tunnel [vxlan] Host: Legacy
Host firewall: Disabled
Hubble: Ok
```

### 4. Test the failing network boundary

Run the connection test from a Pod containing Python:

```python
import socket

for address in (
    "192.168.55.10",
    "192.168.55.11",
    "192.168.55.12",
):
    try:
        connection = socket.create_connection((address, 4244), timeout=3)
        connection.close()
        print(f"{address}:4244 CONNECTED")
    except Exception as error:
        print(f"{address}:4244 FAILED: {type(error).__name__}: {error}")
```

On Cilium `1.19.1`, all three connections failed. A capture on the node hosting the test Pod showed:

```text
PodIP → local NodeIP:4244  TCP SYN
local NodeIP → PodIP       ICMP tcp port 4244 unreachable
```

At the same time, `ss -lntp` confirmed that `cilium-agent` listened on `*:4244`.

### 5. Exclude unrelated layers

- A temporary diagnostic port-forward reproduced the problem, excluding Traefik and Ingress without changing the deployment.
- Node-to-node `4244/TCP` connections succeeded.
- UFW allowed the Pod CIDR and required Cilium ports.
- A temporary UFW route rule did not change the result and its counter remained zero.
- No NetworkPolicy selected the Hubble components.
- Cilium host firewall was disabled.
- Cilium monitor and netfilter tracing did not observe the rejected connection.

The packet was rejected in the Cilium-managed Pod-to-node path before the host netfilter rules used in the tests.

## :material-bug-check-outline: Root cause

The operational cause was Cilium `1.19.1` datapath behavior for Pod-to-NodeIP traffic. It prevented Hubble Relay from establishing usable connections to observers exposed by Cilium agents on `NodeIP:4244`.

An exact upstream commit was not identified. The before-and-after test proves that upgrading Cilium removed the failure, but does not justify assigning it to a specific Cilium bug without separate changelog and source-code analysis.

## :material-wrench-outline: Corrective action

Take an embedded-etcd snapshot and update the Flux-managed HelmRelease:

```yaml
spec:
  chart:
    spec:
      chart: cilium
      version: "1.19.7"
```

Render the target chart with the current values before deployment. Commit the version change to the branch observed by Flux, then reconcile:

```bash
flux reconcile kustomization infrastructure-operators \
  --namespace flux-system \
  --with-source \
  --timeout 10m

flux reconcile helmrelease cilium \
  --namespace kube-system \
  --with-source \
  --timeout 15m
```

No change was required to `hostNetwork`, `kubeProxyReplacement=false`, Kubernetes IPAM, VXLAN routing, Hubble TLS, UFW or NetworkPolicy.

## :material-check-decagram: Validation

The HelmRelease completed successfully with chart `1.19.7`. All three agents reported Cilium `1.19.7`, all Nodes remained `Ready`, and no Pod remained outside `Running` or `Succeeded`.

The same Pod-to-node test then returned:

```text
192.168.55.10:4244 CONNECTED
192.168.55.11:4244 CONNECTED
192.168.55.12:4244 CONNECTED
```

Hubble UI displayed live flows and the service map for the `clients` namespace without reconnect warnings.

```bash
kubectl get helmrelease cilium --namespace kube-system
kubectl get pods --namespace kube-system --output wide | \
  grep -E '(^NAME|cilium-|hubble-)'

hubble status --server 127.0.0.1:4245
hubble list nodes --server 127.0.0.1:4245
```

## :material-shield-check-outline: Prevention

- keep Cilium on a supported patch release instead of remaining on the initial release of a branch;
- upgrade one infrastructure component at a time and preserve its Helm values;
- render the target chart before changing the Flux source of truth;
- take an embedded-etcd snapshot before a CNI upgrade;
- preserve a repeatable Pod-to-NodeIP connectivity test;
- verify Hubble through Relay CLI and UI after every Cilium upgrade;
- do not add firewall exceptions until packet captures and counters identify the firewall as the failing layer.

## :fontawesome-solid-book: Related documents

- [Kubernetes networking](../kubernetes/02-networking.md)
- [Kubernetes observability](../kubernetes/07-observability.md)
- [Kubernetes security](../kubernetes/06-security.md)
- [Kubernetes GitOps](../kubernetes/05-gitops.md)
