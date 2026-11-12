# Snapshots, clones and templates

Right-click a machine, or use the *Snapshots* card on its details page.

* **Take Snapshot…** saves the state of the machine's disks so you can return to it.
  **Revert to Snapshot…** goes back (VM Manager asks first and powers the machine off when the
  hypervisor needs that); **Delete Snapshot…** removes one.
* **Clone…** makes an independent copy: its own disks and network address, the same hardware.
* **Convert to Template…** turns a machine into a template; **New Machine from Template…** stamps out
  new machines from it.

| | Hyper-V | QEMU | libvirt | Proxmox | Nutanix |
|---|:-:|:-:|:-:|:-:|:-:|
| Snapshots | checkpoints | disks (qcow2) | with memory | disks | recovery points |
| Clone | ✓ | ✓ | – | ✓ | ✓ |
| Templates | ✓ | ✓ | – | ✓ | – |
