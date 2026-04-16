# 8 - Monitoring

# K3s Homelab — Sesja 08

**Data:** 2026-02-03  
**Środowisko:** 3x HP T630, k3s v1.34.4, Flux v2.8.1, Cilium v1.19.1

---

### Cel sesji:

- kube-prometheus-stack v82.10.1 (Prometheus + Grafana + AlertManager + node-exporter)
- Grafana dostępna przez Ingress z TLS: `grafana.cluster.kcn333.com`
- Dane Prometheusa na Longhorn PVC (10Gi)
- Hasło Grafany przez SealedSecret
- Pełne metryki klastra — wszystkie 3 nody widoczne w Grafanie

---

### 1. kube-prometheus-stack — instalacja przez Flux

Jeden Helm chart instaluje cały stack:

- **Prometheus** — zbiera metryki
- **Grafana** — wizualizacja
- **AlertManager** — alerty
- **node-exporter** — metryki nodów (DaemonSet na każdym nodzie)
- **kube-state-metrics** — metryki obiektów Kubernetes

```yaml
# apps/base/monitoring/helmrepository.yaml
apiVersion: source.toolkit.fluxcd.io/v1
kind: HelmRepository
metadata:
  name: prometheus-community
  namespace: flux-system
spec:
  interval: 1h
  url: https://prometheus-community.github.io/helm-charts
```

```yaml
# apps/base/monitoring/helmrelease.yaml
apiVersion: helm.toolkit.fluxcd.io/v2
kind: HelmRelease
metadata:
  name: kube-prometheus-stack
  namespace: monitoring
spec:
  interval: 30m
  chart:
    spec:
      chart: kube-prometheus-stack
      version: "82.10.1"
      sourceRef:
        kind: HelmRepository
        name: prometheus-community
        namespace: flux-system
      interval: 12h
  install:
    createNamespace: true
  upgrade:
    remediation:
      retries: 3
  values:
    kubeControllerManager:
      enabled: false
    kubeScheduler:
      enabled: false
    kubeEtcd:
      enabled: false
    kubeProxy:
      enabled: false  # Cilium zastąpił kube-proxy
    kubelet:
      enabled: true
      serviceMonitor:
        https: true
        insecureSkipVerify: true
        cAdvisor: true
    grafana:
      enabled: true
      admin:
        existingSecret: grafana-admin-secret
        userKey: admin-user
        passwordKey: admin-password
      ingress:
        enabled: true
        ingressClassName: traefik
        annotations:
          traefik.ingress.kubernetes.io/ssl-redirect: "true"
        hosts:
          - grafana.cluster.kcn333.com
        tls:
          - secretName: grafana-tls
            hosts:
              - grafana.cluster.kcn333.com
    prometheus:
      prometheusSpec:
        hostNetwork: true   # ← kluczowe dla k3s!
        hostPID: true
        retention: 7d
        storageSpec:
          volumeClaimTemplate:
            spec:
              storageClassName: longhorn
              accessModes: ["ReadWriteOnce"]
              resources:
                requests:
                  storage: 10Gi
```

---

### 2. Wyłączone komponenty k3s

k3s nie uruchamia niektórych komponentów w standardowej formie — wyłącz je żeby uniknąć błędów scrape'owania:

|Komponent|Dlaczego wyłączony|
|---|---|
|`kubeControllerManager`|k3s ma wbudowany, nie wystawia standardowego endpointu|
|`kubeScheduler`|j.w.|
|`kubeEtcd`|embedded etcd, inny port|
|`kubeProxy`|zastąpiony przez Cilium eBPF|

---

### 3. Problem: No data w Grafanie — Cilium blokuje pod → node IP

**Objaw:** Dashboardy `Kubernetes / Compute Resources` pokazują `No data` dla CPU/Memory Utilisation.

**Diagnoza:**

```bash
# Test z poda Prometheusa
kubectl -n monitoring exec -it prometheus-kube-prometheus-stack-prometheus-0 -- \
  wget -qO- --no-check-certificate https://192.168.55.10:10250/healthz
# → Connection refused

# Ale internet działa:
kubectl -n monitoring exec -it prometheus-kube-prometheus-stack-prometheus-0 -- \
  wget -qO- https://8.8.8.8 | head -3
# → OK

# Routing w podzie:
kubectl -n monitoring exec -it prometheus-kube-prometheus-stack-prometheus-0 -- ip route show
# → default via 10.0.2.209 dev eth0
# Brak trasy do 192.168.55.0/24!
```

**Root cause:** Cilium domyślnie nie routuje ruchu z podów do node IP (`192.168.55.x`). Pod widzi tylko sieć podów (`10.0.0.0/16`).

**Złe podejście**:

```yaml
# NIE rób — otwiera zbyt wiele
hostServices:
  enabled: true
autoDirectNodeRoutes: true
bpf:
  hostLegacyRouting: true
```

**Właściwe rozwiązanie — `hostNetwork: true` dla Prometheusa:**

```yaml
prometheus:
  prometheusSpec:
    hostNetwork: true
    hostPID: true
```

Prometheus działa wtedy na sieci hosta (node), ma bezpośredni dostęp do kubelet na `10250` i node-exporter na `9100`. Zero zmian w Cilium.

**Dlaczego to jest bezpieczne?**

