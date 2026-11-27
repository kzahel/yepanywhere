# Codex hardware-key recovery still needs a manual restart and retry

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

YA surfaces the terminal error as an
[action needed](../topics/provider-runtime-status.md#layers) banner in the
conversation. Direct sessions link to the owner's Codex sign-in. Routed
sessions link to provider settings. The user still restarts the session
and retries the prompt manually. An unattended reviewer can still end
without a result or a push alert.

## Occurrence on Direct and routed sessions

Through 2026-11-23, every hardware-key block in the local Codex history
(`thread_turns.error_json` in `~/.codex/thread_history_1.sqlite`; rollouts do
not keep the error) came from a session routed through the Agent Auth Router:
three turns in two sessions. Direct Daybreak Blue sessions completed 71 turns
without one. The router's Codex profile and the direct login are the same
ChatGPT account, and both access tokens list `urn:openai:amr:passkey` in
`amr`. That claim alone does not establish which physical key, if any,
was used in each sign-in.

On November 27, Direct session `05d1293a-4871-4b06-9b9e-8447228bb8a2`
(Codex thread `01a21ead-28d9-7a31-8a74-1c4a74984a12`) recorded the same
error. The provider's indexed history kept the error and the rollout ended
without a final answer. The conversation can recover the notice from that
saved turn.

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
  `01a20a00-2499-7021-90fb-72675e612f6c` (routed).
- The [native-provider fixture](../packages/server/test/native-provider/fixture.ts)
  reproduced the YA behavior with the real Codex 0.171 CLI. Return HTTP 200
  with a Responses stream ending in `response.failed`. Supply
  `response.error.code: "cyber_policy"` and the saved hardware-key wording in
  `response.error.message`. Codex emits a terminal `cyberPolicy` error, YA
  records it as `unknown`, and a subsequent normal turn completes in the
  same session. This test covers turn handling independently of the backend's
  decision to block a response.

## Fix direction

1. Report hardware-key failures to supervised reviewers and push subscribers.
   Verify whether device login completed with the registered key qualifies
   the next turn on Direct and routed sessions.
2. Codex 0.171's app-server adds step-up pieces YA has not adopted:
   `userVerification/status|enroll|verify|cancel` (a local, fingerprint-backed
   P-256 credential that signs a backend challenge), the `attestation/generate`
   server request behind the `requestAttestation` initialize capability, an
   `openai/userVerification` elicitation mode, and
   `account/securitySetup/read`. None is documented as the remedy for this
   error. Evaluate them during the next Codex protocol refresh, which needs
   user approval under [provider development](../docs/development/providers.md).
3. Record the terminal stream error and upstream request ID when available
   so successful HTTP transport is distinguishable from turn completion.
   Compare sign-in evidence through supported provider flows if the
   hardware-key message recurs.

Found 2026-11-23 while investigating reviewer sessions that ended with a
hardware-key cyber error.
