# VM Manager – QEMU

QEMU provider for [VM Manager](https://marketplace.visualstudio.com/items?itemName=sourceregistry.vm-manager).
Create and run QEMU virtual machines from VS Code on Windows, Linux and macOS.

## Features

* **Create** VMs with a qcow2 disk, ISO, UEFI or BIOS firmware, SATA or VirtIO disks and several
  network and display adapters.
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
* **Port forwards**: add and remove host-to-guest forwards while the VM runs. They are saved with the VM.
* **Attach and import**: attach to `qemu-system-*` processes started elsewhere (marked
  **external**), or import disks, `vm.json`, libvirt XML and UTM bundles from a folder.
* **Host device passthrough** (experimental): hot-plug a USB device; on Linux, bind a PCI device to
  `vfio-pci` for a VM. Host-changing steps are listed and confirmed first. Not available on macOS
  and Windows.
* Machines keep running in the background when VS Code closes and are re-attached on start.
* VNC, QMP and serial endpoints listen on `127.0.0.1` only.

## Requirements

QEMU with `qemu-img`, plus `qemu-system-x86_64` for x86-64 guests and `qemu-system-aarch64` for
ARM64 guests (you need at least one). UEFI guests also need the edk2 firmware files, which come with
most QEMU packages. See [Installing QEMU](media/install.md), run **VM: Detect QEMU Installation**,
or set `vmm.qemu.path`.

## Known limits

* Snapshots do not include memory or the UEFI variable store, and are not available for VMs attached from outside.
* Memory charts show the memory QEMU uses on the host, not the memory the guest uses.
* Guest IP addresses need `qemu-guest-agent` in the guest. With user networking the guest is
  usually `10.0.2.15`; use port forwards to reach it from the host.
* Not yet verified on real hardware: PCI passthrough, Windows hosts, and a full OS install on an
  ARM64 guest. Progress is in the [roadmap](../../docs/ROADMAP.md).
