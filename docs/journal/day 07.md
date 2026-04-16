# 7 - Cilium

# K3s Homelab — Sesja 07

**Data:** 2026-02-01  
**Środowisko:** 3x HP T630, k3s v1.34.4, Flux v2.8.1

---

### Cel sesji:

- Migracja CNI: Flannel → Cilium v1.19.1 (eBPF)
- Cilium zarządzany przez Flux jako HelmRelease
- Klaster w pełni operacyjny po migracji

---

### 1. Problem z flannel po twardym wyłączeniu

**Objaw:** Wszystkie pody w stanie `ContainerCreating` / `Unknown` po restarcie klastra przez przycisk zasilania.

**Przyczyna:** Flannel trzyma `subnet.env` w `/run/flannel/` który jest `tmpfs` (RAM). Po twardym wyłączeniu ten plik znika. Flannel nie może zainicjalizować sieci bez tego pliku.

**Tymczasowe rozwiązanie:**

```bash
ssh master "sudo mkdir -p /run/flannel && printf 'FLANNEL_NETWORK=10.42.0.0/16\nFLANNEL_SUBNET=10.42.0.1/24\nFLANNEL_MTU=1450\nFLANNEL_IPMASQ=true\n' | sudo tee /run/flannel/subnet.env"
ssh worker1 "sudo mkdir -p /run/flannel && printf 'FLANNEL_NETWORK=10.42.0.0/16\nFLANNEL_SUBNET=10.42.1.1/24\nFLANNEL_MTU=1450\nFLANNEL_IPMASQ=true\n' | sudo tee /run/flannel/subnet.env"
ssh worker2 "sudo mkdir -p /run/flannel && printf 'FLANNEL_NETWORK=10.42.0.0/16\nFLANNEL_SUBNET=10.42.2.1/24\nFLANNEL_MTU=1450\nFLANNEL_IPMASQ=true\n' | sudo tee /run/flannel/subnet.env"
```

**Prawdziwe rozwiązanie:** Migracja na Cilium

**Wniosek:** Zawsze używaj Ansible graceful shutdown playbooka zamiast przycisku zasilania!

---

### 2. Migracja CNI: Flannel → Cilium

**Dlaczego Cilium jest lepszy:**

- eBPF zamiast iptables — wyższa wydajność, niższy overhead
- Zastępuje zarówno flannel jak i kube-proxy
- NetworkPolicy out of the box
- Hubble — wbudowana observability sieci
- Standard produkcyjny w enterprise

**Plan migracji (krok po kroku):**

```
1. Backup etcd przed migracją
2. Wyłącz k3s na wszystkich nodach
3. Wyczyść pozostałości flannel (CNI dirs, network interfaces)
4. Dodaj flagi do k3s.service: --flannel-backend=none --disable-network-policy
5. Uruchom master (poczekaj na etcd quorum)
6. Uruchom workery
7. Zainstaluj Cilium przez Helm z bezpośrednim IP
8. Przenieś do Flux jako HelmRelease
```

**Krok 1 — Backup etcd:**

```bash
ssh master "sudo k3s etcd-snapshot save --name pre-cilium-migration"
```

**Krok 2 — Stop k3s:**

```bash
ansible all -m systemd -a "name=k3s state=stopped" -b
```

**Krok 3 — Czyszczenie flannel:**

```bash
ansible all -m shell -a "
rm -rf /run/flannel
rm -rf /var/lib/cni
rm -rf /etc/cni/net.d/*
ip link delete flannel.1 2>/dev/null || true
ip link delete cni0 2>/dev/null || true
" -b
```

**Krok 4 — Flagi k3s.service** (edytuj przez `sudo vi` na każdym nodzie):

```
ExecStart=/usr/local/bin/k3s \
    server \
        '--cluster-init' \
        '--flannel-backend=none' \
        '--disable-network-policy' \
        '--tls-san' \
        'cluster.kcn333.com' \
```

Na workerach dodaj te same flagi do ich `ExecStart`.

