<p align="center">
  <img src="https://raw.githubusercontent.com/SourceRegistry/vscode-virtual-machine-manager/main/media/icon.png" width="128" height="128" alt="VM Manager logo">
</p>

<h1 align="center">VM Manager for VS Code</h1>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=sourceregistry.vm-manager"><img src="https://vsmarketplacebadges.dev/version-short/sourceregistry.vm-manager.svg?label=Marketplace" alt="Marketplace version"></a>
  <a href="https://marketplace.visualstudio.com/items?itemName=sourceregistry.vm-manager"><img src="https://vsmarketplacebadges.dev/installs-short/sourceregistry.vm-manager.svg?label=Installs" alt="Installs"></a>
  <a href="https://github.com/SourceRegistry/vscode-virtual-machine-manager/actions/workflows/release.yml"><img src="https://github.com/SourceRegistry/vscode-virtual-machine-manager/actions/workflows/release.yml/badge.svg" alt="Release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/SourceRegistry/vscode-virtual-machine-manager" alt="License"></a>
</p>

Manage your virtual machines without leaving VS Code. See every machine at a glance, start and stop
them, change their settings and work in their consoles in an editor tab, next to your code.

* **One place for all your hypervisors**: Hyper-V, QEMU and Proxmox VE.
* **Consoles in the editor**: the machine's screen or its serial console in a tab, which you can
  drag to another window.
* **Looks like VS Code**: everything follows your theme and uses the views, menus and command
  palette you already know.

## Get started

