# Antigravity credential boundary between Yep Anywhere and AAR

Status: closed without implementation, 2026-11-25. The maintainer chose to
leave Antigravity out of scope for further AAR work. This is a documentation
record.

## Decision

Direct Antigravity uses the official `agy acp` subprocess. Google’s CLI owns
the user's native sign-in, cached credentials and upstream requests. Yep
Anywhere speaks ACP over stdio and manages the conversation and lifecycle.
See [Google’s ACP guide](https://antigravity.google/docs/cli/acp/) and the
[Yep Anywhere Antigravity contract](../../topics/antigravity.md).

The proposed AAR rework considered a separate, opt-in Gemini API-key gateway
on the router's existing HTTPS origin. Google's documented Gemini-compatible
endpoint override applies to Gemini API-key mode. That mode uses a separate
API credential and API billing. The experiment currently described in
[plan 196](196-antigravity-agent-auth-router.md) sends requests to a different
Google backend and reuses a personal OAuth token. Moving that experiment into
an AAR launcher would change which process owns it. Its authentication and
upstream interface would be the same. See
[Google’s authentication guide](https://antigravity.google/docs/cli-install?app=antigravity)
and [Antigravity terms, section 6](https://antigravity.google/terms).

## Review and verification

Fable 5.2 reviewed the proposed plan at high effort in the Work Claude pool.
The read-only review found that AAR main at `07d15bd` still lacked the
Antigravity control operations, catalog, and quota support that YA expects.
It also found that a transport change would need a disposition for existing
bindings and stores. A clean Direct path and old routed history have separate
requirements. A refusal to start a legacy routed session should preserve its
history and its account pin. Any later proposal should qualify hosted HTTPS,
credential isolation and revocation with real YA and AAR against a scripted
provider.

The existing native-provider and native-recovery suites passed all four
Antigravity cases with `agy` 1.5.14 on macOS arm64. A temporary launcher removed
the SSH variables and file-storage override from the child environment. The
fixture used a synthetic API key, an isolated home and a scripted loopback
endpoint. The run exercised streaming, steering, queueing and cold resume
entirely within the scripted fixture.
