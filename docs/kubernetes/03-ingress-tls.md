# Ingress & TLS

Traefik is the ingress controller (ships with k3s), cert-manager handles automatic TLS certificate issuance via Let's Encrypt.

---

## Traefik

Traefik is a reverse proxy and L7 ingress controller. It receives traffic from HAProxy (already past the load balancer layer), matches hostnames and paths against Ingress/IngressRoute rules, and forwards to the appropriate Service.

```
HAProxy (L4, TCP passthrough)
      │
      ▼
Traefik (L7, Ingress Controller)
      │
      ├── nginx.cluster.kcn333.com → Service: nginx → Pods
      ├── grafana.cluster.kcn333.com → Service: grafana → Pods
      └── clients-api.cluster.kcn333.com → Service: clients-api → Pods
```

### klipper-lb (svclb-traefik)

k3s ships with a DaemonSet called `klipper-lb` that simulates a cloud LoadBalancer on bare metal. Without it, a Service of type `LoadBalancer` would sit in `<pending>` forever. It works via iptables rules on each node.

### Configuring Traefik in k3s

k3s manages Traefik through its own Helm mechanism. **Don't edit Traefik's config directly** — k3s will overwrite it. Use a `HelmChartConfig` resource instead:

```yaml
apiVersion: helm.cattle.io/v1
kind: HelmChartConfig
metadata:
  name: traefik        # must match the HelmChart name exactly
  namespace: kube-system
spec:
  valuesContent: |-
    ports:
      web:
        redirections:
          entryPoint:
            to: websecure
            scheme: https
            permanent: true
    api:
      dashboard: true
```

Apply and verify:
```bash
kubectl apply -f helmchartconfig-traefik.yaml
kubectl get helmchartconfig -n kube-system
helm get values traefik -n kube-system
```

### Traefik v2 vs v3 breaking change

The HTTP→HTTPS redirect config changed between versions:

| Version | Config key |
|---------|-----------|
| v2 | `redirectTo.port: websecure` |
| v3 | `redirections.entryPoint.to: websecure` |

Traefik v3 silently ignores unknown config fields — no error in logs. Always check the version and reference the correct docs.

### Traefik Dashboard with BasicAuth

The dashboard needs an IngressRoute (not a standard Ingress) since it points to `api@internal`, a Traefik internal service.

**Generate password hash:**
```bash
sudo apt install apache2-utils
htpasswd -nb admin your-password
# Output: admin:$apr1$xxxxx$yyyyyyy
```

Store the hash as a SealedSecret (see [security/sealed-secrets.md](../06-security.md)).

**Middleware:**
```yaml
apiVersion: traefik.io/v1alpha1
kind: Middleware
metadata:
  name: traefik-dashboard-auth
  namespace: traefik
spec:
  basicAuth:
    secret: traefik-dashboard-auth
```

**IngressRoute:**
```yaml
apiVersion: traefik.io/v1alpha1
kind: IngressRoute
metadata:
  name: traefik-dashboard
  namespace: traefik
spec:
  entryPoints:
    - websecure
  routes:
    - match: Host(`traefik.cluster.kcn333.com`)
      kind: Rule
      middlewares:
        - name: traefik-dashboard-auth
          namespace: traefik
      services:
        - name: api@internal
          kind: TraefikService
  tls:
    secretName: traefik-dashboard-tls
```

### Minimal Ingress

The three things needed for a working Ingress:

1. **Deployment** — pods with the app
2. **Service** — with a correct selector pointing to the pods
3. **Ingress** — with correct `ingressClassName`

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: my-ingress
  annotations:
    traefik.ingress.kubernetes.io/ssl-redirect: "true"
spec:
  ingressClassName: traefik
  tls:
  - hosts:
    - app.cluster.kcn333.com
    secretName: local-prod-kcn333-tls    # Secret name, not Certificate name!
  rules:
  - host: app.cluster.kcn333.com
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: my-service
            port:
              number: 80
```

### Common debugging pitfall

**Empty Endpoints = 503** — if a Service has no endpoints, traffic goes nowhere.

```bash
kubectl get endpoints <svc-name>
```

Empty endpoints means the Service selector doesn't match any pod labels.

- `kubectl expose deployment nginx` — copies selector automatically ✅
- `kubectl create svc` — you have to add the selector manually

### Temporary access without Ingress

```bash
kubectl port-forward -n kube-system deployment/traefik 9000:9000
# → http://localhost:9000/dashboard/
```

---

## cert-manager

cert-manager automates TLS certificate issuance and renewal. It integrates with Let's Encrypt and handles the entire ACME challenge flow — you just declare what certificate you want and it handles the rest, including renewals (auto-renews at 1/3 of remaining validity).

### Installation via Helm

```bash
helm repo add jetstack https://charts.jetstack.io
helm repo update

