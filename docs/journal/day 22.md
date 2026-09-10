# 22 - ServiceLB, Traefik i Ingress

# K3s Homelab — droga ruchu z HAProxy do aplikacji

**Data:** 2026-09-10

**Środowisko:** k3s v1.34.4+k3s1, ServiceLB, Traefik v3, kube-proxy/iptables, Cilium v1.19.1

---

### Cel sesji:

1. Rozróżnienie typów Service: `ClusterIP`, `NodePort` i `LoadBalancer`.
2. Ustalenie ról HAProxy, ServiceLB, `klipper-lb` i Traefika.
3. Prześledzenie wejścia na porty `80/443` każdego noda.
4. Prześledzenie reguły Ingress Grafany do właściwego Poda.
5. Ustalenie, czy Traefik korzysta z ClusterIP backendu, czy łączy się bezpośrednio z Podem.

---

### 1. Typy Service

| Typ            | Zastosowanie                                                                                                   |
| :------------- | :------------------------------------------------------------------------------------------------------------- |
| `ClusterIP`    | Stabilny wirtualny adres dostępny wewnątrz klastra. Jest typem domyślnym.                                      |
| `NodePort`     | Udostępnia ten sam port z zakresu NodePort na każdym nodzie i kieruje ruch do backendów Service.               |
| `LoadBalancer` | Prosi implementację load balancera o zewnętrzne udostępnienie Service. W aktualnym K3s realizuje to ServiceLB. |

`NodePort` nie wymaga osobnego procesu nasłuchującego w userspace. kube-proxy programuje reguły iptables przechwytujące ruch do portu noda.

`kubectl port-forward` jest innym mechanizmem. Utrzymuje tymczasowy proces i tunel związany z działającym poleceniem. Nie jest typem Service.

### 2. Usunięcie nieużywanego testu Nginx

Pozostałość w namespace `flux-test` zawierała Deployment z trzema niedziałającymi replikami, Service typu NodePort, Ingress i PVC w stanie `Terminating`.

Przyczyną `Pending` był brak usuwanego PVC:

```text
persistentvolumeclaim "nginx-pvc" is being deleted
```

Po usunięciu katalogu `nginx` z aktywnej listy zasobów `apps/base/kustomization.yaml` i uzgodnieniu Fluxa pruning usunął zasoby oraz namespace. Potwierdzono również brak PV i wolumenu Longhorna powiązanego z dawnym PVC.

Pliki testu mogły pozostać w repo jako nieaktywne materiały, o ile nie są dołączone przez żadną Kustomization.

### 3. Service Traefika

Aktualny Service:

| Pole                    | Wartość                                        |
| :---------------------- | :--------------------------------------------- |
| Nazwa                   | `kube-system/traefik`                          |
| Typ                     | `LoadBalancer`                                 |
| ClusterIP               | `10.43.164.47`                                 |
| `externalTrafficPolicy` | `Cluster`                                      |
| HTTP                    | `80 → targetPort web`, NodePort `30367`        |
| HTTPS                   | `443 → targetPort websecure`, NodePort `31427` |

Status `LoadBalancer` zawierał adresy wszystkich nodów:

```text
192.168.55.10
192.168.55.11
192.168.55.12
```

NodePort odpowiadał na wszystkich trzech nodach. Porty `80/443` również odpowiadały bezpośrednio na wszystkich trzech adresach nodów.

### 4. ServiceLB, svclb i klipper-lb

ServiceLB jest kontrolerem dostarczanym przez K3s. Obserwuje Service typu `LoadBalancer` i dla każdego z nich tworzy DaemonSet nazwany od Service.

Dla `Service/traefik` utworzono:

```text
DaemonSet/svclb-traefik-33d14f91
```

DaemonSet miał po jednym Podzie na każdym nodzie. Każdy Pod zawierał dwa kontenery z obrazu:

```text
rancher/klipper-lb:v0.4.14
```

