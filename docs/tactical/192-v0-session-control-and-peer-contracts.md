# Target-owned v0 APIs and basic session control

Topic: http-api-v0

Status: **implemented 2026-11-13; final checks recorded below.** The reduced
scope replaces the broader ACP/grant-migration proposal after maintainer review.

The motivating incident: an agent on the Mac launched a Codex session on a
Windows peer through v0, saw it block on its first approval, and could not
recover it through the API. The session had to be killed over SSH, bypassing
YA cleanup.

The owning contracts are [HTTP v0](../../topics/http-api-v0.md) and
[peer access](../../topics/peer-access.md). This builds on
[167](167-agent-session-commands-and-following.md) (commands and following),
[168](168-peer-access-and-enrollment.md) (peer access),
[169](169-server-connections-ui.md) (connections UI) and
[170](170-peer-authentication-refresh.md) (peer authentication).

## Outcome and scope

Each target describes and implements its own v0 API. An access server can pass
requests to that target without understanding every operation or field. After
one coordinated wrapper update, a target can add an operation or change its
request/response shape without requiring the access server to adopt that API.
The operation must still be granted, and the caller must use the target's help
and schema.

The first implementation covers four things:

1. Target-addressed help and schema.
2. Pass-through peer routing, including the small shared request/response
   wrapper needed for authorization and receipt correlation.
3. Light terminology cleanup for prompts.
4. Pending requests, approval responses, interrupt and stop.

Existing conversation reads and following provide session state and output.
This work does not claim that every delegated task can finish unattended:
provider questions still have the [separate launch-policy gap](../../gaps/v0-blocking-questions-need-a-launch-policy.md).

## Working assumptions

- **Alpha, with no migration requirement.** Update both servers for the initial
  wrapper change and recreate affected connections or use fresh alpha API state
  as needed. Add no legacy format readers, grant conversions, receipt backfills,
  compatibility aliases or automatic state-wiping machinery. Ordinary sessions,
  provider transcripts and owner authentication are outside that reset scope.
- **v0 remains unstable HTTP.** Renames replace the old spelling. API revisions
  describe a target's build; they do not require equal operation tables.
- **ACP is naming inspiration.** There is no ACP conformance goal, SDK upgrade,
  stdio adapter requirement or wholesale content conversion in this plan.
- **Keep SRP and encryption.** Reuse the existing peer login, target identity
  proof, credential refresh, NaCl encryption and relay routing. Change only the
  bounded HTTP request/response wrapper inside that protected transport.
- **Keep the existing authority model.** No grant categories or new restricted
  roles. Management enablement, launch authority, peer operation/project grants,
  expiry, revocation and one-hop routing still apply. Default/bypass provider
  permission modes keep their existing meanings.
- **Keep current timing and observation semantics.** Four-second follows,
  existing resource ceilings and replacement-state cursors are sufficient.
  Receipt admission/delivery remains distinct from task completion.

## Original seams addressed

Paths below are relative to `packages/server/src`.

- `routes/v0/index.ts` installs only locally known operations, parses JSON
  bodies, and emits locally selected response types/statuses.
- `peer-api/router.ts` checks local operation ids, validates create/message
  bodies and parses target receipts using the access server's schemas.
- `peer-api/transport.ts` reconstructs paths from the local operation table.
- `peer-api/srp-protocol.ts` already carries method, path, headers and body.
  Its header allow-list needs the new correlation fields.
- `peer-api/srp-server.ts` parses replies as JSON and retains only the server-id
  header. That prevents forwarding Markdown help or receipt metadata unchanged.
- `peer-api/outbound-store.ts` records intent before submission and learns the
  destination session from parsed receipts. Preserve that provenance while
  removing dependence on operation-specific bodies.
- The app API already has pending input, approval responses with an audit log,
  interruption and verified process termination. Reuse their underlying owners;
  do not forward peer callers into the ordinary authenticated `/api` surface.

## Target-owned discovery and forwarding

### Help and schema

