# VM Manager – QEMU

QEMU provider for [VM Manager](https://marketplace.visualstudio.com/items?itemName=sourceregistry.vm-manager).
Create and run QEMU virtual machines from VS Code on Windows, Linux and macOS.

## Features

* **Create** VMs with a qcow2 disk, ISO, UEFI or BIOS firmware, SATA or VirtIO disks and several
  network and display adapters.
* **Create from a cloud image** (cloud-init): pick Debian 13 / 12 or Ubuntu 24.04 / 22.04 LTS for x86-64 or ARM64 (or a disk image file of your own), choose a user, an SSH key (filled from `~/.ssh`) and/or a password, and the machine sets itself up on first boot: no installer. The image is downloaded once, verified against the distribution's published SHA-256 / SHA-512 checksum, resumed if interrupted and kept in the image directory (on the host, for an SSH host). The user gets passwordless sudo, the disk is grown to the size you chose, and the guest agent is installed so the IP address and clean shutdown work. A password is stored only as a hash. The cloud-init disk is built by the extension itself (no `genisoimage` or similar) and stays attached as the CD drive.
* **x86-64 and ARM64 guests.** New VMs default to your computer's architecture, so an Apple Silicon
  Mac or an ARM64 Linux machine runs ARM64 guests at native speed. The other architecture is
  emulated, which is typically 10 to 50 times slower; the create form and the VM list say so.
  ARM64 guests always use UEFI and VirtIO hardware.
* **Hardware acceleration**: WHPX (Windows), KVM (Linux), HVF (macOS), with a TCG (software) fallback.
  Acceleration only applies to guests of your computer's own architecture.
* **Consoles**: graphical (noVNC) and serial (xterm) in editor tabs.
* **Clean shutdown**: *Shut Down* asks a guest running `qemu-guest-agent` first, then sends the
  ACPI power button, and waits for the **Shutdown timeout** (default 30 s, a cluster setting). If the
  guest ignores it you are offered *Power Off*, which stops QEMU. New VMs have the agent channel.
* **Details page**: disks, CD/DVD drives, network adapters (with guest IP addresses when the agent
  answers), PCI devices, port forwards, and live CPU, memory and disk charts.
* **Media**: eject or change the ISO of a running VM.
* **Snapshots**: take, revert and delete snapshots of the disks, from the VM menu or the details page. They are qcow2 internal snapshots, so every disk of the VM must be qcow2 (raw disks are refused with the reason). They save **disk state only**: taken while the VM runs, a snapshot is crash-consistent, like a power cut, and memory is not saved. Reverting needs the VM stopped. The UEFI variable store (`efivars.fd`) is not part of a snapshot.
* **Clone**: a full, independent copy of a stopped VM (`qemu-img convert`, so it is compact and leaves the snapshots behind), with a new MAC address and a copy of the UEFI variables. Port forwards and passed-through devices are not copied; the VM must be stopped.
* **Templates**: *Convert to Template* turns a stopped VM into a template that cannot be started; *New Machine from Template* clones it into a normal VM. A machine made from a cloud image gets its own cloud-init seed (new instance id and host name). The guest's machine-id is copied as is.
* **Port forwards**: add and remove host-to-guest forwards while the VM runs. They are saved with the VM.
* **Attach and import**: attach to `qemu-system-*` processes started elsewhere (marked
  **external**), or import disks, `vm.json`, libvirt XML and UTM bundles from a folder.
* **Host device passthrough** (experimental): hot-plug a USB device; on Linux, bind a PCI device to
  `vfio-pci` for a VM. Host-changing steps are listed and confirmed first. Not available on macOS
  and Windows.
* **QEMU on another Linux computer over SSH.** Add a cluster, set **Connection** to **Remote (SSH)** and fill in **SSH host** (a name, an address or an alias of your `~/.ssh/config`) and everything above, including attaching to running VMs, except import from a folder and passthrough, works on that computer: VMs, disks, snapshots and clones live there, and the display, serial console, control channel and guest agent are carried through the SSH connection. See [QEMU over SSH](#qemu-over-ssh).
* Machines keep running in the background when VS Code closes and are re-attached on start.
* VNC, QMP and serial endpoints listen on `127.0.0.1` only (of the host, for an SSH host).

## Requirements

QEMU with `qemu-img`, plus `qemu-system-x86_64` for x86-64 guests and `qemu-system-aarch64` for
ARM64 guests (you need at least one). UEFI guests also need the edk2 firmware files, which come with
most QEMU packages. See [Installing QEMU](media/install.md), run **VM: Detect QEMU Installation**,
or set `vmm.qemu.path`.

## QEMU over SSH

Add a QEMU cluster, choose **Connection: Remote (SSH)** (the other choice is **Local**) and set **SSH host**: a searchable list of the hosts in your `~/.ssh/config` (and files it includes), or type `user@host`. **Add New SSH Host…** at the bottom takes `ssh user@host -p 22` and, after showing the entry, appends it to the config; **Configure SSH Hosts…** opens the file. VM Manager runs your system `ssh`, so your agent, keys,
`~/.ssh/config` (including `ProxyJump`) and `known_hosts` apply, and no extra software is installed
on either side. What the chosen host's ssh config entry (or `user@host`) already says is not asked again: a `User` skips the user question, a `Port` the port, an `IdentityFile` the sign-in question. Otherwise you are asked for **SSH user** and **SSH port** (both optional) and how to **sign in**: ssh-agent or default keys, a key file, or a password. A key skips the password question and the other way round. A password is kept in the system keychain and given to ssh through an `SSH_ASKPASS` helper that answers password prompts only (never a host key question). It sits in the environment of the ssh process while it runs. The host needs Linux, a POSIX
shell, `qemu-system-*` and `qemu-img`, and `sshd` must allow TCP forwarding (the default), because the
display, serial console and QMP are reached with `ssh -W` to the loopback ports QEMU listens on there.

* VM definitions and disks live on the host, in **VM storage directory** (default `~/vmm-qemu/vms`). Image paths, such as an ISO, are paths on the host: type them, there is no file dialog.
* A background connection cannot ask you anything, so an unknown host key fails with a message: connect once in a terminal (`ssh <host>`) to accept it. A key with a passphrase must be in ssh-agent.
* VMs keep running on the host when VS Code closes, as they do locally.
* **Attach** works there too: it lists the `qemu-system-*` processes running on the host. Their control and display sockets are reached through the connection; a unix socket needs `socat` or `nc` (OpenBSD netcat) on the host, and a socket owned by another user needs permission to open it.
* Not available on an SSH host: importing from a folder, USB/PCI passthrough. `vmm.qemu.path` only applies to this computer; set **QEMU directory** on the cluster instead.
* SSH on Windows works through Windows' OpenSSH client but without connection sharing, so it is slower.

## Known limits

* Over SSH, a user-mode (NAT) guest is not reachable from this computer even with a port forward: the forward is on the host. Use **VM: Connect with Remote-SSH…** with a host alias that jumps through the host, or a bridged network.
* Snapshots do not include memory or the UEFI variable store, and are not available for VMs attached from outside.
* Memory charts show the memory QEMU uses on the host, not the memory the guest uses.
* Guest IP addresses need `qemu-guest-agent` in the guest. With user networking the guest is
  usually `10.0.2.15`; use port forwards to reach it from the host.
* Not yet verified on real hardware: PCI passthrough, Windows hosts, and a full OS install on an
  ARM64 guest. Progress is in the [roadmap](../../docs/ROADMAP.md).
