/**
 * Side-effect import that registers IronRDP's `<iron-remote-desktop>` custom element. Aliased in
 * vite.config.mts to the vendored Svelte component; declared here so the type checker does not
 * descend into third-party sources (they target an older TypeScript `lib`).
 */
declare module 'virtual:ironrdp-element' {}
