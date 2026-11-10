# Changelog

# [0.8.0](https://github.com/SourceRegistry/vscode-virtual-machine-manager/compare/v0.7.0...v0.8.0) (2026-11-10)


### Bug Fixes

* **tree:** the container icon says it, no extra label ([285d03d](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/285d03dea700c925aeb8ac98996c5b695db448e6))


### Features

* distinct tree icon for templates, container badge and icon for Proxmox LXC ([00346a3](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/00346a3f5f9d842e122e1f3f44697badc9fb5386))
* **hyperv:** snapshots, clone and templates (untested on Windows) ([69a54c6](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/69a54c6edb410450d878d49d6034cb797c9b68a6))
* **libvirt:** libvirt provider through virsh (domains, power, details, consoles, media, snapshots) ([17994ca](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/17994ca8713641a60fc59742fd60a5cb7623696e))
* nest provider settings under VM Manager in the Settings editor ([e81276e](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/e81276ed4ba0f1355c782f5bc40eead2e13ec94c))
* **proxmox:** opt-in remembered sessions; callback page opens VS Code by itself ([477624f](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/477624ff0e467343fcd3a8b44b22d7374e691f96))
* **proxmox:** wait 15 minutes for the OpenID sign-in ([e3910b6](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/e3910b6fa095e7e63c735661489e7c29aee4eff2))

# [0.7.0](https://github.com/SourceRegistry/vscode-virtual-machine-manager/compare/v0.6.0...v0.7.0) (2026-11-10)


### Bug Fixes

* make remote SSH CI tests cross-platform ([88ed8dd](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/88ed8ddb5289bbce00c0edee528eef1da1e45c0f))
* **ui:** drop the duplicate operation label from the VM details buttons ([b6bd915](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/b6bd9150c663c2241062e9edbe0c51812e6f8e01))


### Features

* connect to a running VM with Remote-SSH ([d30071e](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/d30071eb2072dce8918045bfb941240127ec07f4))
* Detach for attached VMs, progress while attaching, remote marker in the tree ([40cb3fc](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/40cb3fc23d0ad20f43fdc1b069c9695a5dfb8cb6))
* pick the SSH host of a QEMU cluster from the ssh config ([c24664d](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/c24664d01e2e5d73d42e5277e654bdffc6bc7d78))
* **qemu:** ask only what the ssh config does not answer; password sign-in ([0c5f0eb](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/0c5f0eb63a1b7f347e69aa4893ab8a6d56a77806))
* **qemu:** attach to running VMs on an SSH host ([4555b85](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/4555b85d1a634044ce73d19c74716940fa4d1ece))
* **qemu:** choose Local or Remote (SSH) for a cluster ([9d32f9c](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/9d32f9ceb6b776afb1ba88815ce6c818253f681b))
* **qemu:** create a VM from a cloud image with cloud-init ([30426b0](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/30426b0e29dd091dfc880ce810bfacd3ba5dac9c))
* **qemu:** run QEMU on another Linux computer over SSH ([fcb19a9](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/fcb19a92962afbee7e877150a1fc4c5813ab0307))
* templates — convert a stopped VM, create machines from it ([1fa1191](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/1fa11916546a677ef9f852199e1e2f273815b42b))

# [0.6.0](https://github.com/SourceRegistry/vscode-virtual-machine-manager/compare/v0.5.0...v0.6.0) (2026-11-10)


### Bug Fixes

* **qemu:** always give a VM a CD/DVD drive ([642839c](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/642839c79f271a7693a8db18dd4e10a9039b1d91))


### Features

