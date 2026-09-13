# :material-lan-connect: Cilium IPAM CIDR mismatch and Longhorn recovery

Cilium used an independent cluster-pool while K3s assigned different PodCIDRs to Kubernetes Nodes. The cluster initially remained functional, but the overlapping address plan created routing risk and left existing Pod sandboxes on the legacy range during migration. Rolling node restarts then exposed Longhorn processes still referencing an unreachable legacy Instance Manager address.

## :material-alert-outline: Symptoms

- Kubernetes Nodes and CiliumNode resources reported different per-node PodCIDRs;
- newly created Pods used the Cilium-managed range instead of `Node.spec.podCIDR`;
- the configured Cilium pool covered unrelated private networks used elsewhere in the homelab;
- after changing IPAM, existing Pods retained legacy addresses;
- after restarting one node, several Longhorn volumes became `detaching/faulted`;
- Kubernetes VolumeAttachment objects still requested attachment to the workload node;
- Longhorn replicas on another node remained reported as `running` through an unreachable legacy Instance Manager address;
- affected workloads remained in init or container creation states while waiting for storage.

## :material-map-marker-path: Component boundaries

The cluster intentionally keeps kube-proxy enabled:

```text
kubeProxyReplacement=false
routing-mode=tunnel
tunnel-protocol=vxlan
```

The responsibilities are therefore separate:

| Component | Responsibility |
|:--|:--|
| CoreDNS | internal name resolution and forwarding external queries |
| kube-proxy | Service semantics and iptables DNAT from ClusterIP to endpoints |
| Cilium | Pod networking, IPAM, policy and VXLAN transport between nodes |
| EndpointSlice | current ready backends selected for a Service |

Cilium service-map entries are useful diagnostics, but they do not prove kube-proxy replacement is active. The active `KUBE-SERVICES`, `KUBE-SVC-*` and `KUBE-SEP-*` NAT chains confirmed that kube-proxy implemented ClusterIP translation.

## :material-magnify: Diagnosis

### 1. Compare Kubernetes and Cilium allocation state

```bash
kubectl get nodes \
    -o custom-columns='NAME:.metadata.name,POD_CIDR:.spec.podCIDR,POD_CIDRS:.spec.podCIDRs'

kubectl get ciliumnodes.cilium.io \
    -o jsonpath='{range .items[*]}{.metadata.name}: {.spec.ipam.podCIDRs[*]}{"\n"}{end}'
```

The failure condition is a different per-node CIDR reported by the two APIs.

Inspect active Cilium configuration:

```bash
kubectl get configmap cilium-config \
    --namespace kube-system \
    -o jsonpath='ipam={.data.ipam}{"\n"}kpr={.data.kube-proxy-replacement}{"\n"}routing={.data.routing-mode}{"\n"}'
```

### 2. Verify the service dataplane

Inspect kube-proxy NAT rules for a known Service:

```bash
sudo iptables-save -t nat |
    grep -E 'KUBE-SERVICES|KUBE-SVC-|KUBE-SEP-'
```

The rules are programmed proactively from Service and EndpointSlice state. They are not created by an individual DNS lookup or application request.

### 3. Identify legacy Pod sandboxes

After the IPAM change, list active Pods still using the old range:

```bash
kubectl get pods --all-namespaces --output json |
    jq -r '
      .items[]
      | select((.status.podIP // "") | startswith("<LEGACY_PREFIX>"))
      | [.metadata.namespace, .metadata.name, .status.podIP, .spec.nodeName]
      | @tsv
    '
```

Changing IPAM affects new network sandboxes only. Existing Pods keep their addresses until recreated.

### 4. Inspect faulted Longhorn volumes before mutation

```bash
kubectl get volumes.longhorn.io \
    --namespace longhorn-system \
    -o custom-columns='NAME:.metadata.name,STATE:.status.state,ROBUSTNESS:.status.robustness,NODE:.status.currentNodeID'
```

For each affected volume, inspect replica placement and failure timestamps:

```bash
kubectl get replicas.longhorn.io \
    --namespace longhorn-system \
    --output json |
    jq -r '
      .items[]
      | [
          .spec.volumeName,
          .metadata.name,
          .spec.nodeID,
          .spec.desireState,
          .status.currentState,
          (.spec.failedAt // "-"),
          (.status.instanceManagerName // "-"),
          (.status.ip // "-")
        ]
      | @tsv
    '
```

Do not delete VolumeAttachment or replica resources at this stage. First identify at least one recoverable replica and verify that its data directory exists on disk.

## :material-bug-check-outline: Root cause

The Cilium chart used its default `cluster-pool` IPAM mode. K3s simultaneously populated `Node.spec.podCIDR` from its own cluster CIDR. Cilium therefore allocated Pod addresses independently instead of consuming the Kubernetes-assigned ranges.

