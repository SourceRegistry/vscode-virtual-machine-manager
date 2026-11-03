<p align="center">
  <img src="https://raw.githubusercontent.com/SourceRegistry/vscode-virtual-machine-manager/main/media/icon.png" width="128" height="128" alt="VM Manager logo">
</p>

<h1 align="center">VM Manager for VS Code</h1>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=sourceregistry.vm-manager"><img src="https://img.shields.io/visual-studio-marketplace/v/sourceregistry.vm-manager?label=Marketplace" alt="Marketplace version"></a>
  <a href="https://marketplace.visualstudio.com/items?itemName=sourceregistry.vm-manager"><img src="https://img.shields.io/visual-studio-marketplace/i/sourceregistry.vm-manager" alt="Installs"></a>
  <a href="https://github.com/SourceRegistry/vscode-virtual-machine-manager/actions/workflows/release.yml"><img src="https://github.com/SourceRegistry/vscode-virtual-machine-manager/actions/workflows/release.yml/badge.svg" alt="Release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/SourceRegistry/vscode-virtual-machine-manager" alt="License"></a>
</p>

Manage your virtual machines without leaving VS Code. See every machine at a glance, start and stop
them, change their settings and work in their consoles in an editor tab, next to your code.

* **One place for all your hypervisors**: Hyper-V and QEMU today, more to come.
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
   | [VM Manager – QEMU](https://marketplace.visualstudio.com/items?itemName=sourceregistry.vm-manager-qemu) | QEMU machines on Windows, Linux and macOS |

   Proxmox VE, XCP-ng, VMware and Nutanix are planned.
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
* **Overview** (**VM: Open Overview**): a dashboard of every cluster, node and machine with CPU,
  memory, uptime and IP addresses. Right-click a row for the same menu as in the tree.
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
* **Delete** removes the machine, and its disks if you choose so.

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

Providers add their own settings, for example `vmm.qemu.path`.

## Feedback

Found a bug or missing a hypervisor?
[Open an issue](https://github.com/SourceRegistry/vscode-virtual-machine-manager/issues). To build the
extension yourself or write a provider, see [DEVELOPMENT.md](DEVELOPMENT.md).