* close the tabs of a VM that disappears and tell the user ([a943e28](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/a943e28485205220c3aaf55580138499a83013d0))
* **qemu:** clone a stopped VM into an independent copy ([e5b70ce](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/e5b70ced090620106a1c28f7db67e7985b7b6247))
* **qemu:** snapshots of a VM's disks ([bf52865](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/bf52865cec9bcde6a399639c950e39f5e819ae82))
* say what deleting a VM does to its snapshots, and close its views ([7a61c66](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/7a61c66a1e0a2e658a0e9b6a482302a278e9541d))
* take, revert and delete snapshots from VS Code ([8fa91bc](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/8fa91bc44c0bea0c3382aa037fac816c88c3f357))
* VM: Clone… in the palette and the tree and Overview menus ([26f0b4d](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/26f0b4de391e73d8541db32f18294f546af542f2))

# [0.5.0](https://github.com/SourceRegistry/vscode-virtual-machine-manager/compare/v0.4.0...v0.5.0) (2026-11-08)


### Features

* offer to open the display or serial console after attaching to a VM ([5927861](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/59278613dcd2fdcae1eb626c12ce7130a1ea52ed))

# [0.4.0](https://github.com/SourceRegistry/vscode-virtual-machine-manager/compare/v0.3.0...v0.4.0) (2026-11-05)


### Bug Fixes

* **menus:** Forget Console Sign-in only for providers with RDP consoles ([00a5301](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/00a5301118523803516936b4b69a1f954545bd93))
* **menus:** offer Cancel on connecting clusters in the Overview context menu too ([50411f3](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/50411f39da0bb2505f026f9f81889a60dd5a4d59))
* **proxmox:** ask for the password unless the cluster remembers it ([e2f6e58](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/e2f6e583d20bd7dda158a9ffd8fdceb884cd5802))


### Features

* cancel a connection attempt that is waiting on a sign-in ([addddb5](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/addddb52f46822bf52905f4045eab0a05a42cfeb))
* never prompt for sign-in when the extension connects by itself ([fe06316](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/fe0631657f740a37171baddd4d5aaedc7e25cc96))
* **release:** release each extension on its own version ([d77e55e](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/d77e55e3fcbfbad45b04c861a78a544730e28b07))
* **sdk:** negotiate a provider API version range with the core ([6182c8c](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/6182c8cb902aa1fd3576c1ab9aa37d8513369616))
* share browser sign-in UI and cleanup across providers ([76e7327](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/76e73270fce15fde8459c65d58ea10dc3c2c6840))
* sign out of a cluster that uses a session ([385fbe9](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/385fbe96075d9b10e187e0e6c4d74e49081439a9))

# [0.3.0](https://github.com/SourceRegistry/vscode-virtual-machine-manager/compare/v0.2.0...v0.3.0) (2026-11-05)


### Bug Fixes

