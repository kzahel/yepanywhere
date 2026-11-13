# v0 session control, ACP vocabulary and target-owned peer contracts

Topic: http-api-v0

Status: **proposed 2026-11-13; not approved for implementation.** Drafted
from a maintainer discussion after an agent on the Mac launched a Codex session
on the Windows peer (rex) through v0, saw it block on its first approval,
and could not recover it through the API. The session had to be killed over
SSH. That kill bypassed YA cleanup, and the session then read as
`session_not_found`.

The owning contract is [HTTP v0](../../topics/http-api-v0.md). This extends
[167](167-agent-session-commands-and-following.md) (local commands and
following), [168](168-peer-access-and-enrollment.md) (directional peer access)
and [169](169-server-connections-ui.md) (Server Connections UI).

## Outcome

An agent on one server can complete a delegated task on another server without
a human. It can:

1. launch a session on a peer;
2. see that the session is blocked and why;
3. answer the permission request or change the permission mode;
4. wait for the turn to end and learn how it ended;
5. read the result;
6. cancel the turn or stop the session.

The access server and the target may run different builds. Each target owns its
own operation contract, and the access server forwards requests without
interpreting operation shapes.

Operation names and shapes follow the
[Agent Client Protocol](https://agentclientprotocol.com) wherever ACP has an
equivalent. A later stdio ACP adapter should then be a direct translation.

## Decisions already made

- **v0 is deliberately unversioned. Changes are clean breaks.** There are no
  compatibility aliases, deprecated field names or old routes kept beside new
  ones. Renames replace the old name in the same change.
- **v0 remains an HTTP API.** It is the cleaner versioned form of the app
  API, and its callers are agents issuing shell commands. ACP's stdio
  JSON-RPC model does not fit that use, for three reasons:
  - Its permission requests must be answered on one held connection.
  - It cancels pending requests when the client disconnects.
  - It has no server addressing, grants or provenance.

  v0 borrows ACP's nouns and shapes instead.
- **Use `session` vocabulary, not `agent`.** In ACP, `agent` suggests a model,
  prompt and role, which is too specific. The capability block is called
  `sessionCapabilities`. ACP 0.12, which YA already uses for its Gemini and Grok
  providers, uses the same name.
- **Model switching is limited to the session's provider.** Effort is the
  common live change. Switching provider is a new session or a fork, not a
  configuration change.
- **Answering provider questions is deferred.** Claude's `AskUserQuestion`
  blocks the turn; Codex's question is a soft prompt and the turn continues.
  A launch-time question policy needs its own design:
  [gap](../../gaps/v0-blocking-questions-need-a-launch-policy.md).

## Current behavior this plan replaces

Source references are relative to `packages/server/src`.

- **No control operations.** `/v0/help` states that configuration and
  interruption are unimplemented. The contract's planned route table already
  asks for explicit pending-input and interrupt/stop operations rather than
  configuration patches (`topics/http-api-v0.md`, after the route table).
- **Pending requests are read-only.** Conversation `pendingRequests` items allow
  `id: null` and always have `canAnswer: false`. `activity` is a bare
  `idle | working | waiting | unknown`, so waiting for a prompt and waiting
  for an approval look the same.
- **Help and schema describe only the receiving server.** `/v0/help` and
  `/v0/schema` have no server-addressed form, so an agent working against a
  peer reads the access server's contract, not the target's. Only
  `/v0/servers/{id}/capabilities` reports the peer's real revision and
  operations.
- **The peer proxy depends on the access server's own contract.**
  `peer-api/router.ts` behaves as follows:
  - It forwards only operation ids its own build knows, against an outgoing
    grant that lists those ids (line 185).
  - It validates `createSession`/`sendMessage` bodies with its own schemas
    (lines 216–227).
  - It parses the target's receipts with its own `receiptSchema` (lines 281,
    301 and 307).

  `peer-api/transport.ts` rebuilds the path from the access server's operation
  descriptor. The wire itself (`peer-api/srp-protocol.ts`, `peerWireRequest`) is
  already method/path/headers/body, and allows `GET` and `POST`.
- **Grants freeze operation lists.** Pairing again does not add operations
  created after the grant. The Mac→rex grant still lacks `selection`. rex was on
  `2026-11-01.1` while the Mac served `2026-11-12.1`.
