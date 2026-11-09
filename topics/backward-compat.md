# Backward compatibility decisions

Durable decisions for observable or persisted surfaces whose compatibility
handling is not obvious from the implementation alone.

Topic: backward-compat

## Decisions

2026-11-06 inbox `providerPhase` — an optional field on inbox items and a new
`session-provider-phase-changed` bus event, with no capability. An older
server omits both, and the client keeps the plain Active dot and tiers. An
older client ignores the field and drops the unknown event type. Row
`activity` keeps its meaning, so queueing, push and webhooks are unchanged.
See [provider waits](provider-wait-and-background-work.md#contracts).

2026-11-01 YA-owned session identity — selected direction, implementation
pending. New YA-created sessions will retain a permanent public id and durable
startup state independently of provider identity/transcript creation. Preserve
existing public ids and links, native transcript authority, legacy creation
response semantics and current authentication/transport protocols. The
[identity topic](session-identity.md#compatibility-research--2026-11-01) records
the release audit, filename-based refresh hazard and recommended capability
boundary; [creation/navigation](session-creation.sketches.md) builds on it.
The general new-session work from
[plan 150](../docs/tactical/150-ya-owned-session-ids.md#november-1-selected-follow-up)
is reopened, while the full fork/clone redesign remains deferred. This selects
no database downgrade support, compatibility cutoff or final API/schema shape.

2026-10-11 required SQLite and `session-metadata.json` — session metadata moves
into `discovery.sqlite` (migration 10), imported once from the JSON file, which
is then left on disk unread and unwritten. Downgrading is not supported: an
older build reads only the JSON file and would see metadata as of the upgrade.
SQLite is now required, and a server that cannot open it, including one whose
data directory is on a network filesystem, exits instead of degrading.
`YEP_SQLITE` is removed with no alias; the server and desktop launcher ignore
it. `GET /api/version` keeps its `sqlite` field, now always `ready`. Clients
keep their `disabled`, `unsupported`, `error` and `networkFilesystem` handling
for older servers within the compatibility horizon. See
[built-in SQLite storage](required-sqlite.md#session-metadata) and
[plan 150](../docs/tactical/150-ya-owned-session-ids.md).

2026-10-10 Codex async-delivery tool-use message UUIDs — qualify with
`-tool-call` in live and durable normalization because Codex reuses the call ID
for a distinct displayed agent message. Preserve the displayed message ID,
stored question state, tool block IDs and result references. Existing clients
already merge opaque UUIDs; no new wire field or capability is required.
Previously loaded colliding snapshots require a fresh transcript load.

2026-09-27 `yep-sidebar-interactions:*` — replaced by
`yep-sidebar-submissions:*`; the old key is removed, not migrated. It mixed
session visits with sends, and the two cannot be told apart, so carrying it
forward would keep a pre-change visit pinning its row. Losing old sends costs
nothing lasting: the server's last human turn orders those sessions.
Browser-local state only. See
[sidebar session ordering](sidebar-session-ordering.md) § Storage and
ownership.

2026-09-27 draft envelope `pendingSend: true` — replaced by `pendingSendAt`,
the submit's server-clock time, so a recovery copy can be discarded only on
proof dated from its own send. A stored or sibling-tab marker without a time
reads as an ordinary draft and is never discarded automatically; the worst
case is one stale draft left visible. An older client ignores `pendingSendAt`
the same way. Browser-local state only; no server contract changes. See
[message control](message-control-steer-queue-btw-later-interrupt.md)
§ Composer acknowledgement safety.

2026-09-26 limited users — gate Settings → Users behind the new
version-implied `limited-users` capability (ID 83, from 0.9.0) instead of
probing `/api/users` for a 404. Released v0.9.0 and v0.9.1 carry the feature
and infer the capability from their version; an older server previously got a
toggle whose `limitedUsersEnabled` write it silently dropped, and now gets no
toggle and no request. `GET /api/auth/status` gains an additive
`limitedUsersEnabled` boolean; only the co-deployed local login page reads it,
and a server without it keeps that page's Username field hidden.

2026-09-07 Codex `/clone` — keep the existing route and response fields while
using native provider forks. `messageCount` remains a conservative inherited
prefix offset for older `/btw` clients, using `Number.MAX_SAFE_INTEGER` until
their prompt marker establishes the real boundary. This prevents inherited
answer leakage without scanning history for a count. Quick question cards use
their own marker and ignore the offset. See
[aside contracts](provider-agnostic-btw-asides.md).

2026-08-17 agent launch markers — renamed `YEP_AGENT_HARNESS`,
`YEP_AGENT_INITIAL_MODEL`, and `YEP_AGENT_INITIAL_EFFORT` to
`AGENT_LAUNCH_HARNESS`, `AGENT_LAUNCH_MODEL`, and `AGENT_LAUNCH_EFFORT`, and
added `AGENT_LAUNCHER=yepanywhere`. No compatibility shim: the old names never
reached the reader they were written for. The provider host stamped them on the
worker, then `filterEnvForChildProcess` stripped them one process later along
with every other inherited `YEP_*`, so no agent binary ever saw them and no
in-repo consumer read them. Keeping the `YEP_*` names would have required an
allowlist exception that contradicts "`YEP_*`/`YA_*` is YA's own configuration,
not the agent's"; the unprefixed `AGENT_` namespace passes the filter with no
exception. The host now also deletes the three old names from a worker
environment, so a YA server running inside a session an older YA launched cannot
pass the outer session's stale launch facts down as this launch's. See
[YA environment variables](ya-env-vars.md) § Child launch markers.

2026-08-17 `cacheMissBilling.minimumInputTokens` — dropped and replaced by
`minimumWastedTokens`, which counts only the excess over a turn's expected new
content rather than raw uncached input. The old key measured a quantity the
corrected contract no longer treats as a defect, so carrying its value forward
would preserve a wrong threshold under a right-sounding name. A persisted
`minimumInputTokens` is ignored and the new default (10,000) applies; nothing
depended on the old value, since the feature had never recorded an event. Also
new: `recentActivityMinutes`, absent-means-default at 10.

2026-08-15 `claudeSteerBackgroundBash` expressions — keep the persisted
`allowRegex` / `denyRegex` fields and whole-command matching, but evaluate the
documented regular-expression subset with a linear-time engine. Reject
lookarounds, backreferences, inline flags, word boundaries, and braced
quantifiers on settings writes. A previously persisted expression outside the
subset disables Bash backgrounding instead of reverting to the allow-all
default; explicit supported policies and the absent-setting default retain
their existing meaning.

2026-08-08 session file-change facts — releases `v0.5.2`, `v0.6.0`,
`v0.6.1`, `v0.6.2`, and `v0.7.0` expose the existing activity and focused
session-watch streams but omit exact path/mtime/size correlation facts,
focused change versions, and source-observation timestamps. Add those fields
optionally without a new capability or request: they optimize duplicate
notifications but do not change either event's meaning. A new client
deduplicates only exact cross-route facts within a bounded window. When the
fields are absent, it preserves the existing leading/trailing refresh behavior
and makes no unsupported request; older clients ignore the additive fields.

2026-08-06 frozen public-share relay transport — releases `v0.5.2`, `v0.6.0`,
`v0.6.1`, `v0.6.2`, and `v0.7.0` expose only a materialized one-response
public-share relay path. Add the exact secret-authorized metadata capability
`public-share-session-chunks-v1` for bounded 256 KiB compressed pull requests
over the existing relay request/response framing. Marked v2 metadata without
it keeps `wire=raw-json` and makes no chunk request; unmarked links keep the
combined request and make no metadata or chunk request. Existing capability
meanings and `#v=2` remain unchanged. A browser without
`DecompressionStream` uses the same-socket raw-json fallback even when the
metadata capability is present. New clients require exact success statuses and
runtime-validate each artifact before publishing it: compact metadata may
publish before the body, while a raw or decompressed complete session validates
before session publication. A pre-auth socket selects one lifetime mode: its
first public read locks it to public-read-only, while any SRP control attempt
locks it to SRP even when authentication later fails. Request responses keep the framing
selected at admission rather than consulting later mutable auth state.
Public-read-only sockets allow one request in flight; a second request aborts
and closes as a protocol violation, while authenticated relay multiplexing
remains unchanged. Chunk transfer is available only for safe integer compressed
and decompressed lengths up to 64 MiB. Oversized historical revisions remain
structurally valid but are not chunk-capable: they omit the capability, so a
conforming client sends no chunk request and uses `wire=raw-json`. Relay
raw-json succeeds only through 8 MiB; a larger response returns 413 with update
guidance. Direct HTTP streaming can still load a larger structurally valid
revision. Cap every pre-auth public-share response in the WebSocket adapter at
8 MiB. The adapter retains no more than the accepted 8 MiB body plus
one logical inspection byte. Controlled combined/raw-json serializers emit at
most 64 KiB per source chunk, so cancellation may consume at most one such
bounded chunk past the accepted prefix; an unexpectedly unbounded controlled
producer chunk is an internal invariant failure. Other public resources use
declared length only as an early rejection and enforce the streamed count as
the hard bound; overflow returns 413 without broadening the session-chunk
capability to files. Direct HTTP public-share streams, authenticated relay
traffic, and unrelated relay routes remain uncapped by this adapter policy.

2026-10-15 live public-share relay transport — `v0.9.0`–`v0.9.2` load a live
share only through the one-response relay path, so a live session over 8 MiB
fails with 413. Add the separate scoped metadata capability
`public-share-live-session-chunks-v1`, served by the existing `session-chunks`
route from a transient per-viewer snapshot. A separate name, rather than
broadening `public-share-session-chunks-v1`, keeps already-deployed viewers
from loading a live share as frozen. Without it the viewer keeps raw-json and
makes no chunk request.

2026-08-05 public-share grants and compact URLs — preserve every
legacy 64-byte/86-character bearer secret and display-hint fragment while new
links use a 16-byte/22-character secret plus a compact protocol marker and
server-persisted header. Old viewers ignore the marker and keep using the
combined response; new viewers use legacy fragments and do not call the new
metadata route for an unmarked link. Gate global inventory and opaque-id
revocation behind the new `public-share-management` capability so older
servers receive no unsupported management request.

2026-08-05 public-share owner copy — retain the exact URL for new grants and
return it as an optional authenticated inventory field; pre-change and migrated
hash-only grants remain valid and revocable but cannot offer copy because their
bearer secret is unrecoverable. New clients treat an absent URL as a disabled
copy action, so supported older servers require no new request or response
shape.

2026-08-04 `idleReapHours` settings contract — advertise the optional field
with the permanent `idle-reap-hours-setting` identity. The 2026-10-29
retirement makes it a v0.8.0 client baseline and removes the old UI gate.
Older hosts should update or use their bundled client. Until an operator
saves the field, the legacy `IDLE_TIMEOUT` environment value remains
authoritative; saving opts the deployment into the persisted setting.

2026-08-04 reload-safe runtime viewer presence — retain host protocol v1 and
advertise viewer-state retention as an optional additive lifecycle capability.
A replacement Hono may attach to a host already running older v1 code and use
generation-local viewer timing; capable hosts preserve viewer-absence evidence
across Hono reloads. Older Hono generations ignore the added runtime fields and
never issue the new operation.

2026-08-03 project-directory storage — a server that first implements
`project-directory-storage-policy` defaults absent configuration to app-data
storage, but does not migrate, rewrite, exclude, or delete legacy
`.attachments`, `.yep`, or `refs/yep/*` state during upgrade. Legacy data may
remain readable without permission to refresh or grow it. Older servers lack
the capability and may retain their historical project-write behavior; newer
clients omit the unsupported setting and explain that an update is required to
enforce app-data-only storage.

2026-08-01 `.yep/review-comments.json` version 2 — migrate every valid
version-1 draft, archived comment, and batch into canonical sites, reviewer
entries, active-draft references, and submission summaries before persisting
new submission manifests. Migrated entries use `legacy-missing` rather than a
fabricated current-file capture. The established review-comments endpoint
continues returning its version-1 comments/batches projection for older
clients; only active drafts count toward the 2,000-comment creation limit.

2026-07-31 Source Control action commit counts — add optional
`commitsAdvanced` fields to the existing Pull and Push responses without a new
capability. Released capable servers `v0.6.0`, `v0.6.1`, `v0.6.2`, and
`v0.7.0` omit the field; newer clients preserve the generic success feedback
for those responses and make the same already-capability-gated request. Newer
servers supply exact fast-forward Pull counts and the immediately observed
pre-push ahead count; older clients ignore the additive field.

2026-07-28 blame `authorColorSeed` — add the hue preference as an optional
line field under the existing `git-source-review` capability rather than
expanding that capability or adding a request. Older servers omit it; the
client hashes the author name and runs the same visible-set spacing, so file
content, blame links, and review remain available without protocol probing.

2026-07-27 Claude Gateway `supported_endpoints` omission — treat an explicit
endpoint list as authoritative and omit models with no supported text
endpoint, but retain metadata-less rows for generic gateways and older
`copilot-api` catalogs that predate the extension. The gateway owns its legacy
route and any visible model-specific error; YA never falls through to regular
Claude. Current focused `copilot-api` catalogs preserve endpoint metadata, so
known Responses-only and Messages-capable models do not use this exception.

2026-07-27 `claude-ollama` provider/settings/session identity — retain the
legacy provider during a deprecation grace period and do not auto-migrate
persisted sessions or settings to `claude-gateway`. Hide it from provider
menus only when neither explicit Ollama configuration nor persisted
`claude-ollama` session metadata exists; direct provider lookup remains
available so old sessions can still resume. Existing users receive a
dismissible removal notice directing them to `claude-gateway`.

2026-07-25 previous/custom Claude model settings — persist selections on the
server and advertise one exact transitional capability. A new client hides the
control when an older compatible server lacks that capability, avoiding a
write the old settings parser would silently ignore. A new server's optional
provider metadata is additive for older clients. If a maintained registry item
is later removed, keep an existing saved exact id and label as unlisted/custom
instead of deleting or remapping it. This does not raise
`remoteCompatibilityLevel`.

2026-06-23 `session-metadata.json` — add optional transcript display objects in
schema version 2 while retaining all version-1 session metadata; the additive
migration preserves existing configured state, and interrupted generating
objects recover as errors because their in-memory jobs cannot survive restart.

2026-06-24 `PI_PATH` — rename the pi provider executable override to
`PI_EXECUTABLE` because the value is a full binary path, not a search directory;
keep `PI_PATH` as a startup-normalized legacy alias so existing launches still
resolve the same executable.

2026-07-03 `hasUnread` (REST session rows/detail) — compute unread from the
pre-recap-overlay `updatedAt` instead of the overlaid one, so a recap landing
never flips a fully-seen session unread; reverses the overlaid-freshness
choice in "Tighten recap overlay cursor and freshness handling" because a
YA-synthesized recap is derived viewer content, not new provider activity.

2026-07-04 `clientDefaults.sessionToolbarVisibility` /
`clientDefaults.sessionToolbarPriority` — replaced by a single
`clientDefaults.sessionToolbarPresence` map (`hidden` | narrowing tier) per
explicit direction that the toolbar data model carry no separate visibility
boolean; hiding forgets the prior tier. Stored state is folded in at load on
both sides (`ServerSettingsService.mergeLoadedClientDefaults`; client
localStorage migration in `useSessionToolbarPresence`), but the settings
PUT surface no longer accepts the legacy keys: a stale cached client sending
them gets 400 and logs a console warning until it picks up the new bundle.
Accept-and-translate was deliberately skipped as speculative scaffolding for
a transient skew.

2026-07-05 session-detail REST default / approval audit log — uncursored
`GET /api/projects/:projectId/sessions/:sessionId` now returns a
two-compaction tail unless `fullHistory=1` is explicit, and approval decision
logging now defaults off behind `approvalAuditLogEnabled`. The session-detail
flip is the server-side safety backstop for tactical 055/SPC-007: the current
client source API requires a bound or explicit full-history request and handles
pagination, while stale cached or out-of-repo clients that relied on the old
unbounded default now get a bounded window and must opt in to full history.
The audit-log flip favors privacy/explicit operator intent over implicit
security logging; older clients cannot enable it without the capability-gated
settings surface.

2026-07-10 session-detail turn selectors — `tailTurns` and `tailFrom` narrow
the default or explicitly requested compact-tail scope; they do not replace it.
Only `fullHistory=1` authorizes those selectors to reach across older compact
boundaries. This closes a regression where the client's implicit
`tailTurns=20` safety cap disabled the two-compaction REST default and could
return a full Codex transcript with fewer than twenty user turns.

2026-07-20 process-abort `resumeExemption` response — replace the
`rolloutsRenamed` / `failures` fields with `autoResumeDisabled` / `error` and
stop renaming provider rollout files; the short-lived former contract made an
explicit Kill hide history and prevent deliberate continuation, so preserving
that response shape would preserve the wrong mechanism. YA's co-deployed
client now distinguishes verified shutdown from exemption persistence failure.

2026-07-23 Pi RPC turn completion — use `agent_settled` for Pi 0.80.4 and
newer, but retain `agent_end` for version-probed 0.79.9 through 0.80.3
binaries because they never emit the newer event and would otherwise hang.
Fail startup when `pi --version` is unrecognized rather than guessing a
boundary that could either hang or finalize before retry/compaction completes.

2026-07-25 `clientDefaults.bangCommandsEnabled` — keep the persisted key and
routes but narrow its meaning from "all bang commands" to "the discoverable
!! Commands history surface" (sidebar entry + `GET /api/bang-commands`);
execution, completions, and session-scoped bang routes became always-on under
the vanilla-defaults established-convention carve-out. Key kept because it is
a persisted server setting named in the `bang-commands` capability contract;
older co-deployed clients that still gate the composer on it merely under-use
the server.

2026-08-05 progressive session catalog — gate the client's move from
request-complete session/Inbox enumeration to generation-reusing progressive
snapshots behind a permanent `progressive-session-catalog` capability, rather
than changing the existing responses in place. Permanent because YA is
self-hosted with no forced upgrade, so old servers persist indefinitely and the
gate never becomes removable. The approved obligation is a performance floor,
not a feature floor: an out-of-date client against a current server, and a
current client against an out-of-date server, must still perform basic actions
at some non-optimal performance level, so the ungated path stays a working
enumeration rather than a degraded stub. The server half now exists —
`GET /api/sessions` reports `generation`, accepts `knownGeneration`, and answers
`{ unchanged: true }` on a match — and is additive: an older server ignores the
parameter and returns a full response, so a client without the capability is
safe either way. The client half now sends the token behind the capability;
release corpus audited at that point was `v0.7.0` (2026-07-25), `v0.6.2`
(2026-07-11), and `v0.6.1` (2026-07-10) — no stable release advertises
`progressive-session-catalog`, so every released server takes the enumeration
fallback and receives no `knownGeneration`. No existing capability's meaning
changed. See [Server Capabilities](server-capabilities.md) § Session-catalog
gate.

2026-08-05 `.yepignore` — removed with the project path index's breadth-first
warm. The file was read only to narrow that crawl, so with no crawl it
configures nothing. It is user-authored project-local input, never a YA-written
file, and it never restricted lookup: a path under an excluded directory always
linked when the file existed. A project still holding one is unaffected, since
the index now hydrates only the directory components a displayed candidate
names. See [Project path links](project-path-links.md) § The index.

2026-08-28 `auth.json` browser sessions — version 2 stores a domain-separated
SHA-256 verifier of each high-entropy browser session token instead of the
bearer token itself. On first load of version 1, YA preserves the account,
password hash, enabled state, and localhost-access setting but intentionally
invalidates all browser sessions; users must log in again. This closes the
readable-session-token path from a project-write sandbox without changing the
password or desktop authentication contract.

2026-08-29 project-write session network firewall — add the permanent,
version-implied `session-sandbox-network-firewall` capability rather than
expanding `session-sandboxing`. Current clients require all three sandbox
signals before showing either control and send neither field to older servers.
For older clients and legacy metadata, a missing firewall value defaults on
only when `sandboxLevel` is `project-write`; explicit false stays authoritative,
and true without project-write is rejected. Audited stable releases `v0.7.0`
and `v0.6.2` lack the complete sandbox and firewall contracts.

2026-09-09 `YEP_SQLITE` unset default — initialize built-in SQLite automatically;
the maintainer requires it as normal server storage infrastructure now that
supported runtimes include it. Preserve explicit `off` as a development/recovery
escape hatch, with dependent capabilities unavailable. Learning and other
feature opt-ins remain independent; browsers carry no SQLite opt-in to migrate.

2026-09-16 `settings.claudeGatewayUrl` / `claudeGatewayStartCommand` — keep both
keys readable and writable as the mirror of the default entry in the new
`gatewayServices` list, gated by the `claude-gateway-services` capability.
A client without that capability keeps editing the gateway actually in use, and
an installation upgrading from the single-gateway settings has its configuration
migrated into a `default` entry rather than lost. Audited stable releases
`v0.8.1` and `v0.8.0` have only the single-gateway settings. An absent legacy
value never clears a configured command; an explicit legacy write of an empty
URL removes that one entry.

2026-09-18 `artifactViewer.deleteOnExpiry` removed — the setting, its toggle,
and its status field are gone. It never reached a decision: grant ownership
has only ever come from a request asking for it with `owned`, so no behaviour
changes. `validateArtifactConfig` accepts and drops the field, whatever its
type, so a settings file saved before the removal and a hosted client still
sending it both keep working; the status no longer reports it, and a client
that read it sees the field absent, which it already had to tolerate.

2026-09-26 session metadata `rewindRecords[].droppedThroughMessageId` — add
the transcript's last row at rewind time as an optional record field, and
group a bounded record's rows by file position alone. Records already on disk
lack it and keep the old rule, rows stamped no later than the record's `at`,
because no read of today's transcript can recover which rows existed when
they were made; they keep that rule's clock-skew exposure. The client no
longer computes membership, so no capability gates it: an older client sees
the grouping the server serves and ignores the field.

2026-09-26 `POST /api/artifacts` borrowed-grant reuse — a borrowing request
may now return an existing live grant for the same entry file, with an
additive `reused: true`, rather than a new grant; no capability gates it. Older
servers omit the field and never reuse, so a new client revokes exactly as
before against them. An older client against a new server can still revoke a
reused grant it abandoned mid-request, breaking another viewer's frame of that
file until it reopens; that narrow race was accepted over gating reuse, since
unreused grants exhaust the 256-grant cap for every client. See
[active content security](active-content-security.md).

2026-09-19 persisted session-summary index version 5 — the on-disk shape is
unchanged from 3 and 4; the number now also dates an index's entries, which is
what ends the one-shot Claude empty-summary repair. Versions 3 and 4 are still
accepted and upgraded in place, so no installation rebuilds its indexes on
upgrade. A downgrade to a build predating 5 does rebuild them: an older reader
accepts only 3 and 4 and starts that scope fresh. Indexes are caches, so the
cost is one cold parse per scope, not lost data.

2026-09-25 `POST /api/file-edit/rebuild` approval — `register: true` now also
requires `approved`, the proposal the editor displayed, and registers only when
it equals the artifact's current descriptor. A client from before this change
sends `register` alone and gets 409 instead of an approval, so it can still run
an already-approved hook but cannot approve a new one until it updates. No
fallback is kept: the old request approved whatever command was on disk when it
arrived, which is the defect being closed. A new client against an older server
still works, since the older schema ignores the extra field.
