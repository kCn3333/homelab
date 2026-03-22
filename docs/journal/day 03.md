# 3 - HAProxy 

# K3s Homelab — Sesja 03

**Data:** 2026-02-28  
**Środowisko:** 3x HP T630, k3s v1.34.4, HAProxy, Traefik v3.6.7

---

## Co zbudowaliśmy

- HAProxy przeniesiony na dedykowane IP `192.168.0.45` ze standardowymi portami 80/443
- TLS SAN zaktualizowany o nowe IP i domenę
- HTTP→HTTPS przekierowanie działające przez Traefik v3
- DNS problem z IPv6 zdiagnozowany i rozwiązany

```
Użytkownik → HAProxy:80 → Traefik:80 → 301 → HAProxy:443 → Traefik:443 → Pod
```

---

## Czego się nauczyłem

### 1. IP Alias na Debianie (ifupdown)

Debian używa `/etc/network/interfaces` — starszy styl niż Netplan (Ubuntu).

```
# /etc/network/interfaces
auto enp1s0
iface enp1s0 inet static
    address 192.168.0.46
    netmask 255.255.255.0
    gateway 192.168.0.1

# Alias dla HAProxy
auto enp1s0:0
iface enp1s0:0 inet static
    address 192.168.0.45
    netmask 255.255.255.0
```

Notacja `enp1s0:0` to klasyczny alias w ifupdown — drugie IP na tym samym interfejsie fizycznym.

**Bezpieczne dodawanie bez restartu całego stacku:**

```bash
sudo ifup enp1s0:0
```

Unikaj `systemctl restart networking` przez SSH — możesz stracić połączenie.

**Uwaga na notację VLAN:** `enp1s0.5` to VLAN ID 5, nie alias. VLAN wymaga obsługi na poziomie switcha.

---

### 2. TLS SAN (Subject Alternative Name) — aktualizacja

**Czym jest SAN:** lista adresów IP i domen dla których certyfikat API servera jest ważny. Klient (kubectl) weryfikuje że łączy się z adresem który jest w SAN.

**Gdzie jest konfiguracja w k3s:** `/etc/systemd/system/k3s.service` w sekcji `ExecStart`:

```
ExecStart=/usr/local/bin/k3s \
    server \
        '--cluster-init' \
        '--tls-san' \
        '192.168.0.45' \
        '--tls-san' \
        '192.168.0.46' \
        '--tls-san' \
        'cluster.kcn333.com' \
```

**Dobra praktyka:** używaj domeny zamiast IP w SAN — zmiana IP nie wymaga wtedy aktualizacji certyfikatów.

**Workflow przy zmianie:**

```bash
# 1. Backup etcd przed zmianą
sudo k3s etcd-snapshot save --name pre-tls-san-change

# 2. Edytuj k3s.service
sudo vi /etc/systemd/system/k3s.service

# 3. Przeładuj systemd i zrestartuj k3s
sudo systemctl daemon-reload
sudo systemctl restart k3s

# 4. Zweryfikuj nowy SAN
echo | openssl s_client -connect <IP>:6443 2>/dev/null | \
  openssl x509 -text -noout | grep -A10 "Subject Alternative Name"
```

**Synchronizacja w k3s HA:** zmiana SAN na jednym nodzie control-plane jest automatycznie synchronizowana przez etcd na pozostałe nody. Nie musisz ręcznie edytować `k3s.service` na workerach dla SAN.

**Uwaga na workery:** mają zahardkodowany `--server https://192.168.55.10:6443` — to edge case przy restarcie gdy master jest niedostępny. Do poprawienia w przyszłości (zmiana na `https://cluster.kcn333.com:6443`).

---

### 3. etcd snapshot — backup przed ryzykownymi operacjami

```bash
# Manualny snapshot
sudo k3s etcd-snapshot save --name <nazwa>

# Lista snapshotów
sudo k3s etcd-snapshot ls

# Kopiowanie na inny serwer
scp user@master:/var/lib/rancher/k3s/server/db/snapshots/<nazwa> ~/backups/
```

**Reguła 3-2-1:** 3 kopie, 2 różne nośniki, 1 poza lokalizacją. Automatyczny cronjob + wysyłanie na inny serwer to docelowe rozwiązanie (do zrobienia).

---

### 4. HelmChartConfig — nadpisywanie konfiguracji Traefika w k3s

k3s zarządza Traefikiem przez wbudowany mechanizm Helm. Żeby nadpisać domyślną konfigurację **nie edytujesz** plików k3s bezpośrednio — tworzysz zasób `HelmChartConfig`:

```yaml
apiVersion: helm.cattle.io/v1
kind: HelmChartConfig
metadata:
  name: traefik        # musi być identyczna z nazwą HelmChart
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
```

