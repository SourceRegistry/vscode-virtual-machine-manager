# Browser sign-in for providers

The core extension owns the loopback callback server, browser launch, page template, favicon, timeout and cleanup. Providers own their authorization URL, state/PKCE validation (or the server-side equivalent), code exchange and session storage. The core never puts authorization codes, tokens or server error details in the HTML.

Providers can call the optional `VmManagerApi.browserLogin` method:

```ts
if (!api.browserLogin) throw new Error('Update VM Manager to use browser sign-in.');

const session = await api.browserLogin({
  providerName: 'Example hypervisor',
  providerIcon: 'data:image/png;base64,...', // optional; defaults to the core icon
  port: 8189,
  signal,
  getAuthorizationUrl: async (redirectUrl) => createAuthorizationUrl(redirectUrl),
  exchange: async ({ code, state, redirectUrl }) => {
    // Validate the response and exchange the code. Resolve only when sign-in succeeds.
    return exchangeAuthorizationCode(code, state, redirectUrl);
  }
});
```

The provider must allow the exact redirect `http://localhost:<port>/`. The listener binds only to loopback. It is ready before the browser opens; each attempt owns its server, with a five-minute timeout (a provider can ask for up to 30 through `timeoutMs`; Proxmox asks for 15) and optional cancellation signal. Core deactivation cancels outstanding attempts. Proxmox uses its own `/access/openid/auth-url` and `/access/openid/login` endpoints within these callbacks.

## Page and assets

The shipped template is `media/auth/callback.html`. Edit HTML and CSS there. All `{{variables}}` are HTML-escaped in a single replacement pass; no raw HTML placeholders are supported. Provider icons must be PNG data URIs, otherwise the core icon is used. The same icon becomes the favicon, so no callback-server asset routes or remote downloads are needed. The page uses the active VS Code URI scheme to return to the editor.

## Cleanup

The page reports success only after the exchange resolves. After sending the page, the server closes and releases its port on both success and failure. Authorization-URL errors, browser-launch errors, timeout and cancellation also close it.

On success, the page also tries to open the editor by itself (the *Open VS Code* button stays as the fallback, since browsers may ask first or refuse without a click) and clears callback parameters from its history entry. It attempts to close when hidden (for example when returning to VS Code), or when its local health check can no longer reach the completed callback server. Browsers can refuse `window.close()` on tabs they consider user-opened. In that case, the page retains manual-close instructions and stops polling. Error pages stay visible so the user can read what happened. This is a best-effort tab cleanup, not a guarantee of browser control.
