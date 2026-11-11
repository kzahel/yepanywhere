# Inbox model-card browser fixture does not populate the rendered collection

Running `e2e/inbox-model-card.spec.ts` on 2026-11-11 fails before its layout
and sequential typing checks: the main Inbox renders 11 cards rather than the
100 specified by its intercepted `/api/inbox` fixture. The case intercepts the
REST route and activity WebSocket. Check whether shared collection bootstrap or
updates bypass or replace that snapshot before changing product code; the
failure alone does not establish a product regression.

This is outside the delivered-message tiering change, which changes no client
collection loading. The delivered-message browser case independently checks
real sequential composer typing after loading its 65-turn transcript.

Found 2026-11-11 while removing cross-session deliveries from Inbox attention.