Add `GET /v0/servers/{serverId}/help` and `/schema`, including `self`.
Top-level `/v0/help` explains how to choose a server and read its contract.
Peer help/schema return the target's content and content type. The target's
capabilities/access describe its operations and the caller's effective grants.
Keep the existing capabilities vocabulary; renaming it to ACP-style
`sessionCapabilities` is unnecessary here.

### Opaque operations, with target-side authorization

For `/v0/servers/{peer}/...`, the access server authenticates the caller,
resolves a configured peer and checks the existing owner/launch peer authority.
It then forwards the method, target-scoped path/query and body without parsing
an operation's schema. The target dispatches and validates against its own API.
The target's status, body and selected response headers pass back unchanged.
Local `self` requests continue through the local dispatcher.

Keep operation grants. Carry the source's outgoing operation allow-list in the
protected attestation beside the existing source session/launch attribution.
The target maps its own route to its operation id and checks both its incoming
grant and that outgoing ceiling, plus current project and management policy.
The access server need not recognize that operation id or request shape.
Operation names stored or transported by intermediaries must therefore be
bounded strings rather than enums derived from their local operation table.

A new or renamed operation still needs an explicit grant. Recreating an alpha
connection can select the target's current operation set. Refreshing credentials
does not silently widen it. Inspect the existing manual and Identity Service
policy paths when removing local enum assumptions; retain each path's current
target-side ceilings rather than introducing a second authorization system.

Forwarding stays within the selected target's v0 namespace. It cannot reach
`/api`, private peer administration, a caller-supplied origin or a second peer.
Reject ambiguous/escaping paths and externally supplied authentication or
attestation headers. Preserve expiry/revocation cancellation and recheck
current authority before returning a result.

### Small shared wrapper

The stable cross-build contract is the wrapper, not each target's operations:

- Existing authenticated source/target identity and credential binding.
- Method, target-scoped path/query and bounded body text. Carry response body
  text opaquely so both JSON and Markdown survive without JSON parsing.
- An explicit allow-list of forwarded headers: content type, idempotency key,
  target identity and receipt correlation. Do not make arbitrary headers a
  new authentication channel.
- Source attestation and outgoing operation ceiling.
- A wrapper version checked through the existing protected peer exchange.
  Unsupported versions fail clearly before a mutation is submitted.
- Existing body/frame/response sizes, deadlines, channel budgets and disconnect
  cleanup. No streaming, uploads, persistent channels or longer waits.

Exact wrapper field/header names belong to the implementation's contract
change. Establish this wrapper on both ends together. Later operation-shape
changes within the same wrapper do not require matching API revisions; future
wrapper changes may still require coordinated updates.

### Retry keys and provenance

Move mutation retry keys from the operation body's `requestId` to the
`Idempotency-Key` header. This lets the access server record uncertain outbound
intent without inspecting an operation body. Retain the existing receipt
machinery and its admission/delivery meanings; receipt `requestId` may continue
to report that key. Do not add prompt-completion tracking.

Scope outbound intent by authenticated caller/source session, target, method,
path/query and key; retain a body fingerprint so changed requests conflict.
The target returns small, fixed receipt metadata through the wrapper: receipt
identity and, when known, canonical destination session/project identity. This
preserves source-side relationships without parsing the target's full receipt.
A receipt id alone is insufficient when a creation initially has no session id;
subsequent receipt observations must also carry the updated binding.

New control commands use the same retry principle: after a lost reply, the
identical request recovers its recorded outcome. In particular, retrying an old
interrupt/stop must not act on a newly resumed process or later turn. Use the
existing receipt owner and capture the incumbent process at admission;
no separate command lifecycle service is needed.

## API cleanup and session controls

Keep cleanup small and update help, schema, bootstrap examples and evals in
the same change.

