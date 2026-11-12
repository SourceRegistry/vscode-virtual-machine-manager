# Work inside the machine

* **Connect with Remote-SSH…** opens a running machine in a Remote - SSH window, so you edit, run and
  debug inside it as if it were local. VS Code finds the way in (a port forward to port 22, or an
  address this computer can reach), checks that SSH answers, and asks before adding an entry to your
  ssh config. **Add Machines to SSH Config…** makes them work with plain `ssh <name>` too.
* **Run Command in Guest…**, **Copy File to Guest…** and **Copy File from Guest…** go through the guest
  agent (QEMU, libvirt): no SSH or network route
  needed. Output goes to the *VM Manager: Guest Commands* channel.
* **Forward SSH Port…** and port forwards in the details page reach a service in a machine on
  user-mode networking (QEMU, libvirt).

## Automate

A **`vm` task** starts or shuts down a machine and waits for it, for example before a debug session:

```jsonc
// .vscode/tasks.json
{ "label": "Start test VM", "type": "vm", "vm": "web-01", "action": "start", "waitFor": "ssh" }
```

In `launch.json`, the commands `vmm.getVmAddress` and `vmm.getVmSshPort` give the address to connect
to, and the power commands take a machine's name as argument for keybindings.
