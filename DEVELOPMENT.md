# Developing VM Manager

This repository holds the core extension and the provider extensions. For what the extension does,
see the [README](README.md).

## Repository layout

```
src/extension/        core extension host (registry, clusters, tree, commands, webview hosts, RDP gateway)
src/shared/           host ⇄ webview protocol types
src/lib/client-lib/   client-lib (git submodule, branch migration/svelte-standards — never edited here)
src/lib/client/       extension UI: views, components, SvelteKit shims, VS Code theme bridge
packages/sdk/         @vmm/sdk — provider API shared by core and providers
extensions/hyperv/    Hyper-V provider extension
extensions/qemu/      QEMU provider extension
vendor/ironrdp/       vendored IronRDP web client (WebAssembly) for the RDP console
media/marketplace/    Marketplace icon artwork
scripts/              packaging, publishing, icon rendering, IronRDP vendoring
```

Providers are separate extensions so each one is published and updated on its own (like *Database
Client JDBC* for *Database Client*). The core renders all UI, stores clusters and secrets, relays
console streams, and activates provider extensions lazily when a stored cluster needs them.

### API version handshake

Core and providers are versioned through `VMM_API_VERSION` / `VMM_MIN_API_VERSION` in
`packages/sdk/src/index.ts`. A provider built against API version *P* runs on a core that supports
`VMM_MIN_API_VERSION ≤ P ≤ VMM_API_VERSION`; otherwise the user is told which side to update.

- Bump `VMM_API_VERSION` when `VmManagerApi` or `HypervisorProvider` gains something providers rely on.
- Raise `VMM_MIN_API_VERSION` only for a breaking change (removed or changed API).
- Every provider declares the version it was built against as `apiVersion` in its
  `contributes["vmManager.providers"]` entry; a test keeps this equal to `VMM_API_VERSION`. The core
  checks it before activating the provider, and the provider checks the core again on activation.

The webviews (Overview, VM settings, consoles) use the
[client-lib](https://gitlab.projectsource.nl/sourceregistry/svelte/client-lib) Svelte 5 library.
client-lib is written for SvelteKit; webviews cannot run SvelteKit, so Vite aliases the `$app/*`,
`$env/*` and `@sveltejs/kit` imports to small shims in `src/lib/client/shims` and client-lib stays
unmodified. `src/lib/client/styles/_vscode-bridge.scss` maps all client-lib tokens to `--vscode-*`
theme variables, so the webviews follow the user's theme live.

Console connections run in the extension host and are relayed to the webview over `postMessage`;
the webview never opens sockets. For RDP the core runs an RDCleanPath gateway (pre-connection blob,
TLS, optional CredSSP with the Windows logon through SSPI) in front of the in-webview IronRDP
client.

## Build and run

```sh
git clone --recurse-submodules https://github.com/SourceRegistry/vscode-virtual-machine-manager.git
npm install
npm run build             # webview (Vite) + extension hosts (esbuild)
npm run check             # tsc + svelte-check
npm test                  # unit tests (vitest)
npm run test:integration  # smoke test in a downloaded VS Code
```

Press <kbd>F5</kbd> and pick **Run VM Manager (core + providers)**. In development mode the core also
registers a *Fake (development)* provider so the UI can be exercised without a hypervisor.

`npm run package` writes one `.vsix` per extension to `out/`.

## Vendored IronRDP

The RDP console uses the [IronRDP](https://github.com/Devolutions/IronRDP) web client (MIT OR
Apache-2.0), vendored in `vendor/ironrdp` at a pinned commit with local patches from
`scripts/ironrdp-patches`. To rebuild it (needs Rust and `wasm-pack`):

```sh
node scripts/vendor-ironrdp.mjs
```

## Marketplace icons

The icons are rendered from `media/marketplace/icon.svg`; the provider icons add a badge with the
platform logo (`hyperv.svg`, `qemu.svg`). After changing the artwork:

```sh
node scripts/render-icons.mjs
```

## Releasing

Releases are automatic. Every push to `main` runs
[`.github/workflows/release.yml`](.github/workflows/release.yml): the tests (Linux and Windows,
including the VS Code integration test), then [semantic-release](https://semantic-release.gitbook.io/),
which derives the next version from the [Conventional Commits](https://www.conventionalcommits.org/)
since the last tag (`fix:` → patch, `feat:` → minor, `BREAKING CHANGE:` → major), updates
`CHANGELOG.md` and the package versions, publishes the core and provider extensions to the VS Code
Marketplace and creates a GitHub release with the `.vsix` files. All extensions share one version.

Publishing uses Marketplace [Trusted Publishing](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)
(GitHub OIDC, `vsce publish --oidc`), so no access token is stored. The publisher's policy must name
owner `SourceRegistry`, repository `vscode-virtual-machine-manager`, workflow `release.yml` and environment
`marketplace`. To publish an existing tag again (e.g. after a failed Marketplace upload), run the
*Release* workflow manually with that tag.

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
actions, and `openConsole()` returning a byte stream (raw RFB for `vnc`, raw bytes for `serial`,
the raw TCP connection to the RDP endpoint for `rdp` together with `getRdpTarget()`; the core runs
the RDCleanPath gateway: pre-connection blob, TLS, relaying).
