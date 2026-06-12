# Networking the VLM on macOS (Apple Silicon) with vmnet

This guide replaces the Linux **tun/tap** networking instructions (e.g. the
`og2vlm` setup notes and the TUNTAP section of the top-level `README`) for the
Apple Silicon / Darwin port.

Genera presents a Layer-2 Ethernet NIC: it builds and consumes whole Ethernet
frames (`ETHERTYPE_IP` and `ETHERTYPE_CHAOS`). On Apple Silicon the host has no
raw L2 fabric to attach to and no native tap device, so the Darwin backend
(`life-support/network-darwin.c`) uses Apple's **`vmnet.framework`** — a
kext-free virtual L2 NIC with its own MAC — in **shared (NAT) mode**.

That one choice changes almost every step of the old tap recipe. The table at
the end maps each tap step to its vmnet equivalent.

---

## TL;DR

```sh
# 1. Build with the vmnet backend.
./configure --with-vmnet
make

# 2. Boot ONCE as root and read the subnet vmnet hands you.
sudo ./genera          # look for: "net #0 vmnet subnet 192.168.2.1 - ... gateway = 192.168.2.1"
#                        then quit.

# 3. Put a static address from that subnet into your .VLM file, e.g.
#    genera.network: 192.168.2.2;mask=255.255.255.0;gateway=192.168.2.1

# 4. Boot for real.
sudo ./genera
```

No `tunctl`, no `ifconfig`, no `iptables`, no `ip_forward`. vmnet provides the
interface, a DHCP server, and outbound NAT for you.

---

## 1. Build with the vmnet backend

The vmnet code is compiled in only when you configure with `--with-vmnet`:

```sh
./configure --with-vmnet
make
```

Without it, the macOS network backend is a **sink**: it populates enough of the
embedded channel structure to let Genera's network/namespace init finish
booting, but it moves no host traffic. Use the sink build if you only need a
local Lisp world and no networking; use `--with-vmnet` for real connectivity.

`--with-vmnet` is Darwin-only and adds `-DUSE_VMNET`, `-fblocks`, and
`-framework vmnet` to the build.

## 2. You must run as root

vmnet **shared mode requires root**. Run the VLM under `sudo`:

```sh
sudo ./genera
```

If you don't, `vmnet_start_interface` fails and the VLM aborts with:

```
vmnet_start_interface failed (status N) for VLM network interface #0
  -- shared mode requires running genera as root (sudo)
```

> This is the opposite of the tap setup, whose whole point was running
> *unprivileged* after a one-time `tunctl`. There is no unprivileged path with
> vmnet shared mode.

## 3. Let vmnet pick the subnet, then match Genera to it

In shared mode, vmnet **chooses its own NAT subnet**, runs a DHCP server on it,
and places the gateway at the subnet's **start address**. Genera does **not**
DHCP — it uses the static address you configure — so that static address (and
gateway) **must fall inside the subnet vmnet allocated**.

You don't know the subnet until runtime. On startup the backend prints it:

```
net #0 vmnet subnet 192.168.2.1 - 192.168.2.254 mask 255.255.255.0 (gateway = 192.168.2.1); align Genera's static address with this range
```

So the flow is a deliberate two-pass:

1. **Boot once** (`sudo ./genera`), read the `vmnet subnet ...` line, then quit.
2. Pick an unused host address in that range for the guest (e.g.
   `192.168.2.2`) and set the gateway to the printed start address.
3. Write those into your `.VLM` file (next section) and boot for real.

> **On this machine** the vmnet shared subnet is currently **`192.168.2.0/24`**
> with the host/gateway at **`192.168.2.1`** — you can see it now as the
> `bridge100`/`vmenet0` interface in `ifconfig` (left by an existing vmnet
> client). macOS shared mode tends to reuse this `192.168.2.x` range, which is
> why the examples below use it. It is still assigned by macOS, not chosen by
> you — do not hard-code an arbitrary subnet the way the tap guide did
> (`192.168.6.x`). Always confirm against the `net #0 vmnet subnet ...` line the
> backend prints, and against `ifconfig` (look for the `bridgeN` whose member is
> a `vmenetN`).