During migration, restarted Cilium agents began allocating from `Node.spec.podCIDR`, while existing Pods and Longhorn Instance Managers retained legacy addresses. A node restart killed volume engines and marked some replicas failed. The only replicas not marked failed were still reported through a legacy Instance Manager that was no longer reachable from the migrated network.

Longhorn could not complete detach because replica state remained inconsistent:

```text
desired state: stopped
reported state: running
instance manager: unreachable legacy Pod IP
engine destination: empty address and port
```

## :material-wrench-outline: Corrective action

### 1. Align Cilium with Kubernetes PodCIDRs

Configure the Flux-managed Cilium HelmRelease:

```yaml
values:
  ipam:
    mode: kubernetes
  k8s:
    requireIPv4PodCIDR: true
```

Take an embedded-etcd snapshot and export the relevant Kubernetes, Helm and Cilium state before deployment.

Apply the change through the resource owner. A direct Helm upgrade against a Flux-managed release can conflict with fields owned by `helm-controller`, especially with Server-Side Apply. Suspend the necessary reconciliation layers, update the HelmRelease source of truth, and let the Helm controller perform the upgrade.

Restart Cilium agents after the ConfigMap changes. A ConfigMap data update does not necessarily change the DaemonSet Pod template and therefore may not trigger an automatic rollout.

### 2. Validate new allocation before recycling existing workloads

Create one disposable Pod on each node and verify:

- its address belongs to that node's `Node.spec.podCIDR`;
- cluster DNS resolves through the stable `kube-dns` ClusterIP;
- cross-node Pod communication works through VXLAN;
- the Kubernetes API remains reachable through an independent management path.

### 3. Recycle nodes sequentially

Restart only one node at a time. Before continuing, require:

- the node is `Ready`;
- its Cilium agent reports the expected IPAM range;
- routes contain only the intended PodCIDRs;
- Longhorn volumes have returned to `healthy`.

### 4. Recover an unreachable Longhorn Instance Manager

Before deleting any process Pod:

1. confirm `auto-salvage=true`;
2. confirm replica data directories exist on the affected node;
3. identify every replica and engine handled by the Instance Manager;
4. require affected replicas to have `desiredState=stopped`;
5. require that the Instance Manager handles no active volume engine.

Delete only the stale Instance Manager Pod. If the node-local Longhorn manager also retains a legacy address and fails readiness, recreate only that DaemonSet Pod. The controllers then recreate the Instance Manager using the aligned PodCIDR and reconcile the stale replica state.

Do not manually create an Instance Manager Pod. It is owned by the Longhorn InstanceManager resource.

## :material-check-decagram: Validation

Validate Cilium runtime state on every node:

```bash
kubectl exec \
    --namespace kube-system \
    <CILIUM_POD> \
    --container cilium-agent \
    -- cilium-dbg status --verbose
```

Validate Node and CiliumNode CIDRs:

```bash
kubectl get nodes \
    -o custom-columns='NAME:.metadata.name,POD_CIDR:.spec.podCIDR'

kubectl get ciliumnodes.cilium.io \
    -o jsonpath='{range .items[*]}{.metadata.name}: {.spec.ipam.podCIDRs[*]}{"\n"}{end}'
```

Validate Longhorn:

```bash
kubectl get volumes.longhorn.io \
    --namespace longhorn-system \
    -o custom-columns='NAME:.metadata.name,STATE:.status.state,ROBUSTNESS:.status.robustness,NODE:.status.currentNodeID'
```

The verified final state was:

- all Kubernetes Nodes were `Ready` and schedulable;
- Cilium used Kubernetes IPAM and consumed the Node PodCIDRs;
- no active Pod retained an address from the legacy pool;
- CoreDNS and Service resolution worked from all nodes;
- every Longhorn volume was `attached/healthy`;
- all Flux Kustomizations converged on the merged `main` revision;
- the Cilium HelmRelease and active ConfigMap matched the Git declaration.

Longhorn temporarily reported `attached/degraded` after a node restart. This meant the volume remained available with reduced redundancy. After the configured replica replenishment delay, replacement replicas were built and the volumes returned to `healthy`.

## :material-shield-check-outline: Prevention

- define one authoritative Pod CIDR allocation model;
- compare `Node.spec.podCIDR` and CiliumNode allocation after CNI installation;
- avoid broad Pod pools that overlap other private networks;
- test new IP allocation with disposable Pods before recycling existing workloads;
- restart nodes sequentially and wait for storage redundancy before continuing;
- preserve an API and SSH management path independent of the Pod network;
- inspect replica state and on-disk data before forcing salvage or deleting attachments;
- operate Flux-managed Helm releases through their HelmRelease source of truth;
- merge the desired state into the branch observed by Flux before resuming reconciliation.

## :fontawesome-solid-book: Related documents

- [Kubernetes networking](../kubernetes/02-networking.md)
- [Kubernetes storage](../kubernetes/04-storage.md)
- [Kubernetes GitOps](../kubernetes/05-gitops.md)
- [Kubernetes observability](../kubernetes/07-observability.md)
