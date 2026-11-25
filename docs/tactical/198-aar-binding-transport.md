# Separate AAR routing from Yep Anywhere provider launches

Status: steps 1 and 2 implemented, 2026-11-25. AAR commits `d5623a7` and
`5a5039a` publish the transport and are unreleased. YA consumes it and keeps the legacy shim.
Steps 3 to 5 are open, including the AAR release and the cross-repository
suite. The landed behavior is recorded in the
[binding transport contract](../../topics/agent-auth-router.md#binding-transport-2026-11-25).

## Goal

An operator can run one Agent Auth Router (AAR) for metered subscriptions and
select its accounts or pools from Yep Anywhere (YA) on several machines. Each
YA instance still runs the provider in its local project. AAR owns access to
upstream accounts and supplies the transport for a selected binding. YA owns
the provider subprocess and conversation. Direct login remains the default.
Provider API-key accounts and pay-as-you-go API routing are outside AAR's scope.

Claude and Codex are the first consumers of the new protocol. Experimental
Antigravity routing is the reason the contract must also accommodate an
endpoint that is prepared on the execution host. The protocol design and that
adapter's authentication are separate decisions. Keep Direct and existing
experimental behavior during this protocol work. The
[Antigravity authentication decision](197-antigravity-credential-boundary.md)
records the declined Gemini API-key proposal and the remaining boundary.

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

The experimental Antigravity path goes further. YA owns an in-process loopback
bridge and handles provider-specific authentication setup. Some bindings may
need a host-local endpoint before YA can start the native process. AAR should
own that endpoint and its lifecycle.
See the [current Antigravity routing contract](../../topics/agent-auth-router.md#antigravity-per-session-routing-2026-11-23).

## Ownership

| Owner | Responsibilities |
| --- | --- |
| AAR | Enroll subscription profiles through their official CLIs, own grants and pool policy, choose and pin the account, publish the inference route and supported auth methods, authorize and revoke bindings, and account for traffic. When a transport needs an endpoint on the execution host, an AAR component on that host owns its listener. |
| YA server | Pair with the configured router, request and validate the binding for the user-selected account or pool, retain the binding identity, and keep the AAR-issued inference credential in server-private state. |
| YA provider adapter and runtime owner | Translate the checked transport into supported native client settings. Own the working directory, subprocess, approvals, input delivery, stop, restart or reattach, and native history. |

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

`http-gateway-v1` describes a direct connection from the native client to AAR.
Claude can offer `bearer` and `aar-gateway-header`. YA picks the latter only
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

### Transport prepared on the execution host

Reserve a separate transport kind, `local-http-v1`, for a route that needs a
listener on the machine running the provider. The hosted AAR origin still
uses the same HTTPS port for control and inference. Its binding response
advertises the local transport kind and compatible auth methods. The local
AAR component supplies the actual endpoint after it binds. Port allocation
belongs to that component.

The operator configures the local AAR executable on that host. YA starts it as
a supervised child with a private control pipe, scoped to one provider launch
attempt. YA sends an `init` with the committed binding identity, the launch
attempt ID and the existing AAR gateway credential over that pipe. The helper
acquires its listener and reports readiness on the same pipe. An illustrative
reply is:

```json
{
  "state": "ready",
  "bindingId": "<binding-id>",
  "attemptId": "<attempt-id>",
  "baseUrl": "http://127.0.0.1:53117/inference"
}
```

The provider endpoint may include a URL path. YA checks both identities and
requires a literal loopback address, an explicit port, and a URL free of
credentials, query and fragment. Invalid readiness, timeout, or early helper
exit fails startup. Helper exit during a session ends that native owner with
a transport failure. The listener accepts traffic authenticated for its own
binding. The helper owns listener cleanup on stop or control-pipe closure.
The Provider Host retains the helper with its provider when the backend
reattaches. Cold resume creates a fresh attempt and listener on the same
account binding. Port numbers and readiness replies are process state.

The first protocol tests can exercise `init` and `ready` with a local
scripted HTTP peer and a synthetic AAR credential. Production enablement
needs a concrete adapter with a qualified native authentication path.

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
3. **Prepare transport and start the native provider.** A hosted URL can be
   used immediately after commit. A local transport reaches `ready` first. YA
   applies the checked URL and starts the native runtime in the local project.
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

### 3 — Qualify the execution-host transport boundary

Exercise the local transport contract with a scripted helper. Prove that the
URL path and ephemeral port come from the child, that two concurrent starts
keep their attempt identities separate, and that invalid readiness, stop and
backend reattach leave the expected launch resources. Cover startup failure
and cold resume under the same account pin. Keep the production helper and
provider registration with the first adapter that qualifies for this path.

For an Antigravity cutover, first identify an authentication path that keeps
Google's native sign-in intact and leaves YA with only the AAR binding and
validated endpoint. Keep the original session store and pin available when
qualifying resume. If that authentication path is unavailable, retain the
existing behavior and record the unresolved cutover. The protocol tests can
pass independently of the provider decision.

### 4 — Put experimental provider opt-in in AAR Settings

A qualified experimental adapter is off by default. In AAR Settings, the
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
provider. The toggle applies to the new adapter at cutover.

### 5 — Verify both repositories and ship AAR first

- Extend AAR's [cross-repository integration suite](https://github.com/kzahel/agent-auth-router/tree/main/integration/yepanywhere)
  to run real YA and AAR with synthetic native peers and scripted upstreams.
  Prove local and hosted HTTPS launch, a lost commit response, restart and
  same-pin resume, cleanup after failed startup, and revocation. Include an
  invalid descriptor case that refuses before provider spawn, and verify
  that Direct still launches when the router is unavailable. Assert the
  chosen upstream account, the conversation identity and credential isolation.
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
  Add a cross-repository case that runs new YA against a router without the
  capability: it asserts the shim launch now and the upgrade error after
  removal.
- Record the shipped behavior in the AAR control docs and the
  [YA routing contract](../../topics/agent-auth-router.md). Finish when Claude
  and Codex can start and resume through one hosted HTTPS origin, and a paired
  YA derives each routed launch from AAR's committed binding response.