| Surface | Scoped change |
| --- | --- |
| Existing session creation | Rename initial text `message` to `prompt`; retain a plain string and the current launch options. |
| Existing follow-up submission | Rename `sendMessage` to `prompt`, use `POST .../sessions/{id}/prompts`, and rename text `message` to `prompt`. Keep existing queued delivery behavior. |
| Mutation retry identity | Use `Idempotency-Key`; keep pending-request ids separate. |
| Conversation/following | Keep the existing routes, projection and wait limits. |
| Settings/selection/capabilities | Retain their current shapes and effective launch/routing information. |

Do not introduce `ContentBlock[]`, `modes`, `configOptions` or ACP update events.

| Operation | Route | Behavior |
| --- | --- | --- |
| `requests` | `GET .../sessions/{id}/requests` | List pending input with stable id, kind, useful description and whether it can be answered through v0. |
| `respond` | `POST .../sessions/{id}/requests/{requestId}/response` | Answer a permission request using the existing approval owner and audit path. |
| `cancel` | `POST .../sessions/{id}/cancel` | Invoke YA's existing interrupt behavior and report its actual outcome. |
| `stop` | `POST .../sessions/{id}/stop` | Terminate the incumbent provider through normal verified YA cleanup. |

`requests` is a read. The three mutations require existing management authority
and their peer operation grants. There is no separate `answer`/`configure`/
`interrupt` category split in this slice.

Permission requests advertise only responses supported by the current owner,
using existing Allow/Deny actions rather than inventing ACP `allow_always`
semantics. The minimal response body is `{response: "approve" | "deny"}`.
Combined approval/mode changes and free-form question answers are deferred.
UI and API answers resolve the same request exactly once. A request already
answered, withdrawn or invalidated by interruption returns `request_not_pending`
for a new response command; an identical command retry recovers its receipt.
Questions remain visible with `canRespond: false`.

`cancel` follows current YA behavior: interruption may fall back to killing the
process, and existing queue handling still applies. Report whether interruption
succeeded, was unsupported or required a hard abort; do not promise process
survival or add automatic resume. After a hard abort, use existing YA resume
facilities before sending another prompt. `stop` reports verified shutdown or a
clear failure. Session metadata remains listed/readable even without a native
transcript; unavailable conversation content is reported honestly.

## Implementation steps

### 1 — establish the pass-through peer wrapper and target discovery

Implement the wrapper, generic forwarding, target-side outgoing/incoming grant
checks, retry/provenance correlation and target-addressed help/schema together.
Keep local operation validation at the target. Update both alpha endpoints and
recreate affected connections; implement no upgrade migration path.

Acceptance: an access server whose operation table lacks a target operation can
forward it, including unfamiliar request/response fields and target errors.
Markdown help survives direct and encrypted-relay transport. Disallowed target
operations, project escapes and onward routing remain refused. Lost replies
preserve retry identity and source/destination relationship bindings.

### 2 — apply the bounded prompt terminology cleanup

Rename the prompt operation/text fields throughout the target API, commands,
receipts, help, schema, agent bootstrap and eval fixtures. Include the wrapper
step's header-based retry keys in every updated example. Replace old spellings
without aliases. Preserve launch selection, routing inheritance and native
queued-input behavior.

Acceptance: existing create/message/follow workflows pass using the new names;
access and target operation tables need not have identical shapes.

### 3 — expose pending approvals and existing session controls

Add requests/respond/cancel/stop through the existing native owners. Extract a
shared approval/audit action if needed so the UI and v0 use the same behavior.
Put new logic outside frozen oversized route/supervisor hubs; keep only wiring
in those hubs.
Update [HTTP v0](../../topics/http-api-v0.md) and
[peer access](../../topics/peer-access.md) with observable behavior before
calling implementation complete.

Acceptance: bypass-mode work runs normally; a deliberately permission-blocked
Claude/Codex session can be inspected and answered. UI/API response races
resolve once. Interrupt and stop report what YA actually did, and repeated
control requests cannot affect a later process/turn.

Earlier draft step references map as follows:

