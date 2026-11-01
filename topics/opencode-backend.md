# OpenCode Backend

> The OpenCode backend is YA's provider integration contract for starting,
> resuming, controlling, and rendering OpenCode sessions without losing
> provider-specific transcript meaning.

Topic: opencode-backend

See also [`pi-provider.md`](pi-provider.md): pi-mono is the other
agnostic-backend candidate, recommended primary with OpenCode as
secondary/fallback (see `../docs/research/opencode-vs-pi-mono-provider-backend-comparison.md`).

See also [`opencode-copilot.md`](opencode-copilot.md): the prioritized plan to
expose GitHub Copilot models through this backend (with a gating baseline review
against the upgraded `opencode` binary) plus the copilot auth UX; it
re-prioritizes the "Gaps To Close" list below around the copilot goal. The "Gaps
To Close" contracts here remain authoritative for the general fleshout detail.

The selected [YA-owned session identity](session-identity.md) follow-up reopens
the session-id split below for new YA-created sessions. It will keep a permanent
YA id and a separate native `ses_*` binding; implementation is pending. Existing
native/public ids stay unchanged. Reader selection, focused watches and resume
must resolve that binding rather than infer OpenCode solely from the public
id's prefix. [Session creation](session-creation.sketches.md) depends on this
ownership boundary.

## Scope

OpenCode is integrated through `opencode serve` plus HTTP and SSE, not through a
Claude-style SDK iterator or the Codex app-server JSON-RPC surface. That makes
the provider useful for local and alternate model backends, but the adapter must
translate more provider-specific concepts itself:

- live SSE events from `packages/server/src/sdk/providers/opencode.ts`;
- durable file or `opencode export` reads in
  `packages/server/src/sessions/opencode-reader.ts`;
- normalized session content in
  `packages/server/src/sessions/normalization.ts`;
- generic YA content block rendering in
  `packages/client/src/components/renderers/`.

### Windows executable discovery

Windows `where opencode` may report both npm's extensionless shim and
`opencode.cmd`. YA parses those as separate candidates and resolves the npm
global layout to `opencode-ai/bin/opencode.exe`, because model discovery uses
`execFile()` and cannot execute either shim. A directly reported `.exe` wins;
POSIX retains the first existing `which` hit. The 2026-08-20 Windows regression
probe used OpenCode 1.18.18, selected the packaged executable, completed the
version probe, and returned the verbose model catalog. Session discovery from
durable storage remains independent of whether the executable is installed.

## Capability Comparison

| Capability | Claude | Codex | OpenCode status |
|---|---|---|---|
| Session startup and resume | SDK `query()` with `resume` and native session files. | App-server `thread/start` / `thread/resume`. | Starts or resumes native `ses_*` sessions through `opencode serve`; YA currently exposes that native ID as the session ID. |
| Initial message | Queued through `MessageQueue`. | Queued through `MessageQueue`. | Queued through `MessageQueue`, then sent as a single OpenCode text part. |
| Global instructions | SDK system prompt append. | Prompt-visible `[Global context]` prefix on first turn. | Same prompt-visible `[Global context]` prefix as Codex, not a native system/config channel. |
| Uploaded file references | Prompt-visible file references are appended by `MessageQueue`; image blocks can also be passed to the Claude SDK. | File references survive as text; image blocks are discarded when Codex extracts text for app-server input. | File references survive as text; base64 image blocks become OpenCode file parts with data URLs. |
| Permission modes | Passed to SDK; YA `canUseTool` mediates approvals. | Maps YA modes to app-server approval/sandbox policy and handles approval requests. | No static YA permission-mode mapping, but `permission.asked` and `question.asked` are bridged through the normal YA approval/question UI. |
| Slash commands | Native SDK command list, with YA `/goal` alias for `/loop` when needed. | YA advertises built-in `/goal`; native command surface is app-server-specific. | `supportsSlashCommands=false`; no advertised command list or `/compact` equivalent in YA. |
| Thinking and effort settings | Passed to SDK and adjustable through `setMaxThinkingTokens`. | Maps YA thinking/effort to Codex reasoning effort. | Per-model OpenCode variants map to YA effort; thinking text is rendered when the upstream provider supplies it. |
| Steering and interrupt | Graceful interrupt exists; provider steering flag is false. | Supports active `turn/steer` and `turn/interrupt`. | No steering hook; graceful interrupt posts to `/session/:id/abort`, while hard abort terminates the per-session server. |
| Model changes | SDK-supported `setModel` and supported-model inventory. | Model inventory from app-server/fallbacks; model/service tier passed at thread and turn start. | Model inventory from `opencode models`, with `local-glm/*` sorted first; no dynamic `setModel` hook. |
| Recaps and prompt suggestions | Recaps plus native prompt suggestions. | Recaps, but not native prompt suggestions. | No recap or prompt-suggestion capability flags. |
| Clone/DAG UI metadata | Client metadata says DAG and cloning are supported. | Client metadata says cloning is supported, linear history. | Client metadata marks both DAG and cloning unsupported. |
| Liveness | SDK/process probes. | App-server thread probes and raw event cadence. | `/session/status`, `session.status`, and `session.idle` are integrated as liveness evidence. |

