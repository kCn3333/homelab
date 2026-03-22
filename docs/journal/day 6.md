# 07 - Sealed Secrets + Longhorn

# K3s Homelab — Sesja 06

**Data:** 2026-03-04  
**Środowisko:** 3x HP T630, k3s v1.34.4, Flux v2.8.1

---

## Co zbudowaliśmy

- Sealed Secrets — bezpieczne przechowywanie sekretów w Git
- Longhorn — distributed block storage z RWX
- PVC dla nginx — strona HTML serwowana z Longhorn volume
- Traefik dashboard z BasicAuth i TLS

---

## Czego się nauczyłem

### 1. Sealed Secrets

**Problem który rozwiązuje:** Kubernetes Secrets w plaintext nie mogą być bezpiecznie trzymane w Git. Sealed Secrets szyfruje je kluczem publicznym klastra — tylko klaster może je odszyfrować.

**Jak działa:**

```
Klucz prywatny → zostaje w klastrze (Secret w flux-system)
Klucz publiczny → pobierasz lokalnie, używasz do szyfrowania
SealedSecret → zaszyfrowany blob, bezpieczny w Git
       ↓
Sealed Secrets controller odszyfrowuje → tworzy prawdziwy Secret
```

**Instalacja przez Flux HelmRelease:**

```yaml
# apps/base/sealed-secrets/helmrepository.yaml
apiVersion: source.toolkit.fluxcd.io/v1
kind: HelmRepository
metadata:
  name: sealed-secrets
  namespace: flux-system
spec:
  interval: 1h
  url: https://bitnami-labs.github.io/sealed-secrets

# apps/base/sealed-secrets/helmrelease.yaml
apiVersion: helm.toolkit.fluxcd.io/v2
kind: HelmRelease
metadata:
  name: sealed-secrets
  namespace: flux-system
spec:
  chart:
    spec:
      chart: sealed-secrets
      sourceRef:
        kind: HelmRepository
        name: sealed-secrets
      version: ">=1.15.0-0"
  interval: 1h0m0s
  releaseName: sealed-secrets-controller
  targetNamespace: flux-system
  install:
    crds: Create
  upgrade:
    crds: CreateReplace
```

**Instalacja kubeseal CLI:**

```bash
curl -OL "https://github.com/bitnami-labs/sealed-secrets/releases/download/v0.36.0/kubeseal-0.36.0-linux-amd64.tar.gz"
tar -xvzf kubeseal-0.36.0-linux-amd64.tar.gz kubeseal
sudo install -m 755 kubeseal /usr/local/bin/kubeseal
```

**Pobranie klucza publicznego:**

```bash
kubeseal --fetch-cert \
  --controller-name=sealed-secrets-controller \
  --controller-namespace=flux-system \
  > ~/.config/kubeseal/pub-sealed-secrets.pem
```

**Szyfrowanie Secretu:**

```bash
# Stwórz suchy manifest
kubectl create secret generic <nazwa> \
  --namespace <namespace> \
  --from-literal=klucz=wartość \
  --dry-run=client \
  -o yaml > /tmp/secret.yaml

# Zaszyfruj
kubeseal --format yaml \
  --cert ~/.config/kubeseal/pub-sealed-secrets.pem \
  < /tmp/secret.yaml \
  > apps/base/<app>/secret-sealed.yaml
```

**Ważne:**

- `HelmRepository` dla Sealed Secrets musi być w namespace `flux-system`
- Sealed Secrets controller ma `ClusterRole` — może tworzyć Sekrety w dowolnym namespace
- Jeśli Secret już istnieje i nie jest zarządzany przez SealedSecret → usuń go ręcznie, controller odtworzy go automatycznie
- Nie commituj `pub-sealed-secrets.pem` do repo — trzymaj poza katalogiem Git

**Które Sekrety warto zapieczętować:**

- Tokeny API (Cloudflare, GitHub, etc.) ✅
- Hasła do dashboardów ✅
- Certyfikaty TLS zarządzane przez cert-manager — **nie trzeba**, cert-manager regeneruje je automatycznie

---

### 2. Longhorn — Distributed Block Storage

**Co to jest:** Distributed storage dla Kubernetes — tworzy repliki danych między nodami. Jeśli jeden node padnie, dane są dostępne na pozostałych.

**Wymagania systemowe (przez Ansible):**

```yaml
- open-iscsi      # iSCSI initiator
- nfs-common      # klient NFS (potrzebny dla RWX)
- util-linux      # narzędzia systemowe
- grep, sed, curl # narzędzia pomocnicze
```

```bash
sudo systemctl enable --now iscsid
```

**Instalacja przez Flux:**

