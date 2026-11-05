/** Local callback page. It deliberately contains no identity data, callback parameters or external resources. */
export function oidcPage(success: boolean): string {
	const title = success ? 'Continue in VS Code' : 'Sign-in wasn’t completed';
	const description = success
		? 'Your sign-in response has been received. Return to VS Code to finish connecting to your Proxmox cluster.'
		: 'We couldn’t complete this sign-in. Return to VS Code to review the error and try again.';
	const symbol = success
		? '<path d="m8 12 3 3 5-6"/>'
		: '<path d="m9 9 6 6m0-6-6 6"/>';
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="referrer" content="no-referrer">
<title>${title} · VM Manager</title>
<style>
:root{color-scheme:light dark;--page:#f5f6f8;--surface:#fff;--ink:#182333;--muted:#647083;--border:#e4e8ee;--accent:#df6800;--icon-bg:#fff3e8;--button:#182333;--button-text:#fff;--shadow:0 16px 60px #1823330a}
*{box-sizing:border-box}
body{margin:0;min-height:100svh;background:var(--page);color:var(--ink);font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased;display:flex;flex-direction:column}
header{padding:30px 40px;display:flex;align-items:center;gap:11px;font-size:14px;font-weight:650;letter-spacing:-.02em}
.app-mark{width:29px;height:29px;border-radius:8px;background:var(--ink);color:var(--surface);display:grid;place-items:center}
.app-mark svg{width:19px;height:19px}
main{flex:1;display:grid;place-items:center;padding:32px 24px 100px}
.card{width:100%;max-width:488px;background:var(--surface);border:1px solid var(--border);border-radius:20px;box-shadow:var(--shadow);padding:42px 40px 0;overflow:hidden}
.provider{display:flex;gap:9px;align-items:center;font-size:13px;font-weight:650;color:var(--muted)}
.provider svg{width:23px;height:23px;fill:var(--ink)}
.status{display:grid;place-items:center;width:56px;height:56px;margin:36px 0 23px;background:var(--icon-bg);color:var(--accent);border:1px solid color-mix(in srgb,var(--accent) 14%,transparent);border-radius:50%}
.status svg{width:28px;height:28px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
h1{font-size:30px;font-weight:650;letter-spacing:-1px;line-height:1.2;margin:0 0 15px;text-wrap:balance}
p{font-size:15px;line-height:1.7;color:var(--muted);margin:0;max-width:360px}
.action{display:inline-flex;justify-content:center;align-items:center;gap:12px;min-height:46px;padding:12px 19px;background:var(--button);color:var(--button-text);border-radius:9px;text-decoration:none;font-size:14px;font-weight:600;margin-top:28px;transition:opacity .15s}
.action:hover{opacity:.85}.action:focus-visible{outline:3px solid var(--accent);outline-offset:4px}
.action svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}
.note{font-size:12px;margin:16px 0 34px;line-height:1.6}
.card-footer{margin:0 -40px;padding:18px 40px;display:flex;align-items:center;gap:8px;border-top:1px solid var(--border);color:var(--muted);font-size:12px;line-height:1.5}
.card-footer svg{width:14px;height:14px;flex:none;fill:none;stroke:currentColor;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round}
footer{text-align:center;padding:0 24px 24px;color:var(--muted);font-size:12px}
@media(prefers-color-scheme:dark){:root{--page:#10151d;--surface:#181f29;--ink:#eef2f7;--muted:#a3afc0;--border:#2c3542;--accent:#f89a46;--icon-bg:#36291e;--button:#edf2f7;--button-text:#182333;--shadow:0 16px 60px #0002}}
@media(max-width:520px){header{padding:24px}main{padding:20px 20px 56px}.card{padding:30px 26px 0;border-radius:16px}h1{font-size:27px}.card-footer{margin:0 -26px;padding:17px 26px}.status{margin-top:30px}.action{width:100%}}
@media(prefers-reduced-motion:reduce){.action{transition:none}}
</style>
</head>
<body>
<header><span class="app-mark" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m5 7 5 5-5 5m9 0h5"/></svg></span>VM Manager</header>
<main>
<section class="card" aria-labelledby="title">
<div class="provider"><svg aria-hidden="true" xmlns="http://www.w3.org/2000/svg" xml:space="preserve" viewBox="0 34 512 444"><path d="M137.9 34.1c-10.5 0-19.7 1.9-28.5 5.7-8.6 3.8-16.2 8.9-22.9 15.6l170 186.4L426.1 55.3c-6.7-6.7-14.3-11.8-23.4-15.6-8.3-3.8-18-5.7-28-5.7-10.5 0-20.5 2.2-29.4 6.2-9.2 4-16.7 10-23.7 17l-65.2 72.2-66-72.2c-6.7-7-14.3-12.9-23.7-17-8.3-4-18.3-6.1-28.8-6.1M256.4 270l-170 186.7c6.7 6.5 14.3 11.8 22.9 15.6 8.9 3.8 18.1 5.7 28 5.7 11 0 20.5-2.4 29.4-6.2 9.4-4.3 17.5-10 24.2-17l65.5-72.2 65.4 72.2c6.7 7 14.3 12.7 23.4 17 8.9 3.8 18.6 6.2 29.4 6.2 10 0 19.7-1.9 28-5.7 9.2-3.8 16.7-9.2 23.4-15.6z" style="fill-rule:evenodd;clip-rule:evenodd"/><path d="M56 90.1c-10.8.3-21.3 2.4-30.7 6.5-9.7 4-18 9.7-25.3 16.7L129.8 256 0 398.5c7.3 7.3 15.6 12.9 25.3 17.2 9.4 4.3 19.9 6.2 30.7 6.7 11.6-.5 22.4-2.4 32.3-7.3q15-6.9 25.8-18.6l128-140.5-127.9-140.3c-7.8-7.5-16.2-13.7-26.1-18.6-10-4.6-20.5-6.7-32.1-7m399.7 0c-11.6.3-21.8 2.4-31.8 7-10 4.8-18.6 11-26.1 18.6L270.4 256l127.4 140.6q11.25 11.7 26.1 18.6c10 4.8 20.2 6.7 31.8 7.3 11.6-.5 21.5-2.4 31-6.7 10.2-4.3 18-10 25.3-17.2L382.5 256 512 113.3c-7.3-7-15.1-12.7-25.3-16.7-9.4-4.1-19.4-6.2-31-6.5" style="fill-rule:evenodd;clip-rule:evenodd;fill:#e57000"/></svg><span>Proxmox VE <span aria-hidden="true">·</span> OpenID Connect</span></div>
<div class="status" aria-hidden="true"><svg viewBox="0 0 24 24">${symbol}</svg></div>
<h1 id="title">${title}</h1>
<p>${description}</p>
<a class="action" href="vscode://">Open VS Code<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M5 12h14m-6-6 6 6-6 6"/></svg></a>
<p class="note">${success ? 'Once you’re back in the editor, you can close this tab.' : 'Start a new sign-in from your cluster in VM Manager.'}</p>
<div class="card-footer"><svg aria-hidden="true" viewBox="0 0 24 24"><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>Authentication is handled by your identity provider.</div>
</section>
</main>
<footer>VM Manager for Visual Studio Code</footer>
</body>
</html>`;
}
