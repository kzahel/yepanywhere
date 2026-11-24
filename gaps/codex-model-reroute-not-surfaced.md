# A Codex model reroute for high-risk cyber activity is not shown or recorded

Codex's app-server announces a safety downgrade with the `model/rerouted`
notification: `{ threadId, turnId, fromModel, toModel, reason }`, where the
only `reason` in Codex 0.172 is `highRiskCyberActivity`. It is Codex's
counterpart of the Claude refusal fallback behind the
[restricted capability](../topics/provider-runtime-status.md#restricted-capability)
badge. YA drops it: the protocol types under
`packages/server/src/sdk/providers/codex-protocol/generated/` do not include
`ModelReroutedNotification`, and nothing in
`packages/server/src/sdk/providers/codex-live-event-conversion.ts` handles the
method. A rerouted Codex session therefore looks like an ordinary one.

The notification is live-only. No rollout under `~/.codex/sessions` records
it (checked 2026-11-24 across the local history), and `turn_context` keeps
the requested model, so nothing durable says which model answered. A badge
that survives reload needs YA to keep the reroute itself, for example beside
the turn-failure facts in `codex-failure-trace.ts`, or to treat it as
live-only and say so. `model/verification` (`ModelVerificationNotification`)
is the related trusted-access prompt and is equally unhandled.

The other Codex refusal signals do not move work to another model, so they
are not restricted capability: the `content_filter_block` row YA already
renders is a block followed by a same-model retry, and `cyberPolicy` ends
the turn
([hardware-key gap](codex-hardware-key-cyber-block-fails-the-turn.md)).

No other provider YA integrates (Gemini, OpenCode, Pi, Grok, Copilot CLI,
Antigravity) was found to report a refusal-driven model change. That is a
search of YA's adapters and schemas for refusal, fallback and reroute
fields, not an audit of each provider's current protocol.

Fix: regenerate the protocol types to include the notification, convert it
to a live system row carrying both models and the reason, feed it to
`CapabilityRestrictionFold` on the client, and decide the persistence
question above. This is a Codex compatibility edit, which needs maintainer
approval under [provider development](../docs/development/providers.md).

Found 2026-11-24 while adding the restricted capability badge for Claude.