1. **Install a provider** for your hypervisor. VM Manager itself does not talk to any hypervisor;
   providers do:

   | Provider | For |
   |---|---|
   | [VM Manager – Hyper-V](https://marketplace.visualstudio.com/items?itemName=sourceregistry.vm-manager-hyperv) | Hyper-V on this Windows machine |
   | [VM Manager – Proxmox VE](https://marketplace.visualstudio.com/items?itemName=sourceregistry.vm-manager-proxmox) | Remote Proxmox VE clusters over HTTPS |
   | [VM Manager – QEMU](https://marketplace.visualstudio.com/items?itemName=sourceregistry.vm-manager-qemu) | QEMU machines on Windows, Linux and macOS |

   XCP-ng, VMware and Nutanix are planned. **VM: Install Hypervisor Providers** lists the providers you can install.
2. Open the **Virtual Machines** view in the activity bar and click **Add Cluster**.
3. Your machines appear in the view. Right-click one for everything you can do with it.

The walkthrough (**VM: Get Started with VM Manager**) shows the same steps.

## Find your way around

Machines are grouped as **cluster → node → virtual machine**:

```
Local (Hyper-V)            ← cluster: one hypervisor you added
└─ DESKTOP-ALEX            ← node: a host in it
   ├─ web-01  Running      ← virtual machines
   └─ db-01   Off
```

* **Virtual Machines view**: state icons, the running count as a badge, and quick actions next to
  each machine (start, connect, shut down).
* **Overview** (**VM: Open Overview**): a dashboard of everything you manage.
  * A summary of machines by state (click a state to filter the table) and of the processors and
    memory allocated against what the nodes have, flagged when they are overcommitted.
  * A card per node with its CPU load and memory, plus facts such as the QEMU version or host OS.
  * One table of all machines across all clusters: filter by name, host or IP, sort by any column,
    with a CPU sparkline per machine. Right-click a row for the same menu as in the tree.
  * Select several machines to start, shut down or power them off together.
* **Search** (**VM: Search Virtual Machines…**): jump to a machine by name from the command palette.
* **Status bar**: the number of running machines; click it to open the Overview.

## Work with machines

* **Create** a machine from a node's context menu: name, processors, memory, disk, installation ISO
  and network, step by step.
* **Settings** opens an editor for the machine's configuration. Some settings can only change while
  the machine is off.
* **Start, Shut Down, Reboot, Stop (Power Off)**. *Shut Down* asks the guest to shut down cleanly;
  *Stop* cuts the power. These run in the background: the machine shows a spinner and
  "Shutting down…" until it is done, and you can keep working. If a shutdown hangs, *Stop* is still
  available.
* **Show Details** opens a page for one machine: state, power actions, uptime, processors, memory,
  IP address, its disks, CD/DVD drives, network adapters, port forwards and PCI devices, and live
  charts (CPU, memory, disk throughput, operations and latency, and network where the provider
  reports it) over the last five minutes. Each chart has a **Show data** table.
* **Eject** and **Change ISO…** swap the installation media, also while the machine runs.
* **Snapshots** (**Take Snapshot…**, **Revert to Snapshot…**, **Delete Snapshot…**, or the *Snapshots* card on the details page) save the state of a machine's disks so you can return to it. QEMU saves disks only: taken while the machine runs, a snapshot is like a power cut. Reverting discards everything changed since and needs the machine powered off; VM Manager asks first and does it for you.
* **Clone…** makes an independent copy of a machine: its own disks and network address, the same hardware. Snapshots, port forwards and passed-through devices are not copied. The original must be shut down first, and a large disk takes a while.
* **Connect with Remote-SSH…** opens a running machine in a Remote - SSH window. It finds the way in from the
  machine's details: a port forward to port 22 (QEMU's NAT address is never offered), or an address the
  computer can reach. It checks that an SSH server answers first, and asks before adding an entry for the
  machine to your ssh config; nothing is written silently. **Forward SSH Port…** sets up the forward.
  **Add Machines to SSH Config…** and **Remove Machines from SSH Config…** let you choose which machines
  have an entry, so they work with plain `ssh <name>` and in Remote - SSH's host list.
* **Delete** removes the machine, and its disks if you choose so.

### Bring in machines you already have

QEMU only, through the QEMU provider:

* **Attach to Running Virtual Machine…** finds `qemu-system-*` processes started outside VS Code and
  adds them, marked **external**. With a QMP socket you get full control; without one the machine is
  observe-only (stats and power off). An attached machine disappears when its process exits, and
  deleting it only detaches it. When an attached machine stops on its own, its tabs close and you get a notice; powering it off from here does not show one.
* **Import Virtual Machines from Folder…** reads disk images (qcow2, raw, vmdk, vdi, vhdx and more),
  another install's `vm.json`, libvirt domain XML and the disks of UTM bundles.

## What each provider supports

| | Hyper-V | QEMU | Proxmox VE |
|---|---|---|---|
| Create, edit, delete, power | ✓ | ✓ | ✓ |
| Graphical and serial consoles | ✓ | ✓ | ✓ |
| Details page with live charts | ✓ | ✓ | ✓ |
| Change or eject ISO | ✓ | ✓ | |
| Port forwards | | ✓ | |
| Attach and import | | ✓ (attach also on an SSH host) | |
| Host device passthrough | PCI (DDA), experimental | USB; PCI (VFIO, Linux), experimental | |
| Snapshots | | disks only (qcow2) | |
| Clone | | ✓ | |
| Connect with Remote-SSH | via address | via forward or address | via address |
| Run on a remote host | | over SSH (Linux hosts) | server API |

Experimental means implemented and unit tested, but not yet verified on real hardware.
Snapshots for Hyper-V and Proxmox and remote Hyper-V are on the [roadmap](docs/ROADMAP.md).

## Consoles

* **Graphical console**: the machine's screen in an editor tab, with keyboard and mouse. Hyper-V
  machines use the same connection as *Virtual Machine Connection*; QEMU machines use VNC.
* **Serial console**: a terminal on the machine's serial port, for Linux servers and boot logs.
* The tab's toolbar has **Send Ctrl+Alt+Del**, **Toggle Scaling**, **Type Clipboard Text**,
  **Reconnect**, the power actions and **Open in New Window**.
* **Type Clipboard Text** types the clipboard into the machine as key presses, for consoles without a
  shared clipboard (installers, login prompts). It types with a US keyboard layout.
* Consoles connect through VS Code itself, so they also work over Remote SSH, WSL and Codespaces.

## Your credentials

Passwords and tokens go to VS Code's Secret Storage (your operating system's keychain), never to
settings files. The Hyper-V console signs in with your Windows account, so it needs no password.
When a console does ask for a password, **VM: Forget Console Sign-in** removes the saved one.

## Settings

| Setting | Default | |
|---|---|---|
| `vmm.refreshInterval` | `5` | Seconds between state refreshes while the view or the Overview is visible. |
| `vmm.console.openInNewWindow` | `false` | Open consoles in a new window instead of an editor tab. |
| `vmm.console.scaleViewport` | `true` | Scale graphical consoles to fit the tab. |
| `vmm.confirmPowerOff` | `true` | Ask before a hard power off (*Stop*). |
| `vmm.ssh.user` | empty | Account to sign in as in a guest. Empty: your user name on this computer. Remembered per machine. |
| `vmm.ssh.addConfigEntry` | `true` | Offer to add an ssh config entry before connecting. Turn off to connect by address without touching the file. |

Providers add their own settings, for example `vmm.qemu.path`.

## Feedback

Found a bug or missing a hypervisor?
[Open an issue](https://github.com/SourceRegistry/vscode-virtual-machine-manager/issues). To build the
extension yourself or write a provider, see [DEVELOPMENT.md](DEVELOPMENT.md).
