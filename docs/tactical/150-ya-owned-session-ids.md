# Required SQLite and YA-owned session ids

Topic: optional-sqlite

Status: stage 1 (steps 1–2) implemented 2026-10-11. Stage 2: step 3 passed
and step 4 implemented and verified 2026-10-11; step 8's goal shipped
separately (below). Steps 5–7 were deferred 2026-10-11. On 2026-11-01 the
maintainer reopened the new-session identity/lifecycle boundary for reliable
creation; see [the selected follow-up](#november-1-selected-follow-up).
The full fork/clone migration remains deferred; no new runtime work is claimed.
Referenced from the [roadmap](../roadmap/README.md) "Node 22 and built-in
SQLite" row.

## Objective

Give every session a durable YA record that exists before any provider call,
so per-session facts such as a router pin, executor, sandbox and launch
settings are attached when the session is created instead of after the
provider reports an id. Do it in two stages that each delete a code path
rather than adding a branch beside one:

1. **Required SQLite.** Session metadata moves from `session-metadata.json`
   into SQLite, and the server refuses to start without a working database.
2. **YA-owned session ids.** YA mints a new session's id before launching the
   provider and stores the provider-native id beside it, retiring the
   provisional-id rename machinery.

## Motivation

Cloning a session pinned by the [Agent Auth Router](../../topics/agent-auth-router.md)
failed with a 500: the session menu's Clone posted `/fork`, and
`Supervisor.forkSession` threw a plain `Error` for routed sessions. The refusal
is deliberate: inheriting a pin on fork and clone is deferred as step 3 of
[plan 143](143-agent-auth-router-integration.md). Since 2026-10-11 every
successor route of a routed session (fork, clone, fork-summary, restart,
stale-handoff, retitle) returns 409 before doing any work, and the client
shows those actions as unavailable or hides them; see
[the router topic](../../topics/agent-auth-router.md#supported-slice-and-limits).
The same review found restart/handoff had not been refused at all and would
have run its replacement on the owner's direct login.

Inheritance is hard because of how YA identifies sessions. The session id is
the provider's transcript id, and per-session facts are metadata keyed by that
id. A clone's id exists only after the provider has forked. So a forked
transcript exists before its pin is written, and if that write fails or YA
crashes in between, the clone resumes on the user's normal provider login.
Codex makes it worse: `thread/fork` starts an app-server process that needs
credentials before the child id exists.

New sessions hit the same problem today and work around it with a provisional
id. Launch uses a temporary id, and when the provider reports the real one
(`Process.ts:5161-5186`), `session-id-changed` triggers renames across the
server:

- `SessionMetadataService.remapSessionId` (`metadata/SessionMetadataService.ts:1066`),
  also called directly for routed launches (`Supervisor.ts:2689`)
- `RecentsService.remapSession` (`recents/RecentsService.ts:149`)
- `ReviewCommentService.remapSubmissionSession` (`review/ReviewCommentService.ts:662`)
- `IssueIndexer.remap` and `IssueStore.remap` through
  `Supervisor.observeSessionIdRemaps` (`Supervisor.ts:742`, `app.ts:2916`)
- the `session-id-remapped` bus event (`Supervisor.ts:5895`, `watcher/EventBus.ts:73`)
  and its handlers in `app.ts:3218`, `server-main.ts:654`,
  `services/RetainedSessionCollections.ts:58` and `auth/activityEventAccess.ts:87`
- the `session-id-changed` push to clients (`subscriptions.ts:522`)

`tempSessionId` alone appears 20 times in `Supervisor.ts`.

T3 Code has no such machinery because its thread record, with its provider
instance, is created first, and the provider's session id is stored on it as a
resume cursor. Its October fork design (`ThreadForkService`) commits the child
thread, identity included, before any provider work, then runs the native fork
inside the child's own session. See
[the T3 remote-sessions review](../competitive/t3code-remote-sessions.md) for
the broader comparison.

[DEVELOPMENT.md § Provider Session Identity](../../DEVELOPMENT.md#provider-session-identity)
already makes the YA URL id canonical and lets provider-native ids be stored
separately; OpenCode `ses_*` ids already work that way. This plan applies the
same rule to Claude and Codex.

## Decisions

Approved by the maintainer on 2026-10-11:

- **No downgrade support.** After stage 1, an older YA build cannot be expected
  to read current session metadata. No dual-write of `session-metadata.json`.
- **SQLite is required.** If the database cannot open, the server does not
  start. No JSON fallback and no degraded mode.
- **No network-filesystem data directory.** A data directory on NFS or another
  network filesystem is a startup refusal telling the operator to move the
  data directory to local disk with `YEP_DATA_DIR`. There is no override.
- **Two servers sharing one data directory stays unsupported.** SQLite locking
  prevents corruption; nothing else is promised.
- **Provider-host late renames are out of scope.** A worker started by an older
  server that reports a rename after an upgrade need not be handled.
- **Hosted-client compatibility costs only a delayed deletion.** The client's
  rename handlers are passive listeners, so they stay unchanged through the
  [core compatibility horizon](../../topics/server-capabilities.md#minimum-compatibility-horizons)
  for older servers and are then deleted. No new client branches.

## Design

Every session has one row: a YA id, the provider, and a native id, plus the
metadata `session-metadata.json` holds today. Existing sessions, and sessions
YA discovers from a provider CLI, have a YA id equal to their native id. New
YA-created sessions get a YA id minted before launch.

There is one code path for both. Nothing branches on whether a session is old
or new:

- **Claude** receives the minted id through the Agent SDK's `sessionId` option,
  so the native id equals the YA id for new sessions too. The same option names
  a fork's child when combined with `resume` and `forkSession`.
- **Codex** cannot take a caller-chosen thread id: neither `ThreadStartParams`
  nor `ThreadForkParams` has a field for one. Its thread id is written to the
  native-id column when it arrives. Codex lookups always go through that column,
  even for sessions whose ids are equal.

Translation lives at two boundaries only:

- **Inbound.** Scanners, watchers, rollout paths and provider responses carry
  native ids. They resolve the YA id through an indexed native-id lookup,
  defaulting to the native id when no row exists.
- **Outbound.** Resume, transcript reads and the CLI resume command shown in the
  UI use the native id from the row.

URLs, metadata, REST and WebSocket payloads, and agent-facing ids such as
`AGENTCTL_SESSION_ID` use the YA id.

## Required SQLite

### 1 — make SQLite required at startup

- **Startup.** Always open the discovery database. Exit with an actionable
  error if it is missing, locked, fails migration or sits on a network
  filesystem.
- **Remove the modes.** Drop `YEP_SQLITE` and its `off`, `auto` and `on`
  modes, along with the NFS "skip storage but keep running" path in
  `storage/discovery-sqlite.ts`. Keep the filesystem classification, now used
  only to refuse.
- **Remove the null-database branches** in app wiring: `draftDatabase`
  (`app.ts:810`), `issueDatabase` (`app.ts:2868`), and the
  `getStatus().state === "ready"` guard on learned vocabulary (`app.ts:2984`).
- **Tests and scripts.** Update `scripts/test-sqlite-startup.mjs`,
  `scripts/test-discovery-sqlite.mjs`, `packages/server/test/config.test.ts`,
  the hermetic env list in `packages/server/test/setup/config-env-vars.ts`, and
  the desktop launcher, which passed `YEP_SQLITE` to the server.
- **Version metadata.** The server keeps reporting `sqlite` status in its
  version metadata, now always `ready`. Clients keep their `disabled`, `error`
  and `unsupported` handling (`SpeechSettings.tsx:355`,
  `StorageFilesystemBanner.tsx`) for older servers until the horizon passes.
- **Contracts.** Rewrite the startup policy and data directory placement in
  [`topics/required-sqlite.md`](../../topics/required-sqlite.md) as
  requirements, and update the "Node 22 and built-in SQLite" roadmap row.

### 2 — move session metadata into a session table

- **Table.** Migration 10 creates `session_metadata`: one row per session
  keyed by session id, holding the metadata object as JSON, so it covers
  every field `SessionMetadataService` persists, including display objects
  and `routerBinding`. Identity columns (provider, native id and their index)
  arrive with stage 2, which first needs them.
- **Import.** `SessionMetadataService.initialize()` imports
  `session-metadata.json` once, in its own transaction with the import marker,
  after migration 10 has committed. An unreadable file records no marker, so a
  repaired file is imported on the next start. Leave the file untouched on disk
  for manual recovery; never write it again.
- **Access.** Make `SessionMetadataService` read and write the table, using
  prepared statements reused per the
  [runtime-portable SQLite](../../topics/required-sqlite.md#runtime-portable-sqlite)
  rules. No transaction per session when importing or sweeping.
- **Contract.** Record the decision in
  [`topics/backward-compat.md`](../../topics/backward-compat.md): no downgrade,
  JSON retained but unread. This is the schema, migration, rollback and
  recovery contract that
  [plan 123](123-node-22-builtin-sqlite-cutover.md) requires before a JSON
  store moves into SQLite.

This stage stands alone and can ship before stage 2 starts.

## YA-owned session ids

### November 1 selected follow-up

The maintainer selected a permanent YA session record/id created before the
provider call, with retained startup progress/failure even when no native
session or transcript exists. This is now the foundation for
[session creation and navigation](../../topics/session-creation.sketches.md).
[Session identity](../../topics/session-identity.md) owns the selected behavior,
existing-data rules and November 1 client/server compatibility research.

This supersedes the October deferral only for new-session ownership and native
binding work needed by that feature. Use steps 5–7 below as historical design
input, not a fully reapproved implementation plan.
[Plan 171](171-durable-session-identity-and-creation.md) now defines the proposed
slices and independent review/commit loop. Its implementation must include
durable payload/attempt state, transcript-less catalog/detail reads, duplicate
discovery prevention and old-client refresh behavior. A native-id column alone
does not complete it. Keep existing public ids stable; do not require a bulk
provider-history migration or the complete fork/clone redesign.

The October no-downgrade/storage decisions remain. Refresh the release audit
and settle schema, retention, native binding scope and API/capability choices
before runtime changes. The [roadmap](../roadmap/README.md) records priority;
the archived general session-core refactor remains paused.

### 3 — prove the caller-chosen Claude session id

Before any production change, verify against the pinned Agent SDK:

- A new session started with `sessionId` writes its transcript under that id.
- It resumes normally after a full YA restart and from the CLI.
- It behaves identically under a remote executor, a project-write sandbox, and
  routed launches.
- `query({ resume, forkSession: true, sessionId })` produces a child under the
  given id with the same prefix behavior as the standalone `forkSession()`.

If any check fails, stop and revise this plan before step 4.

**Result (2026-10-11).** `packages/server/scripts/probe-claude-session-id.ts`
passed all 12 checks against SDK 0.3.296 and CLI 2.1.291 in a throwaway
`CLAUDE_CONFIG_DIR`: new sessions, fresh-process resume, CLI resume, launch
forks under a chosen child id, sliced launch forks through `resumeSessionAt`,
and refusal of an id already in use or of `sessionId` with `resume` but no
`forkSession`. Two findings shape step 6:

- A launch fork keeps the parent's message uuids; the standalone
  `forkSession()` remaps all of them. Anything that keys by message uuid across
  sessions must expect shared uuids from launch forks.
- A launch fork writes nothing until it sends a turn. Clone sends none, so
  turnless clones keep using the standalone `forkSession()`, whose random id
  YA cannot choose. Under stage 2 a Claude clone therefore has a native id
  different from its YA id, as Codex sessions do, and needs the native-id
  column from step 5. Forks that send a turn can use the launch fork.

### 4 — mint ids first for new Claude sessions

- **Launch.** Mint the id, write the row with launch facts (provider, model
  settings, executor, sandbox, router pin), then launch with `sessionId`.
- **Router.** `AgentAuthRouter.launch` allocates under the final id. The
  routed-launch remap at `Supervisor.ts:2689` is deleted.
- **Process.** For these launches, `Process` no longer changes its session id.
  An id reported by the provider that differs from the minted one is an error,
  not a rename.

**Implemented 2026-10-11** as a `newSessionId` launch option that Supervisor
sets to its minted id for every new session and that the Claude provider
passes as `sessionId`. The rename path stays for providers that ignore it;
turning a mismatch into an error waits until Codex (step 5) no longer renames.
`packages/server/scripts/probe-ya-session-id.mjs` ran the built server on a
throwaway profile with Haiku turns:

| Variant | Result |
| --- | --- |
| Local | 6/6: one id from start through restart, resume, CLI resume and Clone; no remap logged |
| Agent Auth Router pool | 5/5: same, with the binding on the minted id; routed Clone still refused (step 8) |
| Remote executor (loopback SSH, remote CLI 2.1.236) | 5/5 after working around two sync gaps, below |
| Project-write sandbox | Not run: the host sandbox is Linux-only |

The executor run exposed two sync defects, recorded as
`gaps/remote-executor-sync-needs-gnu-rsync.md` and
`gaps/remote-executor-sync-ignores-claude-config-dir.md`. Both gaps closed when
SSH synchronization was retired on 2026-10-26; their evidence remains in Git
history.

### Deferral of steps 5–7

Historical decision, 2026-10-11. The
[November 1 follow-up](#november-1-selected-follow-up) supersedes this deferral
for new-session identity/lifecycle work; the full fork/clone program is still
not required work. The original rationale follows.

- **Their motivating need is met another way.** Routed clone was the reason
  for minting a child's id before copying. Clone copies stay immediate, and
  the child inherits its pin right after the copy, failing closed (step 8).
- **Only Claude accepts a caller-chosen id.** Codex (`thread/start`),
  OpenCode (`ses_…` from its server), Gemini and Grok (ACP `session/new`) and
  pi all assign their own session ids. Steps 5–7 would therefore need a
  YA-id ↔ provider-id translation at every provider boundary for every
  provider but Claude, not just Codex.
- **Translation does not remove complexity; it moves it.** The provisional
  rename happens once, at startup. Translation instead adds a lookup to every
  scanner, watcher, reader, resume and CLI-resume path.

What steps 5–7 would still buy: closing the crash window between a copy and
its pin, deleting the rename code, and recording session facts before launch.
The original revisit trigger was a feature needing that last property, such
as per-session profiles ([plan 133](133-provider-profile-directories.md)) or
managed remote runners. Reliable
[session creation](../../topics/session-creation.sketches.md) now meets that
trigger. Until implementation lands, Claude sessions keep one id from creation
(step 4) and other providers rename once at startup, as before. The steps below
are kept as the design to start from.

### 5 — mint ids first for new Codex sessions

- **Schema.** Add real `provider` and `native_id` columns to
  `session_metadata` (not fields inside the JSON), with
  `UNIQUE (provider, native_id)`. Native ids are fresh provider UUIDs (in the
  Claude file name and each line's `sessionId`; in the Codex rollout file name
  and its `session_meta` record), so a duplicate means one transcript claimed
  by two YA sessions, which the constraint refuses at write time. This keeps
  today's behavior, where copies of one transcript in several scan roots or an
  executor's remote and local copies are one session. When profiles (plan 133)
  or multiple roots can hold genuinely separate copies, widen the key to
  include the home; that is a cheap index migration, deferred until then.
- **Launch.** Mint the id and write the row before `thread/start`. Record the
  thread id in the native-id column when it arrives.
- **Inbound translation.** Route the Codex scanner, rollout watcher and reader
  entry points through the native-id lookup. This is the largest piece of the
  plan, because these readers are keyed by thread id today.
- **Outbound translation.** Resume, transcript reads, export and the CLI resume
  command read the native id from the row.
- **After this step,** no YA-created session is ever renamed.

### 6 — mint ids first for fork and clone

- **Claude.** Mint the child id and write its row, carrying lineage and
  inherited launch facts, before the provider fork. Fork through a launch for
  the child (`resume` + `forkSession` + `sessionId`), so it runs with the
  child's materialized credentials and placement.
- **Codex.** Write the child row before `thread/fork`. Record the returned thread
  id as the child's native id.
- **Failure.** If the provider fork fails, mark the child row failed so it
  cannot be resumed and does not appear as an empty session.
- **Callers.** `/fork` (all fork kinds), `/clone` (used by /btw and quick
  question asides), the long-context effort guard, and the goal and judge forks
  all go through this path.

### 7 — delete the rename machinery

- **Server.** Delete everything listed under [Motivation](#motivation): the
  `remap*` functions, `observeSessionIdRemaps`, the `session-id-remapped` event,
  its handlers, the `session-id-changed` push, and `tempSessionId` in
  `Supervisor`.
- **Client.** Keep the rename handlers (`useSession.ts:2552`,
  `lib/activityBus.ts`, `useRecentSessions.ts`, `clientSummaryStore.ts`) until
  every server in the core horizon has stage 2, then delete them in one commit.

### 8 — inherit router pins on fork and clone

**Implemented 2026-10-11 without stage 2.** Fork and clone copies stay
immediate, as the maintainer required, so the child's id still comes from
the provider. `Supervisor.forkSession` and the `/clone` route check the
parent's binding before copying (`assertRouterBindingInheritable`) and attach
a child binding right after (`inheritRouterBinding` →
`AgentAuthRouter.inheritBinding`), writing the child's metadata before its
allocation. A copy whose inheritance fails is deleted and the request
returns 409. The remaining window is a crash between the copy and that
metadata write. Fork with summary stays refused: its generator runs through
`provider.generateSummary`, which takes no router launch. `thread/fork` needed no router credentials: it succeeds with
all network refused (see
[`gaps/routed-codex-calls-chatgpt-with-direct-login.md`](../../gaps/routed-codex-calls-chatgpt-with-direct-login.md)
for the app-server's other calls). Stage 2 would close that window; it is no
longer required for this feature. The original design follows.

With step 6 in place, [plan 143](143-agent-auth-router-integration.md) step 3
reduces to:

- **Child binding.** Allocate a child binding for the parent's account (pool
  policy `manual` with the parent's account, no reselection) when writing the
  child row.
- **Codex fork.** Run it through the routed launch, not `getCodexEnv()`.
- **Failed launches.** Cancel a rejected uncommitted child binding. Today
  `AgentAuthRouter.launch` cancels only when the session had no binding.
- **Remove the refusals** for fork and clone: `Supervisor.forkSession`, the
  `/fork`, `/clone` and `/fork-summary` route guards, and the client's
  `routed-session` fork availability and aside gate.

Restart, handoff and stale-handoff start a fresh session rather than a fork,
so this step does not lift their refusal; carrying the pin into a replacement
session is a separate decision. Helper sessions (recap, title) remain refused
for routed sessions unless that plan decides otherwise.

## Explicitly out of scope

- Migrating other JSON stores (recents, review comments, project metadata) into
  SQLite. Their remap code goes away in step 7 regardless.
- A general per-session launch context or T3-style provider instances. This plan
  makes them easier but does not build them.
- Changing ids of existing sessions.
- Supporting a provider-host worker across an upgrade that changes id handling.

## Verification

- **Stage 1.**
  - Startup fails with the documented message for a missing builtin, a locked
    database, a failed migration and a network-filesystem data directory.
  - An installation with a populated `session-metadata.json` upgrades with every
    field intact, and the JSON file is unchanged afterward.
- **Stage 2.**
  - For Claude and Codex, a new session keeps one id from creation through first
    turn, restart, resume and CLI resume.
  - No `session-id-changed` or `session-id-remapped` event is emitted.
  - A session started outside YA keeps appearing and resuming under its native id.
  - A crash injected between writing a child row and the provider fork leaves no
    resumable unpinned session.
  - A routed clone runs on the parent's account under a distinct binding, and is
    refused, not redirected, when that account is unavailable.
