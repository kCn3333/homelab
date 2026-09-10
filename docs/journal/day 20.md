# 20 - CoreDNS Failure Recovery

# K3s Homelab — Kontrolowana awaria CoreDNS

**Data:** 2026-09-07–2026-09-08 

**Środowisko:** 3x HP T630, k3s v1.34.4+k3s1, Cilium v1.19.1, CoreDNS v1.14.1

---

### Cel sesji:

1. Obserwacja wymiany Poda CoreDNS i aktualizacji EndpointSlice.
2. Pomiar dostępności DNS przy jednej replice.
3. Powtórzenie testu przy dwóch replikach na różnych nodach.
4. Sprawdzenie, czy drugi gotowy endpoint eliminuje wszystkie błędy DNS.
5. Diagnoza błędów `kubectl exec` wykrytych podczas testu.
6. Podjęcie decyzji o docelowej liczbie replik w małym klastrze.

---

### 1. Stan początkowy

CoreDNS był zarządzany przez wbudowany AddOn K3s i działał jako pojedyncza replika:

```text
Deployment: coredns
Ready:      1/1
Pod IP:     10.42.2.115
Node:       worker2
```

Service DNS zachowywał stały frontend:

```text
Service:   kube-system/kube-dns
ClusterIP: 10.43.0.10
Ports:     53/UDP, 53/TCP, 9153/TCP
```

EndpointSlice wskazywał jeden backend z warunkami:

```text
ready=true
serving=true
terminating=false
```

### 2. Znaczenie warunków EndpointSlice

| Warunek | Znaczenie |
|:--|:--|
| `ready` | Endpoint może przyjmować zwykły ruch Service. |
| `serving` | Endpoint nadal potrafi obsługiwać ruch. |
| `terminating` | Powiązany Pod jest usuwany. |

Usuwany Pod może mieć jednocześnie:

```text
ready=false
serving=true
terminating=true
```

Oznacza to wycofanie z normalnego ruchu przy trwającym jeszcze zamykaniu procesu.

### 3. Test jednej repliki

Usunięto wyłącznie Pod CoreDNS. Deployment, ReplicaSet i Service pozostały bez zmian:

```bash
kubectl delete pod <COREDNS_POD> \
  --namespace kube-system \
  --wait=false
```

ReplicaSet utworzył nowy Pod, a scheduler umieścił go na innym nodzie:

```text
stary: 10.42.2.115 na worker2
nowy:  10.42.1.76  na worker1
```

Zaobserwowana kolejność zmian:

1. Stary endpoint był gotowy.
2. Stary endpoint przeszedł do `terminating=true` i `ready=false`.
3. EndpointSlice przez chwilę nie zawierał żadnego endpointu.
4. Nowy endpoint pojawił się jako `ready=false`.
5. Nowy endpoint osiągnął `ready=true`.

Okno bez gotowego endpointu widoczne w Kubernetes API trwało około dwóch sekund. Pętla `nslookup` nie zarejestrowała błędu, ale nie był to dowód ciągłej dostępności każdego pakietu. Klient mógł ponowić zapytanie, a EndpointSlice, lokalny dataplane i proces CoreDNS zmieniały stan asynchronicznie.

### 4. Test dwóch replik

Deployment został tymczasowo przeskalowany:

```bash
kubectl scale deployment coredns \
  --namespace kube-system \
  --replicas=2
```

Topology spread umieścił Pody na różnych nodach:

| Pod IP | Node |
|:--|:--|
| `10.42.1.195` | `worker1` |
| `10.42.0.149` | `master` |

Usunięto Pod na `master`. Replika na `worker1` pozostała gotowa, a nowy Pod został utworzony na `worker2` z adresem `10.42.2.42`.

Podsumowanie zapisanych zmian EndpointSlice:

```text
events:          5
minimumReady:    1
zeroReadyEvents: 0
```

W żadnym z zaobserwowanych stanów Service nie stracił wszystkich gotowych backendów.

### 5. Wynik sond DNS

Zapytania były wysyłane równolegle z Podów przypisanych do każdego noda bezpośrednio do `10.43.0.10`:

```text
nslookup kubernetes.default.svc.cluster.local 10.43.0.10
```

Podczas wymiany jednej z dwóch replik sonda na `worker2` zarejestrowała pojedynczy wynik `FAILED`, mimo że EndpointSlice cały czas zawierał co najmniej jeden endpoint `ready=true`.

Najbardziej prawdopodobne wyjaśnienia:

- pakiet UDP trafił do kończącego pracę backendu;
- lokalny dataplane nie zakończył jeszcze aktualizacji;
- zmiana EndpointSlice i konfiguracji przekazywania ruchu nie nastąpiła jednocześnie.

Dwie repliki usunęły okno bez gotowego endpointu, ale nie zagwarantowały bezstratnego przełączenia pojedynczych pakietów UDP.

Pełne statystyki sond nie zostały zachowane, ponieważ testowe Pody usunięto przed zapisaniem logów. Zachowano natomiast obserwację EndpointSlice i pojedynczy błąd widoczny w strumieniu testowym.

### 6. Problemy z Podami diagnostycznymi

Pierwsza próba używała nieistniejącego obrazu:

```text
registry.k8s.io/e2e-test-images/dnsutils:1.3
```

