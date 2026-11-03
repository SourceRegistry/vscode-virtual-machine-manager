# Installing QEMU

| Platform | Install | Acceleration |
|---|---|---|
| Windows | Installer from [qemu.weilnetz.de](https://qemu.weilnetz.de/w64/) or `winget install SoftwareFreedomConservancy.QEMU` | Enable **Windows Hypervisor Platform** in *Windows Features* (WHPX) |
| Linux | `sudo apt install qemu-system-x86 qemu-utils ovmf` (or your distribution's equivalent) | KVM — add yourself to the `kvm` group |
| macOS | `brew install qemu` | HVF (built in) |

VM Manager finds QEMU on your `PATH` and in the default install locations. Otherwise set
**VM Manager – QEMU › Path** (`vmm.qemu.path`).

Virtual machines are started in the background, keep running when VS Code closes, and are picked up
again when VS Code starts. VNC, QMP and serial endpoints listen on `127.0.0.1` only.
