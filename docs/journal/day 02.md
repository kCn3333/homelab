# 2 - Let's Encrypt

# K3s Homelab — Sesja 02

**Data:** 2026-02-27  
**Środowisko:** 3x HP T630, k3s v1.34.4, HAProxy, Traefik

---

## Co zbudowaliśmy

Działający HTTPS z prawdziwym certyfikatem Let's Encrypt na lokalnym klastrze bez wystawiania go na świat:

```
Użytkownik → HAProxy:6453 (tcp/passthrough) → Traefik:443 → Pod
                                               ↑
                                    cert-manager + Let's Encrypt
                                    (DNS-01 via Cloudflare API)
```

---

## Czego się nauczyłem

### 1. Helm — menedżer pakietów dla Kubernetes

**Czym jest Helm:**

- `kubectl apply -f` to jednorazowe "wrzuć do klastra" bez śledzenia stanu
- Helm **zarządza cyklem życia** — wie co zainstalował, może upgrade'ować, rollback'ować i odinstalować jako całość jedną komendą
- Paczka w Helmie to **chart** — zawiera szablony manifestów + domyślne `values.yaml`

**Workflow z Helmem — zawsze trzy kroki:**

```bash
# 1. Dodaj repozytorium
helm repo add jetstack https://charts.jetstack.io

# 2. Przejrzyj dostępne opcje konfiguracji
helm show values jetstack/cert-manager | grep -i crd

# 3. Zainstaluj z własnymi wartościami
helm install cert-manager jetstack/cert-manager \
  -n cert-manager \
  --create-namespace \
  --set crds.enabled=true
```

**Ważne flagi:**

- `--create-namespace` — tworzy namespace jeśli nie istnieje (nie musisz robić `kubectl create ns` osobno)
- `--set klucz=wartość` — nadpisuje wartość z `values.yaml`
- Format charta: `nazwa-repo/nazwa-charta`

**CRD (CustomResourceDefinition):**

- Rozszerzają Kubernetes API o nowe typy zasobów
- Bez CRD cert-managera k8s nie wie co to `Certificate`, `ClusterIssuer`, `CertificateRequest`
- `crds.enabled=true` mówi Helmowi żeby zainstalował te definicje razem z chartem

---

### 2. cert-manager — automatyczne zarządzanie certyfikatami

**Architektura cert-managera (3 pody):**

- `cert-manager` — główny kontroler, zarządza cyklem życia certyfikatów
- `cert-manager-cainjector` — wstrzykuje CA do webhooków k8s
- `cert-manager-webhook` — waliduje zasoby cert-managera przy tworzeniu

**Dlaczego nie potrzebuje replik HA:** cert-manager nie jest w krytycznej ścieżce obsługi requestów użytkownika. Zajmuje się wystawianiem i odnawianiem certyfikatów — operacjami periodycznymi, nie ciągłymi. Jeśli padnie na kilka minut, istniejące certyfikaty dalej działają.

**Rotacja certyfikatów:**

- cert-manager odnawia certyfikat automatycznie gdy zostaje 1/3 ważności
- Let's Encrypt: certyfikaty 90-dniowe → odnowienie ~30 dni przed wygaśnięciem
- Zero manualnej pracy po konfiguracji

---

### 3. Issuer vs ClusterIssuer

||Issuer|ClusterIssuer|
|---|---|---|
|Scope|Jeden namespace|Cały klaster|
|Użycie|Certyfikaty tylko w tym samym namespace|Certyfikaty dla dowolnego namespace|
|Kiedy używać|Izolacja per-team/per-app|Współdzielony CA dla całego klastra|

**Dla homelaba:** zawsze `ClusterIssuer` — jeden issuer dla wszystkich aplikacji.

`ClusterIssuer` jest **cluster-scoped** jak `Node` czy `PersistentVolume` — nie należy do żadnego namespace, nie podajesz `-n` przy apply.

---

### 4. Let's Encrypt — staging vs produkcja

**Dlaczego staging pierwszy:**

- Let's Encrypt produkcja ma **rate limits** — max 5 certyfikatów na domenę na tydzień
- Staging nie ma limitów ale certyfikaty nie są zaufane przez przeglądarki
- Zawsze testuj na staging, przełącz na prod gdy wiesz że działa

**Dwa środowiska:**

```
Staging: https://acme-staging-v02.api.letsencrypt.org/directory
Prod:    https://acme-v02.api.letsencrypt.org/directory
```

---

### 5. DNS-01 Challenge — certyfikaty bez otwierania portów

**HTTP-01 challenge:** Let's Encrypt odpytuje `http://twojadomena.com/.well-known/acme-challenge/...` — wymaga że serwer jest dostępny z internetu.

**DNS-01 challenge:** Let's Encrypt sprawdza rekord `TXT _acme-challenge.twojadomena.com` w publicznym DNS — **klaster nie musi być dostępny z internetu!**

**Flow DNS-01 z Cloudflare:**

1. cert-manager dostaje żądanie certyfikatu
2. Używa Cloudflare API żeby dodać rekord `TXT _acme-challenge.cluster.kcn333.com`
3. Let's Encrypt weryfikuje rekord TXT
4. cert-manager usuwa rekord TXT
5. Certyfikat wystawiony → zapisany jako Secret w k8s

**Cloudflare API Token** — uprawnienia (zasada least privilege):

- `Zone | DNS | Edit`
- `Zone | Zone | Read`
- Zone Resources: Specific zone (tylko Twoja domena)

**NIE używaj** Global API Key — zbyt szerokie uprawnienia.

---

### 6. Przechowywanie sekretów w k8s

