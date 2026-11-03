# Hyper-V prerequisites

1. **Enable Hyper-V** (Windows 10/11 Pro, Enterprise, Education or Windows Server). In an elevated PowerShell:

   ```powershell
   Enable-WindowsOptionalFeature -Online -FeatureName Microsoft-Hyper-V -All
   ```

   Reboot afterwards.

2. **Allow your account to manage Hyper-V** without running VS Code as administrator:

   ```powershell
   Add-LocalGroupMember -Group "Hyper-V Administrators" -Member "$env:USERDOMAIN\$env:USERNAME"
   ```

   Sign out and in again.

3. **Serial consoles** connect to the COM1 named pipe of a VM. Windows only lets administrators open
   these pipes, so the serial console needs VS Code to run elevated. The live preview and the native
   *Virtual Machine Connection* work without elevation.
