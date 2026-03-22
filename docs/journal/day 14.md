# 14 - Hubble

# K3s Homelab — Sesja 14 (Hubble debugging marathon)

**Daty:** 2026-03-14, 2026-03-15, 2026-03-16  
**Środowisko:** 3x HP T630, k3s v1.34.4, Flux v2.8.1, Cilium v1.19.1 (VXLAN)

---

## Co próbowaliśmy zrobić

Uruchomić Hubble UI — wbudowany w Cilium system observability sieci.

## Czego NIE udało się zrobić

Hubble relay nadal nie działa. Klaster był kilkukrotnie destabilizowany.

## Stan końcowy

Klaster stabilny, wszystko działa **oprócz Hubble relay**. Konfiguracja Cilium: VXLAN, `kubeProxyReplacement: false`, kube-proxy k3s włączony.

---

## Root cause problemu z Hubble

### Architektura Hubble

```
Cilium Agent (każdy node) → nasłuchuje na port 4244 (gRPC, node IP)
        ↑
Hubble Relay pod (IP z puli podów, np. 10.0.0.x)
        ↑
Hubble UI
```

### Dlaczego relay nie działa z VXLAN

Relay pod ma IP z puli podów (`10.0.0.x`). Próbuje połączyć się z agentami na `192.168.55.x:4244` (node IP). W trybie VXLAN Cilium nie routuje ruchu **pod→nodeIP** — pakiety przepadają w BPF datapath zanim dotrą do fizycznego interfejsu.

Potwierdzono przez tcpdump: pakiety SYN widoczne na veth interfejsie poda, ale **nigdy nie docierają** do `enp1s0` nodów docelowych.

```
relay pod (10.0.0.x) → SYN → 192.168.55.11:4244
Master widzi SYN na lxc interface ← ale nigdy nie wychodzi przez enp1s0
```

### Dlaczego hostNetwork nie wchodzi w grę

Cilium Helm chart nie ma opcji `hostNetwork` dla relay — nie jest to wspierana konfiguracja. Próba przez `postRenderers` w HelmRelease byłaby obejściem niezgodnym z zamierzeniem projektu.

---

## Co próbowaliśmy (chronologicznie)

### 1. Usunięcie i regeneracja certyfikatów TLS Hubble

**Wynik:** Certyfikaty się zregenerowały. Problem nie był w certach — TLS handshake działał poprawnie.

**Lekcja:** Zawsze sprawdź czy problem jest sieciowy czy TLS zanim zaczniesz grzebać w certach. `openssl s_client` z node→node pokazał że TLS działa.

### 2. Dodanie `hubble.tls.auto.method: helm` do HelmRelease

**Wynik:** Cilium operator zaczął regenerować certyfikaty automatycznie. Dobra zmiana, ale nie rozwiązała problemu z routingiem.

### 3. Reguły UFW dla portów 4240/4244

**Wynik:** UFW nie był problemem — już miał `10.0.0.0/8 ALLOW Anywhere` które pokrywało te porty.

### 4. `kubeProxyReplacement: true` bez zmiany routing mode

**Wynik:** Klaster niestabilny. `kubeProxyReplacement: true` bez `routingMode: native` powoduje niespójny stan — Cilium próbuje przejąć obsługę serwisów ale nie ma pełnego native routing.

**Lekcja:** `kubeProxyReplacement: true` i `routingMode: native` muszą być włączone **razem**.

### 5. Próba przejścia na native routing na żywym klastrze (rolling update)

**Wynik:** Katastrofa. Podczas rolling update Cilium DaemonSet jeden node miał native routing a pozostałe VXLAN → ruch sieciowy się posypał → SSH przestało działać → klaster niedostępny.

**Lekcja:** **Zmiana routing mode Cilium wymaga pełnego restartu klastra.** Rolling update DaemonSet nie jest bezpieczny przy zmianie fundamentalnych parametrów CNI.

### 6. `--disable-kube-proxy` w k3s.service

**Efekt:** Dodane podczas próby przejścia na native routing. Po cofnięciu Cilium do VXLAN z `kubeProxyReplacement: false` — nikt nie obsługiwał ClusterIP ani NodePort. Klaster działał "od wewnątrz" ale żaden zewnętrzny ruch nie docierał (Traefik, Grafana, wszystkie Ingress przestały działać).

**Lekcja:** `--disable-kube-proxy` ma sens TYLKO gdy `kubeProxyReplacement: true` i Cilium jest w trybie native routing.

### 7. Próby naprawy ConfigMap ręcznie przez kubectl patch

**Wynik:** Działało jako rescue — pozwalało przywrócić VXLAN gdy klaster był niedostępny przez Flux.

---

## Kluczowe wnioski techniczne

### Cilium routing modes

