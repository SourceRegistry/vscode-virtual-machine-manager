# Changelog

## Unreleased

* Hyper-V: interactive graphical console in the editor over VMConnect (RDP on port 2179), using the
  IronRDP web client and an RDCleanPath gateway in the extension host. Basic and Enhanced session.
* Right-click menu on VM rows in the Overview, matching the tree.
* Hyper-V console signs in with the current Windows account (single sign-on, like vmconnect):
  the extension host runs CredSSP with Windows SSPI; password sign-in remains as fallback and as
  cluster setting.
* **VM: Forget Console Sign-in** command.
* Fix: tree context menus and inline actions did not show for VMs.

## 0.1.0

* Initial release: clusters → nodes → VMs tree, overview, VM settings editor, power actions,
  noVNC / xterm / preview consoles with *Open in New Window*, Secret Storage credentials,
  walkthrough. Providers: Hyper-V, QEMU.
