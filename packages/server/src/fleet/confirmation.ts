import { html } from "hono/html";

/** No external assets or scripts; display values are HTML-escaped. */
export function renderFleetConfirmation(input: {
  confirmationCode: string;
  displayName: string;
  profileId: string;
  signingFingerprint: string;
}) {
  return html`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Confirm YA enrollment</title><style>
  :root{color-scheme:light dark;font-family:system-ui,sans-serif;line-height:1.5}body{margin:0;padding:1.5rem}main{max-width:42rem;margin:2rem auto}h1{font-size:1.6rem;line-height:1.2}dt{font-weight:600;margin-top:1rem}dd{margin:0;overflow-wrap:anywhere}code{font-family:ui-monospace,monospace}.confirmation{display:block;border:1px solid GrayText;border-radius:.4rem;padding:1rem;margin:1rem 0;overflow-wrap:anywhere;font-size:1rem;user-select:all}.notice{font-weight:600}p{max-width:62ch}
  </style></head><body><main><h1>Confirm this YA server</h1><p>Signing in has not enrolled this server yet. Compare these details with the trusted client where you began enrollment.</p><dl><dt>Server name</dt><dd>${input.displayName}</dd><dt>Profile</dt><dd><code>${input.profileId}</code></dd><dt>Signing fingerprint</dt><dd><code>${input.signingFingerprint}</code></dd></dl><p>Supply this one-use code only to that initiating client to finish enrollment:</p><code class="confirmation" id="enrollment-confirmation">${input.confirmationCode}</code><p class="notice">Do not forward this code or enter it into a server you did not choose to enroll.</p><p>If someone sent you a login link and you did not begin this enrollment, close this page. No server is enrolled from signing in alone.</p></main></body></html>`;
}
