# Hypervisor providers

VM Manager talks to hypervisors through small provider extensions. Install the ones you use; each is
published and updated on its own. **VM: Install Hypervisor Providers** lists them.

| Provider | What it manages |
|:-:|---|
| ![Hyper-V](logos/hyperv.svg)<br>**Hyper-V** | Hyper-V on this Windows computer. Consoles over RDP with single sign-on, checkpoints, export-based clones. |
| ![QEMU](logos/qemu.svg)<br>**QEMU** | QEMU machines run by VS Code on Windows, Linux and macOS, or on a Linux host over SSH. Cloud images, port forwards, guest commands. |
| ![libvirt](logos/libvirt.svg)<br>**libvirt** | libvirt (KVM/QEMU) domains on this computer or over `qemu+ssh://`. Cloud images, snapshots with memory, guest commands. |
| ![Proxmox VE](logos/proxmox.svg)<br>**Proxmox** | Proxmox VE clusters over HTTPS: virtual machines and LXC containers. API token, password or OpenID Connect sign-in. |
| ![Nutanix](logos/nutanix.svg)<br>**Nutanix** | Nutanix AHV clusters through Prism Central (or one Prism Element). Recovery points as snapshots, clones, cloud-init. |

XCP-ng and VMware are planned. The next step shows what each provider can do.