## Transcript Rendering Coverage: 1.15.13 Baseline

This section records the 2026-06-01 OpenCode 1.15.13 baseline that motivated
the later provider work. It is historical evidence, not the current mapping
contract. The 1.17.9 and 1.18.9 sections below supersede it where the provider
shape or YA behavior changed.

Live stream path observed in `opencode.ts` at that baseline:

| OpenCode SSE shape | YA mapping at the 1.15.13 audit | Gap at that audit |
|---|---|---|
| `message.part.updated` / `message.part.delta` with `type: "text"` | Assistant text, after role filtering through `message.updated`. | Covered for live text; user text parts are intentionally not assistant progress. |
| `type: "reasoning"` | YA `thinking` block. | Covered live, but only when the part is seen through SSE or POST fallback. |
| `type: "tool-use"` | YA `tool_use` block. | Generic block is covered; OpenCode lower-case tool names still miss rich renderer aliases. |
| `type: "tool-result"` | YA `tool_result` block. | Pairing assumes the result part ID is the correct `tool_use_id`; this should be fixture-tested against real OpenCode events. |
| `type: "step-finish"` with tokens | Records one model-step's usage; emits no terminal message. | Cost, reason, and snapshot metadata are not rendered. |
| `type: "step-start"` | Ignored. | Usually metadata, but the ignored count should stay visible in coverage metrics. |
| `session.diff` | Ignored. | File-change summaries are not mapped to read/edit/diff UI. |
| `permission.asked` | Routed through YA approval and replied to through OpenCode's permission endpoint. | Static YA permission modes remain unsupported. |

Durable reader path observed in `normalization.ts` at that baseline:

| OpenCode stored/export shape | YA mapping at the 1.15.13 audit | Gap at that audit |
|---|---|---|
| `type: "text"` | YA `text` block. | Covered. |
| old stored `type: "tool"` with `callID` | YA `tool_use`; completed tools also produce `tool_result`. | Generic block is covered, but lower-case OpenCode tool names fall through to the raw JSON fallback renderer. |
| `type: "reasoning"` | Ignored. | Historical/session reload view drops OpenCode thought blocks instead of rendering YA `thinking`. |
| event-shaped `type: "tool-use"` / `type: "tool-result"` in exports | Ignored. | If newer exports use the live-event part shape, historical tool blocks disappear. |
| `type: "step-finish"` | Ignored as a part. | Message-level token usage is rendered when present, but part-level cost, reason, snapshot, and token metadata are lost. |
| `type: "step-start"` | Ignored. | Usually acceptable metadata; still count it when measuring coverage. |

## Local Export Sample

On 2026-06-01, OpenCode 1.15.13 had eight sessions under this project path. Seven
exported as parseable JSON; one older export was malformed or truncated. Across
the seven readable exports:

