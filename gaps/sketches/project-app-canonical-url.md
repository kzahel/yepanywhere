# Project app with a canonical external address

An app that already runs outside YA at a stable address (read-me: a system
service with `--basic-auth` behind a Tailscale Funnel) can be declared today
only as a static stub whose `index.html` meta-refreshes to that address.
YA then frames the stub from its own artifact origin. That causes three
problems:

- The app bar names the stub's localhost URL, not the real address.
- The frame ends up at the canonical origin but embedded under YA's site.
  Browser storage partitioning keys cookies and storage by the top-level
  site, so the framed app's login and state are separate from the same app
  opened in its own tab. HTTP auth cache partitioning probably behaves the
  same way; this has not been verified per browser. Recording also needs the
  microphone and the saved login, and both work only top-level.
- YA cannot tell that the app is unreachable; the frame just fails.

## Intended shape (user-directed, 2026-11-25)

- Declare the canonical address in `app.json`, for example
  `where: { kind: "external", url: "https://…" }`, optionally with a
  loopback fallback port. Today `where` rejects external entry URLs
  ([project service](../../topics/project-service.md), `where` row), so this
  changes that contract.
- Prefer the canonical address. Fall back to the localhost port only when
  the canonical address is unreachable (connection refused, DNS failure),
  never just because it challenges for credentials. The fallback is
  optional per app.
- Reachability must be judged from the viewing browser, not the YA server:
  a tailnet address can be reachable from one and not the other. Probe with
  `credentials: "omit"`, so the probe itself cannot raise a login prompt.
- When the app's state matters, open it top-level by default instead of
  framing it, since partitioning makes framed state diverge from the tab.
  An opt-in "frame anyway" suits client-stateless apps.
- The app bar shows and copies the canonical address.

Related: [app link access control](../app-artifact-access-control.md)
(embedded-cookie restrictions).