| Kontener     | `hostPort` | Cel                |
| :----------- | ---------: | :----------------- |
| `lb-tcp-80`  |   `80/TCP` | `10.43.164.47:80`  |
| `lb-tcp-443` |  `443/TCP` | `10.43.164.47:443` |

Pod miał `hostNetwork=false`, ale używał `hostPort`. `klipper-lb` jest programem i obrazem realizującym dataplane ServiceLB. Nie jest trzecią, niezależną warstwą load balancera.

Nazwa `svclb-traefik-*` pochodzi od obsługiwanego Service. ServiceLB nie jest częścią Traefika; utworzył zasoby nazwane od niego, ponieważ to `Service/traefik` ma typ `LoadBalancer`.

### 5. Rola zewnętrznego HAProxy

HAProxy działa poza klastrem i wybiera jeden z adresów nodów dla ruchu aplikacyjnego. W badanej ścieżce działa na L4 i przekazuje TCP do portu `80` lub `443` noda.

ServiceLB nie wybiera noda za HAProxy. Jego zadaniem jest zapewnienie punktu wejścia na wybranym już nodzie:

```text
HAProxy → node:80/443 → svclb/klipper-lb → Service/traefik
```

API Kubernetes na porcie `6443` korzysta z oddzielnego frontendu HAProxy i trafia bezpośrednio do serwerów API. Nie przechodzi przez ServiceLB ani Traefika.

### 6. Endpoint Traefika

EndpointSlice dla `Service/traefik` zawierał jeden gotowy backend:

```text
Pod:  traefik-6c78dd64c-95g7v
IP:   10.42.2.112
Node: worker2
```

Service Traefika przyjmował ruch pod stabilnym ClusterIP, a kube-proxy kierował go do bieżącego Poda Traefika. Traefik działał jako pojedyncza replika, dlatego w EndpointSlice znajdował się jeden backend.

### 7. Ingress Grafany

Obiekt Ingress deklarował:

| Pole       | Wartość                                    |
| :--------- | :----------------------------------------- |
| Namespace  | `monitoring`                               |
| Nazwa      | `kube-prometheus-stack-grafana`            |
| Klasa      | `traefik`                                  |
| Host       | `grafana.cluster.kcn333.com`               |
| Ścieżka    | `/`, `Prefix`                              |
| Backend    | `Service/kube-prometheus-stack-grafana:80` |
| TLS Secret | `grafana-tls`                              |

Ingress jest deklaracją Kubernetes. Nie przekazuje pakietów. Traefik jest Ingress Controllerem: obserwuje obiekty Ingress klasy `traefik`, tworzy na ich podstawie konfigurację routerów L7 i realizuje ją jako reverse proxy.

W tym przypadku Traefik:

1. odbiera połączenie HTTP lub HTTPS;
2. rozpoznaje host `grafana.cluster.kcn333.com` i ścieżkę `/`;
3. obsługuje TLS przy użyciu `grafana-tls`;
4. wybiera backend Grafany;
5. otwiera nowe połączenie do backendu.

### 8. Backend Grafany

Service backendu:

```text
Service:   monitoring/kube-prometheus-stack-grafana
Type:      ClusterIP
ClusterIP: 10.43.35.99
Port:      80
targetPort: grafana
```

EndpointSlice zawierał:

```text
Pod:  kube-prometheus-stack-grafana-677db88557-9m9ng
IP:   10.42.2.61
Node: worker2
Ready: true
```

Nie znaleziono:

* argumentu Traefika zawierającego `nativeLB`;
* adnotacji `traefik.ingress.kubernetes.io/service.nativelb` na Service Grafany.

Domyślna wartość `nativeLBByDefault` w providerze Kubernetes Ingress wynosi `false`. Traefik używa więc Service jako deklaracji backendu i źródła informacji o porcie, pobiera jego EndpointSlice, a następnie łączy się bezpośrednio z Podem `10.42.2.61`.