## 4. Configure the address in your `.VLM` file

Networking is specified with the `genera.network` resource in your `.VLM`
file, in `address;option;option` form (see the sample `dot.VLM`):

```
genera.network: 192.168.2.2;mask=255.255.255.0;gateway=192.168.2.1
```

- The leading **device name is optional and cosmetic** under vmnet — there is
  no kernel interface to bind, so a `tap0:` prefix (if present) only labels the
  channel. You can omit it.
- `INTERNET|` is implied for a dotted-quad address; the options after each `;`
  (`mask=`, `gateway=`, `host=`, …) are passed through to Genera unchanged.

You can equivalently pass this on the command line:

```sh
sudo ./genera -network "192.168.2.2;mask=255.255.255.0;gateway=192.168.2.1"
```

## 5. MAC address is owned by vmnet

In the tap world you assigned MACs freely (that is how the README bridged
several VLMs). Under vmnet you **cannot**: vmnet *allocates* the guest MAC and
*validates the source MAC on every transmitted frame*. The backend adopts the
allocated address at startup and rewrites any outbound frame whose source MAC
doesn't match. Any MAC you set in config is overridden. The MAC actually in use
is printed at boot:

```
net #0 MAC 00:50:56:xx:xx:xx
```

## 6. What you do NOT need anymore

The following tap-era steps are handled by vmnet and should be **skipped**:

- `sudo tunctl -u <user>` / `sudo ifconfig tap0 ... up` — no device to create.
- `sudo sysctl -w net.ipv4.ip_forward=1` — not applicable.
- `iptables -t nat ... SNAT/POSTROUTING` rules — shared mode does outbound NAT
  for you.
- Manually assigning the gateway IP to a host interface — vmnet is the gateway.

## 7. Reaching the guest, and the NAT limitation

- **Outbound from Genera → internet / your LAN:** works automatically through
  vmnet's NAT.
- **From this Mac → Genera:** works; the host has an interface in the vmnet
  subnet, so you can reach the guest's static address directly (add it to
  `/etc/hosts` if you like).
- **From other machines on your LAN → Genera:** does **not** work out of the
  box. Shared mode hides the guest behind NAT, so the tap-era trick of adding a
  static route (`networksetup -setadditionalroutes ...` /
  `route -p ADD ...`) on another host will **not** reach in. You would need
  port forwarding, or a different vmnet mode (see below). Inbound logins to the
  guest are likewise not reachable from outside without extra work.

> **NFS is the exception, not a casualty of NAT.** In the documented setup the
> *host* is the NFS server and *Genera is the client* — the connection is
> guest → host, the same direction outbound traffic already takes, so it works
> fine under shared mode. See §8.

## 8. Host file sharing (NFS)

NFS is not part of the VLM — it is entirely host-OS plus Genera-world
configuration — but it is the usual way Genera reaches the Unix host's files,
so it is worth covering here.

**Direction matters, and it is in your favor.** In the documented setup the
**macOS host is the NFS server** and **Genera is the client** (the tap-era
`/etc/exports` line `/ kronos(rw,...)` exports the host *to* the guest). The
guest therefore *initiates* the mount toward the host, which sits at the vmnet
gateway address — that is plain guest → host traffic, so NFS works under shared
mode **without** port forwarding or a route hack.

The Linux instructions do **not** port verbatim, though:

**1. macOS uses BSD `/etc/exports` syntax, not the Linux `client(opts)` form.**
The Debian line becomes, scoped to the vmnet subnet you read at boot:

```
/Users/me/genera-share -mapall=me -network 192.168.2.0 -mask 255.255.255.0
```

Replace `me` with your macOS short username (or a numeric UID, e.g.
`-mapall=501`). Why `-mapall` instead of the `-maproot=root` you might expect:

- **Read-write is the default.** BSD/macOS exports have no `-rw` keyword — an
  export is read-write unless you add **`-ro`**. So the line above already
  grants write access; you never write `rw`.
