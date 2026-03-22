# 04 - UFW + backup

# K3s Homelab — Sesja 04

**Data:** 2026-03-01  
**Środowisko:** 3x HP T630, k3s v1.34.4, HAProxy, Traefik v3.6.7

---

## Co zbudowaliśmy

- Diagnoza i naprawa problemu z IPv6/DNS (PiHole bez upstream DNS)
- UFW firewall na wszystkich nodach przez Ansible
- Automatyczny backup etcd na serwer Debiana przez rsync + cron

---

## Czego się nauczyłem

### 1. Diagnoza problemów — metodologia

**Zawsze szukaj problemu u źródła**, nie łataj klientów. Przykład z dzisiejszej sesji:

- Objaw: `time_namelookup: 15s` w curlu
- Błędne podejście: wyłączanie IPv6 na klientach (WSL, Debian)
- Właściwe podejście: sprawdzenie PiHole → brak upstream DNS po aktualizacji

**Narzędzia do diagnozy DNS:**

```bash
# Szczegółowy timing curl
curl -w "\ntime_namelookup: %{time_namelookup}\ntime_connect: %{time_connect}\n" \
  -o /dev/null -s https://domena.com

# Bezpośrednie zapytanie DNS
dig domena.com
dig domena.com @192.168.0.46  # konkretny serwer DNS

# Wymuś IPv4
curl -4 https://domena.com
```

---

### 2. TLS SAN — dynamiczny certyfikat k3s

k3s zarządza certyfikatem API servera przez mechanizm **dynamic listener** — Secret `k3s-serving` w namespace `kube-system`.

**Skąd k3s bierze SAN:**

- Flagi `--tls-san` z `k3s.service`
- Adresy IP wszystkich nodów w klastrze
- Nazwy nodów (`master`, `worker1`, `worker2`)
- Standardowe nazwy k8s (`kubernetes`, `kubernetes.default` itd.)
- **Historia z etcd** — adresy z poprzednich konfiguracji

**Usunięcie starych adresów z SAN:** Samo usunięcie `--tls-san` i restart nie wystarczy — k3s odtwarza Secret z danymi z etcd. Głębsza ingerencja w etcd byłaby potrzebna do pełnego wyczyszczenia. W praktyce — jeśli port nie jest dostępny, stary adres w SAN nie stanowi realnego zagrożenia.

**Rotacja certyfikatów:**

```bash
sudo k3s certificate rotate
sudo systemctl daemon-reload
sudo systemctl restart k3s
```

**Weryfikacja:**

```bash
echo | openssl s_client -connect <IP>:6443 2>/dev/null | \
  openssl x509 -text -noout | grep -A10 "Subject Alternative Name"
```

---

### 3. UFW — firewall na nodach k3s

**Porty wymagane przez k3s:**

|Port|Protokół|Opis|Skąd|
|---|---|---|---|
|22|TCP|SSH|Sieć zarządzania|
|6443|TCP|API Server|HAProxy + nody|
|80|TCP|HTTP Ingress|HAProxy|
|443|TCP|HTTPS Ingress|HAProxy|
|8472|UDP|Flannel VXLAN|Między nodami|
|10250|TCP|Kubelet|Między nodami|
|2379|TCP|etcd client|Między nodami|
|2380|TCP|etcd peer|Między nodami|

**Polityka domyślna:**

```bash
ufw default deny incoming
ufw default allow outgoing
```

**Ważna lekcja:** HAProxy działa na hoście `192.168.0.46` ale binduje na `192.168.0.45`. Reguły ufw muszą zezwalać na **oba adresy** — `192.168.0.45` (wirtualny) i `192.168.0.46` (fizyczny host).

**Sieć podów** też musi być dozwolona:

```yaml
- name: Allow pod network traffic
  community.general.ufw:
    rule: allow
    from_ip: 10.42.0.0/16
```

---

### 4. Ansible playbook dla UFW

```yaml
---
- name: Prepare UFW firewall for K3s
  hosts: all
  become: true
  
  tasks:
    - name: Install UFW
      ansible.builtin.apt:
        name: ufw
        state: present

    - name: Set default deny incoming
      community.general.ufw:
        policy: deny
        direction: incoming

    - name: Allow all outgoing
      community.general.ufw:
        policy: allow
        direction: outgoing

    - name: Allow SSH from local network
      community.general.ufw:
        rule: allow
        from_ip: 192.168.0.0/24
        port: '22'
        proto: tcp

    - name: Allow API and Web from LB (virtual IP)
      community.general.ufw:
        rule: allow
        from_ip: 192.168.0.45
        port: "{{ item }}"
        proto: tcp
      loop: ['6443', '80', '443']

    - name: Allow API and Web from LB (physical host)
      community.general.ufw:
        rule: allow
        from_ip: 192.168.0.46
        port: "{{ item }}"
        proto: tcp
      loop: ['6443', '80', '443']

    - name: Allow K3s cluster internal traffic
      community.general.ufw:
        rule: allow
        from_ip: 192.168.55.0/24
        port: "{{ item.port }}"
        proto: "{{ item.proto }}"
      loop:
        - { port: '6443', proto: 'tcp' }
        - { port: '8472', proto: 'udp' }
        - { port: '10250', proto: 'tcp' }
        - { port: '2379', proto: 'tcp' }
        - { port: '2380', proto: 'tcp' }

    - name: Allow pod network traffic
      community.general.ufw:
        rule: allow
        from_ip: 10.42.0.0/16

    - name: Enable UFW
      community.general.ufw:
        state: enabled

    - name: Enable logging
      community.general.ufw:
        logging: 'on'

    - name: Reject auth port
      community.general.ufw:
        rule: reject
        port: auth
        log: true

    - name: Limit SSH connections
      community.general.ufw:
        rule: limit
        port: ssh
        proto: tcp
```

