# VM Manager for VS Code

Manage virtual machines on any hypervisor without leaving VS Code: create, edit, delete, start, shut
down, reboot and power off machines, and open graphical (noVNC) or serial (xterm) consoles in editor
tabs that you can pop out into their own window.

Everything is organised as **Cluster → Node → Virtual machine**:

```
Local (Hyper-V)            ← cluster   (one hypervisor installation)
└─ DESKTOP-ALEX            ← node      (a host)
   ├─ web-01  Running      ← VMs
   └─ db-01   Off
```

## Providers

Hypervisors are supported by separate provider extensions, so each one is published and updated on
its own (like *Database Client JDBC* for *Database Client*):

| Extension | Status | Graphical console | Serial console |
|---|---|---|---|
| `sourceregistry.vm-manager-hyperv` | ✅ Hyper-V on the local Windows machine | live preview + native viewer (`vmconnect`) | COM1 named pipe |
| `sourceregistry.vm-manager-qemu` | ✅ QEMU machines run by VS Code (WHPX / KVM / HVF) | noVNC | ✅ |
| Proxmox VE, XCP-ng, VMware, Nutanix | planned | | |

## Features

* **Native UI first** — tree view with state icons and badge, inline and context-menu actions, welcome
  views, multi-step quick inputs to add clusters and create VMs, modal confirmations, progress,
  a status bar item, settings and a getting-started walkthrough.
* **Overview** dashboard and a **settings editor** per VM, built with the
  [client-lib](https://gitlab.projectsource.nl/sourceregistry/svelte/client-lib) Svelte 5 library.
* **Follows your theme** — every colour and font in the webviews comes from the active VS Code theme
  (light, dark, high contrast and third-party themes), and updates live when you switch.
* **Consoles in the editor** — noVNC and xterm, toolbar actions for Ctrl+Alt+Del, scaling, power and
  *Open in New Window*. Connections run in the extension host and are relayed to the tab, so they
  also work in Remote SSH / WSL / Codespaces.
* **Secure credentials** — secrets go to VS Code Secret Storage (OS keychain), never to settings or
  webviews.

## Repository layout

```
src/extension/        core extension host (registry, clusters, tree, commands, webview hosts)
src/shared/           host ⇄ webview protocol types
src/lib/client-lib/   client-lib (git submodule, branch migration/svelte-standards — never edited here)
src/lib/client/       extension UI: views, components, SvelteKit shims, VS Code theme bridge
packages/sdk/         @vmm/sdk — provider API shared by core and providers
extensions/hyperv/    Hyper-V provider extension
extensions/qemu/      QEMU provider extension
```

client-lib is written for SvelteKit. Webviews cannot run SvelteKit, so Vite aliases the `$app/*`,
`$env/*` and `@sveltejs/kit` imports to small shims in `src/lib/client/shims` — client-lib stays
unmodified. `src/lib/client/styles/_vscode-bridge.scss` maps all client-lib tokens to `--vscode-*`
theme variables.

## Development

```sh
git clone --recurse-submodules <repo>
npm install
npm run build        # webview (Vite) + extension hosts (esbuild)
npm test             # unit tests (vitest)
npm run check        # tsc + svelte-check
```

Press <kbd>F5</kbd> and pick **Run VM Manager (core + providers)**. In development mode the core also
registers a *Fake (development)* provider so the UI can be exercised without a hypervisor.

`npm run package` writes one `.vsix` per extension to `out/`.

## Writing a provider

A provider is a VS Code extension that depends on the core and registers a `HypervisorProvider`
from `@vmm/sdk`:

```jsonc
// package.json
{
  "extensionDependencies": ["sourceregistry.vm-manager"],
  "contributes": {
    "vmManager.providers": [{ "id": "proxmox", "displayName": "Proxmox VE" }]
  }
}
```

```ts
import * as vscode from 'vscode';
import { CORE_EXTENSION_ID, type VmManagerApi } from '@vmm/sdk';

export async function activate(context: vscode.ExtensionContext) {
	const api = await vscode.extensions.getExtension<VmManagerApi>(CORE_EXTENSION_ID)!.activate();
	context.subscriptions.push(api.registerProvider(new ProxmoxProvider()));
}
```

The provider declares its connection fields as a `FieldSchema[]` (fields marked `secret` are stored
in Secret Storage by the core), and implements `ClusterConnection`: list nodes and VMs, CRUD, power
actions, and `openConsole()` returning a byte stream (raw RFB for `vnc`, raw bytes for `serial`).
The core renders all UI and relays console streams, and activates provider extensions lazily when a
stored cluster needs them.