**Krok 5+6 — Start klastra (HA wymaga quorum!):**

```bash
# Najpierw master
ssh master "sudo systemctl daemon-reload && sudo systemctl start k3s"
# Gdy etcd czeka na quorum — uruchom workery równocześnie
ssh worker1 "sudo systemctl daemon-reload && sudo systemctl start k3s" &
ssh worker2 "sudo systemctl daemon-reload && sudo systemctl start k3s" &
```

**Krok 7 — Instalacja Cilium przez Helm:**

```bash
helm repo add cilium https://helm.cilium.io/
helm repo update

helm install cilium cilium/cilium \
  --version 1.19.1 \
  --namespace kube-system \
  --set k8sServiceHost=192.168.55.10 \  # bezpośrednie IP, nie hostname!
  --set k8sServicePort=6443 \
  --set operator.replicas=1
```

**Dlaczego IP zamiast hostname?** Cilium podczas bootstrapu nie może użyć DNS bo:

- DNS działa przez CoreDNS
- CoreDNS to pod w klastrze
- Pod nie może wstać bez CNI
- CNI (Cilium) nie może się połączyć bez DNS → Deadlock! Bezpośredni IP omija ten problem.

**Krok 8 — Flux HelmRelease:**

```yaml
# apps/base/cilium/helmrepository.yaml
apiVersion: source.toolkit.fluxcd.io/v1
kind: HelmRepository
metadata:
  name: cilium
  namespace: flux-system
spec:
  interval: 1h
  url: https://helm.cilium.io

# apps/base/cilium/helmrelease.yaml
apiVersion: helm.toolkit.fluxcd.io/v2
kind: HelmRelease
metadata:
  name: cilium
  namespace: kube-system
  annotations:
    meta.helm.sh/release-name: cilium
    meta.helm.sh/release-namespace: kube-system
spec:
  interval: 30m
  chart:
    spec:
      chart: cilium
      version: "1.19.1"
      sourceRef:
        kind: HelmRepository
        name: cilium
        namespace: flux-system
      interval: 12h
  install:
    createNamespace: false
  upgrade:
    remediation:
      retries: 3
  values:
    k8sServiceHost: 192.168.55.10
    k8sServicePort: 6443
    operator:
      replicas: 1
```

---

### 3. Problemy które napotkałem

**Problem 1: Cilium crashuje i zabiera sieć**

Cilium DaemonSet crashował w pętli (nie mógł połączyć się z API) i przy tym uszkadzał interfejsy sieciowe. Master i worker1 przestały odpowiadać nawet na ping.

**Rozwiązanie — rescue przez worker2:**

```bash
# Na worker2 uruchom pętlę która złapie okno gdy API wstanie:
while true; do
  kubectl delete daemonset cilium cilium-envoy -n kube-system --force --grace-period=0 2>/dev/null && echo "DONE!" && break
  sleep 2
done
# Następnie fizycznie zrestartuj zawieszony node
```

**Wniosek:** Nigdy nie rób niebezpiecznych operacji na wszystkich nodach jednocześnie.

**Problem 2: Namespace `cilium-secrets` w stanie `Terminating`**

Namespace nie chciał się usunąć przez finalizers.

**Rozwiązanie:**

```bash
kubectl get namespace cilium-secrets -o json | \
  python3 -c "import sys,json; d=json.load(sys.stdin); d['spec']['finalizers']=[]; print(json.dumps(d))" | \
  kubectl replace --raw /api/v1/namespaces/cilium-secrets/finalize -f -
```

**Problem 3: HA etcd wymaga quorum**

Przy starcie tylko mastera — etcd czekał na pozostałe nody i k3s nie przechodził w stan `active`.

**Rozwiązanie:** Uruchamiaj workery równolegle z masterem gdy widzisz że etcd loguje `prober detected unhealthy status`.

---

### 4. Weryfikacja Cilium

