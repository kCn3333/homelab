# 21 - CoreDNS Service Datapath

# K3s Homelab — kube-proxy, Cilium eBPF i VXLAN

**Data:** 2026-09-09

**Środowisko:** 3x HP T630, k3s v1.34.4+k3s1, Cilium v1.19.1, kube-proxy/iptables

---

### Cel sesji:

1. Ustalenie, skąd Service `kube-dns` zna aktualny backend CoreDNS.
2. Sprawdzenie reprezentacji Service i endpointu w iptables kube-proxy.
3. Porównanie translacji ClusterIP dla ruchu z hosta i z Poda.
4. Prześledzenie transportu do CoreDNS działającego na innym nodzie.
5. Potwierdzenie miejsca translacji adresu względem enkapsulacji VXLAN.

---

### 1. Stan klastra podczas testu

| Element         | Wartość                                                                        |
| :-------------- | :----------------------------------------------------------------------------- |
| Service         | `kube-system/kube-dns`                                                         |
| Typ             | `ClusterIP`                                                                    |
| ClusterIP       | `10.43.0.10`                                                                   |
| Porty DNS       | `53/UDP`, `53/TCP`                                                             |
| Pod CoreDNS     | `10.42.1.113` na `worker1`                                                     |
| Pod testowy     | `10.42.0.161` na `master`                                                      |
| PodCIDR klastra | `10.42.0.0/16`                                                                 |
| Cilium          | VXLAN, `KubeProxyReplacement=False`, `Socket LB=Disabled`, `ClusterIP=Enabled` |

Test dotyczył wyłącznie ruchu do `ClusterIP` na porcie `53/UDP` w aktualnej konfiguracji klastra.

### 2. Service i EndpointSlice

Klient DNS korzystał ze stałego frontendu:

```text
10.43.0.10:53
```

Service nie jest procesem ani serwerem DNS. Definiuje wirtualny frontend i wybór backendów. Zapytanie analizuje dopiero CoreDNS.

Aktualny backend był zapisany w EndpointSlice:

```text
10.42.1.113:53, ready=true
```

EndpointSlice uczestniczy w ścieżce sterowania:

1. Kontroler EndpointSlice zapisuje adresy i gotowość Podów pasujących do selektora Service.
2. kube-proxy i Cilium obserwują Service oraz EndpointSlice przez Kubernetes API.
3. kube-proxy aktualizuje iptables, a Cilium aktualizuje mapy eBPF.
4. Pakiet korzysta z zaprogramowanego dataplane i nie odpytuje EndpointSlice.

### 3. Reprezentacja Service w iptables

Na `master` zaobserwowano następujący łańcuch kube-proxy:

```text
KUBE-SERVICES
  10.43.0.10:53/UDP
    → KUBE-SVC-TCOU7JCQXEZGVUNU
      → KUBE-SEP-L5JRWRCR3OTUNAH5
        → DNAT 10.42.1.113:53
```

| Łańcuch         | Rola                                                       |
| :-------------- | :--------------------------------------------------------- |
| `KUBE-SERVICES` | Rozpoznaje adres, protokół i port Service.                 |
| `KUBE-SVC-*`    | Reprezentuje port konkretnego Service i wybiera backend.   |
| `KUBE-SEP-*`    | Reprezentuje konkretny endpoint i wykonuje DNAT do Pod IP. |

`KUBE-SEP-*` nie jest obiektem EndpointSlice. Jest lokalną regułą utworzoną przez kube-proxy na podstawie danych pobranych z Kubernetes API.

### 4. ClusterIP na poziomie hosta

Na `master` potwierdzono:

```text
10.43.0.10 nie jest przypisany do interfejsu
brak dedykowanej trasy do 10.43.0.10
```

Proces hosta może korzystać z ClusterIP, ponieważ kube-proxy programuje reguły netfilter na nodzie. Zwykły host w LAN-ie nie ma tych reguł ani standardowo trasy do Service CIDR.

Ruch z procesu noda jest ruchem spoza sieci Podów, ale nie jest tym samym co ruch z dowolnego klienta w LAN-ie.

### 5. Trasa do zdalnego PodCIDR

Decyzja routingu na `master`:

```console
$ ip route get 10.42.1.113
10.42.1.113 dev cilium_host src 10.42.0.9 uid 1000
    cache mtu 1450
```

Powiązana trasa:

```text
10.42.1.0/24 via 10.42.0.9 dev cilium_host src 10.42.0.9 mtu 1450
```

Wnioski:

* DNAT wskazuje adres backendu, ale nie tworzy trasy do niego;
* zdalny PodCIDR `10.42.1.0/24` jest osiągalny przez `cilium_host`;
* `10.42.0.9` jest infrastrukturalnym adresem hostowym Cilium na `master`;
* MTU `1450` uwzględnia narzut tunelu VXLAN;
* Cilium odpowiada za transport do Poda na innym nodzie.

### 6. Test ruchu z hosta

Na `master` wykonano dziesięć oddzielnych zapytań:

```bash
for i in $(seq 1 10); do
  dig +tries=1 +time=1 +short \
    @10.43.0.10 \
    kubernetes.default.svc.cluster.local A
done
```

Każde zapytanie zwróciło `10.43.0.1`. Liczniki reguł wzrosły do:

