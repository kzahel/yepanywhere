# A Codex hardware-key cyber block fails the turn instead of asking for re-authentication

OpenAI's backend can withhold a finished Codex response when it classifies
the output as cybersecurity work. If the account is approved for Daybreak but
the request is not tied to a sign-in that used one of its registered hardware
keys, the turn ends with `codexErrorInfo: "cyberPolicy"` and:

> You're approved for Daybreak Blue, but this response cannot be shown as this
> session was not authenticated with one of your authorized hardware keys.
> Please re-authenticate with your hardware key and try your request again.

This is decided from the response, not from the selected model or YA's cyber
access setting. It hit `gpt-6.2-sol` and Daybreak Blue reviewer and triage
sessions while `codexCyberAccessProgram` was `provider-default`, so YA
requested no program. The block arrives at the end of the turn: one
reviewer's turn ran about ten minutes and its final response was discarded.
The upstream request still reports HTTP 200, with no usage.

YA handles it as an ordinary failed turn. `classifyCodexTurnError` in
`packages/server/src/sdk/providers/codex-turn-consumer.ts` treats only
`serverOverloaded`, `policyCapacityUnavailable` and a 403 on a turn that
requested a program as recoverable, so this error is not retried and nothing
tells the user what would fix it. An orchestrated reviewer simply returns no
result. A follow-up prompt in the same session later succeeded, so the
session itself survives.

## Routed sessions are the suspected trigger

Through 2026-11-23, every hardware-key block in the local Codex history
(`thread_turns.error_json` in `~/.codex/thread_history_1.sqlite`; rollouts do
not keep the error) came from a session routed through the Agent Auth Router:
three turns in two sessions. Direct Daybreak Blue sessions completed 71 turns
without one. The router's Codex profile and the direct login are the same
ChatGPT account, and both access tokens list `urn:openai:amr:passkey` in
`amr`. That claim alone does not establish which physical key, if any,
was used in each sign-in.

The router's Codex adapter (`agent-auth-router/src/providers.ts`,
`forwardHeader`) already forwards `x-codex-*`, including
`x-codex-turn-metadata` and `x-codex-window-id`. Codex 0.171 sets
`x-client-request-id` to the thread ID. The router filters
`x-oai-attestation`, but Codex's app-server only requests an attestation
from a client that opts into `requestAttestation`. YA omits that capability
on both routes. The router cannot drop an app-server attestation YA never
requested. The router also records these blocked requests as `outcome: "ok"`.

## Reproduction evidence

- On November 23, a matched live pair reviewed the same Plan 195 step 6
  commits as the failed reviewer. Both used GPT-6.2 Sol at high effort and
  existing sign-ins. The narrower prompt restricted the review to reading
  the source and existing tests. Both routes completed in about 3m20s. The
  native threads are `01a20a00-1e55-7f43-9f94-bf70eefd7935` (Direct) and
  `01a20a00-2499-7021-90fb-72675e612f6c` (routed). The previously observed
  hardware-key failures are still associated with routed turns.
- The [native-provider fixture](../packages/server/test/native-provider/fixture.ts)
  reproduced the YA behavior with the real Codex 0.171 CLI. Return HTTP 200
  with a Responses stream ending in `response.failed`. Supply
  `response.error.code: "cyber_policy"` and the saved hardware-key wording in
  `response.error.message`. Codex emits a terminal `cyberPolicy` error, YA
  records it as `unknown`, and a subsequent normal turn completes in the
  same session. This test covers turn handling independently of the backend's
  decision to block a response.

## Fix direction

1. Classify `cyberPolicy` with the hardware-key wording as its own
   recoverable state. Keep the session's work, notify the user (including by
   push), and offer to re-authenticate and then retry the turn. If the routed
   hypothesis holds, also offer to retry it Direct.
2. Re-authentication happens in a browser at `auth.openai.com`. YA and the
   router sign Codex in with `--device-auth`, which can be completed from a
   phone, so a phone-only recovery path already exists.
3. Codex 0.171's app-server adds step-up pieces YA has not adopted:
   `userVerification/status|enroll|verify|cancel` (a local, fingerprint-backed
   P-256 credential that signs a backend challenge), the `attestation/generate`
   server request behind the `requestAttestation` initialize capability, an
   `openai/userVerification` elicitation mode, and
   `account/securitySetup/read`. None is documented as the remedy for this
   error. Evaluate them during the next Codex protocol refresh, which needs
   user approval under [provider development](../docs/development/providers.md).
4. Record the terminal stream error and upstream request ID when available
   so successful HTTP transport is distinguishable from turn completion.
   Compare sign-in evidence through supported provider flows if the
   hardware-key message recurs.

Found 2026-11-23 while investigating reviewer sessions that ended with a
hardware-key cyber error.
