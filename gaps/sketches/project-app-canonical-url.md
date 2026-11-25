# Project app canonical address: remaining work

Redirect, direct host port and Funnel controls are implemented; the
contract is [project service § Direct serving](../../topics/project-service.md#direct-serving).
What remains:

- **A hostname per app.** Funnel publishes this host's own Tailscale node
  name, so apps on one host differ only by HTTPS port (443, 8443, 10000).
  A distinct name needs another node (for example a `tsnet` or second
  `tailscaled` joined with an auth key) or Tailscale Services, which
  `tailscale funnel --service=svc:<name>` addresses and which are defined
  tailnet-side, plausibly through the API key. Neither has been tried;
  verify the current Tailscale mechanism before building on it.
- **Framed state stays separate.** A redirect framed in the App pane is a
  third-party frame under YA's site, so browsers keep its storage and
  cookies apart from the same address opened in its own tab. Whether the
  HTTP auth cache is partitioned the same way is unverified per browser.
  Consider opening stateful redirect apps top-level by default, with
  framing opt-in for client-stateless apps.
- **Browser coverage of the probe.** The no-credential reachability probe
  is unit-tested with a stubbed fetch only. Check in a real browser that a
  Basic-auth redirect raises no prompt from the probe and that a refused
  address falls back.

Found 2026-11-25 while moving read-me behind Tailscale Funnel.
