# Consoles

* **Graphical console**: the machine's screen in an editor tab, with keyboard and mouse. Hyper-V
  uses the same RDP connection as *Virtual Machine Connection*, signed in with your Windows account.
* **Serial console**: a terminal on the machine's serial port, for Linux servers and boot logs. It uses
  your terminal colours and editor font.

| | Hyper-V | QEMU | libvirt | Proxmox | Nutanix |
|---|:-:|:-:|:-:|:-:|:-:|
| Screen | RDP | VNC | VNC | VNC | VNC |
| Serial | ✓ | ✓ | ✓ | ✓ | – |

Console tabs behave like editors: split them, drag them around, or choose **Open in New Window** to
pop one out. The toolbar has **Send Ctrl+Alt+Del**, **Toggle Scaling**, **Type Clipboard Text**
(types the clipboard as key presses, for installers and login prompts), **Reconnect** and the power
actions.

Connections are made by VS Code itself and relayed to the tab, so consoles also work in Remote SSH,
WSL and Codespaces windows.