```yaml
# apps/base/longhorn/helmrepo.yaml
apiVersion: source.toolkit.fluxcd.io/v1
kind: HelmRepository
metadata:
  name: longhorn-repo
  namespace: flux-system
spec:
  interval: 1m0s
  url: https://charts.longhorn.io

# apps/base/longhorn/helmrelease.yaml
apiVersion: helm.toolkit.fluxcd.io/v2
kind: HelmRelease
metadata:
  name: longhorn-release
  namespace: longhorn-system
spec:
  chart:
    spec:
      chart: longhorn
      sourceRef:
        kind: HelmRepository
        name: longhorn-repo
        namespace: flux-system
      version: v1.11.0
  interval: 1m0s
  values:
    persistence:
      defaultClassReplicaCount: 2
      rwoPolicy: cluster-scope
    nfsOptions: "vers=4.1,noresvport"
```

**StorageClass dla RWX:**

```yaml
# apps/base/longhorn/storageclass-rwx.yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: longhorn-rwx
provisioner: driver.longhorn.io
allowVolumeExpansion: true
reclaimPolicy: Delete
volumeBindingMode: Immediate
parameters:
  numberOfReplicas: "2"
  staleReplicaTimeout: "30"
  fsType: "ext4"
  dataEngine: "v1"
  accessMode: "ReadWriteMany"
  nfsOptions: "vers=4.1,noresvport"
```

**Usunięcie podwójnego default StorageClass:**

```bash
kubectl patch storageclass local-path \
  -p '{"metadata": {"annotations":{"storageclass.kubernetes.io/is-default-class":"false"}}}'
```

Utrwalone przez manifest w Git:

```yaml
# apps/base/longhorn/local-path-not-default.yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: local-path
  annotations:
    storageclass.kubernetes.io/is-default-class: "false"
provisioner: rancher.io/local-path
reclaimPolicy: Delete
volumeBindingMode: WaitForFirstConsumer
```

**Dynamic Provisioning:** Longhorn automatycznie tworzy PV gdy powstaje PVC — nie trzeba ręcznie tworzyć PV. StorageClass działa jako provisioner.

```
Developer tworzy PVC
       ↓
StorageClass (Longhorn) automatycznie tworzy PV
       ↓
Longhorn tworzy fizyczny wolumen z replikami na nodach
```

**AccessModes:**

- `ReadWriteOnce` (RWO) — jeden pod, jeden node
- `ReadWriteMany` (RWX) — wiele podów, wiele nodów (wymaga NFS share)

Longhorn tworzy wewnętrzny serwer NFS (`share-manager` pod) dla wolumenów RWX.

---

### 3. PersistentVolume / PersistentVolumeClaim

**PVC w manifeście aplikacji:**

```yaml
# W tym samym pliku co Deployment
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: nginx-pvc
  namespace: flux-test
spec:
  storageClassName: longhorn-rwx
  accessModes:
    - ReadWriteMany
  resources:
    requests:
      storage: 10Mi
```

**Mount w Deployment:**

```yaml
spec:
  template:
    spec:
      volumes:
      - name: nginx-data
        persistentVolumeClaim:
          claimName: nginx-pvc
      containers:
      - name: nginx
        volumeMounts:
          - name: nginx-data
            mountPath: /usr/share/nginx/html
```

**Sposoby zasilania PVC danymi:**

|Metoda|Kiedy używać|
|---|---|
|`kubectl cp`|Debugowanie, jednorazowe testy|
|InitContainer|Statyczne pliki z obrazu Docker|
|Job|Migracje baz danych, seed danych|
|Aplikacja bezpośrednio|Dynamiczne dane (uploady, bazy)|
|CI/CD pipeline|Automatyczna aktualizacja zawartości|

**InitContainer (produkcyjne podejście):**

```yaml
initContainers:
- name: copy-content
  image: twoj-obraz-z-html:1.0
  command: ['cp', '-r', '/app/html/.', '/usr/share/nginx/html/']
  volumeMounts:
  - name: nginx-data
    mountPath: /usr/share/nginx/html
```

---

### 4. Traefik Dashboard z BasicAuth

**Komponenty:**

1. `Certificate` — TLS cert od cert-manager w odpowiednim namespace
2. `SealedSecret` — zaszyfrowane hasło BasicAuth
3. `Middleware` — definicja BasicAuth
4. `IngressRoute` — reguła routingu do dashboardu

**Generowanie hasła htpasswd:**

```bash
sudo apt install apache2-utils
htpasswd -nb admin twoje-haslo
# Output: admin:$apr1$xxxxx$yyyyyyy
```

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