| Part type | Count | Durable block coverage today |
|---|---:|---:|
| `text` | 17 | 17 |
| `reasoning` | 9 | 0 |
| `step-start` | 9 | 0 |
| `step-finish` | 8 | 0 |
| `tool` | 5 | 5 generic tool blocks |

If every part is counted, the durable reader maps 22 of 48 parts to visible YA
blocks. If `step-start` and `step-finish` are treated as metadata rather than
content/action/thought blocks, the durable reader maps 22 of 31 semantically
visible parts. The missing visible parts in that sample are all nine
`reasoning` parts.

The five sampled tool parts used OpenCode tool names `bash` and `task`. YA's
tool renderer registry has rich renderers for `Bash` and `Task`, and aliases for
some Codex/OpenAI names, but not these lower-case OpenCode names. So those five
parts become generic `tool_use` / `tool_result` blocks, but do not get the rich
Bash/Task presentation yet.

These counts are local evidence, not a product-wide statistic. A real regression
test should record fixture exports and SSE events, count OpenCode part/event
types, and report both raw coverage and coverage after excluding deliberate
metadata-only parts.

## 1.17.9 implementation status (2026-06-21)

A provider review against opencode 1.17.9 (the prior tables were sampled vs
1.15.13) closed most rendering/interaction gaps. See
[`opencode-copilot.md`](opencode-copilot.md) for the review plan and the full
element list. Key shape correction and closures:

- **Unified tool part.** 1.16+ streams a tool as a single `type:"tool"` part
  (`callID` + nested `state.{status,input,output,error}`), confirmed via a live
  `/event` capture — *not* the split `tool-use`/`tool-result` parts the live
  baseline tables above describe. The live path had no case for it, so live
  tool calls were invisible; now handled (emit tool_use when underway,
  tool_result when settled, deduped by callID). New part types seen: `patch`
  (snapshot) and `compaction` (marker), both treated as metadata.
- **Tool name + field normalization** (`opencode-tools.ts`): lower-case names →
  YA canonical (`bash`→`Bash`, …) and fields → Claude shape
  (`filePath`→`file_path`, `oldString`→`old_string`, grep `include`→`glob`, …),
  applied live + durable. Unknown tools stay explicit.
- **Durable reasoning** → thinking (was dropped on reload). Failed tools now also
  emit a tool_result (error text was dropped).
- **Interactive bridge**: `permission.asked` → YA approval → `POST
  /permission/{id}/reply` (capture-verified the gated tool resumes);
  `question.asked` (interview) → YA AskUserQuestion → `POST /question/{id}/reply`.
  opencode decides whether to ask per its own config; YA answers when asked.
- **Background bash**: opencode's bash tool is foreground-only (`command`,
  `description`, `timeout`); background is a separate `/pty/shells` feature the
  agent doesn't use as a tool — nothing to map.

## 1.18.9 action-vocabulary refresh (2026-07-29)

OpenCode 1.18.9 (official tag `v1.18.9`,
`4da7bb227ac0259168bd8af7f7d99f21c9e0a03a`) was exercised through YA with
`github-copilot/claude-haiku-4.5` in a disposable project. The audit compared
official source, raw SSE, the message POST/export, live YA messages, the
SQLite-backed durable reader, and rendered desktop/phone conversations.

**Turn boundary.** A current OpenCode turn can contain many
`step-start`/model/tool/`step-finish` cycles. `step-finish` ends one model step;
it does not mean the user's turn is idle. The coverage trace contained 23
assistant steps and exactly one `session.idle`. YA therefore retains the latest
usage for each `step-finish` part ID, emits no result for those parts, and emits
one terminal YA `result` after the matching `session.idle`, with aggregate
input/output/cache-read/cache-write usage. This is load-bearing for queue
semantics: treating each step as terminal lets a queued user turn enter while
OpenCode is still executing the previous one.