Traefik nie zastępuje obiektu Service. Service nadal wiąże nazwę backendu, selektor, port i endpointy. W tej konfiguracji jego ClusterIP nie znajduje się jednak w faktycznej ścieżce połączenia Traefik → Grafana.

### 9. Pełna ścieżka ruchu

```text
przeglądarka
→ HAProxy
→ wybrany node:80/443
→ Pod svclb-traefik / klipper-lb
→ ClusterIP Service/traefik 10.43.164.47
→ Pod Traefik 10.42.2.112
→ reguła L7 z Ingress
→ Pod Grafana 10.42.2.61
```

Traefik i Grafana działały na `worker2`, dlatego ostatnie połączenie było lokalne dla jednego noda. Gdyby Grafana została przeniesiona na inny node:

1. EndpointSlice otrzymałby nowy adres Poda.
2. Traefik zaktualizowałby listę swoich backendów.
3. Cilium przesłałoby nowe połączenie do zdalnego PodCIDR przez VXLAN.

### 10. Podział warstw

| Element                | Warstwa | Rola w badanej konfiguracji                                                    |
| :--------------------- | :------ | :----------------------------------------------------------------------------- |
| HAProxy                | L4      | Wybór noda i przekazanie TCP do klastra.                                       |
| ServiceLB / klipper-lb | L4      | Udostępnienie `Service/traefik` na `80/443` każdego noda.                      |
| kube-proxy             | L3/L4   | Reguły iptables, NodePort, ClusterIP i DNAT dla ruchu objętego jego dataplane. |
| Cilium                 | L3/L4   | Sieć Podów, lokalny datapath, routing i VXLAN pomiędzy nodami.                 |
| Traefik                | L7      | TLS, wybór routera według hosta i ścieżki oraz reverse proxy do aplikacji.     |

Cilium może realizować dodatkowe funkcje L7, ale nie były one używane ani testowane w tej ścieżce.

### 11. Ocena konfiguracji

Konfiguracja jest funkcjonalna i spójna:

* HAProxy zapewnia zewnętrzny punkt wejścia;
* ServiceLB udostępnia Service Traefika na standardowych portach nodów;
* Traefik realizuje routing aplikacyjny;
* Cilium zapewnia transport pomiędzy Podami.

ServiceLB można byłoby pominąć, kierując HAProxy bezpośrednio do NodePort Traefika, ale oznaczałoby to zmianę działającej architektury. W tej sesji pozostawiono aktualny układ bez modyfikacji.

### 12. Otwarte problemy

1. Hubble wymaga oddzielnej diagnozy i naprawy.
2. Dashboardy Grafany wyświetlają komunikat:

   ```text
   An error occurred within the plugin
   ```

   Problem należy zbadać niezależnie: stan Podów, logi Grafany, wersje pluginów, zapytania datasource i błędy w przeglądarce.

### 13. Najważniejsze wnioski

1. `Ingress` jest deklaracją routingu, a Traefik jej wykonawcą.
2. ServiceLB jest kontrolerem K3s, `svclb-*` wygenerowanym DaemonSetem, a `klipper-lb` jego dataplane.
3. ServiceLB nie wybiera noda; w tym układzie robi to zewnętrzny HAProxy.
4. `NodePort` i `kubectl port-forward` są różnymi mechanizmami.
5. Traefik kończy połączenie klienta i tworzy nowe połączenie do backendu.
6. Przy domyślnym `nativeLB=false` Traefik łączy się bezpośrednio z adresami Podów z EndpointSlice.
7. Cilium zapewnia transport L3/L4 po wyborze backendu przez Traefika.
8. VXLAN jest potrzebny tylko wtedy, gdy źródłowy i docelowy Pod znajdują się na różnych nodach.

### Następna sesja:

Diagnoza Hubble oraz błędu dashboardów Grafany `An error occurred within the plugin`. 