- **The app API already implements the needed behavior:**
  - `PUT /api/sessions/:id/mode` (`routes/sessions.ts`);
  - `POST /api/sessions/:id/input` for approval responses, with an approval
    audit log;
  - `POST /api/processes/:id/interrupt` and `/abort` (`routes/processes.ts`);
  - `Process.setEffort` and `Process.setModel`, which apply through
    `SessionActivationCoordinator`.

  v0 control means exposing these through grants, not reimplementing them.

## Target-owned contract

The target server is the authority for its own operations.

- **Help and schema are addressed to a server:**
  `GET /v0/servers/{serverId}/help` and `/schema`. For a peer, these are
  forwarded and return the target's text and schema. Top-level `/v0/help`
  tells agents to read the target's help before peer work.
- **The access server forwards requests without interpreting them.** For any
  `/v0/servers/{peer}/…` request, the access server:
  - authenticates the caller;
  - checks that the caller may route to that peer;
  - attaches the attestation;
  - forwards the method, path suffix, query and body unchanged;
  - returns the target's status and body unchanged.

  It does not validate operation bodies or responses, and it can forward
  operations its own build does not know.
- **The peer envelope is the only cross-version contract.** It contains:
  - target identity check (`/peer/id`);
  - credential;
  - attestation (calling session, launch and outgoing grant ceiling);
  - `Idempotency-Key` header;
  - receipt identity returned in a response header;
  - size and time bounds.

  The envelope has its own small version. A mismatch fails with
  `peer_incompatible`, naming both versions. Only envelope changes require both
  ends to update together.
- **Retry keys move into the envelope.** The `requestId` body field becomes an
  `Idempotency-Key` request header. This removes the conflict with ACP's
  request ids and with pending-request ids. The outbound provenance ledger
  reserves records by (peer, idempotency key, method, path). It confirms them
  from a receipt-identity response header, so it never parses operation
  bodies.
- **The target enforces grant ceilings.** The attestation carries the outgoing
  grant's categories for this caller and launch. The target authorizes the
  intersection of its incoming grant and that ceiling. The access server no
  longer needs an operation-id list to decide what to forward.
- **`/servers` keeps reporting revisions**, as information only. Each peer item
  includes `apiRevision` and `envelopeVersion`, and flags an envelope mismatch.

## Grant categories

Grants name categories, not operation ids. Each target maps its operations
onto categories. The split follows the action vocabulary in
[principals and grants](../../topics/principals-and-grants.md), which keeps
send, approvals, session settings and interruption separate.

| Category | Operations |
|---|---|
| `read` | discovery, projects, providers, selection, sessions, session, conversation, updates, requests, receipts, relationships, help, schema |
| `create` | `createSession` |
| `prompt` | `prompt` |
| `answer` | `respond` |
| `configure` | `setMode`, `setConfigOption` |
| `interrupt` | `cancel`, `stop` |

New operations are admitted under these rules:

- A new operation may join an existing category only if it adds no authority
  beyond that category's definition.
- Otherwise it gets a new category, which existing grants do not hold.

This is what keeps "a new read is automatically granted" from becoming silent
widening, which principals-and-grants forbids.

Migration converts each stored grant once. A category is granted if the stored
grant held any operation in it. This slightly widens some stored grants: for
example, Mac→rex gains `selection` under `read`. Under the
[hard development rules](../../topics/hard-development-rules.md) that is a
maintainer product decision. The owner audit view lists every widening.

Authorization failures name what is missing. Each case gets its own code:
- `target_management_disabled`;
- `target_grant_missing_category` (with the category);
- `outgoing_grant_missing_category`;
- `launch_not_permitted`.

These replace the single combined `forbidden` message.

## Proposed operations

All mutations use `POST`, which the existing peer wire already carries, and the
`Idempotency-Key` header.

### Existing operations