| Earlier draft | Revised scope |
| --- | --- |
| 1–3: discovery, forwarding, categories | Step 1; categories and migrations dropped. |
| 8: ACP vocabulary | Step 2; limited to prompt naming and retry-key examples. |
| 4–5: requests and cancel/stop | Step 3. |
| 6–7 and 9: mode, config and updates | Deferred. |

## Verification

Follow [test value and CI cost](../development/testing.md#test-value-and-ci-cost).
Extend the existing isolated two-peer/direct/relay harness and
[native provider scenarios](../../topics/native-provider-testing.md). Prefer
those boundaries over route tests that only assert mock wiring.

- Exercise operation-shape skew with a target-only operation and unfamiliar
  fields, not merely two servers advertising different revision strings.
- Verify opaque Markdown/JSON/error replies and wrapper-version refusal.
- Cover grant intersection, revocation during a wait, one-hop/path confinement,
  lost replies, payload conflicts and delayed destination-session bindings.
- Race UI/API approval answers; interrupt a blocked approval; verify hard-abort
  reporting and stop before a transcript exists. Retry a control after a later
  turn/resume and prove it does not act again.
- Run native bypass and approval cases for both Claude and Codex. The final
  cross-machine case is macOS to native Windows through the protected peer API:
  launch, inspect, answer if needed, read output, interrupt/stop and inspect
  retained session state. Follow the existing
  [Windows qualification limits](../../gaps/windows-validation-baseline.md).
- No Server Connections UI redesign is planned. If removing local operation
  assumptions requires UI edits, retain the sequential typing requirement and
  required desktop/phone capture checks.

### Agent eval acceptance

Use the existing [agent API eval runner](../../scripts/agent-api-eval/README.md).
Its job is to show that an agent given the shipped bootstrap can discover and
use the API from help/schema. Deterministic integration tests establish routing,
authorization, retries and races; native-provider scenarios establish actual
Claude/Codex control behavior. Each supplies different evidence.

The existing encrypted-relay `workflow` lane uses independent peer managers
and scripted worker behavior. Its fixture and graders now also cover these
tasks, using the same runner and opt-in account isolation:

| New task | Agent task | Required evidence |
| --- | --- | --- |
| Target contract discovery | Discover a target-only operation whose request/result shape differs from the access server, use the target's docs and return its fixture result. | Successful target help/focused-schema reads and remote operation, with the expected submitted fields and returned result. The access operation table must actually lack the operation. |
| Approval recovery | Find a permission-blocked worker, inspect and approve its request, then read its resulting output. | Successful request read/response and the scripted worker's post-approval artifact. A final claim that it approved something does not pass. |
| Interrupt and stop | Interrupt one owned worker and stop another, then inspect the resulting session states. | Successful control calls and observed outcomes matching fixture truth, including whether interruption hard-aborted. Do not grade only the model's narrative. |

Give tasks in terms of the desired outcome, without supplying the new route
names or the target-only schema in the task prompt. Include the existing
`evidence` case so the agent continues to distinguish unknown completion from
success. API evidence grading must accept equivalent valid call sequences.
Add deterministic grader checks that reject plausible prose without the
required HTTP effects. Control fixture state must expose those effects rather
than have the grader trust a successful POST alone.

Before source implementation, retain a small baseline: `operation`, `selection`,
`workflow` and `evidence` locally, plus `workflow` over the owned encrypted relay.
Use the shipped `help` variant, one sample per task and the same model/effort/CLI
for the candidate. This is five baseline trials. After implementation, repeat
those five and run one trial for each of the three new peer tasks: eight
candidate trials. Keep existing-task comparisons and new-task results in
separate reports; new operations have no supported old-build baseline. Expand
only to diagnose a failure or resolve ambiguous evidence, retaining every failed
or timed-out trial.

Current commands for the baseline/candidate regression tasks:

```sh
# Dry run: no credential reads or model calls; also runs under tools:check.
pnpm exec tsx --conditions source scripts/agent-api-eval/run.ts

# Four existing local tasks; use separate temporary output directories per run.
pnpm exec tsx --conditions source scripts/agent-api-eval/run.ts --run \
  --variants help --cases operation,selection,workflow,evidence --max-trials 4

# One existing protected peer workflow.
pnpm exec tsx --conditions source scripts/agent-api-eval/run.ts --run \
  --peer-relay --variants help --cases workflow --max-trials 1
```

Use the runner's `--out` option to retain each complete report separately, then
use `compare.ts` on matching before/after local matrices and matching peer
matrices. Record task successes, errors, requests, fetched documentation bytes
and CLI usage. Inspect grader results: the runner can exit successfully while
a trial fails. The existing comparison flags extra calls/bytes as well as task
failures; investigate and report any intentional cost of target discovery
rather than calling that result an efficiency improvement. Small trials provide
behavioral evidence, not a statistical ranking or a latency benchmark.

Real-model trials remain opt-in, outside CI, using the runner's existing saved
sign-in isolation and cleanup. No new paid fallback or model matrix. Update the
runner README with the new task commands when they exist. The worker in this
eval remains scripted; actual Claude/Codex controls and the native Windows peer
still need the separate qualification above.

## Implementation and qualification

The four scoped steps are implemented. Domain modules own native controls and
HTTP wrapper validation; two frozen hubs received only extracted factory/
projection calls, with lowered source budgets in a separate prerequisite slice.
No migration, compatibility alias, new grant category, SRP replacement or
completion/update system was added. Fresh owner connections take operations
from the target-issued grant and retain narrower existing outgoing policy.

Deterministic tests cover target-only routes/shapes, opaque docs and errors,
operation ceilings, path confinement, revocation, uncertain replies, receipt
binding and native approval/control retry races. Native Claude/Codex controls
and the four existing app creation/replacement combinations pass on macOS.
The owned macOS→native Windows ARM64 protected-peer case passes launch, actual
approval/output, retry, interrupt, verified stop, retained metadata and delayed
provenance. The reusable fixture/controller commands and qualification details
are in the [eval README](../../scripts/agent-api-eval/README.md#native-cross-host-control-qualification).
Focused Windows control/path/eval-comparison checks also pass (eight cases).
This is focused Windows evidence, not a whole-repository Windows aggregate;
Linux execution remains for CI. Root lint (zero warnings), formatting,
typechecking and all workspace tests pass: 7,440 server, 7,401 client, 989 shared,
139 relay and 45 push-broker cases. The final server run takes 156.89 seconds;
this is qualification timing, not a performance claim. One earlier unchanged
relay case exhausted its guard; its eleven-case file and the final workspace
run pass unchanged, with the unexplained timeout retained in
[the timing gap](../../gaps/full-suite-timing-and-diagnostics.md). Existing
unowned jsdom navigation and deliberate negative-provider diagnostics remain
recorded in their owning gaps; they were not globally suppressed.

The retained five baseline and eight candidate model trials all pass their
respective tasks, with zero HTTP errors. Candidate totals are four local,
one existing peer workflow and three new peer tasks. The comparison's
non-increase gates do **not** pass: local calls 35→34 and documentation bytes
71,176→76,212; peer calls 15→18 and bytes 12,023→49,985. Target help and two
focused target schemas account for the peer increase. Documentation metrics
now include target-addressed reads and are recomputed from recorded traces,
including older reports. This qualifies discoverability and behavior, without
an efficiency or statistical model-quality claim. The new workers are scripted;
the separate native checks establish real provider behavior.

## Deferred

- Grant categories, granular approval/settings roles, migrations and legacy
  compatibility machinery.
- Permission-mode, effort and same-provider model changes through v0.
- Per-prompt completion/turn correlation, `completion.stopReason` and task-success
  claims. Idle activity and consumed input remain observations.
- A replacement `updates` API, 30-second waits, SSE, tool-output expansion and
  ACP content/event schemas.
- Question responses, launch-time question policy, automatic resume and launch
  preflight/recommended modes.
- An ACP stdio adapter or any promise that it would be a direct translation.