```bash
# Status
cilium status

# Test łączności (bez NetworkPolicy)
cilium connectivity test --test no-policies

# Sprawdź ile podów zarządza Cilium
cilium status | grep "Cluster Pods"
```

Oczekiwany output:

```
Cilium:             OK
Operator:           OK
Envoy DaemonSet:    OK
Cluster Pods:       53/53 managed by Cilium
```

---

### 5. Ratowanie klastra — procedury awaryjne

**Wymuś usunięcie podów:**

```bash
kubectl delete pods -n <namespace> --field-selector status.phase=Unknown
kubectl delete pods -n <namespace> --field-selector status.phase=Failed
kubectl delete pods -n <namespace> --all --force --grace-period=0
```

**Wymuś usunięcie namespace:**

```bash
kubectl get namespace <nazwa> -o json | \
  python3 -c "import sys,json; d=json.load(sys.stdin); d['spec']['finalizers']=[]; print(json.dumps(d))" | \
  kubectl replace --raw /api/v1/namespaces/<nazwa>/finalize -f -
```

**Sprawdź logi k3s:**

```bash
ssh master "sudo journalctl -u k3s -n 50 --no-pager | grep -i 'error\|warn\|flannel\|cni'"
```

**etcd snapshot przed ryzykowną operacją:**

```bash
ssh master "sudo k3s etcd-snapshot save --name <nazwa-snapshotu>"
ssh master "sudo k3s etcd-snapshot ls"
```

---

### 6. Dlaczego graceful shutdown jest kluczowy

Twardy restart (przycisk zasilania) może spowodować:

- Utratę `tmpfs` danych (np. flannel subnet.env)
- Pody w stanie `Unknown` wymagające ręcznego czyszczenia
- Problemy z etcd jeśli lider był w trakcie operacji

**Zawsze używaj:**

```bash
ansible-playbook graceful-shutdown.yml
```

Lub ręcznie:

```bash
ansible all -m shell -a "shutdown -h +1" -b
```

---

## Finalna struktura repo

```
k3s-homelab/
├── README.md
├── apps/
│   ├── base/
│   │   ├── kustomization.yaml
│   │   ├── cilium/                    # ← NOWE
│   │   │   ├── helmrelease.yaml
│   │   │   ├── helmrepository.yaml
│   │   │   └── kustomization.yaml
│   │   ├── longhorn/
│   │   ├── nginx/
│   │   ├── sealed-secrets/
│   │   └── traefik-dashboard/
│   └── kustomization.yaml
└── clusters/
    └── k3s-homelab/
        ├── apps.yaml
        ├── helmchartconfig-traefik.yaml
        ├── image-update-automation.yaml
        └── flux-system/
```

---

## Backlog (do zrobienia)

- [ ] **Prometheus + Grafana monitoring** ← następna sesja
- [ ] Hubble UI — Cilium network observability
- [ ] NetworkPolicy — izolacja między podami
- [ ] Własna aplikacja (Spring Boot) + CI/CD pipeline
- [ ] HashiCorp Vault
- [ ] External-dns
- [ ] Progressive delivery (staging/production)
- [ ] RBAC

---

## Przydatne komendy

```bash
# Cilium
cilium status
cilium status --wait
cilium connectivity test --test no-policies

# Flux HelmReleases
flux get helmreleases -A
flux reconcile helmrelease cilium -n kube-system

# etcd snapshots
ssh master "sudo k3s etcd-snapshot save --name <nazwa>"
ssh master "sudo k3s etcd-snapshot ls"

# Ratowanie namespace
kubectl get namespace <nazwa> -o json | \
  python3 -c "import sys,json; d=json.load(sys.stdin); d['spec']['finalizers']=[]; print(json.dumps(d))" | \
  kubectl replace --raw /api/v1/namespaces/<nazwa>/finalize -f -

# Czyszczenie starych podów
kubectl delete pods -n <ns> --field-selector status.phase=Unknown --force
kubectl delete pods -n <ns> --field-selector status.phase=Failed --force
```