**Current tool vocabulary.** The live Copilot run exercised `todowrite`,
directory `read`, `glob`, `grep`, text/image `read`, `write`, `edit`, `bash`,
`webfetch`, and `question`; all reached the corresponding canonical YA
renderers. The 1.18.9 registry also contains `websearch` and `apply_patch`.
YA maps those to `WebSearch` and `Edit`; `patchText` is preserved as the
canonical raw-patch fields so the existing edit renderer can parse it. The
Copilot-backed run did not execute `websearch` because that OpenCode provider
configuration did not expose a usable search backend. `skill`, experimental
LSP/plan/code-mode, invalid, custom, and MCP tools stay explicit raw fallbacks
unless a semantically equivalent YA renderer exists.

**Image-result contract.** A completed image `read` stores a `state.attachments`
file entry with `mime` and a base64 data URL. Both streaming and stored-part
schemas must retain that field. Live and durable normalization convert an image
attachment to YA's structured image result; durable tool results are emitted
as separate user messages so each result keeps its own `callID` and media when
an assistant message contains multiple tools. The media materializer removes
the data URL/base64 from the response and stores the image. The live and
reloaded coverage sessions each retained the same 6,071-byte, 192×192 PNG and
rendered the standard `Read … (image)` row at desktop and phone widths.

## Durable Storage Format: SQLite (1.16+), legacy JSON tree dead

**The break.** OpenCode 1.16+ (confirmed on 1.17.9) persists sessions in a
SQLite database at `~/.local/share/opencode/opencode.db` (WAL mode: also
`-wal`/`-shm` sidecars). The legacy JSON file tree
`~/.local/share/opencode/storage/{session,message,part}/…` that
`opencode-reader.ts` was built against is **frozen** — on this machine the
newest `storage/message/<ses>/` dir is from Feb 26, while live sessions only
exist in the DB. So the reader's primary path (`getFileSessionSummary`,
`loadSessionMessages`, `loadMessageParts`) finds nothing for any current
session: `messageCount: 0`, and **reload / attach-to-unowned shows no content,
not even the user turn.** For a TUI- or externally-owned session the reader is
the only source, so it renders empty — distinct from a YA-owned live session,
which still streams via SSE while the process runs.

**Why the `opencode export` fallback also fails.** `loadCliExport` shells
`opencode export <id>` through `execFile`, which captures stdout via a **pipe**.
`opencode` is a Bun binary, and Bun drops buffered piped stdout on
`process.exit()` once it exceeds the kernel pipe buffer — the document is
truncated mid-string and `JSON.parse` throws, so the reader returns null.
Redirecting the child's stdout to a regular **file** fd returns the whole
document. Measured on a ~430 KB session (`ses_11777a2c…`, a `/harsh-review` with
large tool outputs):

| Capture | Bytes | Valid JSON |
|---|---:|---|
| `execFile` → pipe (current YA path) | 146,093 | no (unterminated string) |
| `spawn` → file fd / shell `>file` | 429,953 | yes (23 messages) |

This is the same failure the 2026-06-01 sample above recorded as "one older
export was malformed or truncated"; it is size-dependent, so small sessions
reload fine and large ones blank out — matching the intermittent behavior.

**Correct durable source: read the DB directly.** Schema (relevant columns):

```
project(id TEXT pk, worktree TEXT, …)
session(id TEXT pk, project_id TEXT, directory, title, model, metadata,
        time_created, time_updated, cost, tokens_input/output/reasoning/
        cache_read/cache_write)
message(id TEXT pk, session_id TEXT, time_created, time_updated, data TEXT)
part(id TEXT pk, message_id TEXT, session_id TEXT, time_created, data TEXT)
  -- INDEX part_session_idx(session_id), session_project_idx(project_id)
```

`message.data` is the JSON message `info` object (role, time, model, tokens,
variant); `part.data` is the JSON part (`type` ∈ {text, reasoning, tool,
step-start, step-finish, patch, compaction}, with the unified `tool` shape
`{callID, state:{status,input,output,error}}`). Mapping is mechanical:

- worktree path → `project.id` (the same opaque hash YA already derives, e.g.
  `8e8fab…` for this repo) → `session` rows by `project_id`.
- per session, `message` rows ordered by `id` (ULID, chronological) or
  `time_created`; per message, `part` rows likewise. `part.id`/`message.id` are
  the same ULIDs used as the old tree's filenames, so ordering is preserved.