**Zasada:** nigdy nie edytuj bezpośrednio konfiguracji zarządzanych przez narzędzia — używaj ich mechanizmów konfiguracji.

**Weryfikacja:**

```bash
kubectl get helmchartconfig -n kube-system
helm get values traefik -n kube-system
```

---

### 5. Traefik v2 vs v3 — breaking changes

Składnia konfiguracji przekierowania HTTP→HTTPS zmieniła się między wersjami:

||Traefik v2|Traefik v3|
|---|---|---|
|Przekierowanie|`redirectTo.port: websecure`|`redirections.entryPoint.to: websecure`|

**Traefik v3 po cichu ignoruje** nieznane pola konfiguracji bez błędu w logach. To utrudnia debugowanie — zawsze sprawdzaj wersję i szukaj dokumentacji dla tej konkretnej wersji.

**Lekcja:** breaking changes w narzędziach DevOps są częste. Zawsze sprawdzaj changelog i migration guide przy aktualizacji.

---

### 6. Debugowanie DNS i IPv6

**`time_namelookup: 15s`** to klasyczny objaw problemu z IPv6 — system próbuje IPv6 (AAAA record) najpierw, timeout po 15s, potem IPv4.

**Szybka diagnoza:**

```bash
curl -w "\ntime_namelookup: %{time_namelookup}\n" -o /dev/null -s https://domena.com
```

**Rozwiązania:**

- Flaga `-4` w curlu — wymusza IPv4 jednorazowo
- WSL: `generateResolvConf = false` + usunięcie symlinka + własny `resolv.conf`
- Debian/systemd: `echo "precedence ::ffff:0:0/96 100" >> /etc/gai.conf`
- Traefik: `service.ipFamilyPolicy: SingleStack` w HelmChartConfig

**WSL specifics:**

```bash
# /etc/wsl.conf
[network]
generateResolvConf = false

# Usuń symlink i stwórz prawdziwy plik
sudo unlink /etc/resolv.conf
echo "nameserver 192.168.0.46" | sudo tee /etc/resolv.conf
```

---

### 7. HAProxy — finalna konfiguracja

```
frontend k8s-api
    bind *:6443
    mode tcp          # TLS passthrough do API server

frontend ingress-http
    bind *:80
    mode http         # HTTP — Traefik obsługuje przekierowanie

frontend ingress-https
    bind *:443
    mode tcp          # TLS passthrough do Traefika
```

**Docker Compose — bindowanie na konkretnym IP:**

```yaml
ports:
  - "192.168.0.45:80:80"
  - "192.168.0.45:443:443"
  - "192.168.0.45:6443:6443"
```

Bez `network_mode: host` — mapowanie portów daje dodatkową warstwę izolacji.

---

### 8. kubectl port-forward

Narzędzie do tymczasowego dostępu do serwisu/poda bez Ingressu:

```bash
kubectl port-forward -n kube-system deployment/traefik 9000:9000
# Otwórz http://localhost:9000/dashboard/
```

Przydatne do: dashboardów, debugowania, jednorazowego dostępu.

---

## Backlog (do zrobienia)

- [ ] Zmienić `--server` na workerach z IP mastera na `https://cluster.kcn333.com:6443`
- [ ] Usunąć `192.168.0.46` z TLS SAN (po potwierdzeniu że wszystko działa na `.45`)
- [ ] Cronjob z automatycznym backupem etcd na inny serwer
- [ ] Traefik dashboard z BasicAuth
- [ ] `service.ipFamilyPolicy: SingleStack` w Traefiku (fix IPv6)
- [ ] PersistentVolume / PersistentVolumeClaim
- [ ] Zablokować bezpośredni dostęp do portów nodów (ufw + NetworkPolicy)
- [ ] **Flux — GitOps, CD** ← następny krok
- [ ] RBAC — własni użytkownicy
- [ ] Własna aplikacja w Pythonie lub Javie
- [ ] Własne Helm charts
- [ ] Pełne CI/CD pipeline
- [ ] Sealed Secrets / External Secrets Operator

---

## Przydatne komendy

```bash
# TLS diagnostyka
echo | openssl s_client -connect <host>:<port> 2>/dev/null | \
  openssl x509 -text -noout | grep -A10 "Subject Alternative Name"

# Traefik
kubectl get helmchartconfig -n kube-system
helm get values traefik -n kube-system
kubectl rollout restart deployment traefik -n kube-system

# etcd backup
sudo k3s etcd-snapshot save --name <nazwa>
sudo k3s etcd-snapshot ls

# DNS debug
curl -w "\ntime_namelookup: %{time_namelookup}\n" -o /dev/null -s <url>
dig <domena>
curl -4 <url>   # wymuś IPv4
```