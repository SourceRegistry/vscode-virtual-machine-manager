# Developing VM Manager

This repository holds the core extension and the provider extensions. For what the extension does,
see the [README](README.md).

## Repository layout

```
src/extension/        core extension host (registry, clusters, tree, commands, webview hosts, RDP gateway)
src/shared/           host ⇄ webview protocol types
src/lib/client-lib/   client-lib (git submodule, branch migration/svelte-standards — never edited here)
src/lib/client/       extension UI: views, components, SvelteKit shims, VS Code theme bridge
packages/sdk/         @vmm/sdk — provider API shared by core and providers;
                      @vmm/sdk/provisioning — cloud images, cloud-init, cidata ISO (Node only, not for the webview)
extensions/hyperv/    Hyper-V provider extension
extensions/libvirt/   libvirt provider extension
extensions/proxmox/   Proxmox VE provider extension
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
platform logo (`media/marketplace/<id>.svg`, listed in `BADGES` in `scripts/render-icons.mjs`). After
changing the artwork or adding a provider:

```sh
node scripts/render-icons.mjs
```

### Adding a provider extension

The build (`esbuild.mjs`), the type check (`npm run check`), packaging and releases find every
directory in `extensions/` on their own. A new provider needs:

- `extensions/<id>/src/extension.ts` (bundled to `dist/extension.js`, which `main` must name) and a `tsconfig.json`
- its platform logo as `media/marketplace/<id>.svg` and an entry in `BADGES`, then `node scripts/render-icons.mjs`
  to write `extensions/<id>/media/icon.png`; `"icon": "media/icon.png"` in its `package.json`
- a `.vscodeignore` that keeps `package.json`, `README.md`, `LICENSE`, `CHANGELOG.md`, `dist/extension.js` and `media/**`

`test/extensions.test.ts` fails when any of these is missing, so `npm test` catches a provider that
would ship without its icon.

## Releasing

Releases are automatic, and every extension is released on its own. Every push to `main` runs
[`.github/workflows/release.yml`](.github/workflows/release.yml): the tests (Linux and Windows,
including the VS Code integration test), then `scripts/release.mjs`. That runs
[semantic-release](https://semantic-release.gitbook.io/) once per extension (core first), configured
in `release.config.mjs` from the list in `scripts/packages.mjs`. For each extension it looks only at the
[Conventional Commits](https://www.conventionalcommits.org/) that touched that extension since its own last
tag (`fix:` → patch, `feat:` → minor, `BREAKING CHANGE:` → major). If there are any, it updates that
extension's version and `CHANGELOG.md`, publishes it to the VS Code Marketplace and creates a GitHub
release with its `.vsix`. Extensions without releasable commits are skipped.

| Extension | Files that count | Tag | Changelog |
| --- | --- | --- | --- |
| core (`vm-manager`) | everything except `extensions/` | `v1.2.3` | `CHANGELOG.md` |
| provider (`vm-manager-qemu`, …) | `extensions/<id>/` and `packages/sdk/` | `vm-manager-qemu-v1.2.3` | `extensions/<id>/CHANGELOG.md` |

Providers bundle `packages/sdk`, so a commit that changes it releases every provider. Keep SDK commits
purposeful, and keep provider-only changes inside `extensions/<id>/`. A commit that touches several
extensions counts for each of them. Compatibility between versions is handled by the API version
handshake above, not by matching version numbers.

### Adding a provider to the releases

Create the directory under `extensions/` and tag the commit its first version should be measured from
(otherwise semantic-release would release `1.0.0` from the whole history):

```sh
git tag vm-manager-<id>-v<version> <commit> && git push origin vm-manager-<id>-v<version>
```

`main` is protected by the *Protect main* ruleset: changes land through a pull request whose
*Test (ubuntu-latest)* and *Test (windows-latest)* checks pass, and nobody can force-push or delete the
branch. The release job pushes its release commit (version, changelog) straight to `main`, which only
a repository admin may do, so it authenticates with the `RELEASE_TOKEN` secret: a fine-grained personal
access token of an admin with *Contents: read and write* on this repository. If it expires, the release
job fails at checkout; create a new token and update the secret.

Publishing uses Marketplace [Trusted Publishing](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)
(GitHub OIDC, `vsce publish --oidc`), so no access token is stored. The publisher's policy must name
owner `SourceRegistry`, repository `vscode-virtual-machine-manager`, workflow `release.yml` and environment
`marketplace`. To publish an existing tag again (e.g. after a failed Marketplace upload), run the
*Release* workflow manually with that tag (`v1.2.3` for the core, `vm-manager-qemu-v1.2.3` for a provider).

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
