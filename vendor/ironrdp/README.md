# IronRDP (vendored)

Web RDP client used by the in-editor RDP console (Hyper-V VMConnect).

- Source: https://github.com/Devolutions/IronRDP @ `ddcffc42c06dc11cd21cf8c9ce2266cd5bdaed9f`
- License: MIT OR Apache-2.0 (see LICENSE-MIT, LICENSE-APACHE)
- `pkg/`: wasm-pack build of `crates/ironrdp-web` (release flags of `cargo xtask web build`)
- `iron-remote-desktop/`: `web-client/iron-remote-desktop/src` (the `<iron-remote-desktop>` web component)
- Local patches: `scripts/ironrdp-patches/0001-vmconnect-proxy-credssp.patch`, `scripts/ironrdp-patches/0002-iron-remote-desktop-shadow-root.patch`, `scripts/ironrdp-patches/0003-web-resize-canvas-on-reactivation.patch`

Regenerate with `node scripts/vendor-ironrdp.mjs`. Do not edit these files by hand.
