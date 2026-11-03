# Credentials

Connection passwords and API tokens are stored with VS Code **Secret Storage**, which uses the
operating system keychain (Windows Credential Manager, macOS Keychain, libsecret on Linux).

* Only non-secret connection details (host names, ports, paths) are stored in VS Code's state and may
  be synchronised with Settings Sync.
* Secrets are never written to `settings.json` and never sent to the webviews.
* Removing a cluster deletes its stored secrets.
