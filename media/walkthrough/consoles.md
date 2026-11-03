# Consoles

* **Graphical console** — a noVNC display inside an editor tab (QEMU, Proxmox). Hyper-V has no VNC
  endpoint, so it shows a live preview with a button for the native *Virtual Machine Connection*.
* **Serial console** — an xterm terminal connected to the first serial port of the guest. It uses
  your terminal colours and editor font.

Console tabs behave like editors: split them, drag them around, or choose
**Open in New Window** in the editor toolbar to pop one out. The toolbar also has
*Send Ctrl+Alt+Del*, *Toggle Scaling* and the power actions.

Connections are made by VS Code itself and relayed to the tab, so consoles also work in Remote SSH,
WSL and Codespaces windows.
