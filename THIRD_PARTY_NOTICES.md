# Third-party notices

The core extension's webview bundle (`dist/webview`) contains the following third-party software.

| Component | Version | License | Source |
|---|---|---|---|
| IronRDP web client (`ironrdp-web`, `iron-remote-desktop`) | `ddcffc42` | MIT OR Apache-2.0 | https://github.com/Devolutions/IronRDP |
| noVNC | 1.7.0 | MPL-2.0 | https://github.com/novnc/noVNC |
| xterm.js, @xterm/addon-fit | 6.0.0, 0.11.0 | MIT | https://github.com/xtermjs/xterm.js |
| Svelte | 5 | MIT | https://github.com/sveltejs/svelte |
| Bootstrap Icons | 1.13.2 | MIT | https://github.com/twbs/icons |
| Codicons | 0.0.46 | CC-BY-4.0 | https://github.com/microsoft/vscode-codicons |

IronRDP's license texts are included in `vendor/ironrdp/LICENSE-MIT` and
`vendor/ironrdp/LICENSE-APACHE`. IronRDP is modified by the patches in `scripts/ironrdp-patches`
(gateway-side CredSSP for VMConnect, shadow-root setup, canvas resize on reactivation). noVNC is used unmodified; its source is available at the link above.
