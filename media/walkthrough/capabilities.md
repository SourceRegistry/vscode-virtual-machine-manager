# What each provider can do

✓ works · – not available. Commands a provider cannot do are never offered for its machines.

| | Hyper-V | QEMU | libvirt | Proxmox | Nutanix |
|---|:-:|:-:|:-:|:-:|:-:|
| **Machines** | | | | | |
| Create | ✓ | ✓ | ✓ | ✓ | ✓ |
| From a cloud image (cloud-init) | – | ✓ | ✓ | – | your user data |
| Edit settings | ✓ | ✓ | – | ✓ | ✓ |
| Start, shut down, reboot, power off | ✓ | ✓ | ✓ | ✓ | ✓ |
| Containers (LXC) | – | – | – | ✓ | – |
| **Consoles** | | | | | |
| Screen in an editor tab | RDP | VNC | VNC | VNC | VNC |
| Serial console | ✓ | ✓ | ✓ | ✓ | – |
| **Inspect** | | | | | |
| Details page with live charts | ✓ | ✓ | ✓ | ✓ | ✓ |
| Change or eject ISO | ✓ | ✓ | ✓ | – | – |
| **Protect and copy** | | | | | |
| Snapshots | ✓ | ✓ | ✓ | ✓ | ✓ |
| Clone | ✓ | ✓ | – | ✓ | ✓ |
| Templates | ✓ | ✓ | – | ✓ | – |
| **Inside the guest** | | | | | |
| Run commands, copy files | – | ✓ | ✓ | – | – |
| Port forwards | – | ✓ | ✓ | – | – |

Every provider also has favorites and groups, the Overview, *Show Log*, `vm` tasks and
**Connect with Remote-SSH** for machines with an address you can reach.