helm install cert-manager jetstack/cert-manager \
  -n cert-manager \
  --create-namespace \
  --set crds.enabled=true
```

`crds.enabled=true` installs the CRDs that define the `Certificate`, `ClusterIssuer`, etc. resource types. Without these, k8s doesn't know what those objects are.

cert-manager runs 3 pods:
- `cert-manager` — main controller, manages certificate lifecycle
- `cert-manager-cainjector` — injects CA into k8s webhooks
- `cert-manager-webhook` — validates cert-manager resources on creation

None of these need replicas for HA — cert-manager isn't in the critical path for serving user traffic.

### Issuer vs ClusterIssuer

| | Issuer | ClusterIssuer |
|-|--------|---------------|
| Scope | Single namespace | Whole cluster |
| When to use | Per-team isolation | Shared CA for everything |

In a homelab, always use `ClusterIssuer`. It's cluster-scoped (like `Node` or `PV`) — no `-n` flag needed when applying.

### Let's Encrypt staging vs production

**Always test with staging first.** Production has rate limits: max 5 certificates per domain per week. Staging has no limits but the certs aren't trusted by browsers.

```yaml
# Staging
server: https://acme-staging-v02.api.letsencrypt.org/directory

# Production
server: https://acme-v02.api.letsencrypt.org/directory
```

### DNS-01 Challenge — certificates without exposing the cluster

**HTTP-01**: Let's Encrypt visits `http://yourdomain.com/.well-known/acme-challenge/...` — the server must be accessible from the internet.

**DNS-01**: Let's Encrypt checks a TXT record `_acme-challenge.yourdomain.com` in public DNS — **the cluster doesn't need to be reachable from the internet.**

Flow with Cloudflare:

1. cert-manager requests a certificate
2. Uses Cloudflare API to add `TXT _acme-challenge.cluster.kcn333.com`
3. Let's Encrypt verifies the TXT record
4. cert-manager removes the TXT record
5. Certificate issued → stored as a Secret in k8s

### Cloudflare API Token

Create a token with **minimum permissions** (principle of least privilege):

- `Zone | DNS | Edit`
- `Zone | Zone | Read`
- Zone Resources: Specific zone (your domain only)

**Don't use** the Global API Key — it has way too broad access.

Store the token as a Secret in `cert-manager` namespace:

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: cloudflare-token
  namespace: cert-manager
type: Opaque
stringData:
  api-token: <your-token>
```

In production, use Sealed Secrets so this can be committed to Git safely.

### ClusterIssuer

```yaml
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-prod-cluster-issuer
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: your@email.com
    privateKeySecretRef:
      name: letsencrypt-prod-cluster-issuer
    solvers:
    - dns01:
        cloudflare:
          apiTokenSecretRef:
            name: cloudflare-token
            key: api-token
```

### Certificate resource

```yaml
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: local-prod-cert
  namespace: flux-test
spec:
  secretName: local-prod-kcn333-tls      # name of the Secret to create
  commonName: "*.cluster.kcn333.com"
  dnsNames:
    - "cluster.kcn333.com"
    - "*.cluster.kcn333.com"             # wildcard for all subdomains
  issuerRef:
    name: letsencrypt-prod-cluster-issuer
    kind: ClusterIssuer
```

> ⚠️ Common mistake: referencing the Certificate name in Ingress `secretName` instead of the Secret name. Traefik needs the Secret name.

### Certificate per namespace

If you have an IngressRoute in a namespace other than `default`, create a Certificate resource in that namespace. cert-manager creates the Secret directly in the same namespace as the Certificate.

```yaml
metadata:
  name: traefik-dashboard-tls
  namespace: traefik   # ← cert-manager creates the Secret here
```

### cert-manager resource flow

```
ClusterIssuer → Certificate → CertificateRequest → Order → Challenge → Secret (TLS)
```

### Debugging

```bash
kubectl describe certificate <name>
kubectl get certificaterequest
kubectl get orders
kubectl get challenges
kubectl describe clusterissuer <name>
```

Check what certificate the server is actually serving:
```bash
echo | openssl s_client -connect domain.com:443 2>/dev/null | \
  openssl x509 -text -noout | grep -A2 "Issuer\|Subject\|Validity"

# Staging: Issuer contains "(STAGING)"
# Production: Issuer: C=US, O=Let's Encrypt, CN=R10/R11/R12
```
