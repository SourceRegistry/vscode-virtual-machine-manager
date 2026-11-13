# Changelog

## [0.11.2](https://github.com/SourceRegistry/vscode-virtual-machine-manager/compare/vm-manager-qemu-v0.11.1...vm-manager-qemu-v0.11.2) (2026-11-13)


### Bug Fixes

* attach the cloud-init seed on virtio-scsi so Debian cloud images see it ([56ba682](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/56ba682d936f6d1102fcc85d7765ff538fe7e873))

## [0.11.1](https://github.com/SourceRegistry/vscode-virtual-machine-manager/compare/vm-manager-qemu-v0.11.0...vm-manager-qemu-v0.11.1) (2026-11-13)


### Bug Fixes

* refuse USB passthrough for QEMU on Windows ([bdadc98](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/bdadc98c29367802b82167fae35c74ee814d2a44))

# [0.11.0](https://github.com/SourceRegistry/vscode-virtual-machine-manager/compare/vm-manager-qemu-v0.10.0...vm-manager-qemu-v0.11.0) (2026-11-13)


### Features

* attach an existing disk image ([59558a6](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/59558a61f472ca0c2a57cd60f2a5ad4cc3fe28f2))
* disk management for QEMU and libvirt ([994ff94](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/994ff94537a68e129b770f777562c8ac1568f89d))
* disk sizes in a form with a number field and MB/GB ([926899d](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/926899d02f7b72fe1f6bbf669b4da4eefe16f352))

# [0.10.0](https://github.com/SourceRegistry/vscode-virtual-machine-manager/compare/vm-manager-qemu-v0.9.0...vm-manager-qemu-v0.10.0) (2026-11-12)


### Features

* Groups view with Favorites and user-defined groups ([fd3920b](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/fd3920b69110d753d7337fb48363598f497de7ae))
* **qemu:** shutdown countdown, emulated guests and QEMU's output in the machine log ([559730b](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/559730bb4530c77a95f4f679134ea0166a0a8da9))
* **sdk:** shutdown timeout, emulated guests, hypervisor logs, and an API for other extensions ([8a78690](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/8a78690cf601899ee5ad925714920f05f86a1df9))

# [0.9.0](https://github.com/SourceRegistry/vscode-virtual-machine-manager/compare/vm-manager-qemu-v0.8.1...vm-manager-qemu-v0.9.0) (2026-11-12)


### Bug Fixes

* **sdk:** a missing file in the guest is not a missing guest agent ([2bbd5a7](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/2bbd5a7315a22bf89a0917eda4adf1bfc664f737))


### Features

* **qemu:** commands and files in the guest; guest memory from the balloon ([3405763](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/34057639385c5914986a45312fccab81c348560c))
* **sdk:** run commands and copy files in a guest through its agent ([02ccf2d](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/02ccf2d61dad310cff89b8312ba6db192b8791b6))

## [0.8.1](https://github.com/SourceRegistry/vscode-virtual-machine-manager/compare/vm-manager-qemu-v0.8.0...vm-manager-qemu-v0.8.1) (2026-11-12)


### Bug Fixes

* **sdk:** fall back to Debian's generic image when latest has no genericcloud ([4b9c217](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/4b9c217ea3dc60c2ccc0a3dfd702d1595b03721e))

# [0.8.0](https://github.com/SourceRegistry/vscode-virtual-machine-manager/compare/vm-manager-qemu-v0.7.0...vm-manager-qemu-v0.8.0) (2026-11-10)


### Features

* distinct tree icon for templates, container badge and icon for Proxmox LXC ([00346a3](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/00346a3f5f9d842e122e1f3f44697badc9fb5386))
* nest provider settings under VM Manager in the Settings editor ([e81276e](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/e81276ed4ba0f1355c782f5bc40eead2e13ec94c))
* **proxmox:** wait 15 minutes for the OpenID sign-in ([e3910b6](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/e3910b6fa095e7e63c735661489e7c29aee4eff2))

# [0.7.0](https://github.com/SourceRegistry/vscode-virtual-machine-manager/compare/vm-manager-qemu-v0.6.0...vm-manager-qemu-v0.7.0) (2026-11-10)


### Bug Fixes

