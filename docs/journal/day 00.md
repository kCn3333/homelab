# 0 - Planowanie

Przygotowanie środowiska pod klaster HA k3s z embedded etcd oraz zewnętrznym Load Balancerem (HAProxy).

kluczowe założenia:

- control-plane HA (3 nody)
- embedded etcd (bez zewnętrznego DB)
- ruch przez jeden punkt wejścia (HAProxy)

```
HAProxy
   ↓
3× k3s server (z etcd)
   ↓
workload + ingress
```

---

## Plan docelowy
- HA control plane    
- persistent storage z replikacją    
- backup etcd    
- monitoring control plane    
- alerting    
- log aggregation    
- ingress z TLS    
- GitOps    
- sieć z politykami (NetworkPolicies)    
- RBAC sensownie skonfigurowany    
- secrets management    
- disaster recovery plan
---

## Krok 0 — Zewnętrzny LoadBalancer

Debian Server :
https://github.com/kCn3333/docker-compose/tree/main/haproxy


Dlaczego HAProxy zamiast MetalLB?

- działa jako L4/L7 proxy
- daje pełną kontrolę nad routingiem
- lepszy do nauki niż "magiczny" LB

## Krok 1 — Wyłączenie klastra

Na wszystkich 3 nodach:

`sudo /usr/local/bin/k3s-uninstall.sh`

Na workerach:

`sudo /usr/local/bin/k3s-agent-uninstall.sh`

Klaster HA w k3s musi być inicjalizowany od pierwszego noda z --cluster-init, ponieważ to on tworzy początkowy stan etcd. Próba nadpisania istniejącej instalacji kończy się niespójnym stanem danych.

Sprawdź:

`ls /var/lib/rancher`

Jeśli coś zostało:

`sudo rm -rf /var/lib/rancher`


## Krok 2 — Pierwszy control-plane (inicjalizacja etcd)

Na 192.168.55.10:

```bash
curl -sfL https://get.k3s.io | INSTALL_K3S_EXEC="  
server \  
--cluster-init \  
--tls-san 192.168.0.46  
" sh -
```
Kluczowe flagi:

`--cluster-init` → tworzy nowy klaster etcd

`--tls-san` → dodaje adres HAProxy do certyfikatu API servera

Bez tego kube-apiserver nie zaakceptuje połączeń przez LB.

## Krok 3 — Pobranie token klastra

`sudo cat /var/lib/rancher/k3s/server/node-token`

## Krok 4 — Dodanie drugiego control-plane

Na worker1 (192.168.55.11):

```bash
curl -sfL https://get.k3s.io | INSTALL_K3S_EXEC="  
server \  
--server https://192.168.55.10:6443 \  
--token <TOKEN> \  
--tls-san 192.168.0.46  
" sh -
```

Dlaczego `--server` wskazuje IP pierwszego noda?

Bo dołącza do istniejącego klastra etcd.

- `--cluster-init` = twórz nowe etcd    
- bez tego = dołącz do istniejącego etcd