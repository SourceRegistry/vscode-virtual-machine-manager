# Credentials

Connection passwords and API tokens are stored with VS Code **Secret Storage**, which uses the
operating system keychain (Windows Credential Manager, macOS Keychain, libsecret on Linux).

| Provider | Signs in with |
|---|---|
| Hyper-V | Your Windows account: no password to store. |
| QEMU | Nothing for this computer; your SSH key or agent for a remote host. |
| libvirt | Nothing for this computer; your SSH key or agent for `qemu+ssh://`. |
| Proxmox VE | API token, password, or OpenID Connect in the browser. |
| Nutanix | Password (kept in memory unless you choose to remember it) or API key. |

* Only non-secret connection details (host names, ports, paths) are stored in VS Code's state and may
  be synchronised with Settings Sync.
* Secrets are never written to `settings.json` and never sent to the webviews.
* Removing a cluster deletes its stored secrets.
