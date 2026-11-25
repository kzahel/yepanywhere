# Separate AAR routing from Yep Anywhere provider launches

Status: steps 1 to 4 implemented and pushed, 2026-11-25. AAR commits
`d5623a7`, `5a5039a` and `1f56bb1` publish the transport, `819f342` adds the
Antigravity opt-in, and none is released. YA consumes the transport from
`f4c106fb1` with the legacy shim, fronts routed Antigravity with a
provider-neutral proxy from `9793c4832`, and names the opt-in's refusal from
`b01a2335a`. Step 5 is partly done: AAR's cross-repository suite (AAR
`819f342`) runs YA `b01a2335a` against the describing router over the local
control socket, and
[one live Antigravity run](#live-antigravity-run-2026-11-25) is recorded.
The hosted and official-executable checks and the AAR release in step 5 are
open. A routed Antigravity resume
[failed with `agy` 1.5.17 on macOS](../../gaps/agy-1-5-17-ignores-routed-profile-login.md).
The landed behavior is recorded in the
[binding transport contract](../../topics/agent-auth-router.md#binding-transport-2026-11-25).

## Goal

An operator can run one Agent Auth Router (AAR) for metered subscriptions and
select its accounts or pools from Yep Anywhere (YA) on several machines. Each
YA instance still runs the provider in its local project. AAR owns access to
upstream accounts and supplies the transport for a selected binding. YA owns
the provider subprocess and conversation. Direct login remains the default.
Provider API-key accounts and pay-as-you-go API routing are outside AAR's scope.

Claude and Codex are the first consumers of the new protocol. Experimental
Antigravity routing needs an endpoint on the execution host, because `agy`
cannot be handed the binding token. The protocol design and that adapter's
authentication are separate decisions. Keep Direct and existing experimental
behavior during this protocol work. The
[Antigravity authentication decision](197-antigravity-credential-boundary.md)
records the declined Gemini API-key proposal. On 2026-11-25 the maintainer
accepted the existing Antigravity authentication as the experimental mode.

## What exists today

YA pairs with AAR over a local control socket or HTTPS, asks AAR to select and
reserve an account, and commits the reservation before starting Claude or Codex.
AAR keeps the account pin across restarts, authorizes inference with a revocable
binding token, and tracks usage and quota. YA retains its own session ID, the
provider-native resume ID, and the AAR binding ID. The operator can run hosted
control and inference on one HTTPS origin. See the
[YA routing contract](../../topics/agent-auth-router.md#ownership-and-lifecycle)
and [AAR control protocol](https://github.com/kzahel/agent-auth-router/blob/main/docs/control.md).

The missing piece is an explicit handoff for inference transport. Today YA
builds `inferenceOrigin + /${provider}`, infers auth behavior from global
capabilities, and appends `/models` itself for Codex. That couples AAR's URL
layout and transport decisions to YA's launch code. The binding endpoints
already return the selected account and state. Add the transport description
there and keep the existing account-selection and ownership rules. See
[YA binding and launch code](../../packages/server/src/services/AgentAuthRouter.ts)
and [native launch adapters](../../packages/server/src/sdk/providers/router-transport.ts).

The experimental Antigravity path goes further. Before step 3, YA owned an
in-process loopback bridge that listed Google's private Cloud Code endpoint
names, and its binding described no transport.
See the [current Antigravity routing contract](../../topics/agent-auth-router.md#antigravity-per-session-routing-2026-11-23).

## Ownership

| Owner | Responsibilities |
| --- | --- |
| AAR | Enroll subscription profiles through their official CLIs, own grants and pool policy, choose and pin the account, publish the inference route and supported auth methods, decide which paths and methods each route serves, authorize and revoke bindings, and account for traffic. |
| YA server | Pair with the configured router, request and validate the binding for the user-selected account or pool, retain the binding identity, and keep the AAR-issued inference credential in server-private state. |
| YA provider adapter and runtime owner | Translate the checked transport into supported native client settings. When the native program cannot be handed the binding token, front the route with YA's provider-neutral loopback proxy. Own the working directory, subprocess, approvals, input delivery, stop, restart or reattach, and native history. |

The paired YA installation is the AAR integration principal. The owner grants
it use of accounts or pools. The control credential acts for that principal.
The inference credential authorizes only the selected binding and provider.
Credentials for AAR-enrolled subscriptions stay on the router host. YA's
existing local project and session authorization governs who can request a
launch. See [principals and grants](../../topics/principals-and-grants.md) and
[YA's security model](../../topics/security.md#authority-model).

## Proposed wire contract

Keep `prepare`, `commit`, `inspect`, and `cancel` on the existing integration
API. AAR includes a typed `transport` in prepared and committed binding
responses. The prepared response lets YA check it has a compatible adapter.
A committed response authorizes inference. `inspect` can recover the
committed response after response loss. Its existing authorization checks
still apply.

Illustrative committed Codex response fields:

```json
{
  "id": "<binding-id>",
  "routerId": "<router-id>",
  "accountId": "<account-id>",
  "provider": "codex",
  "state": "committed",
  "transport": {
    "kind": "http-gateway-v1",
    "basePath": "/codex",
    "authMethods": ["bearer"],
    "modelCatalogPath": "/codex/models"
  }
}
```

`http-gateway-v1` describes a route on AAR's inference origin and how a
request presents the token there. Claude and Codex connect to it directly;
`agy` reaches it through YA's loopback proxy. Claude can offer `bearer` and `aar-gateway-header`. YA picks the latter only
for the existing explicit connector option when the local login is available.
The native Claude adapter continues to own the CLI's header and environment
configuration. AAR continues to discard the execution host's native bearer
when the dedicated AAR header authenticates a request. Codex uses its native
Responses configuration, including the catalog path when supplied. YA maps
only recognized auth methods.
The descriptor contains no credentials. YA uses the existing binding token
whose hash it registered during preparation. That token stays out of URLs,
command arguments, logs, transcripts, and client-facing metadata.

For `http-gateway-v1`, paths are rooted at the validated inference origin
from `/v1/info`. Hosted control stays under `/control/v1/*`, with inference on
paths such as `/claude/*` and `/codex/*` on the same host and port. A local
socket connection uses the existing loopback inference origin. On recovery,
validate the router, binding, account and provider. Reject invalid paths, foreign origins,
control or dashboard targets, and a kind or auth mode the provider adapter
cannot use. Catalog paths must stay within the selected inference route. The
descriptor accepts data fields only. Executables, arguments, environment
overlays and headers remain locally authored by the native adapter. See
[hosted AAR](../../topics/agent-auth-router.md#hosted-https-router-2026-11-15).

### Endpoint on the execution host

`agy` presents the login stored in its profile, and sends that login to
Google as well as to the endpoint it is pointed at. It therefore cannot be
given the binding token. Something on the machine running `agy` must accept a
stand-in credential and replace it with the token. That listener cannot live
on a hosted router: the stand-in must be worthless anywhere but on the
execution host's own loopback listeners.

Decided 2026-11-25: YA hosts that listener as a provider-neutral proxy, and
AAR describes the Antigravity route with the same `http-gateway-v1` transport
as Claude and Codex (`/antigravity`, `bearer`). `bearer` states what the route
accepts. That the native program may not hold the token is a fact about `agy`,
so it lives in YA's Antigravity launch adapter beside the launch flags and
the profile setup.

The proxy knows a local token, the binding token, and the checked route. It
requires its own `Host` and the local token on every request, replaces the
credential, and forwards plain HTTP exchanges below the route. It names no
provider endpoint. AAR refuses any path or method outside the provider's
registered routes before it checks the token, so a second list in YA would
only repeat AAR's. The
[routing contract](../../topics/agent-auth-router.md#antigravity-per-session-routing-2026-11-23)
lists what the proxy refuses.

The earlier design reserved a `local-http-v1` kind: YA would start an `aar`
executable as a supervised child, and that helper would own the listener and
report its URL over a control pipe. It was set aside because a hosted router
would then need an `aar` install on every execution host, kept compatible
with the router, where today a hosted setup needs nothing beyond YA. The kind
stays reserved and unimplemented. A router would offer a later kind only to a
client that names it in its prepare request.

### Launch and recovery sequence

1. **Prepare the account binding.** YA persists its allocation ID and token
   before the request. AAR can select a pool member or reserve an explicitly
   requested account. YA checks the binding response, model and transport
   before committing. A retry reuses the same allocation identity.
2. **Commit and obtain the launch transport.** AAR checks the live grant and
   durably enables inference before replying. YA launches only after validating
   a committed response. After a lost reply, YA inspects the same binding or
   repeats the idempotent commit. A definitive grant or account refusal is
   surfaced with the existing error path. A new preflight failure releases its
   reservation through the existing cancellation logic.
3. **Prepare transport and start the native provider.** The checked URL can
   be used immediately after commit. An adapter whose program cannot hold the
   token starts the loopback proxy first and points the program at it. YA
   applies the URL and starts the native runtime in the local project.
   Its existing startup and first-input boundaries determine whether the
   launch succeeded. AAR commit confirms routing authorization. Native
   readiness stays with YA.
4. **Stop or resume.** Routine stop and idle reap end the process and leave
   the binding pinned. A failed fresh launch uses the existing durable
   cancellation path. A failed resume keeps its pin for retry. A cold resume
   checks the existing binding and gets its current transport. Backend reattach
   retains the running worker and its launch configuration only when its binding
   still matches, following the current Provider Host contract. Revocation
   blocks new inference.

## Implementation sequence

### 1 — Publish transport on AAR binding responses

Define the versioned response in AAR's control contract and add construction
near the existing provider route definitions. Have both account and pool
prepare return it, then reuse it on commit and inspect through local and
hosted control. Build it from the router's registered inference routes.
Advertise `binding-transport-v1` in `/v1/info` so a client can tell before
allocating whether binding responses carry the description. The capability
covers Claude and Codex bindings. Antigravity bindings already go through the
same prepare and commit under `antigravity-control-v1`. Their responses carry
no `transport` until the step 3 cutover, and YA's per-session bridge keeps
using the `/antigravity` route as it does today. A later transport kind is
offered only to a client that names it in its prepare request. A client that
names none keeps receiving `http-gateway-v1`.
Existing committed bindings get the same description on their next lookup.
Tokens, binding IDs and account pins stay stable. Use the existing binding
state and grant checks. Verify a prepared or revoked credential cannot infer
and that a repeated commit after response loss returns the same pin.

### 2 — Consume the binding transport in YA

Decode and validate the response in the AAR service. Pass only the validated
transport and private binding token to the native launch adapter. Remove YA's
Claude/Codex provider-path and catalog-path assembly from this flow. Keep
native configuration, connector opt-in, model/effort validation and Codex
service tiers on their current paths. Use explicit existing startup errors for
an unsupported transport. A kind or auth method YA cannot map means YA is the
older side, so that error asks for a YA update.

Keep one compatibility shim for routers that predate the descriptor. When
`/v1/info` lacks `binding-transport-v1`, a single function in the AAR service
synthesizes the equivalent `http-gateway-v1` descriptor for Claude and Codex
from the provider name and the existing `service-tiers-v1` and
`gateway-token-header-v1` capabilities. The launch adapters read only the
descriptor, so they have one code path. The shim is the sole remaining place
that builds AAR's URLs. The check itself knows one layout rule, which AAR's
contract now states: a described path begins with the binding's provider,
because a hosted origin sends only those paths to inference. File `gaps/aar-legacy-transport-shim.md` in the
commit that adds it, naming the function and the removal condition in
[step 5](#5--verify-both-repositories-and-ship-aar-first). Exercise new session,
existing-session continuation, account switch and routed child starts through
their normal entry points.

The separate [auxiliary launch gap](../../gaps/routed-auxiliary-launch-inheritance.md)
keeps its current refusals. The [account switch gap](../../gaps/router-switch-kills-in-flight-work.md)
tracks lost in-flight work when the operator switches pins. This transport
change preserves the current switch behavior and its stale-owner fence. The
[Codex ancillary traffic gap](../../gaps/routed-codex-calls-chatgpt-with-direct-login.md)
tracks non-inference calls that the native client can make using its local
login. Qualify routed model traffic here and keep the separate gap visible.

### 3 — Describe the Antigravity route and make YA's listener generic

Redecided and implemented 2026-11-25 (AAR `1f56bb1`, YA `9793c4832`); see
[endpoint on the execution host](#endpoint-on-the-execution-host).

- **AAR:** attach the `http-gateway-v1` transport to Antigravity bindings. A
  YA that predates this ignores the field on those bindings, so AAR ships
  first.
- **YA:** check that transport like the others, with the legacy shim covering
  a router that does not advertise `binding-transport-v1`, and any
  Antigravity reply that omits `transport`, as unreleased AAR commits
  `d5623a7` to `a1e96cc` do. Replace the
  Antigravity bridge with a provider-neutral loopback proxy that carries no
  endpoint list, and keep the `agy` profile setup and launch flags in the
  Antigravity adapter.
- **Cross-repository:** show that a request outside AAR's registered routes
  passes YA's proxy and is refused by AAR, and that `agy` still never holds
  the binding token.

What stays specific to `agy` in YA is the launch flags and a stand-in login
written in `agy`'s token-file format. It holds no real credential and no
OAuth logic. Removing it too would need the AAR helper set aside above.

All routed Antigravity sessions share one profile and so one local token; see
[the gap](../../gaps/routed-antigravity-sessions-share-one-local-token.md).

#### Live Antigravity run, 2026-11-25

One run on macOS arm64 with `agy` 1.5.14, a personal Google subscription
enrolled in a local AAR at `d270e9c`, and YA at `9793c4832`. The session was
created through HTTP v0 with `routerAccountId` (an account grant, no pool) on
`gemini-3.8-flash`.

- **Launch.** `agy acp` received a loopback `--cloud_code_endpoint` on an
  ephemeral port and the routed profile as `--gemini-dir`. A search of its
  arguments, its environment and the profile's files found no binding token.
  The profile's token file held an `aar_local_` stand-in.
- **Turns.** Two text turns and one turn with a file-read tool answered
  correctly. AAR logged `loadCodeAssist`, `listExperiments`, `fetchUserInfo`,
  `fetchAdminControls`, `fetchAvailableModels`, `retrieveUserQuotaSummary` and
  six `streamGenerateContent` calls, all 200 on the granted account.
- **A call AAR does not serve.** `agy` sent `writeTrajectoryAcls` once. The
  proxy forwarded it, AAR answered 404 `unknown route`, and the session went
  on.
- **Who may use the proxy.** A request with no token or a wrong one got 401,
  and one with another `Host` got 403.
- **Exit and resume.** The port refused connections within 2 seconds of
  killing `agy`. `POST /api/projects/:p/sessions/:s/resume` started a new
  `agy` on a new port (v0 has no resume). YA's private state still held one
  Antigravity binding, and the model recalled both earlier replies.
- **Catalog and quota.** `aar owner accounts/refresh` returned eight models
  and `aar account quotas` returned four windows.

This run did not exercise a pool grant, a hosted router, a second concurrent
routed session, or a long-running turn.

### 4 — Put experimental provider opt-in in AAR Settings

An experimental adapter is off by default. In AAR Settings, the
router owner can check **Enable experimental Antigravity routing**. Show the
warning next to the unchecked control, before the owner opts in:

> This integration can break when Antigravity changes. Google may restrict
> account access for unsupported third-party use.

Link the warning to [Google's Antigravity terms](https://antigravity.google/terms).
Store the setting in AAR's owner-managed configuration. Enablement makes the
provider available for its existing account and pool grants and authorizes no
new grants. A paired YA installation reads provider availability from AAR and
uses the normal router selection and binding flow. The setting can be changed
only by the router owner, through AAR. Direct `agy acp` in YA is independent.

When the owner clears the checkbox, AAR stops offering the experimental
provider for new routed sessions and refuses new inference on its existing
bindings. Already accepted streams can drain using the current revocation
semantics. Retain pins and conversation history. A cold resume reports that
the router disabled the provider. Re-enabling uses the current grants and the
existing pin. Test discovery, admission and revocation through both local and
hosted AAR with a synthetic adapter before exposing the checkbox for a real
provider. The toggle applies to the existing Antigravity path and does not
wait for any transport change.

Implemented 2026-11-25 (AAR `819f342`, YA `b01a2335a`). AAR's
[Antigravity page](https://github.com/kzahel/agent-auth-router/blob/main/docs/antigravity.md#turning-it-on)
owns the contract. What landed beyond the text above:

- **Refusals.** Each control operation that would use the provider answers
  409 with `code: "provider_disabled"`, and inference answers 403. The plain
  grant listing still names the accounts, so YA's launch reaches that
  refusal and does not report the pinned account as gone.
- **The router's own use.** While the provider is off AAR sends no catalog
  or quota read to Cloud Code and runs no renewal, and it skips retries
  while routing is off.
- **YA.** YA names the refusal on launch and resume: "Antigravity routing
  is turned off in AAR…". A refused resume keeps its existing pin. New
  Session offers no router choice for
  the provider and
  [does not yet say why](../../gaps/router-disabled-provider-has-no-picker-hint.md).

Tested in AAR over the control socket and the public listener with a
scripted upstream, and in the cross-repository suite for a refused new
session, a live session refused through YA's proxy, and the same pin
answering once the provider is back on. A cold resume while it is off is
covered by YA's connector test only.

On 2026-11-25 the running router was restarted on `819f342` with the real
account from the live run. With the setting off, YA's selection offered
nothing, and a new routed session and a resume of the earlier one were
refused with AAR's text, with no `agy` started and the pin kept. The YA
build running then predated `b01a2335a`, so it quoted the text inside its
generic rejection. With the setting on, the account and its eight models
were offered again. The resume that followed failed for
[a separate reason](../../gaps/agy-1-5-17-ignores-routed-profile-login.md):
that launch logged `agy` language server version 1.5.17, where the earlier
ones logged 1.5.14.

### 5 — Verify both repositories and ship AAR first

- Extend AAR's [cross-repository integration suite](https://github.com/kzahel/agent-auth-router/tree/main/integration/yepanywhere)
  to run real YA and AAR with synthetic native peers and scripted upstreams.
  Prove local and hosted HTTPS launch, a lost commit response, restart and
  same-pin resume, cleanup after failed startup, and revocation. Include an
  invalid descriptor case that refuses before provider spawn, and verify
  that Direct still launches when the router is unavailable. Assert the
  chosen upstream account, the conversation identity and credential isolation.
  Done on 2026-11-25 for the local control socket (AAR `d270e9c`, YA
  `9793c4832`): the existing lifecycle cases pass on the described transport,
  and new cases cover a described route YA could not have assembled, a router
  reply without the capability, both refusals before provider spawn, and a
  lost commit reply on a resume. A synthetic Antigravity peer completes a
  turn through the described route, and AAR refuses an unregistered call
  that YA's proxy forwards. Still open here: the hosted HTTPS launch, Direct launching while the
  router is unavailable, and a new session's first commit reply being lost,
  which today
  [leaves a committed binding behind](../../gaps/new-routed-session-lost-commit-reply-orphans-binding.md).
- Before cutover, use the pinned official Claude and Codex executables with
  scripted upstreams to check one streamed turn and cold resume per provider.
  Check connector and catalog behavior at the boundary they use. Prefer those
  checks over live subscription inference. See
  [native provider testing](../../topics/native-provider-testing.md).
- Release the additive AAR responses first. Older YA can keep using its current
  URLs against upgraded AAR. New YA uses the descriptor when the router
  advertises `binding-transport-v1` and the step 2 shim otherwise, so routed
  sessions keep launching and resuming in either upgrade order. Existing pins
  and history remain available after upgrading AAR. Keep the YA browser/server
  and Remote Access protocols unchanged.
- Remove the shim once the AAR desktop update and Docker image that advertise
  `binding-transport-v1` have both been released. Record that AAR version and
  release date in the gap entry when it ships. The removal commit deletes the
  shim and the gap entry, checks the capability before persisting an
  allocation, and replaces the fallback with an "Update AAR" launch error.
  The cross-repository suite runs new YA against a router whose replies lack
  the capability (a relay hides it on a current router): it asserts the shim
  launch now and must assert the upgrade error after removal.
- Record the shipped behavior in the AAR control docs and the
  [YA routing contract](../../topics/agent-auth-router.md). Finish when Claude
  and Codex can start and resume through one hosted HTTPS origin, and a paired
  YA derives each routed launch from AAR's committed binding response.