* **console:** tab title is the VM name for the terminal too ([8909e9e](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/8909e9e3adc1f1cf25e603caf54d94ff944823d8))
* **core:** make the shutdown-timeout prompt modal and log it ([b6b3949](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/b6b3949b9447ea454e95b8194ecb05d2c84494c5))
* dashboard buttons did nothing (no runCommand handler) ([64b45d6](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/64b45d6463f8d95c52309d59a4ab46bd60a68919))
* **proxmox:** open the console viewer, not the guest summary ([27147bd](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/27147bd39b9ef7cc1433c97645bbcf9083f7c2d4))
* **proxmox:** open the stand-alone console page from the context menu ([e6287c7](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/e6287c781a54e9f8fd889f693f6703533e75200b)), closes [#v1](https://github.com/SourceRegistry/vscode-virtual-machine-manager/issues/v1)
* **qemu:** shutdown no longer hangs when the guest ignores ACPI ([674d3d4](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/674d3d4b27efc31cd2c72d4bb5f1bb93a3baa5cd))
* **qemu:** stop VMs fighting over VNC/QMP ports on start ([0f3cd90](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/0f3cd904b9d6f29238ce3837b520969e3263df08))
* **search:** let our own filter decide, so IP and MAC matches show ([5ebdb62](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/5ebdb62094ace91746690ff34805a01c41bb6765))
* **tree:** keep IP addresses out of the tree row ([226fbae](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/226fbae6dc8ee8c6c7a669795d8eb7151e4e3cef))
* **ui:** centered empty states, compact host devices button, tidier notes ([c13dd06](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/c13dd066b628709ef69aa07b8fa2d7d24f5139a9))
* **ui:** compact refresh button on the host devices card ([69d91f0](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/69d91f0f812adf1b3062ac886b4c41cc364041ae))
* **ui:** show the external badge beside the status, hide Console without a console ([c01068a](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/c01068af07eb7ec929caa2370e2173e48d6fc511))


### Features

* device passthrough (USB hot-plug, Linux VFIO, Hyper-V DDA) ([8b766ae](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/8b766aefbb307ef248b14ca153c1271c4d2cd4bc))
* eject-fill icon and an eject button in the VM settings ([f0a204b](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/f0a204bb092fa386f023106ce364c2603016e6a3))
* hardware inventory, live stats and quick media eject ([c83ae62](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/c83ae62a867efd2550c089164462459c87ee5487))
* **icons:** Proxmox marketplace icon, refreshed Hyper-V badge ([b22747f](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/b22747f9f51e62e12facbac05bef429f5910d4ee))
* overview dashboard with node gauges, all-VMs table and bulk actions ([1ac4389](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/1ac4389a57b1ef8144a7f2474e939976205e4b18))
* per-VM details dashboard with live charts ([d817237](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/d8172378fb7547a78a6080dea900435e7380e809))
* **proxmox:** hardware details and guest IP addresses ([b75ec60](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/b75ec601631903c24507934dfaa60dd28df8fdec))
* **proxmox:** sign in with a session (password, 2FA, OpenID) ([eceb87b](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/eceb87b99fbe6ed7464dfed5e024f579f7a5fe52))
* **qemu:** ARM64 (aarch64) guests, native on Apple Silicon ([1fa12e9](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/1fa12e956d79dbcd57d13da2485a51fe9545dba6))
* **qemu:** attach to running VMs and import from folders ([9eab4e9](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/9eab4e963bdc5c224de47ad820543d54d70439fd))
* **qemu:** live port forwards with ssh/browser actions ([bb89ff7](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/bb89ff78f9b35e457d84d1a529dfba76b53fffa8))
* **sdk:** conditional connection fields; sign-in method shows its own fields ([c85ca61](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/c85ca611c62389f00db9c62b19f886f6f490a21f))
* search virtual machines by name, id, IP or MAC ([19e487c](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/19e487c7c419f806b0533c8c791d7d8370692358))
* **search:** #<id> matches an id prefix ([24a9395](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/24a9395e86ab87b47120a970d9a4182559f25ac8))
* **tree:** open the details page when a VM is clicked ([e017c15](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/e017c1527f14a11fb93e634514281474bdea6303))
* **tree:** open the terminal of terminal-only resources, hide serial next to a display ([c35d78f](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/c35d78fecb89998d368aeed8d0f36790eec04b6a))
* **tree:** show the Proxmox VMID beside the guest name ([21c820b](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/21c820b2a0e9a1ff03887b77a5a9bd1184370bae))
* **ui:** add port forwards from a + button as an inline table row ([bff7e66](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/bff7e66b9c568f9454541a8fd82787befe65d625))
* **ui:** show forward direction, compact icon buttons ([f970cb8](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/f970cb83cb4b760d8f0cbbc0f77e88c594ca735b))
* **ui:** show the VM id on the details page ([f30bde6](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/f30bde605560469211a2ddb2194be95082f66041))
* **ui:** terminal quick action for terminal-only resources ([3a76a9a](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/3a76a9a62e92832450f045049a5ea0e61a6e994d))
* use the outline eject icon and name the command Eject ([d51c4d2](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/d51c4d2a7d7001f7962416ec8b432fd0670aca82))


### Reverts

* **tree:** clicking a VM always opens its details page ([b01add8](https://github.com/SourceRegistry/vscode-virtual-machine-manager/commit/b01add8c570e0d3e1b6a8e17b060449cf17ee7d2))

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
