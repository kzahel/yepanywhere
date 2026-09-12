# Client And Server Capabilities

> Capabilities gate optional behavior across independently updated clients and
> servers. From 0.7.1 onward, official capabilities have permanent numeric IDs:
> release semver implies support, while sparse positive and negative bits report
> optional, source-ahead, or exceptionally withdrawn support. Names remain
> registry metadata and legacy wire data.

Topic: server-capabilities

## Source Of Truth

`session-async-questions` (permanent ID 60, version-implied from 0.8.2)
owns the optional bounded `asyncQuestions` projection on session lists, Inbox,
and session-updated events. The approved optional-feature corpus is v0.8.0
(2026-08-31) and v0.8.1 (2026-09-05), the latest two stable releases and all
stable releases in the preceding 14 days on 2026-09-07. Both lack this field.
Without the capability, hide collection counts and menus while retaining
existing transcript answering when its structured fields are present. Add no
unsupported request, reply route, or new meaning to an older capability.
See [question discovery](provider-output-contract.md#discovery-from-inbox-and-session-navigation)
for preview bounds, omission semantics, and local reminder state.

The permanent global ID ledger lives in
`packages/shared/src/capability-ids.ts`. The server registry in
`packages/shared/src/server-capabilities.ts` adds lifecycle, advertisement,
fallback, and route/field/event ownership metadata. Together they export:

- the exact capability string constants;
- lifecycle and advertisement metadata for each registered capability;
- the durable client/server ID ledger and sparse-bit helpers;
- a helper for checking a `/api/version`-style capability source.

The first application notification on a direct WebSocket, and the first
encrypted application notification after remote authentication, is
`client_capabilities`. A 0.7.1+ client includes its `version`,
its sparse `capabilityBits`, and the existing transport `formats`. Same-origin
HTTP has no persistent connection state, so every API request carries the same
value in `X-Yep-Client-Version`. A tunneled request inherits the version
recorded on its connection.

The server chooses the **newest encoding supported by both peers**. Encoding 1
was introduced with the version-bearing 0.7.1 handshake. A missing or older
client version selects the legacy name list; a 0.7.1+ client selects encoding
1. A git-describe source build may still name the preceding release, so the
newly present version field itself proves encoding-1 support for that source
client. Future encodings add a later semantic-version cutover and the server
chooses the highest cutover it implements that the client version reaches.

An encoding-1 `/api/version` response omits the capability name list and
returns:

- `current`, whose release semver implies every `version-implied` server
  capability with `introducedIn <= current`;
- `capabilityEncoding: 1`;
- `capabilityBits`, sparse `[wordIndex, bits]` pairs. Empty 32-bit words are
  omitted. Bits explicitly report optional capabilities and monotonic
  capabilities present in a source build ahead of its release semver; and
- optional `deniedCapabilityBits` in the same sparse form, naming known
  version-implied contracts that this server generation deliberately refuses.

The same rule applies in the other direction: a server infers permanent client
capabilities from the client's version and reads bits for optional or
source-ahead client support. Transport `formats` retain their separate byte
namespace; they are not capability IDs.

No version-aware peer expects an official 0.7.1+ capability by name. Names are
still useful in source, diagnostics, and the legacy `capabilities: string[]`
fallback. The earlier `compact-v1` query, `optionalCapabilityBits`, and
`capabilityExtensions` remain readable for compatibility with intermediate
source builds, but new clients do not negotiate that representation.

An untagged source checkout may report a bare commit hash instead of semver.
Its advertisements must still include implemented version-implied contracts,
including `subagent-max-depth-setting`, in every supported encoding. The
provider-depth control must remain usable without fetching release tags.

`git-file-diff-projections` owns the exact file-viewer manifest and per-file
diff routes. Releases `0.6.2` and `0.7.0` have neither route. A client without
the capability hides every file-viewer diff selector and sends no projection
request; it does not reuse `git-source-review-projections`, whose advertised
meaning predates these routes. The capability is permanent and
version-implied from `0.7.1`.

`git-file-revision` owns read-only last-revision metadata for a selected file.
The ordinary optional-feature corpus is `v0.7.0` (2026-07-25) and `v0.6.2`
(2026-07-11); no other stable server release fell in the preceding 14 days as
of 2026-08-24. Both lack the route and permanent ID 47. Without it, clients
omit file-revision chrome and make no metadata request. Existing capability
meanings and older capable behavior remain unchanged. It is version-implied
from `0.7.2`.

`public-file-shares` owns authenticated exact-file list, create, and revoke
routes plus the dedicated live-file grant semantics on existing public file
reads. The ordinary optional-feature corpus is `v0.7.0` (2026-07-25) and
`v0.6.2` (2026-07-11); both lack these routes and permanent ID 51. Without it,
the client hides the File Viewer share action and makes no file-share request;
session sharing and existing public file reads keep their prior behavior. It is
version-implied from `0.7.2`.

`codex-stream-durable-id-alignment` owns the meaning of existing Codex
`message.uuid` values across streamed `session-message` events and REST session
detail rows. The core corpus `v0.6.0`, `v0.6.1`, `v0.6.2`, and `v0.7.0` lacks
the alignment contract and permanent ID 48. Without it, the client uses the
legacy two-second non-tool reconciliation, Codex steer pairing, and
timestamp-watermark replay suppression; it adds no request. With it, equal
content or timestamps never substitute for provider/client identity. The
capability is version-implied from `0.7.2`, while source-ahead servers advertise
the positive ID explicitly. Its fallback remains until a separate
compatibility-floor review approves removal.

`codex-plan-tool-setting` owns the optional `codexPlanToolMode` field on the
existing settings read and write routes. Stable releases `v0.8.0` and `v0.7.0`
lack the field and permanent ID 53. Without the capability, clients hide the
Codex plan-tool control and make no unsupported settings write. It is
version-implied from `0.8.1`; existing settings and capability meanings are
unchanged.

`codex-paginated-rollout-lineage` owns complete logical reads of Codex
rollouts whose `session_meta.history_base` references a frozen prefix in
another rollout. Stable releases `v0.8.0` and `v0.7.0` can issue the existing
native fork request but cannot list, summarize, or load the resulting
reference-backed child; they lack permanent ID 54. Without this capability, a
current client keeps Codex Clone and per-turn Fork visible but disabled with
server-update guidance and makes no fork request. Other providers retain the
existing `session-fork-turn-intents` gate. The capability owns no new route:
it strengthens the existing session list/detail and fork-route product as a
single contract, is version-implied from `0.8.1`, and does not broaden any
older capability meaning.

`project-queue-attachment-editing` owns the existing Project Queue update
route's ability to atomically combine retained queue-owned staged references
with newly uploaded draft references, including individual removal. The
ordinary optional-feature corpus is `v0.8.0` (2026-08-31) and `v0.7.0`
(2026-07-25); both have Project Queue updates and staging but lack this mixed
ownership update semantic and permanent ID 55. Without the capability, the
projects-page editor remains text-only, preserves its original attachment
fields, and starts no attachment upload or mutation request. It is
version-implied from `0.8.1`; no route or request-field shape changes.

The additive top-level `transcriptSnapshotUpdatedAt` field on existing session
detail responses is a reader snapshot receipt, not a new feature capability.
The core compatibility corpus `v0.6.0`, `v0.6.1`, `v0.6.2`, and `v0.7.0`
lacks it. A current client connected to one of those servers sends no new
request and leaves its heartbeat-reconciliation watermark unchanged, accepting
bounded extra refreshes rather than letting unrelated `session.updatedAt`
metadata suppress a needed catch-up. Older clients ignore the additive field.
No existing capability meaning changes. The Maintainer approved this
self-gated response-field fallback on 2026-08-28.

The additive `session.effectiveModelSettings` field on existing session
metadata and detail responses is a durable model-state receipt, not a new
feature capability. The core compatibility corpus `v0.6.0`, `v0.6.1`,
`v0.6.2`, `v0.7.0`, and `v0.8.0` lacks it. A current client connected to one
of those servers sends no new request and retains the released live-process,
initial Codex acknowledgement, and global-default fallbacks. Older clients
ignore the additive field. Newer servers expose only requested model,
thinking, and effort; retained permission and service-tier settings remain
internal. No existing capability meaning changes. The Maintainer approved
this self-gated response-field fallback on 2026-09-04.

`git-working-tree-files` owns the current-content inventory, persistent
untracked-cache route, and cache-backed status request. Releases `0.6.2` and
`0.7.0` have none of them. Without the permanent capability, the client retains
tracked-only Files plus legacy compact untracked expansion and sends no
working-tree or cache request. It is version-implied from `0.7.1` and owns ID
38.

`git-incoming-commits` owns the read-only local `HEAD..<upstream>` preview. The
server reads the tracking ref left by the last remote check and never fetches on
open. Releases `0.6.2` and `0.7.0` lack the route. Without the permanent
capability, upstream remains inert and the client sends no incoming-commit
request. It is version-implied from `0.7.1` and owns ID 39.

`git-inclusive-to-head` owns inclusive selected-commit-through-pinned-HEAD list
and per-file diff routes. The core corpus `v0.6.0`, `v0.6.1`, `v0.6.2`, and
`v0.7.0` lacks them. Without permanent ID 40, the client hides inclusive **To
HEAD** and sends no range request. The existing
`git-source-review-projections` capability retains its direct
selected-tree-to-HEAD and ignore-whitespace meaning; a separately available
direct per-file action continues to use only those older routes. It is
version-implied from `0.7.1`.

`git-working-tree-sections` owns the optional lease-backed project snapshot and
sequenced live-delta contract, including requested Tracked / Untracked /
Ignored coverage, lazy opened-directory coverage for filesystem-only projects,
embedded dirty and cumulative Git facts when available, and the sectioned
static route used for explicit refresh or resynchronization. A filesystem
subscriber sends optional `coverage.expandedPrefixes`; root is implicit, and
snapshots plus deltas may carry pending or bounded directory rows. Subscribers
to one project share the server snapshot, unioned watcher set, and
reconciliation owner while receiving a projection of their own prefixes.
Omitting the new request field retains the preceding bounded breadth-first
filesystem inventory, and omitting the new response fields remains readable by
a current client. Without permanent ID 41, the client keeps the released static
`git-working-tree-files` behavior, sends no worktree subscription, does no
ignored enumeration, and retains the focused 30-second fallback refresh. It is
an optional bit from `0.7.2`, advertised only while the default-off server
setting is effectively enabled. The Maintainer approved correcting this
unpublished capability before its first stable release after native watcher
exhaustion crashed the server.

`git-working-tree-complete-scan` owns exact filesystem file totals on worktree
snapshots, deltas, and directory rows plus the optional
`coverage.filesystemScan: "complete"` request. The ordinary optional-feature
corpus is `v0.7.0` (2026-07-25) and `v0.6.2` (2026-07-11); neither contains ID
41's live subscription or these fields. Without permanent ID 42, the client
keeps the bounded opened-directory projection and its truncation notice, hides
**Show all N**, and sends no complete request. Existing capability meanings and
older capable behavior remain unchanged. It is an optional bit from `0.7.2`
and is advertised only with active ID 41.

`git-live-worktree-setting` owns the additive
`settings.liveWorktreeMonitoringEnabled` field on `GET /api/settings` and
`PUT /api/settings`. The ordinary optional-feature corpus is `v0.7.0`
(2026-07-25) and `v0.6.2` (2026-07-11); neither contains IDs 41/42 or the
setting. Without the permanent setting capability, a current client hides the
control, omits the field, and refuses to activate a live subscription even if a
source-ahead server advertises pre-stabilization ID 41. The setting capability
does not mean monitoring is active: optional IDs 41/42 carry that fact.

`cache-miss-billing-ignore-after` owns the additive
`settings.cacheMissBilling.ignoreAfterMinutes` field on `GET /api/settings` and
`PUT /api/settings`. The ordinary optional-feature corpus is `v0.7.0`
(2026-07-25) and `v0.6.2` (2026-07-11); both lack the field and capability.
Without permanent ID 43, the client keeps presenting and writing the legacy
`recentActivityMinutes` lower no-alert window, hides the ignore-after control,
and omits the additive field from writes and undo restores. Existing capability
meanings and older behavior remain unchanged. It is version-implied from
`0.7.2`.

`cache-miss-billing-expected-expiry` owns the additive
`includeExpectedExpiry=1` query on
`GET /api/settings/cache-miss-billing/events`, the post-window outcome and
`expectedInputCost.freshEnough: false` records it reveals, and the distinct
`cache-miss-billing-expected-expiry` live event. The ordinary optional-feature
corpus is `v0.7.0` (2026-07-25) and `v0.6.2` (2026-07-11); both lack the query,
records, event, and capability. Without permanent ID 49, the client hides the
default-off evidence toggle, omits the query, and listens only for the legacy
live event. The legacy route filters expected-expiry evidence before applying
its limit, and the legacy live event never carries it. Existing capability
meanings and older behavior remain unchanged. It is version-implied from
`0.7.2`.

`attachment-only-session-messages` owns empty-text submissions that carry at
least one uploaded attachment across direct session start, detached start,
resume, and live queue routes. Stable releases `v0.7.0` (2026-07-25) and
`v0.6.2` (2026-07-11) reject these requests before inspecting attachments.
Without permanent ID 50, a current client retains the attachment draft,
explains that the server must be updated or text added, and makes no empty-text
request. Text-bearing attachment sends keep their existing behavior. It is
version-implied from `0.7.2`.

`project-code-names` owns the additive `codeName` field on project list,
detail, and create responses; `PATCH /api/projects/:projectId/code-name`; and
the `project-code-names-changed` invalidation event. The ordinary optional
feature corpus is `v0.7.0` (2026-07-25) and `v0.6.2` (2026-07-11); no other
stable server release fell in the preceding 14 days as of 2026-08-24. Both
lack the field, route, event, and permanent ID 46. Without it, clients use full
project names, retain the released browser-title activity frames, hide
code-name editing, and make no code-name request. Existing capability meanings
and older capable behavior remain unchanged. It is version-implied from
`0.7.2`.

`codex-reasoning-summary-setting` owns `settings.codexReasoningSummary` on
`GET /api/settings` and `PUT /api/settings`. The ordinary optional-feature
corpus was `v0.7.0` (2026-07-25) and `v0.6.2` (2026-07-11); no other stable
server release fell in the preceding 14 days as of 2026-08-16. Both lack the
field. The permanent capability is version-implied from `0.7.1` and owns ID 35.
Without it, the client hides the Codex reasoning-summary row and sends no field.
Existing capability meanings and older capable behavior remain unchanged.

`claude-gateway-disable-plan-mode` owns
`settings.claudeGatewayDisablePlanMode` on `GET /api/settings` and
`PUT /api/settings`. The ordinary optional-feature corpus is `v0.7.0`
(2026-07-25) and `v0.6.2` (2026-07-11); no other stable server release fell in
the preceding 14 days as of 2026-08-17. Both lack the field. The transitional
capability is version-implied from `0.7.1` and owns ID 36. Without it, the
client hides the Gateway plan-mode row and sends no field. Existing Gateway and
Agent-denial capability meanings and older capable behavior remain unchanged.

`synthetic-archive-command` owns
`POST /api/sessions/:sessionId/archive`, the atomic archive-plus-automation-pause
mutation, and `/archive` queued/transcript projections. The ordinary
optional-feature corpus is `v0.7.0` (2026-07-25) and `v0.6.2` (2026-07-11);
both lack the route. The permanent capability is version-implied from `0.7.1`
and owns ID 37. Without it, a client connected to a server that advertises
`synthetic-done-command` calls only the established bodyless `/done` route and
canonicalizes every visible projection to `/done`; it makes no archive request.
Without either capability, the existing provider-command fallback remains.
The already-advertised done capability and older capable behavior remain
unchanged.

`glossary-tooltips` owns artifact version 2's additive
`terminals[].caseSensitiveForms` field and its lowercase-insensitive,
all-caps-exact, and mixed-case matching semantics. The ordinary optional
corpus `v0.7.0` and `v0.6.2` lacks the glossary route and capability entirely;
without permanent ID 10, the client requests no artifact and renders ordinary
prose. A version-1 artifact from a briefly advertised source-ahead server lacks
the field, so the current matcher preserves its legacy case-insensitive
behavior. The Maintainer approved correcting this capability before its first
stable release on 2026-08-27; `introducedIn` remains `0.7.1`.

`serverHasCapability` accepts release implication, encoding-1 IDs, and both
legacy representations. This union keeps old installed servers usable without
making a new capability depend on its textual name.

### Exceptional negative overrides

`deniedCapabilityBits` is the standard negative override for a contract the
reported release would otherwise imply. A known denied ID wins over release
implication, a legacy name, and a positive source-ahead bit. Unknown denied IDs
are ignored: they describe registry entries this client does not know and must
not turn `/api/version` into an error. IDs belonging to `optional-bit` or
`scoped` capabilities are likewise irrelevant to this set; optional support is
already expressed by presence or absence of its positive bit.

Omission means no version-implied contracts are withdrawn. A legacy name-list
response instead omits the denied capability name because those clients do not
infer support from the server version. The server encoder accepts negative
overrides only for registered `version-implied` capabilities and emits an ID
only when `current` would otherwise imply that contract.

This is an exceptional compatibility escape hatch, not another availability
class. YA has no current plan to introduce a version-implied capability it
expects may be withdrawn; anticipated experimental, removable, host-dependent,
or configuration-dependent support uses `optional-bit`. A possible later
reduction in routine negative-bit traffic is kept in
[Server Capability Sketches](server-capabilities.sketches.md).

Every capability string advertised from `/api/version` should have a registry
entry, including permanent static features and dynamic environment/state
capabilities. Keeping the complete set in shared code lets client and server
call sites import constants instead of repeating wire strings.

For session sandboxing, `session-sandboxing-status` advertises the structured
host-preflight contract while `session-sandboxing` is dynamic and means the
local host currently has a usable enforcement backend. Clients require both
and an `available` status before showing or sending the optional launch field;
the launch path still rechecks and fails closed.

`session-sandbox-network-firewall` permanently gates the additive network
selection and enforcement status. Current clients require it together with the
two sandbox capabilities before showing either sandbox control, and otherwise
send neither launch field. It is version-implied from 0.7.2 because every
official build from that release owns the setting, session/queue fields,
derivative inheritance, and public-only egress boundary. Stable releases
`v0.7.0` and `v0.6.2` lack the complete sandbox contract. An omitted firewall
value on a project-write request defaults on at the new server; explicit false
is preserved. No existing capability meaning changes.

For session copying, `session-fork-turn-intents` advertises the additive
`forkKind` / `sourceMessageId` contract on the existing project-session fork
route. The client requires it together with provider `supportsForkSession`
before rendering header Clone or direct per-turn Fork. When absent, the whole
unified surface is hidden and no fork request is made; legacy server parsing is
not treated as a client fallback. This transitional gate was introduced in
`0.7.1`. Its 2026-09-02 optional-feature review covered stable `v0.8.0`
(2026-08-31) and `v0.7.0` (2026-07-25); no other stable release fell in the
preceding 14 days. `v0.8.0` has the server-resolved intent contract, while
`v0.7.0` lacks it. Because a latest-two release still needs the fallback, the
client gate and server advertisement remain, with the next review due
2026-10-01.

For authenticated public-share management, `public-share-management`
advertises compact inventory plus opaque-id single-link and confirmed global
revocation. A client without it preserves the existing session sharing popup
and Settings kill switch, hides the direct/global manager entries, leaves the
browser context menu unchanged, and sends no management request. Storage
readiness is reported by the routes themselves and is not inferred from an
empty inventory.

`public-share-management-freeze` independently advertises exact-ID batch
conversion of live grants to current frozen snapshots. It is permanent,
version-implied from `0.7.1`, and owns indexed ID 32. The split preserves the
meaning already advertised by source servers with `public-share-management`.
Without the freeze capability, the manager hides live-row and bulk freeze,
keeps inventory/copy/revocation, and makes no freeze request. Stable releases
`v0.7.0` and `v0.6.2` contain the older session-wide freeze route but neither
selective management nor the authenticated management route family, so that
session route is not a safe per-link fallback.

`public-share-session-chunks-v1` is a representation capability carried by the
secret-authorized v2 public metadata response, not a global `/api/version`
claim. It means the selected immutable primary or viewer revision supports
ordered pull reads of at most 256 KiB of compressed `session.json.gz` data per
ordinary relay request, with at most 256 chunks and 64 MiB each for compressed
and decompressed totals. The public viewer gates only on that metadata field;
an installed server's global capabilities cannot prove that one selected
revision has the required persisted integrity metadata. Releases `v0.5.2`,
`v0.6.0`, `v0.6.1`, `v0.6.2`, and `v0.7.0` lack this route and field. An
unmarked link keeps the combined response and makes no metadata request. Marked
v2 metadata without the capability keeps the one-response `wire=raw-json`
path and makes no chunk request. Relay raw-json responses are capped at 8 MiB;
larger responses return 413 with update guidance. A browser without
`DecompressionStream` takes that same raw-json path on the already-open relay
WebSocket even when metadata advertises chunks. Existing capability meanings
and the `#v=2` marker remain unchanged.

## Capability Lifecycle Classes

Use `kind: "permanent"` for client gates that remain useful indefinitely. This
includes self-hosted feature boundaries and environment-dependent availability;
the lifecycle kind does not decide how the capability is encoded.

Use `kind: "transitional"` for rollout guards that protect a new client from
showing controls that call routes, fields, or event semantics older compatible
servers do not have. Transitional capabilities must define:

- `clientFallback` - what the new client does when the capability is absent;
- `reviewAfter` - the date Maintainers should re-evaluate the gate;
- `removeClientGateWhen` - the compatibility floor or support-window condition
  that makes the client branch removable;
- `removeServerAdvertisementWhen`, when useful - when the server can stop
  advertising the string after older maintained clients no longer branch on it.

## Advertisement Classes

Advertisement is independent from lifecycle:

- `version-implied` is for a contract that is monotonic on the official release
  line. Once a stable release reaches its `introducedIn` version, later official
  releases are expected to keep that contract. A future client therefore
  normally needs only the server version and its own registry; an exceptional
  explicit negative override can deny the implication. Capabilities introduced
  after that client's build are unknown and irrelevant to it.
- `optional-bit` is for support that may be disabled, removed, host-dependent,
  or installation-dependent. Its allocated ID is sent whenever support is
  present; the ID remains reserved after retirement.
- `scoped` is for a capability advertised by another payload rather than global
  `/api/version`, such as one immutable public-share representation. It remains
  an explicit representation name in that owning payload and is outside the
  global client/server ID namespace.

IDs are global across both directions, chronological within the introducing
release, and never renumbered or reused. Every global capability introduced in
0.7.1 or later requires one, including a permanent capability normally implied
by release version. This lets a source build report the capability numerically
before its release semver can imply it. The 0.6.x optional-bit assignments seed
the same ledger:

| ID | Direction | Introduced | Capability |
| ---: | :---: | :---: | --- |
| 0 | server | 0.6.0 | `voiceInput` |
| 1 | server | 0.6.0 | `deviceBridge-available` |
| 2 | server | 0.6.0 | `deviceBridge` |
| 3 | server | 0.6.0 | `deviceBridge-download` |
| 4 | server | 0.6.0 | `deviceBridge-update` |
| 5 | server | 0.6.3 | `browser-settings-backup` |
| 6 | server | 0.7.1 | `security-client-audit-v1` |
| 7 | server | 0.7.1 | `reload-safe-codex-runtime` |
| 8 | server | 0.7.1 | `session-sandboxing` |
| 9 | server | 0.7.1 | `public-share-management` |
| 10 | server | 0.7.1 | `glossary-tooltips` |
| 11 | server | 0.7.1 | `progressive-session-catalog` |
| 12 | server | 0.7.1 | `project-directory-storage-policy` |
| 13 | server | 0.7.1 | `idle-reap-hours-setting` |
| 14 | server | 0.7.1 | `tool-result-media-preservation-policy` |
| 15 | server | 0.7.1 | `git-dirty-file-editor` |
| 16 | server | 0.7.1 | `git-source-review` |
| 17 | server | 0.7.1 | `git-source-review-submissions` |
| 18 | server | 0.7.1 | `git-source-review-projections` |
| 19 | server | 0.7.1 | `claude-gateway` |
| 20 | server | 0.7.1 | `claude-gateway-autostart` |
| 21 | server | 0.7.1 | `claude-gateway-disable-agent` |
| 22 | server | 0.7.1 | `provider-subscription-usage` |
| 23 | server | 0.7.1 | `reload-safe-codex-runtime-settings` |
| 24 | server | 0.7.1 | `host-agent-process-observability` |
| 25 | server | 0.7.1 | `session-sandboxing-status` |
| 26 | server | 0.7.1 | `project-session-defaults` |
| 27 | server | 0.7.1 | `sidebar-session-resume` |
| 28 | server | 0.7.1 | `session-fork-turn-intents` |
| 29 | server | 0.7.1 | `git-file-diff-projections` |
| 30 | server | 0.7.1 | `provider-host-control` |
| 31 | server | 0.7.1 | `remote-browser-diagnostics-v1` |
| 32 | server | 0.7.1 | `public-share-management-freeze` |
| 33 | server | 0.7.1 | `synthetic-done-command` |
| 34 | server | 0.7.1 | `subagent-max-depth-setting` |
| 35 | server | 0.7.1 | `codex-reasoning-summary-setting` |
| 36 | server | 0.7.1 | `claude-gateway-disable-plan-mode` |
| 37 | server | 0.7.1 | `synthetic-archive-command` |
| 38 | server | 0.7.1 | `git-working-tree-files` |
| 39 | server | 0.7.1 | `git-incoming-commits` |
| 40 | server | 0.7.1 | `git-inclusive-to-head` |
| 41 | server | 0.7.2 | `git-working-tree-sections` |
| 42 | server | 0.7.2 | `git-working-tree-complete-scan` |
| 43 | server | 0.7.2 | `cache-miss-billing-ignore-after` |
| 44 | server | 0.7.2 | `git-live-worktree-setting` |
| 45 | server | 0.7.2 | `synthetic-terminate-command` |
| 46 | server | 0.7.2 | `project-code-names` |
| 47 | server | 0.7.2 | `git-file-revision` |
| 48 | server | 0.7.2 | `codex-stream-durable-id-alignment` |
| 49 | server | 0.7.2 | `cache-miss-billing-expected-expiry` |
| 50 | server | 0.7.2 | `attachment-only-session-messages` |
| 51 | server | 0.7.2 | `public-file-shares` |
| 52 | server | 0.7.2 | `session-sandbox-network-firewall` |
| 53 | server | 0.8.1 | `codex-plan-tool-setting` |
| 54 | server | 0.8.1 | `codex-paginated-rollout-lineage` |
| 55 | server | 0.8.1 | `project-queue-attachment-editing` |
| 56 | server | 0.8.2 | `project-file-completion` |
| 57 | server | 0.8.2 | `session-conversation-context` |
| 58 | server | 0.8.2 | `turn-effort-modifiers` |
| 59 | server | 0.8.2 | `artifact-viewer` |
| 60 | server | 0.8.2 | `session-async-questions` |
| 61 | server | 0.8.2 | `project-queue-readiness-check` |
| 62 | server | 0.8.2 | `acli-commentary-rendering` |
| 63 | server | 0.8.2 | `retained-session-collections` |
| 64 | server | 0.8.2 | `local-speech-model-selection` |
| 65 | server | 0.8.2 | `speech-vocabulary` |

The code ledger is authoritative. The next client or server capability takes
ID 66; retired rows stay in the ledger as reserved IDs.

`speech-vocabulary` (ID 65, optional bit from 0.8.2) owns GET/PUT
`/api/speech/vocabulary` and POST `.../scan` and `.../reset`. It is advertised
only when SQLite is ready. The maintainer approved the v0.8.0/v0.8.1 optional
corpus on 2026-09-08: both lack these endpoints. Without the capability,
clients hide the vocabulary controls and issue no vocabulary requests. Existing
speech and capability meanings remain unchanged. See
[learned speech vocabulary](pluggable-speech-recognition.md#learned-vocabulary-contract).

`local-speech-model-selection` gates per-request Whisper model overrides and
recent Parakeet presets, including unified English on the isolated NeMo
runtime. The maintainer approved this plan on 2026-09-08 against the optional
support corpus v0.8.0 and v0.8.1: both accept `model` on batch requests but
ignore it for Whisper, and both use NeMo 2.0. Without the capability, hide
Whisper selectors and recent Parakeet presets, send no Whisper model override,
and resolve unset or unsupported new Parakeet presets to the existing v3
request without rewriting stored preferences. Existing custom Parakeet IDs
and older capable behavior remain unchanged. No new endpoint is required;
the existing transcription and prewarm routes carry the model. The permanent
capability is version-implied from 0.8.2 with source-ahead ID advertisement.

`session-conversation-context` gates the general sequence-of-user/assistant-text
delivery route; it does not gate question-card fork orchestration. The
2026-09-06 optional-feature horizon contains v0.8.0 and v0.8.1 (latest two and
all stable releases from the preceding 14 days). Neither has the new route.
Clients without the capability use existing clone/resume/read routes for
answers and an attributed ordinary user turn for Save, making no unsupported
context request. Existing capabilities retain their meanings. See
[synthetic-turn injection](synthetic-turn-injection.md) for the receipt and
provider-fallback contract.

## When To Add One

Add a server capability when:

- a visible UI control depends on a server route, response field, or event
  behavior older compatible servers lack;
- feature availability genuinely varies by server environment;
- the old/new mismatch would create a confusing click path or broken visible
  affordance.

Do not add a capability for:

- internal implementation details;
- required protocol changes, which belong in `remoteCompatibilityLevel` or a
  dedicated protocol version;
- requests the client can attempt and recover from invisibly without changing
  the user-visible experience.

Capability flags are feature hints. They are not a substitute for protocol
compatibility levels when a hosted client must stop supporting an older server
class entirely.

## Minimum Compatibility Horizons

Hosted clients can update before installed servers. Capability fallbacks are
user-facing support contracts, not rollout conveniences.

Before making the client depend on a server route, response field, event, or
changed semantic that is absent from a supported stable release, read
this topic and [remote hosted compatibility](remote-hosted-compatibility.md).
Identify whether the feature is core or optional and inspect every stable
server release in the applicable minimum horizon:

- optional features: the latest two stable releases and every stable release
  from the preceding 14 days;
- core functionality: the latest two stable releases and every stable release
  from the preceding 60 days.

Then present a compatibility plan before editing the client/server contract:
name the releases, new routes/fields/events, proposed capability or protocol
gate, exact behavior when it is absent, proof that the fallback makes no
unsupported request, and whether any existing capability meaning or older
capable fallback changes. Pause for maintainer approval. An
originating request that already states and approves those decisions satisfies
the pause; do not ask twice.

Use an available structured async or blocking question form for this approval.
Use plain text only when neither question form is available.

Never expand an already-advertised capability to cover a contract older servers
do not provide. A new client must not call a new endpoint until its gate is
known present. Passing a support horizon permits human review only; it never
automatically removes a fallback or raises a compatibility floor. Security
exceptions follow [hard development rules](hard-development-rules.md).

Preserve a cheap fallback longer when practical.

Default a new global capability to `version-implied` when every official build
from its introducing release onward provides the contract. Use an explicit
sparse capability bit only when support is clearly experimental or
withdrawable, or can vary by build, host, or configuration. A version-implied
capability still receives a permanent ID for registry identity and source-ahead
advertisement, but released peers normally infer it from the version and do not
send a positive ID. An exceptional withdrawal uses the standard negative
capability set; do not classify anticipated variability as version-implied.

Suggested approval prompt:

> Compatibility review for `<feature>`: releases `<corpus>` lack
> `<routes/fields/events>`. I propose `<capability/protocol>`; without it the
> client `<fallback>` and makes no unsupported requests. Existing capability
> meanings and older capable behavior remain unchanged. Approve?

### Planned storage policy gates

The project-directory storage correction is a core trust/default change. Its
2026-08-03 60-day stable corpus is `0.5.2`, `0.6.0`, `0.6.1`, `0.6.2`, and
`0.7.0`; `0.5.0` and `0.5.1` are also audited because `0.5.0` introduced the
project-local attachment default. Every one of those releases lacks a storage
setting and every release from `0.5.0` through `0.7.0` writes uploads to
`.attachments/`. No stable release contains the later tool-result, review,
author-palette, or managed-exclude writers.

The permanent capability is `project-directory-storage-policy`. It owns
`GET /api/settings`, `PUT /api/settings`, and the request/response field
`settings.projectDirectoryStorage: "app-data" | "project"`. Advertisement
attests that every audited YA-managed writer obeys the setting, absent
configuration defaults to `"app-data"`, and a mode change reconciles
revisioned authoritative Source Review state before publishing the new mode; a
server must not advertise a partial settings-only implementation.

Without the capability, the client omits the field and makes no unsupported
request. Because absence means an older server may still write into projects,
the Settings surface shows a read-only update-required explanation rather than
claiming app-data-only protection. Stable releases through `0.7.0` never
advertised this capability, so their behavior and fallback remain unchanged.
The maintainer explicitly accepted broadening the capability meaning for
post-`0.7.0` source builds that briefly advertised routing-only semantics rather
than introducing a second gate before the first stable release. The registry
`introducedIn` value remains `0.7.1`. The full behavior and audit are in
[Project Directory Storage](project-directory-storage.md).

### Session-catalog gate

Approved 2026-08-05. Global session lists and Inbox move from request-complete
enumeration to a progressive retained snapshot, so the client begins sending a
known generation on revalidation and relies on answers older servers cannot
give.

The permanent capability is `progressive-session-catalog`. Permanent rather
than transitional because YA is self-hosted with no forced upgrade: the
population of older servers never converges, so the gate never becomes
removable. Absent the capability the client keeps today's complete-request
enumeration and issues no unsupported request. Existing provider and session
capabilities, and explicit session-detail reads, are unchanged.

**The fallback is the contract, and it is a performance floor, not a feature
floor.** An out-of-date client must still perform basic actions against a
current server, and a current client against an out-of-date server, at some
non-optimal performance level. The ungated path therefore stays a working
enumeration rather than a degraded stub, and that — not the size of the release
corpus audited — is what a review of this gate should check.

**The wire surface is `GET /api/sessions`.** The response carries
`generation`; a request may carry `knownGeneration`, and a match answers
`{ unchanged: true, generation }` without walking any project. Three rules a
caller must respect, because none is enforceable from the server side alone:

- a token is only meaningful against **identical query parameters**. The
  generation covers the collection, not a particular filter, so replaying a
  token from a different `project` / `q` / `starred` / `includeArchived` read
  would claim rows the client does not have. Cursor pages (`after`) never
  short-circuit for the same reason.
- a client without the capability must not send `knownGeneration` and must
  ignore `generation`; an older server silently ignores the parameter and
  returns a full response, so the fallback is safe either way.
- a token claims the client **still holds those rows**, which is a claim about
  coverage as well as content. `unchanged` is a truthful answer to a consumer
  asking for a wider window than it retains, and a useless one: it would leave
  that consumer permanently short of rows. Offer the token only when the
  retained collection already covers the request.

Both halves have landed. `useGlobalSessionsFeed` offers its accepted generation
on automatic revalidation and treats `unchanged` as keeping its retained rows;
an explicit user refresh always asks for rows, since that is a fidelity request
rather than a freshness one. Bounded deltas, and the cross-tab/IndexedDB
persistence in the same plan step, are not built.

### Retained collection gate

Approved 2026-09-08. `retained-session-collections` is permanent ID 63,
version-implied from 0.8.2. The reviewed core-functionality corpus is v0.6.1,
v0.6.2, v0.7.0, v0.8.0, and v0.8.1. None provides `summaryMode=retained`
on `/api/sessions` or `/api/inbox`, their `catalog` status object, or the
`session-catalog-updated` event. Source builds advertise the new bit explicitly
until the introducing release implies it.

Capable clients request saved rows immediately and accept later badge/detail
enrichment. `catalog` contains `catalogEpoch`, `catalogGeneration`, `complete`,
`refreshing`, and optional `refreshError`. The update event carries that object
and a timestamp. An incomplete empty generation cannot replace existing client
membership, and omitted detail fields cannot clear known complete facts.
Catalog status describes retained source observations, not a new full-summary
freshness claim.

Before its first request a client joins the source's version acquisition.
Without this capability, it sends no retained-mode parameter and keeps the
complete-request path, including any independently supported conditional-read
behavior. Old clients on new servers also keep that path. Full-prompt search
continues using complete requests. `progressive-session-catalog` still means
only the existing global collection revision/`knownGeneration` contract;
neither its meaning nor that of `session-async-questions` changes.
The execution and lifecycle contract is in
[Session Catalog Observation](session-catalog-observation.md#retained-global-sessions-and-inbox).

Tool-result preservation is independently gated by the proposed permanent
`tool-result-media-preservation-policy` capability. It owns `GET
/api/settings`, `PUT /api/settings`, and
`settings.toolResultMediaPreservation: "on-demand" | "preserve"`.
Advertisement attests that absent configuration defaults to `"on-demand"`,
that on-demand and historical session-detail reads create no persistent media
copy, that preserve mode captures only new results emitted by managed
sessions, and that preserved copies have no automatic pruning or eviction.

No stable release through `0.7.0` contains tool-result media handles or
preservation. A new client connected to a server without the capability omits
the field and shows a read-only update-required explanation; it does not infer
safe on-demand semantics because an unadvertised post-`0.7.0` source build may
contain the unconditional materializer. Existing capability meanings remain
unchanged. The complete UI and timing contract is in
[Storage Settings](storage-settings.md).

## Server Use

Optional discovery storage reports `sqlite?: { state }` on `/api/version`;
absence means the server does not report storage status. This diagnostic does
not allocate a capability or imply session search. Future discovery endpoints
need their own runtime-dependent optional gate. See
[optional SQLite](optional-sqlite.md) for startup policy and the approved
v0.8.0/v0.8.1 compatibility corpus.

`packages/server/src/routes/version.ts` advertises capability names from the
shared registry. Static capabilities can be included directly. Dynamic
capabilities, such as environment-backed integrations, still use registry
constants but decide at runtime whether to advertise them. The version route
uses the client version to select the newest mutual encoding, then passes the
resulting name set through the matching encoder. Clients without a version get
the complete legacy name list.

Do not hand-write raw capability strings in the version route when a registry
constant exists. Every new global client or server capability first gets the
next never-used entry in `CAPABILITY_ID_ALLOCATIONS`. A monotonic server
contract then gets `version-implied` advertisement metadata; a dynamic or
removable contract gets `optional-bit`. Both registry definitions reference
the allocated global ID.

### Snapshot delivery

`/api/version` is a shared compatibility snapshot, not a per-component probe.
The client retains one resolved snapshot per connected source and all
capability consumers subscribe to it. A reconnect or explicit refresh may
revalidate that source; mounting another component must not issue a new request.
When a validation field such as speech-backend readiness is temporarily
pending, one source-level owner schedules the follow-up rather than every hook
instance starting its own timer.

Ordinary server reads assemble the response from retained state. Static
process/build facts such as the development `git describe` result and install
source are computed once per server generation. Dynamic services such as
sandbox or device-bridge availability own their own bounded snapshots and
in-flight coalescing. `fresh=1` remains the explicit path for bypassing the
applicable caches; a normal capability read must not repeatedly launch Git,
package-manager, sandbox, bridge, or provider subprocesses.

This delivery contract does not change any capability's meaning and therefore
does not itself require a new capability flag. A new route or response field
used to implement a feature still follows the compatibility-horizon rules
above.

## Client Use

Client code should use `serverHasCapability` with registry constants or domain
helpers rather than inspecting names, bits, or semver directly. The helper
handles old-server name arrays, intermediate compact responses, global ID bits,
and release implication. Fixtures for 0.7.1+ capabilities should use a server
version or allocated bit rather than constructing a capability-name list.
Missing transitional capabilities mean "hide or degrade the optional feature,"
not "the server is broken."

For visible controls, prefer gating before rendering. A defensive request error
path is still useful, but it should not be the primary compatibility behavior.

## Cleanup

Periodically audit transitional capabilities:

1. Find all registry entries with `kind: "transitional"`.
2. Check whether `reviewAfter` has passed.
3. If the current hosted-client compatibility floor excludes servers missing
   the capability, remove the client gate and fallback branch.
4. Keep server advertisement for one more support window if older maintained
   clients may still branch on the string.
5. Retire or remove the registry entry once no maintained client or server
   code depends on it.

`pnpm capabilities:audit` lists due transitional capabilities, rejects raw
capability checks outside registry constants/helpers, validates global ID
uniqueness and the 0.7.1 allocation floor, checks optional-bit aliases, and
verifies that every route declared by a capability-owned route module is
present in that capability's route contract (and vice versa). CI runs the
audit. New capability-owned feature families should list their route modules
in registry metadata so later route additions cannot silently escape the
advertisement.

The audit complements, rather than replaces, released-server behavior
fixtures. A capability may be registered perfectly while the client still
mounts its consumers before checking it.

## Optional Windows Computer Control

The 2026-09-12 optional compatibility review covers stable v0.8.0 and v0.8.1;
neither has the new contract. Permanent optional ID 70,
`optional-computer-control`, covers the authenticated operator routes and
explicit session-start selection. Advertisement means the server can report
availability; Windows/Node/local-Codex eligibility and default-off enablement
remain separate checks. Absent support sends no computer-control requests or
launch fields. See [Computer Control](optional-computer-control.md) for the
exact routes and authority contract. No older capability changes meaning.

## Experimental issue/session associations

The approved 2026-09-10 optional review used v0.8.0 and v0.8.1 (latest two stable
releases and all releases in the preceding 14 days). Optional sparse capability
`issue-session-associations-v1`, permanent ID 68, covers automatic discovery,
settings/scope, issue/reference search, evidence and corrections. It requires
ready SQLite and the indexing owner, independently of the default-off opt-in.
Absent support hides settings/sidebar/session controls and sends no issue requests.
Existing capabilities and protocol levels keep their meanings. The unpublished v1
contract may evolve before release; released changes need the usual review. See
[issue/session associations](issue-session-associations.md#compatibility-and-migrations)
for exact routes, fields and source-switch behavior.
