# Changelog

# [0.10.0](https://github.com/SourceRegistry/vscode-virtual-machine-manager/compare/vm-manager-proxmox-v0.9.0...vm-manager-proxmox-v0.10.0) (2026-11-13)


### Features

* attach an existing disk image ([59558a6](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/59558a61f472ca0c2a57cd60f2a5ad4cc3fe28f2))
* disk management for QEMU and libvirt ([994ff94](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/994ff94537a68e129b770f777562c8ac1568f89d))

# [0.9.0](https://github.com/SourceRegistry/vscode-virtual-machine-manager/compare/vm-manager-proxmox-v0.8.0...vm-manager-proxmox-v0.9.0) (2026-11-12)


### Features

* Groups view with Favorites and user-defined groups ([fd3920b](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/fd3920b69110d753d7337fb48363598f497de7ae))
* **sdk:** shutdown timeout, emulated guests, hypervisor logs, and an API for other extensions ([8a78690](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/8a78690cf601899ee5ad925714920f05f86a1df9))

# [0.8.0](https://github.com/SourceRegistry/vscode-virtual-machine-manager/compare/vm-manager-proxmox-v0.7.1...vm-manager-proxmox-v0.8.0) (2026-11-12)


### Bug Fixes

* **sdk:** a missing file in the guest is not a missing guest agent ([2bbd5a7](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/2bbd5a7315a22bf89a0917eda4adf1bfc664f737))


### Features

* **sdk:** run commands and copy files in a guest through its agent ([02ccf2d](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/02ccf2d61dad310cff89b8312ba6db192b8791b6))

## [0.7.1](https://github.com/SourceRegistry/vscode-virtual-machine-manager/compare/vm-manager-proxmox-v0.7.0...vm-manager-proxmox-v0.7.1) (2026-11-12)


### Bug Fixes

* **sdk:** fall back to Debian's generic image when latest has no genericcloud ([4b9c217](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/4b9c217ea3dc60c2ccc0a3dfd702d1595b03721e))

# [0.7.0](https://github.com/SourceRegistry/vscode-virtual-machine-manager/compare/vm-manager-proxmox-v0.6.0...vm-manager-proxmox-v0.7.0) (2026-11-10)


### Bug Fixes

* **proxmox:** settings page named like the other providers ([1c620d7](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/1c620d72447796da51af5c192d9ee8739100f182))


### Features

* distinct tree icon for templates, container badge and icon for Proxmox LXC ([00346a3](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/00346a3f5f9d842e122e1f3f44697badc9fb5386))
* **hyperv:** snapshots, clone and templates (untested on Windows) ([69a54c6](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/69a54c6edb410450d878d49d6034cb797c9b68a6))
* nest provider settings under VM Manager in the Settings editor ([e81276e](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/e81276ed4ba0f1355c782f5bc40eead2e13ec94c))
* **proxmox:** opt-in remembered sessions; callback page opens VS Code by itself ([477624f](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/477624ff0e467343fcd3a8b44b22d7374e691f96))
* **proxmox:** snapshots, full clone and templates ([9ec1959](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/9ec1959a6bea45e3be38d89579a13fec2723acb3))
* **proxmox:** wait 15 minutes for the OpenID sign-in ([e3910b6](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/e3910b6fa095e7e63c735661489e7c29aee4eff2))

# [0.6.0](https://github.com/SourceRegistry/vscode-virtual-machine-manager/compare/vm-manager-proxmox-v0.5.0...vm-manager-proxmox-v0.6.0) (2026-11-10)


### Features

* connect to a running VM with Remote-SSH ([d30071e](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/d30071eb2072dce8918045bfb941240127ec07f4))
* Detach for attached VMs, progress while attaching, remote marker in the tree ([40cb3fc](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/40cb3fc23d0ad20f43fdc1b069c9695a5dfb8cb6))
* pick the SSH host of a QEMU cluster from the ssh config ([c24664d](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/c24664d01e2e5d73d42e5277e654bdffc6bc7d78))
* **qemu:** choose Local or Remote (SSH) for a cluster ([9d32f9c](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/9d32f9ceb6b776afb1ba88815ce6c818253f681b))
* **qemu:** create a VM from a cloud image with cloud-init ([30426b0](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/30426b0e29dd091dfc880ce810bfacd3ba5dac9c))
* **qemu:** run QEMU on another Linux computer over SSH ([fcb19a9](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/fcb19a92962afbee7e877150a1fc4c5813ab0307))
* templates — convert a stopped VM, create machines from it ([1fa1191](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/1fa11916546a677ef9f852199e1e2f273815b42b))

# [0.5.0](https://github.com/SourceRegistry/vscode-virtual-machine-manager/compare/vm-manager-proxmox-v0.4.0...vm-manager-proxmox-v0.5.0) (2026-11-10)


### Features

* **qemu:** clone a stopped VM into an independent copy ([e5b70ce](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/e5b70ced090620106a1c28f7db67e7985b7b6247))
* **qemu:** snapshots of a VM's disks ([bf52865](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/bf52865cec9bcde6a399639c950e39f5e819ae82))

# [0.4.0](https://github.com/SourceRegistry/vscode-virtual-machine-manager/compare/vm-manager-proxmox-v0.3.0...vm-manager-proxmox-v0.4.0) (2026-11-05)


### Bug Fixes

* **proxmox:** ask for credentials again after a sign-out ([3069218](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/3069218a29624e5e30279b803bad535e17badeb9))
* **proxmox:** ask for the password unless the cluster remembers it ([e2f6e58](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/e2f6e583d20bd7dda158a9ffd8fdceb884cd5802))


### Features

* cancel a connection attempt that is waiting on a sign-in ([addddb5](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/addddb52f46822bf52905f4045eab0a05a42cfeb))
* never prompt for sign-in when the extension connects by itself ([fe06316](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/fe0631657f740a37171baddd4d5aaedc7e25cc96))
* **sdk:** negotiate a provider API version range with the core ([6182c8c](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/6182c8cb902aa1fd3576c1ab9aa37d8513369616))
* share browser sign-in UI and cleanup across providers ([76e7327](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/76e73270fce15fde8459c65d58ea10dc3c2c6840))
* sign out of a cluster that uses a session ([385fbe9](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/385fbe96075d9b10e187e0e6c4d74e49081439a9))