Critically, the rows deserialize into exactly the `{ message, parts }`
(`OpenCodeSessionEntry`) shape the file path already produces, so
`normalization.ts` and the renderer path need **no change** — only the source
of the entries moves from files to SQLite.

**Invariants for a DB reader.** Open **read-only** (`mode=ro` / `PRAGMA
query_only=ON`), never write; tolerate the concurrent `opencode serve` writer
(WAL allows concurrent readers); the YA session id stays the native `ses_*`
(Provider Session Identity). Degrade gracefully when the DB is absent or
pre-1.16: fall back to CLI export (captured via a **file fd**, not a pipe), then
to the legacy file tree. Do not delete the file-tree path — older installs and
already-migrated transcripts still use it.

### Direct SQLite reader (Gap #11) — LANDED 2026-06-21

`OpenCodeDbReader` (`packages/server/src/sessions/opencode-db-reader.ts`) reads
transcripts straight from `opencode.db` and is wired as the **first** durable
source in `OpenCodeSessionReader` (`getSession`, `getSessionSummary`,
`getSessionSummaryIfChanged`, `listSessions`, `listSessionFiles`). The plan
below is the as-built contract; a few choices deviate from the original draft
and are flagged inline.

**Mechanism chosen: `node:sqlite`, not `better-sqlite3`** (the draft's primary).
The published `yepanywhere` package copies `packages/server` dependencies
verbatim (`scripts/build-bundle.ts`) and advertises zero external deps, so
`better-sqlite3` would force a native build on every install plus the host's
GLIBCXX friction. The DB reader is an *optimization with a working fallback*, so
a dependency-free builtin fits better. It is loaded via `createRequire("node:sqlite")`
(not a static/dynamic `import`): that degrades to null on Node < 22.5 (the main server now requires the
[Node 22/Bun floor](server-runtime.md)) instead of crashing at module load, and sidesteps vitest's module runner,
which can't transform this newer-than-vite builtin. On old runtimes the reader
returns null and the export/file-tree fallbacks run exactly as before. One-time
`ExperimentalWarning` on first use is left intact (reliable suppression needs a
global `emitWarning` override that risks swallowing other warnings).

**Fallback order: DB → file tree → export** (draft said DB → export → file tree).
Putting the subprocess *last* keeps even pre-1.16 file-storage installs from
spawning `opencode export` when a local read suffices; the DB still covers all
1.16+ sessions first, so the "no child process on reload" acceptance holds.

**Enumeration gates the CLI on DB absence.** `listSessions` / `listSessionFiles`
enumerate from the `session` table when the DB has this worktree's project, and
only fall back to `opencode session list` when it does not (pre-1.16 / no DB) —
the CLI reads the same store in 1.16+, so unioning it would just re-spawn the
subprocess for rows the DB already returned. Rows with `session.parent_id`
(legacy file-tree `parentID`) are OpenCode task/subagent children: they are
omitted from those top-level lists and exposed through
`listProviderChildSessions` instead. See
[provider-child-sessions.md](provider-child-sessions.md).

**Global opt-out: `OPENCODE_DB_READER` (default on).** Set it to `0`/`false`/
`off`/`no` and the reader never opens the DB and never imports `node:sqlite` —
every OpenCode session path falls back to CLI export / file tree, exactly as
before the reader existed. The check sits at the single `ensureDb` choke point,
so the whole sqlite dependency is conditional and switchable per environment.
This keeps the builtin off any path that does not want it.

**Detail route had to be taught the `ses_*` shape, not just metadata.** The
reader is necessary but not sufficient: the session-detail route
(`GET …/sessions/:sessionId` in `routes/sessions.ts`) hand-rolls its own
provider cascade (separate from `findSessionSummaryAcrossProviders`) and
originally consulted the OpenCode reader only when YA's *own* session metadata
already labeled the session `opencode`. A TUI-/externally-owned 1.16+ session
has no such metadata, so it 404'd even though the reader could load it. Fixed by
also consulting the OpenCode reader whenever the id has OpenCode's native `ses_*`
shape; the shape gate keeps non-opencode UUIDs from triggering a wasted
`opencode export`. (Latent follow-up: the detail route still diverges from the
summary/list path's `getSessionSources` resolution and could gap again for other
providers.)

**CI runs at the Node 22.16 floor and exercises the reader.** Previously the
Node 20 lane skipped the builtin tests after an older Node-24 CI run hung.
The runtime cutover restores builtin coverage with the existing bounded CI job
timeout. No reader fallback or opt-out was removed by raising the server floor.

**Evaluation (live `opencode.db`, this repo's project, 2026-06-21).** Reading the
430 KB `/harsh-review` session (`ses_11777a2c…`, 23 messages) via the DB reader:
**3.8 ms, no subprocess**; the 145-message `ses_117763878…`: 7.3 ms. The
equivalent `opencode export` subprocess for the 430 KB session: **1.19 s wall,
259 MB RSS** (Bun-binary startup) — ~300× slower and the path that needed the
file-fd capture fix to avoid mid-string truncation. Model prefix, context-usage
%, and full tool transcripts all matched the export path. The DB is the
correct durable source of truth.

**Tail-type watch — verdict.** Keeping an open mind on "is there a use case for
tailing opencode instead": for *durable/historical* content, no — the DB is
strictly safer (canonical committed state, read-only WAL snapshot, no subprocess,
no truncation) than tailing `opencode export`/stdout, which inherits every cost
the DB removes. The live SSE `/event` stream is **not** replaced: it remains the
source for a YA-*owned*, actively-streaming session because it carries sub-part
text deltas and interactive permission/question prompts that the DB only sees at
per-part commit granularity, after the fact. The one genuinely new use the DB
unlocks is a **DB poll/watch for externally- or TUI-owned sessions YA is not
streaming** — `getSessionSummaryIfChanged` (row `time_updated` + message count)
plus a paged `getSession(afterMessageId)` already make near-live "monitoring" of
an unowned session cheap (single-digit ms per poll), where there is no SSE to
tail at all. That is a poll over the DB, not a tail of opencode; it is a
worthwhile follow-up, not part of this reader.

#### Original implementation plan (as-built unless flagged above)

Goal: make `OpenCodeSessionReader` read transcripts straight from `opencode.db`
so reload/attach no longer spawns an `opencode export` subprocess per call.
This removes the truncation-prone shell-out from the hot path (it stays only as
a fallback) and makes externally/TUI-owned 1.16+ sessions render on reload.

**Mechanism.** Use `better-sqlite3` (already a dependency in `packages/relay`;
add it to `packages/server`), opened **read-only** with `fileMustExist: true`.
It is synchronous, WAL-friendly, and the team already uses it. Alternative with
no native dep: Node 24's built-in `node:sqlite` (`DatabaseSync`, readonly) — keep
as a fallback option if adding a native build to the server is undesirable. Do
not write, checkpoint, or `PRAGMA` anything that mutates; concurrent
`opencode serve` writers are safe for read-only WAL readers.

**Shape.** Add an internal `OpenCodeDbReader` (own file) exposing, per session:
a summary (title/model/createdAt/updatedAt/tokens) and
`OpenCodeSessionEntry[]` (`{ message, parts }`), identical to what the file and
export paths return — so `normalization.ts` and the renderer need no change.
`OpenCodeSessionReader` calls it as the **first** durable source, then falls
back in order to: CLI export (file-fd capture), then the legacy file tree.

**Queries** (all parameterized; `data` columns are JSON — `JSON.parse` then feed
the existing `asOpenCodeMessage` / `asOpenCodeStoredPart` validators):

- project id: `SELECT id FROM project WHERE worktree = ?` (cache like
  `openCodeProjectIdCache`).
- summary: `SELECT * FROM session WHERE id = ? AND project_id = ?` (enforces
  project scoping the way `exportBelongsToProject` does today).
- messages: `SELECT id, data FROM message WHERE session_id = ? ORDER BY id`
  (ULID id is chronological; `time_created` is a tiebreaker), honoring
  `afterMessageId` by slicing after that id.
- parts: `SELECT id, data FROM part WHERE message_id = ? ORDER BY id`, or one
  `WHERE session_id = ? ORDER BY message_id, id` join to avoid N+1.
- model: canonicalize to `providerID/modelID` via the same helper the file path
  uses (`session.model` JSON also carries both).

**Edge cases / contracts.**

- DB absent, unreadable, locked, or pre-1.16 schema (missing `message`/`part`
  tables) → return null and fall through to export/file-tree. Never throw out
  of the reader.
- Handle caching: open lazily and cache the read-only handle keyed by db path;
  re-stat `opencode.db` mtime to decide when a re-read is needed. A single
  shared handle is fine (WAL readers don't block the writer).
- Change detection: `getSessionSummaryIfChanged` should compare the session
  row's `time_updated` (and a message-count) rather than only the db-file
  mtime, since every session shares one db file (coarse mtime over-triggers).
  The index side of this contract (the `sharedFilePath` enumeration flag and
  the terminal "unchanged" rule that keeps validation off the CLI) lives in
  [`session-index-validation.md`](session-index-validation.md).
- Enumeration: `listSessions` / `listSessionFiles` should prefer DB rows
  (`SELECT id, time_updated FROM session WHERE project_id = ?`) over the CLI
  `session list`, keeping the CLI only as the legacy fallback.
- `getSessionFilePath` already returns the db path; keep it as the index anchor.

**Testing.** Build a temp `opencode.db` with `better-sqlite3` in the test
(create `project`/`session`/`message`/`part`, insert JSON rows), then assert:
parity with the export path for the same logical session; `afterMessageId`
paging; empty-`reasoning` skipped; `providerID/modelID` preserved; large
transcript intact; and graceful null when tables/rows are missing.

**Acceptance.** Reloading or attaching to a TUI-owned 1.17.x session shows the
full transcript with **no** `opencode` child process spawned (verify via
process inspection); export/file-tree fallbacks still cover old installs; no
change to any REST/WS payload shape or the YA-visible `ses_*` id.

## Thinking text is provider-dependent (empty for Copilot-proxied Claude)

"No thinking shown" is often not a YA defect. opencode stores a `reasoning`
part per step, but its `text` can be empty when the upstream API does not expose
chain-of-thought. Measured on `ses_11777a2c…` (github-copilot/claude-opus-4.8):
all 19 `reasoning` parts have zero-length text in the SQLite source, the CLI
export, and the live API — GitHub Copilot's Claude proxy returns reasoning
timing markers without thought text. YA correctly skips empty reasoning parts
rather than rendering blank thinking blocks, so the transcript shows tool calls
and final text but no thinking — unlike claude.ai for the same model. Before
treating missing thinking as a normalization bug, check `part.data.$.text`
length at the source.

Independently, the client gate matters: `effectiveShowThinking` resolves the
"default" Show-thinking preference to **off** for every provider except Codex
(`packages/client/src/lib/showThinking.ts`), so opencode thinking is hidden
unless the user sets the toggle to "on". That preference is browser-local under
`yep-anywhere-show-thinking` (`BROWSER_LOCAL_KEYS.showThinking`), so it survives
reloads in the same browser profile; there is no client install-id scoping or
async `/api/server-info` dependency in the settings path.

## Live reply streaming and the unfinished durable row

OpenCode writes an assistant row to `opencode.db` when a step starts and fills
it in place until it records `time.completed`. YA's other transcripts append
immutable rows, and the client relies on that: a durable row wins over a live
row with the same id, and catch-up reads only rows after the last known id.
Issue #115 was the result: a view opened mid-turn held the partial row, dropped
the live reply, and never re-read the completed row until a reload.

- The prompt `POST /session/:id/message` resolves only after the turn ends, so
  the adapter drains `/event` concurrently with it. The POST body is still the
  fallback reply when the event stream carries no assistant content.
- Live output republishes each assistant message's reasoning and text so far
  under the durable message id, marked `_isStreaming` (the Codex item
  pattern). It commits once, when `message.updated` reports `time.completed`,
  or at `session.idle` as a backstop. Committing when every part seen so far has
  ended is wrong: that is also true between parts, and the commit's delayed
  augmented copy then overwrites newer streamed text.
- While YA's own process is mid-turn (`in-turn` or `waiting-input`), detail
  reads omit a trailing assistant row without `time.completed`. The stream owns
  that row, and the catch-up cursor stays before it so the completed row is
  returned after idle. Other readers keep it: a killed `opencode serve` never
  completes its row, and its partial output must stay visible.

Reproduce with a scripted OpenAI-compatible server as an OpenCode custom
provider (`npm: "@ai-sdk/openai-compatible"`, `options.baseURL`), with
`OPENCODE_CONFIG` and isolated `XDG_*` directories so no account or model is
needed. Pause between reasoning and text, and open the session during the
pause. Use a git repository as the project: see
[the global-project gap](../gaps/opencode-non-git-sessions-unreadable.md).

## Gaps To Close

Status tags added 2026-06-21 (DONE = landed in that review). These statuses and
the later 1.18.9 refresh govern current behavior; the explicitly dated
1.15.13 tables above remain only as the baseline that exposed the gaps.

1. **DONE.** Durable reasoning: stored `reasoning` parts now map to YA `thinking`
   blocks (with a unit test); empty timing-only parts are skipped.
2. **DONE.** Durable + live event-shape parity: the unified `type:"tool"` part
   (with `state`) is handled in both the live provider and the durable
   normalizer; legacy split `tool-use`/`tool-result` kept for older servers.
3. **DONE.** Tool name aliases: `opencode-tools.ts` maps names + input fields to
   YA's rich renderers; unknown tools stay explicit.
4. **DONE.** Tool result pairing: both paths pair by `callID`.
5. **DONE.** Permission bridge: `permission.asked` → YA approval →
   `POST /permission/:id/reply` (capture-verified). Plus `question.asked` →
   AskUserQuestion → `POST /question/:id/reply`.
6. **Open.** Native command inventory: OpenCode exposes `GET /command`;
   `supportedCommands` is still unpopulated.
7. **DONE.** Thinking/effort options: opencode exposes per-model reasoning effort
   via model `variants` (low/medium/high/xhigh/max) + the message `variant` field;
   `getAvailableModels` advertises `supportsEffort`/`supportedEffortLevels` and
   dispatch sends `variant=effort`. (Earlier "no surface" assessment was wrong.)
8. **Partly DONE.** Multimodal input: base64 image content blocks are now sent as
   OpenCode `FilePartInput` (data-URL); prompt-visible uploaded-file references
   remain independent of physical attachment location.
9. **DONE.** Graceful control: `interrupt()` POSTs `/session/:id/abort` (stop the
   turn, keep the server) alongside the SIGTERM `abort()`. Steer still absent.
10. **Open.** Session ID split: YA still exposes the native `ses_*` as the YA
    session id.
11. **DONE.** Durable storage moved to SQLite (`opencode.db`); `OpenCodeDbReader`
    reads it directly as the first durable source, so reload/attach to a 1.16+
    (incl. TUI/externally-owned) session renders the full transcript with no
    subprocess. Export (file-fd) + file-tree remain fallbacks for old installs /
    Node < 22.5. See *Direct SQLite reader (Gap #11)*.

## Verification Shape

OpenCode backend changes should be checked against both live and durable paths:

- live SSE fixture: text deltas, final updates, reasoning, tool use/result,
  repeated and distinct `step-finish` usage, one `session.idle` terminal
  boundary, and role-filtered user parts;
- durable export fixture: old stored `tool`, live-style `tool-use` /
  `tool-result`, `reasoning`, image attachments, `step-finish` usage, and
  lower-case tool names;
- UI renderer fixture or client test: OpenCode `bash` and `task` aliases either
  reach rich renderers or intentionally fall back with clear raw display; image
  tool results render after both live streaming and durable reload;
- liveness fixture: `/session/status`, `session.status`, `session.idle`, and
  malformed/missing entries still follow `topics/session-liveness.md`.
