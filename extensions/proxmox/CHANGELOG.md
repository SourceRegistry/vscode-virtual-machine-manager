# Changelog

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