API Token Cloudflare przechowujemy jako `Secret`, nie wklejamy bezpośrednio do manifestu `ClusterIssuer`:

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: cloudflare-token
  namespace: cert-manager
type: Opaque
stringData:
  api-token: <token>
```

**Dlaczego to ważne:** manifest `ClusterIssuer` może trafić do GitHuba — Secret nie powinien. W produkcji używa się **Sealed Secrets** lub **External Secrets Operator** żeby bezpiecznie trzymać sekrety w repo (temat na później).

---

### 7. Zasoby cert-managera — przepływ

```
ClusterIssuer → Certificate → CertificateRequest → Order → Challenge → Secret (TLS)
```

**ClusterIssuer** — konfiguracja CA (Let's Encrypt + Cloudflare)  
**Certificate** — żądanie certyfikatu dla konkretnej domeny  
**CertificateRequest** — pojedyncze żądanie do CA  
**Order** — sesja ACME  
**Challenge** — weryfikacja kontroli domeny  
**Secret** — gotowy certyfikat (tls.crt + tls.key)

**Diagnostyka gdy coś nie działa:**

```bash
kubectl describe certificate <nazwa>
kubectl get certificaterequest
kubectl get orders
kubectl get challenges
kubectl describe clusterissuer <nazwa>
```

---

### 8. Manifest Certificate

```yaml
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: local-prod-cert-kcn333
spec:
  secretName: local-prod-kcn333-tls      # nazwa Secretu który zostanie utworzony
  commonName: "*.cluster.kcn333.com"
  dnsNames:
    - "cluster.kcn333.com"
    - "*.cluster.kcn333.com"             # wildcard dla subdomen
  issuerRef:
    name: letsencrypt-prod-cluster-issuer
    kind: ClusterIssuer
```

**Częsty błąd:** w Ingress podawanie nazwy `Certificate` zamiast nazwy `Secret` w polu `secretName`. Traefik potrzebuje nazwy Secretu.

---

### 9. Ingress z TLS

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: minimal-ingress
  annotations:
    traefik.ingress.kubernetes.io/ssl-redirect: "true"
spec:
  ingressClassName: traefik
  tls:
  - hosts:
    - nginx.cluster.kcn333.com
    secretName: local-prod-kcn333-tls    # nazwa Secretu, nie Certyfikatu!
  rules:
  - host: nginx.cluster.kcn333.com
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: nginx
            port:
              number: 80
```

---

### 10. HAProxy — tryby i TLS

**Dwa tryby HAProxy:**

- `mode http` — HAProxy rozumie HTTP, może modyfikować nagłówki, ale wymaga odszyfrowania TLS
- `mode tcp` — HAProxy przepuszcza surowe bajty, "ślepy" na zawartość → TLS Passthrough

**Kiedy używać:**

- API server k8s (port 6443) → `mode tcp` (TLS terminowany przez API server)
- Ingress HTTP (port 6480→80) → `mode http` (brak TLS)
- Ingress HTTPS (port 6453→443) → `mode tcp` (TLS terminowany przez Traefik)

**Health checki a tryb TCP:**

- `option httpchk` nie ma sensu w `mode tcp` — HAProxy nie może parsować HTTP
- Traefik odpowiada `404` na nieznane ścieżki → domyślnie HAProxy uznaje za "unhealthy"
- Rozwiązanie: usunąć `check` lub użyć `http-check expect status 200,301,302,404`

---

### 11. Debugowanie certyfikatów

```bash
# Sprawdź jaki certyfikat serwuje serwer
echo | openssl s_client -connect domena.com:443 2>/dev/null | \
  openssl x509 -text -noout | grep -A2 "Issuer\|Subject"

# Staging: Issuer zawiera "(STAGING)"
# Prod: Issuer: C = US, O = Let's Encrypt, CN = R10/R11/R12
```

---

### 12. Problem z przekierowaniem HTTP→HTTPS przy niestandardowych portach

Traefik przekierowuje HTTP na `https://domena.com` (port 443). Przy niestandardowych portach (6453 zamiast 443) przekierowanie kieruje na zły port.

**Opcje rozwiązania (do przemyślenia):**

- Cloudflare Tunnel — ruch wchodzi przez tunel na standardowych portach
- Przepięcie nginx-proxy-manager na inne porty i zajęcie 80/443 przez HAProxy
- Zaakceptowanie niestandardowych portów i rezygnacja z automatycznego przekierowania

---

## Backlog (do zrobienia)

- [ ] Rozwiązać problem z portami (Cloudflare Tunnel lub przepięcie NPM)
- [ ] Traefik dashboard z BasicAuth
- [ ] PersistentVolume / PersistentVolumeClaim
- [ ] Zablokować bezpośredni dostęp do portów nodów (ufw + NetworkPolicy)
- [ ] Flux — GitOps, CD
- [ ] RBAC — własni użytkownicy
- [ ] Własna aplikacja w Pythonie lub Javie
- [ ] Własne Helm charts
- [ ] Pełne CI/CD pipeline
- [ ] Sealed Secrets / External Secrets Operator

---

## Przydatne komendy

```bash
# Helm
helm repo add <nazwa> <url>
helm repo update
helm show values <repo/chart>
helm install <release> <repo/chart> -n <namespace> --create-namespace --set klucz=wartość
helm list -A
helm uninstall <release> -n <namespace>

# cert-manager diagnostyka
kubectl get certificate -A
kubectl get clusterissuer
kubectl get challenges
kubectl get orders
kubectl describe certificate <nazwa>
kubectl describe clusterissuer <nazwa>

# Sprawdzenie certyfikatu TLS
echo | openssl s_client -connect <host>:<port> 2>/dev/null | openssl x509 -text -noout | grep -A2 "Issuer\|Subject\|Validity"
```