**Testowanie na jednym nodzie przed wdrożeniem na wszystkich:**

```bash
ansible-playbook ufw.yml --limit master
```

**Weryfikacja po wdrożeniu:**

```bash
sudo ufw status verbose
```

---

### 5. Backup etcd — automatyczny przez rsync + cron

**Problem z uprawnieniami:** Pliki snapshotów mają uprawnienia `rw-------` i właściciel `root`. Rozwiązanie: `--rsync-path="sudo rsync"` + wpis w sudoers.

**Sudoers (bezpieczny wpis):**

```
kcn ALL=(ALL) NOPASSWD: /usr/bin/rsync --server *
```

Flaga `--server` ogranicza rsync tylko do trybu zdalnego serwera.

**Skrypt backupu:**

```bash
#!/bin/bash
BACKUP_BASE_DIR="/home/kcn/k3s_etcd_backup"
CURRENT_DATE=$(date +%Y-%m-%d_%H%M)
TARGET_DIR="$BACKUP_BASE_DIR/$CURRENT_DATE"
REMOTE_NODE="master"
REMOTE_PATH="/var/lib/rancher/k3s/server/db/snapshots/"

mkdir -p "$TARGET_DIR"

if ! rsync -avz \
  -e "ssh -i /home/kcn/.ssh/id_for_master_rsa" \
  --rsync-path="sudo rsync" \
  "$REMOTE_NODE:$REMOTE_PATH/" "$TARGET_DIR"; then
    echo "ERROR: rsync failed!" | logger -t etcd-backup
    exit 1
fi

echo "Backup finished: $CURRENT_DATE" | logger -t etcd-backup

# Retencja - usuń foldery starsze niż 30 dni
find "$BACKUP_BASE_DIR" -mindepth 1 -maxdepth 1 -type d -mtime +30 -exec rm -rf {} +
```

**Cron (na serwerze Debiana, user kcn):**

```
0 13 * * * /home/kcn/backup.sh >> /home/kcn/k3s_etcd_backup/backup.log 2>&1
```

Uruchomienie godzinę po automatycznym snapshocie k3s (12:00 UTC).

**Ważne dla crona:** zawsze podawaj jawną ścieżkę do klucza SSH — cron ma ograniczone środowisko i może nie czytać `~/.ssh/config`.

**k3s automatyczne snapshoty:**

- Domyślnie: raz dziennie o 12:00 UTC
- Domyślna retencja: 5 ostatnich snapshotów
- Rozmiar: ~5-7MB (rośnie wraz z liczbą zasobów w klastrze)

**Sprawdzenie snapshotów:**

```bash
sudo k3s etcd-snapshot ls
```

---

## Architektura bezpieczeństwa po sesji 04

```
Internet/LAN
     ↓
HAProxy (192.168.0.45:80/443/6443)
  host: 192.168.0.46
     ↓
ufw na nodach (whitelist: HAProxy + cluster subnet + pod network)
     ↓
Traefik (HTTP→HTTPS redirect) → Pody
API Server (TLS, cert-manager)
```

**Bezpośredni dostęp do nodów:** zablokowany przez ufw ✅  
**Ruch klastrowy:** dozwolony w podsieci `192.168.55.0/24` ✅  
**Sieć podów:** dozwolona `10.42.0.0/16` ✅

---

## Backlog (do zrobienia)

- [ ] **Flux — GitOps, CD** ← następny krok
- [ ] Traefik dashboard z BasicAuth
- [ ] PersistentVolume / PersistentVolumeClaim
- [ ] RBAC — własni użytkownicy
- [ ] Własna aplikacja w Pythonie lub Javie
- [ ] Własne Helm charts
- [ ] Pełne CI/CD pipeline
- [ ] Sealed Secrets / External Secrets Operator
- [ ] NetworkPolicy dla izolacji między aplikacjami

---

## Przydatne komendy

```bash
# UFW
sudo ufw status verbose
sudo ufw show added
ansible-playbook ufw.yml --limit <node>

# Backup etcd
sudo k3s etcd-snapshot ls
sudo k3s etcd-snapshot save --name <nazwa>
journalctl -t etcd-backup  # logi backupu

# Ansible
ansible-playbook playbook.yml --limit master  # test na jednym nodzie
ansible-playbook playbook.yml  # wszystkie nody
```