**Certificate w osobnym namespace:** Gdy IngressRoute jest w innym namespace niż `default`, trzeba stworzyć osobny Certificate — cert-manager stworzy Secret bezpośrednio w tym namespace:

```yaml
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: traefik-dashboard-tls
  namespace: traefik
spec:
  secretName: traefik-dashboard-tls
  dnsNames:
    - traefik.cluster.kcn333.com
  issuerRef:
    name: letsencrypt-prod-cluster-issuer
    kind: ClusterIssuer
```

**Włączenie dashboardu w HelmChartConfig:**

```yaml
apiVersion: helm.cattle.io/v1
kind: HelmChartConfig
metadata:
  name: traefik
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

---

### 5. HelmRepository — ważna zasada

`HelmRepository` zawsze w namespace `flux-system` — niezależnie gdzie instalujesz aplikację. Flux source-controller działa w `flux-system` i tam szuka źródeł.

W `HelmRelease` dodaj referencję z namespace:

```yaml
sourceRef:
  kind: HelmRepository
  name: longhorn-repo
  namespace: flux-system  # ← ważne!
```

---

### 6. Flux generator — przydatne komendy

Zamiast pisać YAML ręcznie:

```bash
# Generuj HelmRepository
flux create source helm <nazwa> \
  --url=<url> \
  --namespace=flux-system \
  --export > helmrepo.yaml

# Generuj HelmRelease
flux create helmrelease <nazwa> \
  --chart=<chart> \
  --source=HelmRepository/<nazwa> \
  --chart-version=<wersja> \
  --namespace=<namespace> \
  --export > helmrelease.yaml
```

---

## Finalna struktura repo

```
k3s-homelab/
├── README.md
├── apps/
│   ├── base/
│   │   ├── kustomization.yaml
│   │   ├── longhorn/
│   │   │   ├── helmrelease.yaml
│   │   │   ├── helmrepo.yaml
│   │   │   ├── kustomization.yaml
│   │   │   ├── local-path-not-default.yaml
│   │   │   ├── namespace.yaml
│   │   │   └── storageclass-rwx.yaml
│   │   ├── nginx/
│   │   │   ├── imagepolicy.yaml
│   │   │   ├── imagerepository.yaml
│   │   │   ├── kustomization.yaml
│   │   │   ├── namespace.yaml
│   │   │   └── nginx-deploy.yaml
│   │   ├── sealed-secrets/
│   │   │   ├── cloudflare-token-sealed.yaml
│   │   │   ├── helmrelease.yaml
│   │   │   ├── helmrepository.yaml
│   │   │   └── kustomization.yaml
│   │   └── traefik-dashboard/
│   │       ├── certificate.yaml
│   │       ├── ingressroute.yaml
│   │       ├── kustomization.yaml
│   │       ├── middleware.yaml
│   │       ├── namespace.yaml
│   │       └── traefik-auth-sealed.yaml
│   └── kustomization.yaml
└── clusters/
    └── k3s-homelab/
        ├── apps.yaml
        ├── helmchartconfig-traefik.yaml
        ├── image-update-automation.yaml
        └── flux-system/
            ├── gotk-components.yaml
            ├── gotk-sync.yaml
            └── kustomization.yaml
```

---

## Backlog (do zrobienia)

- [ ] **Własna aplikacja (Spring Boot) + CI/CD pipeline z GitHub Actions** ← następny krok
- [ ] InitContainer — zasilanie PVC z obrazu Docker
- [ ] Helm charts dla własnych aplikacji
- [ ] Progressive delivery (staging/production branches)
- [ ] External-dns — automatyczne wpisy DNS z Ingress
- [ ] HashiCorp Vault w kontenerze
- [ ] ArgoCD — porównanie z Flux
- [ ] NetworkPolicy dla izolacji między aplikacjami
- [ ] RBAC — własni użytkownicy

---

## Przydatne komendy

```bash
# Sealed Secrets
kubeseal --fetch-cert \
  --controller-name=sealed-secrets-controller \
  --controller-namespace=flux-system \
  > ~/.config/kubeseal/pub-sealed-secrets.pem

kubeseal --format yaml \
  --cert ~/.config/kubeseal/pub-sealed-secrets.pem \
  < secret.yaml > sealed-secret.yaml

kubectl get sealedsecret -A

# Longhorn
kubectl get storageclass
kubectl get pvc -A
kubectl get pv

# Traefik
kubectl get ingressroute -A
kubectl get middleware -A
kubectl logs -n kube-system deployment/traefik | grep ERR

# Flux
flux get helmreleases -A
flux reconcile kustomization apps
flux reconcile helmrelease <nazwa> -n <namespace>
```