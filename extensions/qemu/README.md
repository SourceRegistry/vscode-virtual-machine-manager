# VM Manager – QEMU

QEMU provider for [VM Manager](https://marketplace.visualstudio.com/items?itemName=sourceregistry.vm-manager).
Create and run QEMU virtual machines from VS Code on Windows, Linux and macOS.

* Create VMs with a qcow2 disk, ISO, UEFI or BIOS firmware, SATA or VirtIO disks and several network
  and display adapters.
* Hardware acceleration: WHPX (Windows), KVM (Linux), HVF (macOS), with TCG fallback.
* Graphical console (noVNC) and serial console (xterm) in editor tabs.
* Machines keep running in the background when VS Code closes and are re-attached on start.
* VNC, QMP and serial endpoints listen on `127.0.0.1` only.

## Requirements

QEMU (`qemu-system-x86_64` and `qemu-img`). Run **VM: Detect QEMU Installation** or set
`vmm.qemu.path`.
