# 00 Plan

Plan docelowy:
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
```
master (server + embedded sqlite)  
worker1  
worker2
```

```
HAProxy
   ↓
3× k3s server (z etcd)
   ↓
workload + ingress
```


## Krok 0  — Zewnętrzny LoadBalancer

Debian Server :
[[HA k8s/HAProxy|HAProxy (TCP dla API server + HTTP dla ingress)]]

## Krok 1 — Wyłączenie klastra

Na wszystkich 3 nodach:

`sudo /usr/local/bin/k3s-uninstall.sh`

Na workerach:

`sudo /usr/local/bin/k3s-agent-uninstall.sh`

Dlaczego?

Bo k3s HA musi być inicjalizowany jako pierwszy node etcd.  
Nie możemy „nadpisać” istniejącej instalacji.

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
### `--cluster-init`
→ mówi k3s:
> tworzę nowy klaster HA z embedded etcd
### `--tls-san 192.168.0.46`
→ bardzo ważne  
To IP HAProxy.

Bez tego kube-apiserver nie zaakceptuje połączeń przez LB.

## Krok 3 — Pobierz token klastra

`sudo cat /var/lib/rancher/k3s/server/node-token`

## Krok 4 — Dodanie drugiego control-plane

Na 192.168.55.11:

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




