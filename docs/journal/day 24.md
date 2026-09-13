# K3s Homelab — start remotedialera i naprawa Hubble

**Data:** 2026-09-13

**Środowisko:** 3× HP T630, k3s `v1.34.4+k3s1`, Cilium `1.19.1 → 1.19.7`, Flux

## Cel sesji

1. Porównać poprawny start klastra z błędnym startem remotedialera z 2026-09-12.
2. Zaktualizować Cilium w obrębie gałęzi `1.19.x`.
3. Sprawdzić, czy aktualizacja naprawi Hubble.

## Start klastra i remotedialer

Klaster uruchomił się poprawnie. Wszystkie dziewięć ścieżek lokalny API server → kubelet zakończyło się powodzeniem.

Rzeczywiste czasy uruchomienia K3s:

| Node | `ExecMainStartTimestamp` | `ActiveEnterTimestamp` |
|---|---|---|
| `worker1` | 11:58:26 UTC | 11:59:02 UTC |
| `worker2` | 11:58:31 UTC | 11:58:56 UTC |
| `master` | 11:58:34 UTC | 11:59:02 UTC |

Kolejność rozpoczęcia procesów była podobna do błędnego startu z 2026-09-12. Różniła się kolejność osiągnięcia stanu aktywnego: tym razem pierwszy był `worker2`.

`worker2` początkowo ustabilizował tylko własny adres:

```text
Settled apiserver addresses sync: [192.168.55.12:6443]
```

Po pojawieniu się pozostałych serwerów watch EndpointSlice wygenerował kolejne zdarzenia. Druga synchronizacja objęła komplet:

```text
Settled apiserver addresses sync:
[192.168.55.10:6443 192.168.55.11:6443 192.168.55.12:6443]
```

`worker2` dołączył tunele do `master` i `worker1` bez ręcznej ingerencji.

W błędnym starcie z 2026-09-12 pełna lista z watch została anulowana przez późniejszą, niepełną listę `from server`. Nie pojawił się następny event, dlatego brakujący tunel nie został odtworzony. Zmiana adnotacji EndpointSlice wymusiła nową synchronizację i naprawiła połączenie.

Wniosek: kolejność osiągania gotowości wpływa na moment zdarzeń, ale problemem jest wyścig pomiędzy źródłami listy API serverów i mechanizmem `Cancelled/Settled`. Playbook pozostaje bez zmian; istniejąca kontrola wykrywa błąd, a resync EndpointSlice służy jako obejście.

## Stan Hubble przed aktualizacją

Cilium `1.19.1` raportowało lokalny Hubble jako `Ok`, a Relay wykrywał trzy peery. Mimo tego:

```text
hubble status: NOT_SERVING
master:  Unavailable
worker1: Unavailable
worker2: Unavailable
```

Hubble UI stale pokazywał:

```text
Data streams are reconnecting...
```

Port-forward do Hubble UI dawał ten sam wynik, dlatego wykluczono Traefika i Ingress.

`hubble-peer` miał `internalTrafficPolicy: Local` i mapowanie:

```text
10.43.158.216:443 → lokalny NodeIP:4244
```

Test z Poda Grafany do wszystkich `NodeIP:4244` kończył się `ConnectionRefusedError`. `tcpdump` na lokalnym nodzie pokazał SYN z Poda i odpowiedź:

```text
ICMP tcp port 4244 unreachable
```

Proces `cilium-agent` słuchał na `*:4244`. Połączenia node → node działały. UFW zezwalał na Pod CIDR i port `4244`, NetworkPolicy nie obejmowała Hubble, a Cilium host firewall był wyłączony. Pakiet nie docierał do netfiltera ani monitora Cilium. Problem znajdował się w datapath ruchu Pod → NodeIP.

## Aktualizacja Cilium

Przed zmianą wykonano snapshot embedded etcd:

```text
pre-cilium-1.19.7-20260913T122228Z
```

Chart `1.19.7` został sprawdzony lokalnie z aktualnymi wartościami Helm. Render zakończył się powodzeniem. W repo Flux zmieniono wyłącznie:

```diff
-      version: "1.19.1"
+      version: "1.19.7"
```

Nie zmieniano:

- `hostNetwork`;
- `kubeProxyReplacement=false`;
- trybu routingu VXLAN;
- Kubernetes IPAM;
- reguł UFW;
- konfiguracji Hubble.

Flux zastosował chart `cilium@1.19.7`. Po rolloutcie działały:

- trzy agenty Cilium `1.19.7`;
- operator `1.19.7`;
- Hubble Relay `1.19.7`;
- Hubble UI i backend `0.13.5`;
- wszystkie nody `Ready`;
- brak Podów w stanie innym niż `Running` lub `Succeeded`.

## Wynik

Po aktualizacji Hubble UI zaczął natychmiast wyświetlać przepływy i mapę usług dla namespace `clients`.

Kontrolny test z Poda Grafany:

```text
192.168.55.10:4244 CONNECTED
192.168.55.11:4244 CONNECTED
192.168.55.12:4244 CONNECTED
```

Aktualizacja Cilium `1.19.1 → 1.19.7` usunęła wcześniejszy problem Pod → NodeIP i przywróciła połączenia Hubble Relay z agentami. Nie ustalono konkretnego commita odpowiedzialnego za poprawkę, dlatego nie należy przypisywać awarii pojedynczemu błędowi źródłowemu bez dalszej analizy wydań.

## Stan końcowy

- Cilium: `1.19.7`.
- Hubble Relay: działa.
- Hubble UI: działa.
- Mapy usług i przepływy dla `clients`: dostępne.
- Dodatkowe reguły UFW: niepotrzebne.
- `hostNetwork`: niepotrzebny.
- Problem Hubble: rozwiązany operacyjnie.
- Problem startowej synchronizacji remotedialera: nadal nierozstrzygnięty; dostępne obejście przez resync EndpointSlice.