| v0 today | ACP equivalent | Change |
|---|---|---|
| `describe`, `help`, `schema`, `me` | `initialize` | `help`/`schema` also become server-addressed. `describe` reports `envelopeVersion`. |
| `servers`, `server`, `access` | none | `apiRevision` and `envelopeVersion` per server. `access` reports categories, not operation ids. |
| `capabilities` | `agentCapabilities` | Becomes `sessionCapabilities` plus server facts. Lists supported session operations and their categories. |
| `projects` | `cwd` on `session/new` | Unchanged. A project id resolves to the target's cwd. |
| `providers`, `selection` | `configOptions` at `session/new` | Launch choices use the same `configOptions[]` shape as live sessions: `{id, name, currentValue, options[{value, name}]}`. |
| `sessions` | `session/list` | Items carry structured `activity`. |
| `session` | `session/new` result | `settings` is replaced by `modes: {currentModeId, availableModes[]}`, `configOptions[]`, per-session `sessionCapabilities` (what this provider and owner state allow now) and `activity: {state, requestId?}`. |
| `conversation` | `session/load` | Content blocks follow ACP `ContentBlock`. Tool activity becomes `tool_call` summaries `{title, kind, status}`, with decoded output and `exitCode`, never raw UTF-16 provider bytes. |
| `followConversation` | `session/update` | Becomes `updates` at `GET …/sessions/{id}/updates` (see below). |
| `createSession` | `session/new` + `session/prompt` | Body `{projectId, provider, prompt: ContentBlock[], modeId?, config?: {model?, effort?}, …}`. `message`, `permissionMode`, `model` and `thinking` are removed. |
| `sendMessage` | `session/prompt` | Becomes `prompt` at `POST …/sessions/{id}/prompts`, body `{prompt: ContentBlock[], delivery?}`. |
| `receipt`, `followReceipt` | none | Add `completion.stopReason` using ACP values: `end_turn`, `cancelled`, `refusal`, `max_tokens`, `max_turn_requests`. |
| `relationships` | none | Unchanged. |

### New operations

| Operation | Route | ACP equivalent | Uses | Category |
|---|---|---|---|---|
| `requests` | `GET …/sessions/{id}/requests` | `session/request_permission`, as a resource | `getPendingInputRequest` | `read` |
| `respond` | `POST …/sessions/{id}/requests/{requestId}/response` | `request_permission` result | `/api/sessions/:id/input` and its audit log | `answer` |
| `cancel` | `POST …/sessions/{id}/cancel` | `session/cancel` | `interruptProcess` | `interrupt` |
| `stop` | `POST …/sessions/{id}/stop` | none (YA extension) | `abortProcessWithVerification` | `interrupt` |
| `setMode` | `POST …/sessions/{id}/mode` | `session/set_mode` | `/api/sessions/:id/mode` | `configure` |
| `setConfigOption` | `POST …/sessions/{id}/config` | `session/set_config_option` | `setEffort`/`setModel` via `SessionActivationCoordinator` | `configure` |

Each new operation behaves as follows:

- **`requests`.** Each item has the shape
  `{id, kind: permission | question, toolCall: {title, kind, command?, cwd?}, options: [{optionId, name, kind: allow_once | allow_always | reject_once | reject_always}], canRespond}`.
  `id` is always present. Questions are listed, so the reason a session is
  blocked is visible, but they have `canRespond: false` until the question
  policy exists.
- **`respond`.** The body is `{outcome: {outcome: "selected", optionId}}` or
  `{outcome: {outcome: "cancelled"}}`.
  - Requests stay open until someone answers them. Answering from the UI or
    through the API resolves the same request.
  - A late answer gets `request_not_pending`.
  - "Approve and accept edits" is an `allow_always` option, not a separate
    verb.
- **`cancel`.** It ends the current turn and keeps the process alive.
  Unanswered requests resolve as `cancelled`, and the turn ends with
  `stopReason: cancelled`. A session that is not running gets
  `session_not_running`.
- **`stop`.** It ends the provider process through normal YA cleanup. The
  session stays listed and readable afterwards, including a session that never
  persisted a transcript.
- **`setMode`.** The body is `{modeId}`, and the value must be one of
  `modes.availableModes`. The response reports the requested and applied mode.
- **`setConfigOption`.** The body is `{configId, value}`, with values taken from
  the session's `configOptions`.
  - `effort` comes first.
  - `model` lists only models from the session's provider.
  - The response includes `appliesAt: now | next_turn`, because YA applies
    configuration at turn boundaries.

### `updates`

`GET …/sessions/{id}/updates?after={cursor}&until={change|turn_end|blocked|idle}&waitMs=…`
replaces `followConversation`:

- `waitMs` rises to a bounded long wait of about 30 s, not 4 s. The
  [architecture mandates](../../topics/architecture-mandates.md) still apply:
  no per-waiter polling, and demand is released when the client disconnects.
- Results carry ACP-named update kinds:
  - `agent_message_chunk` (finalized prose);
  - `tool_call` and `tool_call_update` (summaries);
  - `plan`;
  - `current_mode_update`;
  - `config_option_update`;
  - `turn_end` with `stopReason`;
  - YA additions `request_opened` and `request_resolved`.

  A cursor reset still returns replacement state rather than claiming replay.

## Steps

### 1 — target-addressed help and schema

Add the server-addressed `help` and `schema` operations, forwarded for peers.
Update top-level help so peer work reads the target's contract. This is small,
and it makes the build mismatch visible before anything else changes.

### 2 — forward peer requests without interpreting them

Replace operation-specific routing with generic forwarding of
`/v0/servers/{peer}/…`. Move the retry key to `Idempotency-Key` and receipt
identity to a response header. Re-key the outbound ledger accordingly, and add
`envelopeVersion` and `peer_incompatible`.

Acceptance: an access server whose operation table lacks an operation can still
drive that operation on a newer target, and provenance is still recorded. This
version-skew case is the regression test the current suite lacks.

### 3 — grant categories and specific authorization errors

Store categories, carry the outgoing ceiling in the attestation, and have the
target enforce the intersection. Migrate stored grants with the owner-visible
widening list. Update the Server Connections editor to choose categories.
Add the specific authorization error codes.

This step must follow [security](../../topics/security.md) and principals and
grants.

### 4 — pending permission requests and blocked activity

Add `requests` and `respond` for permission requests, and structured
`activity`.

Acceptance: a Codex approval in `default` mode and a Claude tool permission can
each be read and answered over v0. A UI answer and an API answer to the same
request resolve it exactly once.

### 5 — cancel and stop

Add `cancel` and `stop`.

Acceptance:
- A turn blocked on an approval can be cancelled, and its request resolves as
  `cancelled`.
- A stopped session that never wrote a transcript remains listed.

### 6 — permission mode

Add `setMode` with `modes` on session detail.

### 7 — config options: effort, then same-provider model

Add `configOptions` on session detail and `setConfigOption`. Effort comes
first, then models from the same provider.

### 8 — ACP vocabulary renames

Apply the clean-break renames in the existing-operations table in one revision:
`prompt`, `modeId`, `config`, `ContentBlock`, `sessionCapabilities` and
`stopReason`. Update help, schema, evals and the agent documentation in the
same change.

This step depends on step 2. Otherwise the renames break access servers paired
with older targets.

### 9 — updates

Replace `followConversation` with `updates`, add long waits and `until`, decode
tool output, and add `turn_end`.

### Later, not in this plan

- The question launch policy ([gap](../../gaps/v0-blocking-questions-need-a-launch-policy.md)).
- A `ya acp --server {id}` stdio adapter, so ACP clients such as Zed or
  JetBrains can drive YA sessions on any paired server. This becomes a
  translation once steps 4–9 land.
- Recommended launch modes and a launch preflight that warns when a mode is
  likely to stall.

## Verification

Follow [test value and CI cost](../development/testing.md#test-value-and-ci-cost).
Prefer the existing isolated two-peer integration harness from 168 over mocked
route tests.

| Coverage | Steps |
|---|---|
| Version skew between peers | 2, 8 |
| Grant intersection and revocation during an in-flight request | 3 |
| UI and API racing to answer one request | 4 |
| Cancelling a blocked turn | 5 |
| [Native provider scenarios](../../topics/native-provider-testing.md) for Codex and Claude approvals | 4–7 |

The final acceptance is the scenario from Outcome, run from macOS against the
native Windows peer. This plan therefore needs the Windows qualification that
167 and 169 deferred. Any change to the Server Connections UI keeps the
repository's typing-acknowledgement requirement.

## Open questions

- Should `stop` require `interrupt`, or a stronger separate category? It ends
  the process; `cancel` only ends the turn.
- What is the exact `waitMs` ceiling for `updates`, and is SSE worth adding
  beside long polling? Measure the cost of held requests across the relay
  before deciding.
- Receipt identity in a header or in a fixed top-level body field? A header
  keeps the access server from ever parsing bodies.
