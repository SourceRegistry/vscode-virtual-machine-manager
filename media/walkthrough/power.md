# Create and manage machines

**Create Virtual Machine** walks you through name, processors, memory, disk, installation ISO and
network. With QEMU and libvirt a machine can
also start from a **cloud image** (Debian, Ubuntu): it sets itself up on first boot with your user,
SSH key and the guest agent, no installer. Nutanix clones a Prism disk
image and takes your own cloud-init user data.

Use the actions next to a machine in the **Virtual Machines** view, its context menu, the Command
Palette (`VM: …`) or the Overview.

| Action | What it does |
|---|---|
| **Start** | Powers the machine on (or resumes it). |
| **Shut Down** | Asks the guest to shut down cleanly; the view counts down until the hypervisor gives up. |
| **Reboot** | Restarts the machine. |
| **Stop (Power Off)** | Cuts the power immediately. Unsaved data in the guest may be lost. |
| **Show Details** | State, hardware, addresses and live CPU, memory, disk and network charts. |
| **Settings** | Processors, memory, media, network and more. |
| **Change ISO… / Eject** | Swap the installation media, also while the machine runs. |
| **Delete** | Removes the machine, optionally with its disks. |

Power actions run in the background: the machine shows a spinner and you can keep working.
