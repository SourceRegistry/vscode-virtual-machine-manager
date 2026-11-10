# VM Manager – Hyper-V

Hyper-V provider for [VM Manager](https://marketplace.visualstudio.com/items?itemName=sourceregistry.vm-manager).
Manage the Hyper-V virtual machines on your Windows machine from VS Code.

* List, create, edit and delete virtual machines (generation 1 and 2, Secure Boot templates,
  switches, ISO, dynamic memory, automatic start/stop, checkpoints).
* Start, shut down (integration services), reboot and power off.
* Interactive graphical console in an editor tab: the same RDP connection *Virtual Machine
  Connection* (vmconnect) uses, rendered by an in-editor RDP client. Keyboard, mouse,
  Ctrl+Alt+Del, scaling and *Open in New Window* work as in other consoles.
  * Signs in with the Windows account VS Code runs as, like vmconnect: no password and no
    elevation (the account must be allowed to manage Hyper-V, e.g. member of "Hyper-V
    Administrators"). This uses Windows' SSPI (Negotiate) through PowerShell.
  * If that fails, or with the cluster setting *Console sign-in: Ask for a user name and password*,
    it asks for an account instead (for a Microsoft account: `MicrosoftAccount\you@example.com` and
    the account password, not the PIN). That sign-in is stored in your OS keychain; **VM: Forget
    Console Sign-in** removes it.
  * *Basic session* (default) shows the VM's own screen, including firmware and boot. *Enhanced
    session* (cluster setting) needs guest support (Windows, or Linux with xrdp).
  * Hyper-V allows one basic console connection per VM; connecting takes over an open vmconnect
    window.
* Details page with disks, DVD drives, network adapters and live CPU and memory; change or eject the ISO.
* **PCI passthrough (Discrete Device Assignment)**, experimental: dismount a host device and assign it to a VM
  on Windows Server. The commands are shown and confirmed first. Not verified on real hardware yet.
* One click to the native *Virtual Machine Connection*.
* Serial console on the COM1 named pipe (requires VS Code to run as administrator).

## Requirements

* Windows 10/11 Pro, Enterprise or Education, or Windows Server, with Hyper-V enabled.
* Your account in the **Hyper-V Administrators** group (or VS Code running elevated).

Run **VM: Check Hyper-V Prerequisites** to verify the setup.
