# Changelog

# [0.2.0](https://github.com/SourceRegistry/vscode-virtual-machine-manager/compare/v0.1.0...v0.2.0) (2026-11-03)


### Bug Fixes

* browse button on file fields ([d98a418](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/d98a4184c96c981d160ddf665dd31008b329baf0))


### Features

* in-editor RDP console for Hyper-V VMs ([28c360d](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/28c360d668ed24d2c5042bf12099b067f8bf1866))
* Marketplace icons for the core and provider extensions ([355406b](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/355406b526edb51098e2839f4d2b90f78dfbdef6))
* type clipboard into consoles, background power actions ([626e89f](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/626e89ff482fb287859c56104f9be4d95c57ae89))
* VM Manager extension with Hyper-V and QEMU providers ([2be84db](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/2be84dbda1de814a2b7dfc29cc7f4faf0bc675f7))

## 0.1.0

First version, before automated releases.

* Clusters → nodes → VMs tree, overview, VM settings editor, power actions, noVNC / xterm / preview
  consoles with *Open in New Window*, Secret Storage credentials, walkthrough. Providers: Hyper-V,
  QEMU.
* Hyper-V: interactive graphical console in the editor over VMConnect (RDP on port 2179), using the
  IronRDP web client and an RDCleanPath gateway in the extension host. Basic and Enhanced session.
* Hyper-V console signs in with the current Windows account (single sign-on, like vmconnect): the
  extension host runs CredSSP with Windows SSPI; password sign-in remains as fallback and as cluster
  setting.
* Right-click menu on VM rows in the Overview, matching the tree.
* **VM: Forget Console Sign-in** command.
* **VM Console: Type Clipboard Text** — types the clipboard into RDP, VNC and serial consoles as key
  presses (US keyboard layout).
* Power actions run as background tasks: the VM shows a spinner and "Shutting down…" (tree and
  Overview) with progress in the status bar until the hypervisor is done; a hard power-off stays
  available while a shutdown hangs. Hyper-V runs concurrent operations in separate PowerShell
  processes so they do not queue behind a long shutdown.
