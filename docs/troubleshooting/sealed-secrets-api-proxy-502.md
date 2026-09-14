# :material-key-alert: Sealed Secrets API proxy returns intermittent 502

`kubeseal --fetch-cert` and `kubeseal --validate` intermittently returned
`502 Bad Gateway` although the controller, Service and EndpointSlice were ready.
The result depended on which k3s API server HAProxy selected.

## :material-alert-outline: Symptoms

- the controller Pod was ready with zero restarts;
- all live SealedSecrets reported `Synced=True`;
- repeated client requests alternated between success and proxy errors;
- repository validation mixed successful results with transport failures;
- only the node hosting the controller reached its Pod directly.

A cryptographic validation failure is deterministic. Mixed results for unchanged
manifests indicate a transport path problem.

## :material-map-marker-path: Request path

```text
kubeseal
→ HAProxy:6443
→ one of three k3s API servers
→ Kubernetes API proxy
→ sealed-secrets-controller Pod:8080
```

For a cross-node final hop, Cilium classifies the API server source as
`remote-node`.

## :material-magnify: Diagnosis

Verify the Deployment, Service and EndpointSlice, then test the Pod endpoint from every
node. A success only on the local node isolates the failure to cross-node ingress.

Confirm Cilium health before changing policy:

```bash
kubectl get pods --namespace kube-system --selector k8s-app=cilium
kubectl -n kube-system exec ds/cilium -c cilium-agent -- cilium-dbg status --brief
```

A healthy overlay does not prove that policy permits the application flow. Observe
drops on the node hosting the controller:

```bash
kubectl exec --namespace kube-system <CILIUM_POD> -c cilium-agent -- \
  hubble observe --since 2m --to-ip <CONTROLLER_POD_IP> \
  --verdict DROPPED --output compact
```

The decisive event was:

```text
remote-node -> sealed-secrets-controller:8080 Policy denied DROPPED
```

## :material-bug-check-outline: Root cause

Generated Flux policies allowed Pods in `flux-system` and Pod sources from all
namespaces on `8080/TCP` for scraping. Kubernetes Pod and namespace selectors do not
match Cilium's `remote-node` identity.

HAProxy distributes requests among all control-plane nodes. The request succeeded when
the chosen API server was local to the controller Pod and failed on a cross-node proxy
hop. A rollout changed Pod placement and exposed the pre-existing gap.

## :material-wrench-outline: Corrective action

Add this policy to the Sealed Secrets Flux Kustomization:

```yaml
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: sealed-secrets-allow-api-server-proxy
  namespace: flux-system
spec:
  endpointSelector:
    matchLabels:
      app.kubernetes.io/instance: sealed-secrets-controller
      app.kubernetes.io/name: sealed-secrets
  ingress:
    - fromEntities:
        - remote-node
      toPorts:
        - ports:
            - port: "8080"
              protocol: TCP
```

Do not edit generated `gotk-components.yaml`. Hubble observed `remote-node`
directly; `kube-apiserver` would not match this k3s path.

## :material-shield-check-outline: Security impact

| Dimension | Allowed scope |
|---|---|
| Source | Cilium `remote-node` entity |
| Namespace | `flux-system` |
| Workload | controller labels only |
| Port | `8080/TCP` |

The rule does not allow LAN or Internet sources, select other Flux workloads or open
other ports. Existing `allow-scraping` already permits Pod sources from every
namespace on port 8080. This adds only the node-originated API proxy path. All three
nodes are also control-plane and etcd members, so compromising one already grants much
broader authority.

## :material-check-decagram: Validation

Require all of the following:

- the CiliumNetworkPolicy reports `Valid=True`;
- every node receives HTTP 200 from `/v1/cert.pem`;
- repeated `kubeseal --fetch-cert` calls return one fingerprint;
- every repository `*-sealed.yaml` passes `kubeseal --validate`;
- every live SealedSecret remains `Synced=True`;
- Hubble records no further drops to the controller;
- Flux converges on the expected revisions.

## :material-shield-check-outline: Prevention

- repeat API-proxy tests when an external load balancer fronts multiple API servers;
- distinguish intermittent transport errors from deterministic crypto failures;
- inspect Hubble verdicts before adding firewall or network exceptions;
- scope policy exceptions by source identity, destination labels and port;
- revalidate the repository after controller upgrades or Pod relocation.

## :fontawesome-solid-book: Related documents

- [Kubernetes networking](../kubernetes/02-networking.md)
- [Kubernetes security](../kubernetes/06-security.md)
- [Kubernetes backup](../kubernetes/08-backup.md)
- [Kubernetes GitOps](../kubernetes/05-gitops.md)