- **UID mapping is the real gate, not the `rw` flag.** An export being
  read-write only means the *protocol* permits writes; each write still has to
  pass normal Unix permission checks under whatever UID the request arrives as.
  By default NFS squashes client root to `nobody`, and every other client UID
  must *match* a server UID that can write the files — so a mismatched Genera
  UID gets permission-denied even on an RW export.
- **`-mapall=<you>` collapses every client UID (root included) onto your
  account**, so all reads and writes land with your permissions regardless of
  what UID Genera presents. For a single-user Genera setup this is the reliable
  choice. Use `-maproot=root` instead (the equivalent of Linux
  `no_root_squash`) only when you need to preserve distinct client UIDs;
  `-mapall` and `-maproot` are mutually exclusive on one line.
- `-network`/`-mask` (or a literal client IP) scopes *who* may mount. There is
  no `-sync`/`-no_subtree_check` equivalent — those Linux options have no
  counterpart here.

**2. Enable the server with `nfsd`, not `nfs-kernel-server`:**

```sh
sudo nfsd enable         # start at boot
sudo nfsd start          # or: sudo nfsd restart, after editing /etc/exports
sudo nfsd checkexports   # validate /etc/exports
showmount -e localhost   # confirm what is exported
```

**3. You cannot export `/`.** On modern macOS the system volume is sealed and
read-only (SIP/APFS), so the doc's `/ kronos(rw,...)` is impossible. Export a
real data directory under `/Users` instead.

**On the Genera side**, point the host's file-system access at the **vmnet
gateway address** (where the macOS host lives on the vmnet subnet), not an old
LAN address, and make sure the export permits the guest's static address.

> **Untested compatibility note.** Genera's NFS client is old (NFSv2/v3) while
> macOS `nfsd` today is primarily NFSv3. If mounts fail, version/transport
> negotiation (force v3, or try UDP vs TCP) is the first thing to check. This
> path has not been verified on this port.

## 9. Multiple VLMs and Chaosnet

vmnet does carry full L2 frames, and the backend handles `ETHERTYPE_CHAOS`, so
Chaosnet between guests on the same vmnet is possible in principle. Two caveats:

- There is **no host-side Linux Chaosnet kernel module** here; that part of the
  README's motivation does not apply on macOS.
- The backend currently hard-codes `VMNET_SHARED_MODE`. It is **not verified**
  that shared mode faithfully forwards non-IP ethertypes (CHAOS) between two
  guests. If inter-VLM Chaosnet is the goal, `VMNET_HOST_MODE` (isolated,
  host-only L2 — closer to a dumb bridge) may be more faithful, but selecting
  it is a source change in `StartVMNetInterface`, not a config option.

## 10. Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| `vmnet_start_interface failed ... requires root` | Not running under `sudo`. |
| Booted but no host traffic, no `vmnet subnet` line | Built without `--with-vmnet` (sink backend). |
| Guest can't route off-host | Static address/gateway not inside the printed vmnet subnet. |
| `frame source MAC != interface MAC; rewriting it` warning | Harmless once; vmnet enforces its allocated MAC and the backend fixes the frame. |
| Other LAN hosts can't reach Genera | Expected under shared-mode NAT (§7). |

---

## Appendix: tap step → vmnet equivalent

| Linux tap step | macOS vmnet |
| --- | --- |
| `tunctl -u user` / `ifconfig tap0 ... up` | Deleted — vmnet creates the interface |
| Run unprivileged after setup | **Requires `sudo`** every run |
| Pick guest IP / gateway freely | Must match vmnet's auto-assigned subnet (read it from stdout) |
| Assign MAC / bridge VLMs by MAC | vmnet allocates and enforces the MAC |
| `iptables` NAT + `ip_forward` | Deleted — shared mode NATs automatically |
| Static host routes for inbound access | Guest is behind NAT; won't work as written |
| `/etc/hosts`, NFS exports | Still apply, with the new IP and macOS syntax |