|Tryb|Opis|Pod→NodeIP|KubeProxy needed|
|:--|:--|:--|:--|
|VXLAN (tunnel)|Enkapsulacja L3, działa wszędzie|❌|Tak (lub kubeProxyReplacement)|
|Native routing|Bezpośredni routing L2, wymaga tej samej podsieci|✅|Nie (kubeProxyReplacement)|

### Dlaczego Prometheus działa z hostNetwork a relay nie może

Prometheus używa `hostNetwork: true` — działa na sieci hosta, ma bezpośredni dostęp do node IP. To jest udokumentowane obejście dla k3s. Cilium Helm chart nie przewiduje `hostNetwork` dla relay.

### Prawidłowa konfiguracja dla native routing

```yaml
# Cilium HelmRelease values
kubeProxyReplacement: true
routingMode: native
autoDirectNodeRoutes: true
ipv4NativeRoutingCIDR: "10.0.0.0/8"
```

```
# k3s.service — wymagana flaga
'--disable-kube-proxy'
```

Wymagania: wszystkie nody w tej samej podsieci L2 (spełnione — `192.168.55.0/24`).

### Bezpieczny sposób zmiany routing mode

1. Zaktualizuj HelmRelease w Git
2. Graceful shutdown klastra przez Ansible
3. Włącz wszystkie nody jednocześnie (lub master + workery z małym opóźnieniem)
4. Flux zaaplikuje nową konfigurację przy starcie
5. **NIE rób rolling update DaemonSet na żywym klastrze**

### Dlaczego "delete all Cilium pods at once" jest bezpieczniejsze niż rolling update

Przy jednoczesnym usunięciu wszystkich podów — wszystkie nody tracą CNI jednocześnie i odbudowują się z tą samą konfiguracją. Brak okna gdy jeden node ma native a drugi VXLAN.

---

## Stan klastru po sesjach

**Działa:**

- Cilium VXLAN ✅
- kube-proxy k3s ✅ (przywrócony)
- Traefik + TLS ✅
- Grafana / Prometheus / Loki ✅
- AlertManager + ntfy ✅
- clients-api + CloudNativePG ✅
- Longhorn + S3 backup ✅
- metrics-server ✅ (z flagą `--authentication-tolerate-lookup-failure=true`)
- Sealed Secrets ✅
- Flux image automation ✅

**Nie działa:**

- Hubble relay ❌ — wymaga native routing

**Konfiguracja Cilium (aktualna):**

```yaml
values:
  k8sServiceHost: 192.168.55.10
  k8sServicePort: 6443
  operator:
    replicas: 1
  hubble:
    enabled: true
    tls:
      auto:
        enabled: true
        method: helm
    relay:
      enabled: true
    ui:
      enabled: true
      ingress:
        enabled: true
        ingressClassName: traefik
        hosts:
          - hubble.cluster.kcn333.com
        tls:
          - secretName: hubble-tls
            hosts:
              - hubble.cluster.kcn333.com
```

---

## Plan na przyszłość — przejście na native routing

Zrobić w osobnej sesji, ze świeżą głową:

1. Zaktualizuj HelmRelease Cilium z pełną konfiguracją native
2. Graceful shutdown klastra
3. Start klastra — Flux zaaplikuje nowe ustawienia
4. Weryfikacja

**Nie próbuj tego na żywym klastrze przez rolling update.**

---

## Przydatne komendy do debugowania Cilium

```bash
# Status Cilium
kubectl -n kube-system exec ds/cilium -- cilium status | grep -E "Routing|KubeProxy|Hubble|Cluster"

# Test TCP z agenta do innego agenta
kubectl -n kube-system exec ds/cilium -- \
  openssl s_client -connect 192.168.55.11:4244 \
  -CAfile /var/lib/cilium/tls/hubble/client-ca.crt \
  -cert /var/lib/cilium/tls/hubble/server.crt \
  -key /var/lib/cilium/tls/hubble/server.key \
  2>&1 | head -10

# Sprawdź trasy w kernel routing table
ssh master "ip route | grep '10\.0'"

# tcpdump na veth poda relay
ssh master "sudo tcpdump -i any -n 'port 4244' -c 20"

# Monitor dropów Cilium
kubectl -n kube-system exec ds/cilium -- cilium monitor --type drop

# ConfigMap Cilium
kubectl get configmap -n kube-system cilium-config -o yaml | \
  grep -E "routing-mode|kube-proxy|auto-direct|tunnel"

# Rescue — cofnij do VXLAN gdy klaster jest niedostępny
kubectl patch configmap cilium-config -n kube-system \
  --type merge \
  -p '{"data":{"routing-mode":"tunnel","kube-proxy-replacement":"false","auto-direct-node-routes":"false"}}'
kubectl delete pods -n kube-system -l k8s-app=cilium --force --grace-period=0
```