# VM Manager – libvirt

libvirt provider for [VM Manager](https://marketplace.visualstudio.com/items?itemName=sourceregistry.vm-manager). It manages the QEMU/KVM domains libvirt already knows about, on this computer or on another one over SSH, by running `virsh`. There is no native binding and nothing to compile.

## Requirements

`virsh` (the libvirt client): macOS `brew install libvirt`; Debian and Ubuntu `apt install libvirt-clients`; Fedora `dnf install libvirt-client`. The extension looks on `PATH` and in the usual install folders; set **virsh program** in the cluster settings for anything else. The hypervisor side (libvirt with its QEMU driver) must run where the domains are.

## Connecting

Add a cluster of type **libvirt** and choose a **Connection**:

| Choice | URI | For |
|---|---|---|
| This computer, my user | `qemu:///session` | Your own domains, no privileges. The only choice on macOS (Homebrew starts the session daemon by itself). |
| This computer, system-wide | `qemu:///system` | Linux: needs access to libvirt (the `libvirt` group). |
| Another computer over SSH | `qemu+ssh://user@host/system` | Remote KVM hosts. Uses `ssh` with a key or the agent: virsh cannot ask for a password here, and an unknown host key is an error (connect once in a terminal to accept it). |
| Custom URI | any | Anything virsh understands. |

For SSH, `ControlMaster auto` (with `ControlPersist`) in `~/.ssh/config` makes it much faster: every refresh runs a few `virsh` commands.

## What it does

* **Domains** across the host, with state (running, paused, shut off, saved), CPU and memory, MAC and IP addresses (DHCP leases, or the guest agent when the domain has the channel).
* **Power**: start, shut down (ACPI, then offers *Power Off* when the guest ignores it; the wait is the *Shut down timeout* setting), reboot, force stop, reset.
* **Details page**: disks and CD/DVD drives (with sizes), network adapters, and live CPU, memory, disk and network charts.
* **Consoles**: the VNC display (and its password), and the serial console (a pty on this computer, a unix socket, or a TCP port; over SSH only the TCP port).
* **Create**: a domain from an installer ISO, or from a **cloud image** with cloud-init (Debian 12/13, Ubuntu 22.04/24.04 for the host's architecture, or a qcow2/raw file): the image is downloaded on this computer with its published checksum verified and cached, uploaded into a directory storage pool as the domain's disk (over libvirt's own connection, so `qemu+ssh://` hosts work too), enlarged to the asked size, and a `cidata` seed volume sets up your user, SSH key or password, host name and the guest agent on first boot. A pool is made in `~/.local/share/libvirt/images` (session) or `/var/lib/libvirt/images` (system) when the connection has none.
* **Media**: insert and eject an ISO in a CD/DVD drive, on a running domain too.
* **Snapshots**: take, revert and delete (`virsh snapshot-*`, libvirt's internal snapshots). A snapshot of a running domain includes its memory.
* **Delete**: removes the domain, its UEFI variables and snapshot metadata, and with *Delete disks* its disks: volumes of a storage pool through libvirt, other files by deleting them (this computer only).

## Not included yet

* Editing and cloning domains: use `virt-install`, `virt-manager`, Cockpit or `virsh edit`, and the change shows up here.
* Templates, port forwards, passthrough, SPICE displays.
* Uptime and CPU on macOS come from the QEMU process (libvirt has no cgroups there).

## Limits worth knowing

* libvirt refuses **snapshots of a UEFI domain** whose firmware variables are a raw file (the usual case, including every `firmware='efi'` domain with the Homebrew firmware): *internal snapshots of a VM with pflash based firmware require QCOW2 nvram format*. The extension says so; domains without UEFI snapshot fine.
* The serial console of a **pty** needs the domain on this computer.

## Status

Tested against a real libvirt 12.9 with QEMU 11.1 on Apple Silicon (HVF, `qemu:///session`): listing, start, stats, details, VNC banner, serial, media, snapshots with and without memory, shut down timeout, deletion, and a Debian 13 cloud image created, set up by cloud-init (guest agent and host name checked) and deleted with its volumes. Also run over `qemu+ssh://` against a Debian 12 libvirt 9.0 host (arm64 guest, no KVM; `qemu:///system`): create with a pool made on the way, start, details, stats, the VNC display through the tunnel, delete with the disk (`VMM_E2E_LIBVIRT_URI`). **Not yet run** on a KVM or x86 host.