* make remote SSH CI tests cross-platform ([88ed8dd](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/88ed8ddb5289bbce00c0edee528eef1da1e45c0f))
* spawn the stand-in ssh through node in the unreachable-host test ([7a8ef58](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/7a8ef58b2b9241761918fe65cdfe148a058f5115))
* **ui:** drop the duplicate operation label from the VM details buttons ([b6bd915](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/b6bd9150c663c2241062e9edbe0c51812e6f8e01))


### Features

* connect to a running VM with Remote-SSH ([d30071e](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/d30071eb2072dce8918045bfb941240127ec07f4))
* Detach for attached VMs, progress while attaching, remote marker in the tree ([40cb3fc](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/40cb3fc23d0ad20f43fdc1b069c9695a5dfb8cb6))
* pick the SSH host of a QEMU cluster from the ssh config ([c24664d](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/c24664d01e2e5d73d42e5277e654bdffc6bc7d78))
* **qemu:** ask only what the ssh config does not answer; password sign-in ([0c5f0eb](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/0c5f0eb63a1b7f347e69aa4893ab8a6d56a77806))
* **qemu:** attach to running VMs on an SSH host ([4555b85](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/4555b85d1a634044ce73d19c74716940fa4d1ece))
* **qemu:** choose Local or Remote (SSH) for a cluster ([9d32f9c](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/9d32f9ceb6b776afb1ba88815ce6c818253f681b))
* **qemu:** create a VM from a cloud image with cloud-init ([30426b0](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/30426b0e29dd091dfc880ce810bfacd3ba5dac9c))
* **qemu:** ISO 9660 writer, cloud-init data and a verified image downloader ([3e0ec57](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/3e0ec57fe3b3155ec94c3424980b94219d1137bb))
* **qemu:** run QEMU on another Linux computer over SSH ([fcb19a9](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/fcb19a92962afbee7e877150a1fc4c5813ab0307))
* templates — convert a stopped VM, create machines from it ([1fa1191](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/1fa11916546a677ef9f852199e1e2f273815b42b))

# [0.6.0](https://github.com/SourceRegistry/vscode-virtual-machine-manager/compare/vm-manager-qemu-v0.5.0...vm-manager-qemu-v0.6.0) (2026-11-10)


### Bug Fixes

* **qemu:** always give a VM a CD/DVD drive ([642839c](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/642839c79f271a7693a8db18dd4e10a9039b1d91))


### Features

* **qemu:** clone a stopped VM into an independent copy ([e5b70ce](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/e5b70ced090620106a1c28f7db67e7985b7b6247))
* **qemu:** snapshots of a VM's disks ([bf52865](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/bf52865cec9bcde6a399639c950e39f5e819ae82))

# [0.5.0](https://github.com/SourceRegistry/vscode-virtual-machine-manager/compare/vm-manager-qemu-v0.4.0...vm-manager-qemu-v0.5.0) (2026-11-08)


### Features

* **qemu:** open the display and serial console of attached VMs ([62f441f](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/62f441f1940a47a6a844a8d1a5e79e7fc245e26b))

# [0.4.0](https://github.com/SourceRegistry/vscode-virtual-machine-manager/compare/vm-manager-qemu-v0.3.0...vm-manager-qemu-v0.4.0) (2026-11-05)


### Bug Fixes

* **proxmox:** ask for the password unless the cluster remembers it ([e2f6e58](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/e2f6e583d20bd7dda158a9ffd8fdceb884cd5802))


### Features

* cancel a connection attempt that is waiting on a sign-in ([addddb5](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/addddb52f46822bf52905f4045eab0a05a42cfeb))
* never prompt for sign-in when the extension connects by itself ([fe06316](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/fe0631657f740a37171baddd4d5aaedc7e25cc96))
* **sdk:** negotiate a provider API version range with the core ([6182c8c](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/6182c8cb902aa1fd3576c1ab9aa37d8513369616))
* share browser sign-in UI and cleanup across providers ([76e7327](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/76e73270fce15fde8459c65d58ea10dc3c2c6840))
* sign out of a cluster that uses a session ([385fbe9](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/385fbe96075d9b10e187e0e6c4d74e49081439a9))