```text
[10:1050] KUBE-SERVICES ... 10.43.0.10 ... udp dpt:53
[10:1050] KUBE-SVC-* ... → 10.42.1.113:53
[10:1050] KUBE-SEP-* ... DNAT 10.42.1.113:53
```

Wniosek: dla ruchu z procesu hosta translację `10.43.0.10:53 → 10.42.1.113:53` wykonał kube-proxy przez iptables.

Reguła `KUBE-MARK-MASQ` również otrzymała trafienia, ponieważ źródło hostowe nie należało do PodCIDR `10.42.0.0/16`.

### 7. Test ruchu z Poda

Pod `10.42.0.161` działał na `master`. Wykonano pięć oddzielnych zapytań `nslookup` do `10.43.0.10`.

| Moment                             | Licznik reguły kube-proxy |
| :--------------------------------- | ------------------------: |
| Przed pięcioma zapytaniami z Poda  |                 `[1:105]` |
| Po pięciu zapytaniach z Poda       |                 `[1:105]` |
| Po jednym kontrolnym `dig` z hosta |                 `[2:210]` |

Pięć zapytań z Poda nie zwiększyło licznika iptables, natomiast kontrolne zapytanie z hosta zwiększyło go o jeden pakiet i 105 bajtów.

Wniosek: dla badanego ruchu z Poda translację ClusterIP wykonał Cilium w eBPF, przed dojściem pakietu do reguł kube-proxy na hoście.

Liczniki tabeli `nat` odnoszą się do pierwszych pakietów nowych przepływów śledzonych przez conntrack, a nie do wszystkich pakietów zapytania i odpowiedzi.

### 8. Potwierdzenie VXLAN

Capture zapytania z Poda pokazał:

```text
outer: 192.168.55.10 → 192.168.55.11:8472
inner: 10.42.0.161 → 10.42.1.113:53/UDP
query: A kubernetes.default.svc.cluster.local
```

Drugie zapytanie dotyczyło rekordu `AAAA` i korzystało z tej samej drogi. Odpowiedź wróciła jako:

```text
outer: 192.168.55.11 → 192.168.55.10:8472
inner: 10.42.1.113:53 → 10.42.0.161
```

W pakiecie wewnętrznym nie było już adresu `10.43.0.10`. Translacja Service do backendu nastąpiła na `master` przed enkapsulacją VXLAN.

Capture ruchu z procesu hosta pokazał:

```text
outer: 192.168.55.10 → 192.168.55.11:8472
inner: 10.42.0.9 → 10.42.1.113:53/UDP
```

Odpowiedź wróciła przez VXLAN do `10.42.0.9`. Conntrack i netfilter wykonały odwrotne translacje NAT, dlatego aplikacja hostowa komunikowała się logicznie z `10.43.0.10:53`.

### 9. Porównanie ścieżek

| Źródło ruchu       | Translacja ClusterIP  | Transport do zdalnego Poda |
| :----------------- | :-------------------- | :------------------------- |
| Proces na `master` | kube-proxy / iptables | Cilium VXLAN               |
| Pod na `master`    | Cilium eBPF           | Cilium VXLAN               |

Wspólny był transport między nodami przez Cilium VXLAN. Różniło się miejsce realizacji translacji Service.

### 10. Najważniejsze wnioski

1. Service i EndpointSlice należą do ścieżki sterowania; pakiet korzysta z lokalnie zaprogramowanego dataplane.
2. ClusterIP nie musi istnieć na interfejsie ani w tablicy routingu hosta.
3. kube-proxy reprezentuje Service za pomocą łańcuchów `KUBE-SERVICES`, `KUBE-SVC-*` i `KUBE-SEP-*`.
4. Dla badanego ruchu hostowego translację ClusterIP wykonał kube-proxy w iptables.
5. Dla badanego ruchu z Poda translację ClusterIP wykonał Cilium eBPF.
6. DNAT i routing są osobnymi operacjami: po wyborze backendu Cilium musi jeszcze zapewnić trasę do jego PodCIDR.
7. Translacja `ClusterIP → Pod IP` nastąpiła przed enkapsulacją VXLAN.
8. `KubeProxyReplacement=False` nie oznacza, że Cilium nie obsługuje żadnego ruchu ClusterIP.
9. Wyniku nie należy rozszerzać na NodePort, LoadBalancer, Ingress ani ruch przychodzący z LAN-u bez osobnych testów.

### Przydatne komendy

```bash
kubectl get service kube-dns \
  --namespace kube-system \
  --output wide

kubectl get endpointslices \
  --namespace kube-system \
  --selector kubernetes.io/service-name=kube-dns \
  --output wide
```

```bash
ssh master \
  "sudo iptables-save -c -t nat | \
   grep 'kube-system/kube-dns:dns' | \
   grep -v 'dns-tcp'"
```

```bash
ssh master 'ip route get 10.42.1.113'
```

```bash
ssh master \
  'sudo timeout 15 tcpdump -ni enp1s0 -nn -vv udp port 8472'
```

### Następna sesja:

Porównanie ścieżek `ClusterIP`, `NodePort` i `LoadBalancer` oraz sprawdzenie, które elementy obsługuje kube-proxy, Cilium i Traefik w aktualnej konfiguracji klastra.