Kubelet prawidłowo zwrócił `ErrImagePull` i `ImagePullBackOff`. Test powtórzono z dostępnym obrazem zawierającym `nslookup`.

Pody wykonujące skończone polecenie przechodziły do fazy `Succeeded`, więc nie nadawały się do późniejszego `kubectl exec`. W teście wymagającym kolejnych poleceń proces kontenera musi pozostać uruchomiony. Logi należy zapisać przed usunięciem Podów.

### 7. Incydent remotedialer

Podczas testu `kubectl exec` do Poda na `worker2` okresowo zwracał:

```text
proxy error from 127.0.0.1:6443 while dialing <WORKER2_IP>:10250,
code 502: 502 Bad Gateway
```

Wyniki diagnostyki:

- kubelet na `worker2:10250` był osiągalny ze wszystkich nodów i odpowiadał `HTTP 401`;
- lokalne API na `master` i `worker2` wykonywały `exec` poprawnie;
- lokalne API na `worker1` nie wykonywało `exec` do Poda na `worker2`;
- log K3s na `worker1` zawierał `failed to find Session for client worker2`;
- `egress-selector-mode` korzystał z domyślnej wartości `agent`.

Problemem był brak sesji tunelu remotedialer pomiędzy agentem `worker2` i serwerem K3s na `worker1`. Bezpośrednia łączność TCP z kubeletem działała, dlatego nie był to błąd CoreDNS, Cilium ani firewalla.

Po kontrolowanym restarcie K3s na `worker2` agent ponownie zestawił tunel. Końcowy test dał:

```text
3 lokalne API servery × 3 docelowe kubelety = 9/9 OK
```

### 8. Cordon bez drain

Przed krótkim restartem wykonano `cordon`, aby scheduler nie umieszczał nowych Podów na `worker2`.

`drain` nie był potrzebny, ponieważ:

- restart dotyczył wyłącznie usługi K3s;
- nie wykonywano prac na systemie operacyjnym ani storage;
- nie planowano długiej niedostępności noda;
- ewakuacja workloadów i relokacja wolumenów Longhorn zwiększyłyby zakres operacji.

Po odtworzeniu tunelu, potwierdzeniu `Node Ready`, gotowości Cilium oraz testach `9/9 OK` zdjęto cordon.

### 9. Wniosek dla Power On

`systemctl active`, `/readyz`, gotowość etcd i `Node Ready` nie potwierdzają poprawności wszystkich sesji remotedialer.

Końcowa walidacja Power On powinna sprawdzać dostęp do każdego kubeleta przez lokalne API każdego serwera, na przykład przez:

```text
/api/v1/nodes/<NODE>/proxy/healthz
```

Dla trzech serwerów i trzech nodów jest to dziewięć odczytów. Kontrola ma wykrywać błąd, ale nie wykonywać automatycznego restartu bez diagnozy.

### 10. Decyzja konfiguracyjna

Po teście przywrócono jedną replikę CoreDNS zarządzaną przez wbudowany AddOn K3s.

Nie wdrożono:

- zarządzania CoreDNS przez Flux;
- skalowania CoreDNS z playbooka Power On;
- `cluster-proportional-autoscaler`;
- dodatkowego PodDisruptionBudget.

Dwie repliki poprawiają dostępność podczas awarii Poda lub noda, ale nie zapewniają pełnego HA. W tym trzywęzłowym homelabie korzyść nie uzasadnia przejmowania wbudowanego komponentu K3s ani zwiększania zakresu odpowiedzialności automatyzacji Power On.

### 11. Stan końcowy

```text
Deployment/coredns: 1/1 Ready
Pod CoreDNS:        10.42.1.113 na worker1
Service/kube-dns:   10.43.0.10
EndpointSlice:      jeden endpoint, ready=true
```

Końcowe testy potwierdziły:

```text
kubernetes.default.svc.cluster.local. → 10.43.0.1
example.com.                           → rekordy A i AAAA
```

Restart kontenera CoreDNS odpowiadał czasowi uruchomienia klastra i nie wskazywał nowej awarii.

### 12. Najważniejsze wnioski

1. ReplicaSet odtwarza usunięty Pod, ale jedna replika może pozostawić krótkie okno bez backendu.
2. EndpointSlice pokazuje stan backendów, lecz nie przekazuje pakietów.
3. Dwie repliki utrzymały co najmniej jeden gotowy endpoint podczas usunięcia Poda.
4. Gotowy endpoint nie gwarantuje dostarczenia każdego pakietu UDP w trakcie konwergencji.
5. `Node Ready` nie potwierdza działania wszystkich tuneli używanych przez `exec`, `logs` i API proxy.
6. `cordon` wystarcza przy krótkiej, kontrolowanej operacji; `drain` powinien wynikać z zakresu maintenance.
7. Test powinien zapisywać wyniki przed cleanupem.
8. Dodatkową redundancję należy wdrażać tylko wtedy, gdy odpowiada wymaganiom i uzasadnia koszt operacyjny.

### Następna sesja:

Eksperymentalne prześledzenie dataplane `Service/kube-dns`: porównanie ruchu z procesu hosta i z Poda, liczników kube-proxy w iptables oraz transportu Cilium VXLAN do CoreDNS na innym nodzie.
