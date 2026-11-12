# Changelog

# [1.1.0](https://github.com/SourceRegistry/vscode-virtual-machine-manager/compare/vm-manager-nutanix-v1.0.0...vm-manager-nutanix-v1.1.0) (2026-11-12)


### Features

* Groups view with Favorites and user-defined groups ([fd3920b](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/fd3920b69110d753d7337fb48363598f497de7ae))
* **sdk:** shutdown timeout, emulated guests, hypervisor logs, and an API for other extensions ([8a78690](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/8a78690cf601899ee5ad925714920f05f86a1df9))

# 1.0.0 (2026-11-12)


### Bug Fixes

* **proxmox:** ask for the password unless the cluster remembers it ([e2f6e58](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/e2f6e583d20bd7dda158a9ffd8fdceb884cd5802))
* **qemu:** shutdown no longer hangs when the guest ignores ACPI ([674d3d4](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/674d3d4b27efc31cd2c72d4bb5f1bb93a3baa5cd))
* **sdk:** a missing file in the guest is not a missing guest agent ([2bbd5a7](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/2bbd5a7315a22bf89a0917eda4adf1bfc664f737))
* **sdk:** fall back to Debian's generic image when latest has no genericcloud ([4b9c217](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/4b9c217ea3dc60c2ccc0a3dfd702d1595b03721e))


### Features

* cancel a connection attempt that is waiting on a sign-in ([addddb5](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/addddb52f46822bf52905f4045eab0a05a42cfeb))
* connect to a running VM with Remote-SSH ([d30071e](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/d30071eb2072dce8918045bfb941240127ec07f4))
* Detach for attached VMs, progress while attaching, remote marker in the tree ([40cb3fc](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/40cb3fc23d0ad20f43fdc1b069c9695a5dfb8cb6))
* device passthrough (USB hot-plug, Linux VFIO, Hyper-V DDA) ([8b766ae](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/8b766aefbb307ef248b14ca153c1271c4d2cd4bc))
* distinct tree icon for templates, container badge and icon for Proxmox LXC ([00346a3](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/00346a3f5f9d842e122e1f3f44697badc9fb5386))
* eject-fill icon and an eject button in the VM settings ([f0a204b](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/f0a204bb092fa386f023106ce364c2603016e6a3))
* hardware inventory, live stats and quick media eject ([c83ae62](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/c83ae62a867efd2550c089164462459c87ee5487))
* in-editor RDP console for Hyper-V VMs ([28c360d](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/28c360d668ed24d2c5042bf12099b067f8bf1866))
* never prompt for sign-in when the extension connects by itself ([fe06316](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/fe0631657f740a37171baddd4d5aaedc7e25cc96))
* **nutanix:** Nutanix AHV provider through Prism Central ([fea4903](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/fea4903060b7df2c5dc48266493fa5658127f666))
* overview dashboard with node gauges, all-VMs table and bulk actions ([1ac4389](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/1ac4389a57b1ef8144a7f2474e939976205e4b18))
* pick the SSH host of a QEMU cluster from the ssh config ([c24664d](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/c24664d01e2e5d73d42e5277e654bdffc6bc7d78))
* **proxmox:** wait 15 minutes for the OpenID sign-in ([e3910b6](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/e3910b6fa095e7e63c735661489e7c29aee4eff2))
* **qemu:** attach to running VMs and import from folders ([9eab4e9](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/9eab4e963bdc5c224de47ad820543d54d70439fd))
* **qemu:** choose Local or Remote (SSH) for a cluster ([9d32f9c](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/9d32f9ceb6b776afb1ba88815ce6c818253f681b))
* **qemu:** clone a stopped VM into an independent copy ([e5b70ce](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/e5b70ced090620106a1c28f7db67e7985b7b6247))
* **qemu:** create a VM from a cloud image with cloud-init ([30426b0](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/30426b0e29dd091dfc880ce810bfacd3ba5dac9c))
* **qemu:** live port forwards with ssh/browser actions ([bb89ff7](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/bb89ff78f9b35e457d84d1a529dfba76b53fffa8))
* **qemu:** run QEMU on another Linux computer over SSH ([fcb19a9](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/fcb19a92962afbee7e877150a1fc4c5813ab0307))
* **qemu:** snapshots of a VM's disks ([bf52865](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/bf52865cec9bcde6a399639c950e39f5e819ae82))
* **sdk:** conditional connection fields; sign-in method shows its own fields ([c85ca61](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/c85ca611c62389f00db9c62b19f886f6f490a21f))
* **sdk:** negotiate a provider API version range with the core ([6182c8c](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/6182c8cb902aa1fd3576c1ab9aa37d8513369616))
* **sdk:** run commands and copy files in a guest through its agent ([02ccf2d](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/02ccf2d61dad310cff89b8312ba6db192b8791b6))
* search virtual machines by name, id, IP or MAC ([19e487c](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/19e487c7c419f806b0533c8c791d7d8370692358))
* share browser sign-in UI and cleanup across providers ([76e7327](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/76e73270fce15fde8459c65d58ea10dc3c2c6840))
* sign out of a cluster that uses a session ([385fbe9](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/385fbe96075d9b10e187e0e6c4d74e49081439a9))
* templates — convert a stopped VM, create machines from it ([1fa1191](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/1fa11916546a677ef9f852199e1e2f273815b42b))
* **tree:** open the terminal of terminal-only resources, hide serial next to a display ([c35d78f](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/c35d78fecb89998d368aeed8d0f36790eec04b6a))
* **tree:** show the Proxmox VMID beside the guest name ([21c820b](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/21c820b2a0e9a1ff03887b77a5a9bd1184370bae))
* VM Manager extension with Hyper-V and QEMU providers ([2be84db](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/2be84dbda1de814a2b7dfc29cc7f4faf0bc675f7))