- Tylko Prometheus ma `hostNetwork: true` — nie cały klaster
- Prometheus to zaufany komponent infrastruktury
- Standardowe podejście dla k3s w dokumentacji kube-prometheus-stack

---

### 4. Problem: UFW blokuje port 9100 między nodami

**Objaw:** Node Exporter / Nodes w Grafanie pokazywał tylko 1 node (worker2 — ten na którym działał Prometheus).

**Diagnoza:**

```bash
# worker2 działa (Prometheus jest na tym samym nodzie)
wget -qO- http://192.168.55.12:9100/metrics | head -3  # OK

# master i worker1 nie odpowiadają
wget -qO- http://192.168.55.10:9100/metrics | head -3  # timeout
wget -qO- http://192.168.55.11:9100/metrics | head -3  # timeout
```

**Root cause:** UFW nie miał reguły dla portu 9100. Prometheus z `hostNetwork: true` wychodzi z IP noda (`192.168.55.12`) i próbuje dotrzeć do innych nodów — UFW blokuje.

**Rozwiązanie:**

```bash
ansible all -m shell -a "ufw allow from 192.168.55.0/24 to any port 9100" -b
```

Zaktualizuj Ansible playbook UFW:

```yaml
- rule: allow
  from_ip: 192.168.55.0/24
  port: '9100'
  proto: tcp
```

---

### 5. Hasło Grafany przez SealedSecret

```bash
kubectl create secret generic grafana-admin-secret \
  --namespace monitoring \
  --from-literal=admin-user=admin \
  --from-literal=admin-password=TWOJE-HASLO \
  --dry-run=client -o yaml | \
kubeseal --format yaml \
  --cert ~/.config/kubeseal/pub-sealed-secrets.pem \
  > apps/base/monitoring/grafana-secret-sealed.yaml
```

W HelmRelease odwołaj się do Secretu:

```yaml
grafana:
  admin:
    existingSecret: grafana-admin-secret
    userKey: admin-user
    passwordKey: admin-password
```

---

### 6. Certyfikat TLS dla Grafany

```yaml
# apps/base/monitoring/certificate.yaml
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: grafana-tls
  namespace: monitoring
spec:
  secretName: grafana-tls        # musi zgadzać się z Ingress TLS secretName
  dnsNames:
    - grafana.cluster.kcn333.com
  issuerRef:
    name: letsencrypt-prod-cluster-issuer
    kind: ClusterIssuer
```

⚠️ Uwaga: `secretName` w Certificate to certyfikat TLS — nie mylić z `grafana-admin-secret` który trzyma hasło!

---

### 7. Admission webhook — CrashLoopBackOff przy upgrade

Podczas `flux reconcile` HelmRelease kube-prometheus-stack pojawia się Job `admission-patch` który crashuje przez chwilę. To normalne — webhook musi poczekać na stabilizację operatora.

**Rozwiązanie:** Poczekaj — samo się naprawia po 1-2 minutach. Nie panikuj. 🙂

---

## Struktura plików monitoringu

```
apps/base/monitoring/
├── namespace.yaml
├── helmrepository.yaml
├── helmrelease.yaml
├── certificate.yaml
├── grafana-secret-sealed.yaml
└── kustomization.yaml
```

---

## Przydatne dashboardy Grafana

|Dashboard|Ścieżka|Co pokazuje|
|---|---|---|
|Cluster overview|Kubernetes / Compute Resources / Cluster|CPU/RAM całego klastra|
|Per node|Node Exporter / Nodes|CPU, RAM, dysk, sieć per node|
|Per namespace|Kubernetes / Compute Resources / Namespace|Zużycie per namespace|
|Per pod|Kubernetes / Compute Resources / Pod|Zużycie per pod|
|Prometheus|Prometheus / Overview|Metryki samego Prometheusa|

---

## Finalne zużycie zasobów klastra

|Metryka|Wartość|
|---|---|
|CPU Utilisation|~20%|
|CPU Requests Commitment|18.3%|
|CPU Limits Commitment|50%|
|Memory Utilisation|~49%|
|Memory Requests Commitment|3.16%|
|Memory Limits Commitment|27.5%|

---

## Backlog (do zrobienia)

- [ ] **AlertManager** — skonfigurować alerty (np. node down, high CPU)
- [ ] **Hubble UI** — Cilium network observability
- [ ] NetworkPolicy — izolacja między podami
- [ ] Własna aplikacja (Spring Boot) + CI/CD pipeline
- [ ] HashiCorp Vault
- [ ] External-dns
- [ ] Progressive delivery (staging/production)
- [ ] RBAC

---

## Przydatne komendy

```bash
# Status monitoringu
kubectl get pods -n monitoring
flux get helmrelease kube-prometheus-stack -n monitoring

# Test node-exporter
kubectl -n monitoring exec -it prometheus-kube-prometheus-stack-prometheus-0 -- \
  wget -qO- http://192.168.55.10:9100/metrics | head -5

# Test kubelet
kubectl -n monitoring exec -it prometheus-kube-prometheus-stack-prometheus-0 -- \
  wget -qO- --no-check-certificate https://192.168.55.10:10250/healthz

# Sprawdź Prometheus targets (przez port-forward jeśli nie ma Ingress)
kubectl port-forward -n monitoring svc/kube-prometheus-stack-prometheus 9090:9090
# → http://localhost:9090/targets
```