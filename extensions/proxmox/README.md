# VM Manager – Proxmox VE

Proxmox VE provider for [VM Manager](https://marketplace.visualstudio.com/items?itemName=sourceregistry.vm-manager), using [pve-client](https://github.com/AlexanderSlaa/pve-client).

Add a cluster of type **Proxmox VE**, enter the HTTPS origin (for example `https://pve.example.com:8006`), API token ID (`user@pve!vscode`), and token secret. The secret is saved in VS Code SecretStorage. TLS verification is enabled by default; the connection form allows disabling it for a trusted server with a self-signed certificate.

### Signing in without a token

Under **Sign in with** you can instead choose:

- **User name and password (session)**: any realm the Proxmox login supports with a password (`pam`, `pve`, LDAP, Active Directory). Enter `root`, `alice@ldap`, or a name plus the **Realm** field. The password is optional to save (VS Code SecretStorage); if left empty you are asked at every sign-in. If the account has two-factor authentication you are asked for the TOTP code (or a recovery key). The session ticket is renewed automatically, kept in SecretStorage only (never the password), and deleted when VS Code closes. Proxmox has no logout call, so a ticket also expires on its own after two hours.
- **OpenID Connect (browser)**: enter the name of the OpenID realm. Your browser opens the identity provider and returns to `http://localhost:<callback port>/` (default 8189), which the provider must allow as a redirect. Not available over Remote-SSH/containers where the browser cannot reach the extension host's localhost.

Create a token under **Datacenter → Permissions → API Tokens** in Proxmox. Grant its user and token the permissions needed for the operations you intend to perform, scoped to the relevant nodes, VMs, storage and networks. Privilege-separated tokens need their own ACLs as well as the user's permissions. See the [Proxmox API documentation](https://pve.proxmox.com/wiki/Proxmox_VE_API).

Supported:

- Discover nodes, QEMU VMs and LXC containers across a cluster.
- Create VMs with CPU, memory, a SCSI disk, a bridged VirtIO NIC and an optional existing ISO volume.
- Edit name, CPU cores, memory, description and start-at-boot settings.
- Start, shut down, reboot, force stop and reset, with task completion checks.
- View CPU, memory, disk throughput, network throughput, reported storage usage and uptime in the VM dashboard. Samples combine per-guest status with a shared, briefly cached cluster resource snapshot. IOPS and disk latency are shown only when a provider supplies those counters.
- Open graphical VNC and serial terminal consoles inside VS Code. Consoles use the configured credentials (API token or session), which need effective VM.Console permission. Some older Proxmox versions reject tokens on console endpoints; the extension reports that rejection without prompting for a separate password. Serial terminals require a `serial0: socket` device and a guest OS configured for serial console output.
- Open the VM in the Proxmox web UI (browser sign-in required).
- Delete VMs and their owned disks. Disk-preserving deletion is rejected.

**Staying signed in:** by default a session is forgotten when VS Code closes or reloads. Set `vmm.proxmox.rememberSession` to keep it in the operating system keychain, so the next start reuses it while it is valid (2 hours) instead of asking again. **Sign Out** removes it either way.

**Status:** the provider is covered by unit tests against a mocked API client (inventory, power tasks, creation, stats, console choice, sign-in). It has not been run against a live Proxmox VE server yet, so treat console and sign-in behaviour on your own setup as unverified and report what you find.

Snapshots (disk state, no RAM), full clone and converting a VM to a template are included (a template cannot be turned back into a VM; clone it). Not included: LXC creation, ISO upload, migration and hardware passthrough are not included. Create ISO volumes through Proxmox first. Some settings require a guest restart; Proxmox manages pending changes. Long tasks may continue on the server after the extension's two-minute wait expires; inspect Proxmox task status before retrying.

Build from the repository root with `node esbuild.mjs --only proxmox`. Package with `node scripts/package.mjs proxmox`.
