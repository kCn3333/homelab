# 1 - HA k3s embedded etcd

# K3s Homelab — Sesja 01

**Data:** 2026-01-12  
**Środowisko:** 3x HP T630 (8GB RAM, 128GB SSD), Ubuntu Server 24.04

---

### Architektura klastra

```
[PC / kubectl] → [HAProxy :6443/:6480/:6453] → [master / worker1 / worker2]
                                                       ↓
                                              [Traefik Ingress]
                                                       ↓
                                              [Service → Pods]
```

Wszystkie trzy nody mają role `control-plane,etcd` — każdy jest jednocześnie masterem i członkiem klastra etcd.

---

## Kluczowe wnioski:

### 1. High Availability w Kubernetes

**HA ma dwa wymiary:**

- **Control-plane HA** — scheduler, controller-manager, API server muszą działać żeby klaster mógł reagować na awarie (np. ewakuować pody z martwego noda)
- **Aplikacyjne HA** — pody działają dalej nawet gdy control-plane padnie, ale klaster jest wtedy "ślepy" — nie może schedulować, skalować ani naprawiać

**Kworum etcd:** przy 3 nodach klaster wytrzyma awarię 1 noda. Wzór: `(n-1)/2` nodów może paść.

**Test który przeprowadziłem:** wyłączyłem mastera i obserwowałem przez `watch kubectl get pods -A`. Po ~2-3 minutach pody z martwego noda zostały zreplikowane na pozostałych nodach. Dostęp do API nie został przerwany.

**`node-monitor-grace-period`** — czas po którym k8s uznaje node za martwy i zaczyna ewakuację. Domyślnie ~40s, ale pody mogą wisieć w stanie `Terminating` długo jeśli kubelet nie potwierdzi ich zatrzymania (`--force` wymusza usunięcie).

---

### 2. etcd w k3s

- etcd jest **wbudowany w proces k3s** — nie ma osobnego `etcd` w `kubectl get pods`
- Pliki danych: `/var/lib/rancher/k3s/server/db/etcd/`
- etcd zakłada **lock na plikach WAL** — próba uruchomienia drugiej instancji wskazującej na ten sam katalog = błąd `file already locked`
- **Błąd który popełniłem:** `k3s server etcdctl member list` próbuje uruchomić nowy proces k3s server zamiast odpytać działający — stąd błąd z lockiem. To nie był problem z klastrem.

---

### 3. HAProxy jako zewnętrzny Load Balancer

**Rola HAProxy w architekturze:**

- Przyjmuje ruch z zewnątrz i rozdziela na nody
- Port `6443` → K8s API server (wszystkie nody)
- Port `6480` → Traefik HTTP (wszystkie nody, port 80)
- Port `6453` → Traefik HTTPS (wszystkie nody, port 443)

**TLS Passthrough:**

- `mode tcp` = HAProxy nie "widzi" zawartości pakietów, przepuszcza surowe bajty
- TLS jest terminowany przez API server / Traefik, nie przez HAProxy
- HAProxy **nie potrzebuje** certyfikatu żeby przekazywać ruch HTTPS
- `mode http` wymagałby od HAProxy posiadania klucza prywatnego do odszyfrowania

**Health checki — pułapka:**

- `option httpchk GET /healthz` + `mode tcp` = błąd (HAProxy nie rozumie HTTP w trybie tcp dla health checku w tym kontekście)
- Traefik odpowiada `404` na nieznane ścieżki — domyślnie HAProxy uznaje to za "unhealthy"
- Rozwiązanie: usunąć `check` z backendów lub użyć `http-check expect status 200,301,302,404`
- Traefik ma endpoint `/ping` ale na porcie wewnętrznym niedostępnym z zewnątrz

**Lekcja z debugowania:** najpierw usuń health check żeby potwierdzić że routing działa, potem napraw health check. Zawsze potwierdzaj hipotezę zanim optymalizujesz.

---

### 4. kubectl z poziomu PC

**kubeconfig** (`/etc/rancher/k3s/k3s.yaml`) zawiera:

- adres API servera
- `client-certificate-data` i `client-key-data` — credentials z pełnym dostępem (odpowiednik root), traktować jak hasło

