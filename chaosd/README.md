# chaosd — host-side Chaosnet station for the Portable Genera VLM

`chaosd` lets host programs open Chaosnet stream connections to the live
Genera VLM. It replaces cbridge for one job: serving the
`/tmp/chaos_stream` socket that the SUPDUP client uses (`supdup -C 401`).

## Build and test

```sh
cd chaosd
make            # builds chaosd and chaosd-test (clang via cc, -framework vmnet)
make test       # protocol core + stream front end; no root, no vmnet
```

## Run

Start the VLM first. `bridge100` only exists while the VLM runs. Then:

```sh
sudo ./chaosd -d            # -d traces every Chaos / chaos-ARP frame
```

In a second terminal, as your normal user:

```sh
cd ~/Public/Projects/supdup && ./supdup -C 401
printf 'RFC 401 STATUS\r\n' | nc -U /tmp/chaos_stream    # prints: ANS 32 + host name
```

To watch the wire:

```sh
sudo tcpdump -i bridge100 -e -n -XX 'ether proto 0x0804 or ether proto 0x0806'
```

Stop it with ^C or SIGTERM. chaosd sends CLS on every open connection,
removes the socket and stops the vmnet interface.

### Flags

| flag | meaning |
|---|---|
| `-a addr` | chaosd's own Chaos address, octal. Default **402** (subnet 1, host 2). The route-b second VLM also used 402, so don't run both at once, or pick another address. |
| `-s path` | stream socket. Default `/tmp/chaos_stream` (the path supdup expects). |
| `-N a.b.c.0` | the VLM's /24, from `genera.network: INTERNET\|192.168.2.2;…` in `~/.VLM`. Default `192.168.2.0`. This value picks the vmnet network. |
| `-S` | the VLM runs with `mode=shared` instead of `mode=private`. |
| `-n name` | name returned to incoming STATUS RFCs. Default: the short hostname, in upper case. |
| `-w n` | receive window in packets. Default 13 (Genera's default), maximum 32. |
| `-H name=addr` | a host name to accept in RFC lines, e.g. `-H genera=401` (repeatable). |
| `-R` | keep root. chaosd does not seteuid to `SUDO_UID` once vmnet is up (see *Privileges*). |
| `-d` | trace frames on stderr. |

## Socket protocol

This matches supdup's `chaos.c`:

```
client → RFC <host> <contact> [args]\r\n      host = octal address or a -H name
daemon → OPN Connection to host 401\r\n       then the socket is a raw byte stream
       | CLS <reason>\r\n                      refused by the host
       | LOS <reason>\r\n                      lost / unknown host / "LOS Timed out: …" (20 s)
       | ANS <n>\r\n<n bytes>                  simple-protocol answer (e.g. STATUS)
```

The RFC's data is `CONTACT args`, as written. After a failure or an ANS,
chaosd closes the socket.

When the client closes its end, chaosd sends a Chaos EOF, waits up to 10 s
for the EOF to be acknowledged, then sends CLS. When the peer sends EOF,
chaosd delivers the data before it and then half-closes the socket
(`shutdown(SHUT_WR)`). When the peer sends CLS or LOS, chaosd delivers
whatever data is still pending and then closes the socket. chaosd reads
from a socket only while the Chaos send window has room, and consumes
Chaos data (which reopens the peer's window) only as fast as the client
drains it.

## Privileges

vmnet needs root. chaosd starts the interface as root, creates the socket,
`chown`s it to `SUDO_UID:SUDO_GID` with mode 0660, and then drops its
effective ids to those with `setegid`/`seteuid`. The saved uid stays 0, so
it can take root back to stop the interface on exit. If chaosd is not run
through sudo, the socket gets mode 0666.

The official VLM's own `DropPrivileges` calls `seteuid(getuid())`, which
does nothing under sudo. Nobody has yet checked that vmnet I/O keeps
working after a real drop. If frames stop flowing once chaosd has started,
run it with `-R`.

## Design

**A vmnet station, not BPF.** The VLM (VLM-12.10.3 `network-darwin.c`) puts
Genera on a vmnet host-only network (`mode=private`). That is an L2
segment inside the vmnet framework. The host sees it as `bridge100`, but
frames between stations never need the host's IP stack. chaosd starts its
**own** vmnet interface in `VMNET_HOST_MODE` with exactly the VLM's
description:

- start address subnet.1, end subnet.254, mask 255.255.255.0;
- `vmnet_network_identifier_key` = UUIDv5 (SHA-1) with namespace
  `EBF87D3A-7D21-4D37-A92F-36E49E9F640D` over the 4-byte network-order
  subnet address. For 192.168.2.0 that is
  `97CFF149-CD12-5CE0-8A33-11B2E025E146`.

vmnet therefore places chaosd on the VLM's segment as a separate station
with a MAC that vmnet allocates. `port-log/vmnet-chaos-probe.c` showed
earlier that 0x0804 frames and chaos-ARP pass between vmnet stations.
Sending through BPF on `bridge100` would mean forging frames onto a
bridge that vmnet owns. A station of its own also gives chaosd its own
MAC, so Genera can ARP for it like any other host. Genera has no
Chaos-over-IP, so chaosd can only reach it over Ethernet.

**Wire format.** Ethertype 0x0804. The Chaos header is eight
little-endian 16-bit words:

1. opcode<<8 (the opcode is frame byte 15)
2. nbytes (low 12 bits) | forwarding count
3. destination address
4. destination index
5. source address
6. source index
7. packet#
8. ack#

Up to 488 data bytes follow. Chaos ARP uses ethertype 0x0806 with
htype 1, ptype 0x0804, hlen 6 and plen 2, and its protocol addresses are
little-endian. chaosd answers ARP for its own address. It learns peer
MACs from chaos-ARP and from same-subnet Chaos frames, and asks for
unknown addresses with rate-limited requests (at most one every 500 ms).
Cache entries are refreshed after 5 minutes.

**NCP.** chaosd follows the Genera 9.0 NCP
(`sys.sct/network/chaos-ncp.lisp`):

- RFC, OPN, EOF and DAT are controlled packets: numbered, queued until
  receipted, and retransmitted after 500 ms.
- Every packet's ack# is the last packet the user consumed, which opens
  the peer's window. A receipt only stops retransmission.
- STS and SNS carry packet# 0. The STS data is (receipt, window). An SNS
  is answered with STS.
- Duplicate, out-of-order and over-window packets are answered with STS.
  Out-of-order packets inside the window are buffered.
- Packet numbers wrap at 16 bits (Genera's `PKTNUM-<`).
- When data is unacknowledged, or after 60 s of silence, chaosd probes
  with SNS every 5 s. After 90 s without hearing from the peer, the
  connection is closed.
- Packets for unknown connections get LOS. Replies such as ANS, CLS, FWD
  and LOS are never answered.

Incoming RFCs for `STATUS` get an ANS carrying the host name in 32 bytes,
zero-padded. This is the format of Genera's `CHAOS-STATUS` server. Other
contacts are refused with CLS.

**Files.**

| file | role |
|---|---|
| `chaos-core.[ch]` | pure core: ARP, NCP, connection table. It is driven by `chaos_core_input()` and `chaos_core_tick()` and sends frames through an emit callback. |
| `chaos-stream.[ch]` | Unix-socket front end and the RFC line protocol. |
| `vmnet-transport.[ch]` | vmnet start/read/write/stop. The dispatch event is turned into a pipe byte, so everything runs on one `poll()` thread. |
| `netid.[ch]` | the VLM's network identifier. |
| `chaosd.c` | option parsing, privileges, signals, main loop. |
| `chaosd-test.c` | unit tests, using a scripted peer and an automatic mini-NCP peer. |
