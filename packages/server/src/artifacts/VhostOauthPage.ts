import { createHash } from "node:crypto";
import { html, raw } from "hono/html";

const stylesheet = `
:root{color-scheme:light dark;font-family:system-ui,sans-serif;color:#20242c;background:#f5f6f8}
*{box-sizing:border-box}
body{margin:0;min-height:100svh;display:grid;place-items:center;padding:24px}
main{width:100%;max-width:440px;padding:32px;background:#fff;border:1px solid #dce0e6;border-radius:16px;box-shadow:0 8px 32px #18203008}
.host{margin:0 0 24px;font-size:14px;color:#596271;overflow-wrap:anywhere}
h1{margin:0;font-size:28px;line-height:1.2;letter-spacing:-.5px}
.message{margin:16px 0 28px;line-height:1.5;color:#596271}
nav{display:grid;gap:12px}
a{display:flex;align-items:center;justify-content:center;min-height:48px;padding:12px 16px;border:1px solid #b7bfca;border-radius:8px;color:inherit;background:#fff;text-decoration:none;font-size:16px;font-weight:600;text-align:center;overflow-wrap:anywhere}
a:hover{background:#f0f3f7;border-color:#687588}
a:focus-visible{outline:3px solid #2766ca;outline-offset:3px}
@media(prefers-color-scheme:dark){:root{color:#edf0f5;background:#12151b}main{background:#1d222b;border-color:#343d4b}.host,.message{color:#b1bbc9}a{background:#262d38;border-color:#566275}a:hover{background:#323d4d;border-color:#94a4bb}a:focus-visible{outline-color:#83b5ff}}
`;
const styleHash = createHash("sha256").update(stylesheet).digest("base64");

/** Render public app sign-in without scripts, remote assets or operator state. */
export function vhostOauthPage(options: {
  host: string;
  title: string;
  message: string;
  buttons: { label: string; href: string }[];
  status: number;
}): Response {
  const document = html`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${options.title}</title><style>${raw(stylesheet)}</style></head><body><main><p class="host">${options.host}</p><h1>${options.title}</h1><p class="message">${options.message}</p><nav aria-label="Sign-in options">${options.buttons.map((button) => html`<a href="${button.href}">${button.label}</a>`)}</nav></main></body></html>`;
  return new Response(document.toString(), {
    status: options.status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": `default-src 'none'; style-src 'sha256-${styleHash}'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
      "X-Content-Type-Options": "nosniff",
    },
  });
}