**Kopiowanie na PC:**

```bash
ssh user@master "sudo cat /etc/rancher/k3s/k3s.yaml" | Out-File -Encoding ascii k3s.yaml
# Zmień server: https://127.0.0.1:6443 → https://<IP-HAProxy>:6443
```

**Mergowanie kubeconfigs:**

```bash
KUBECONFIG=~/.kube/config:~/.kube/k3s.yaml kubectl config view --flatten > ~/.kube/config_new
```

Na samych nodach `127.0.0.1` jest poprawne — każdy jest control-plane i ma lokalny API server.

---

### 5. Sieć i Service w Kubernetes

**Jak ruch trafia do poda:**

```
HAProxy (L4) → Traefik (L7, Ingress Controller) → Service → Pod
```

**Service bez selectora = puste Endpoints = 503**  
To był mój błąd przy `k create svc` — nie dodałem selectora, więc Service nie wiedział do których podów kierować ruch.

**`k expose` vs `k create svc`:**

- `k expose deployment nginx` — automatycznie kopiuje selector i labels z Deploymentu
- `k create svc` — trzeba ręcznie dodać selector w manifeście lub przez `k edit`

**Endpoints** — sprawdzaj zawsze gdy serwis nie działa:

```bash
kubectl get endpoints <nazwa-svc>
```

Puste Endpoints = selector nie pasuje do żadnego poda.

---

### 6. Ingress i Traefik

**IngressClass** to "połączenie" między zasobem `Ingress` a konkretną implementacją Ingress Controllera. Bez poprawnego `ingressClassName` Ingress jest ignorowany.

```bash
kubectl get ingressclass
# traefik   traefik.io/ingress-controller
```

**`svclb-traefik` (klipper-lb)** — DaemonSet k3s który symuluje cloud LoadBalancer na bare-metal. Bez niego serwis typu `LoadBalancer` miałby `<pending>` w kolumnie EXTERNAL-IP. Działa przez iptables na każdym nodzie.

**Minimalne zasoby do działającego Ingressu:**

1. **Deployment** — pody z aplikacją
2. **Service** — z poprawnym selectorem wskazującym na pody
3. **Ingress** — z poprawnym `ingressClassName`

---

### 7. DNS — CoreDNS vs zewnętrzny DNS

**CoreDNS** — DNS wewnątrz klastra, tylko dla podów. Pozwala używać nazw `svc.namespace.svc.cluster.local` zamiast IP.

**PiHole / zewnętrzny DNS** — dla urządzeń w sieci lokalnej. Żeby `cluster.kcn.lan` działało zarówno z PC jak i z podów, oba muszą używać tego samego DNS lub DNS musi być skonfigurowany w obu miejscach.

---

## Co zostało do zrobienia (backlog)

- [ ] Naprawić health checki w HAProxy dla Traefika
- [ ] Skonfigurować DNS w PiHole dla lokalnej domeny klastra
- [ ] PersistentVolume / PersistentVolumeClaim — hostowanie prawdziwej strony
- [ ] cert-manager — self-signed i CA Issuer dla środowiska lokalnego
- [ ] Zablokować bezpośredni dostęp do portów nodów (ufw + NetworkPolicy)
- [ ] Helm — instalacja i zarządzanie aplikacjami
- [ ] Flux — GitOps, CD
- [ ] RBAC — własne użytkownicy zamiast domyślnego admin
- [ ] Własna aplikacja w Pythonie lub Javie
- [ ] Własne Helm charts
- [ ] Pełne CI/CD pipeline

---

## Przydatne komendy

```bash
# Stan klastra
kubectl get nodes -o wide
kubectl get pods -A -o wide
kubectl get endpoints <svc>
kubectl get ingressclass

# Debugowanie
kubectl describe pod <nazwa>
kubectl describe ingress <nazwa>
kubectl logs <pod>

# Szybkie tworzenie zasobów
kubectl expose deployment <nazwa> --port=80 --target-port=80
kubectl create deployment nginx --image=nginx --replicas=5

# Kubeconfig
kubectl config get-contexts
kubectl config use-context <nazwa>
```