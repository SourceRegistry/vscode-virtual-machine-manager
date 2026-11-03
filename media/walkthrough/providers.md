# Hypervisor providers

VM Manager talks to hypervisors through small provider extensions. Install the ones you need:

| Provider | Extension | Manages |
|---|---|---|
| Hyper-V | `sourceregistry.vm-manager-hyperv` | Hyper-V on this Windows machine |
| QEMU | `sourceregistry.vm-manager-qemu` | QEMU virtual machines run by VS Code |

Proxmox VE, XCP-ng, VMware and Nutanix providers are planned. Because every provider is a separate
extension, each one is published and updated on its own.
