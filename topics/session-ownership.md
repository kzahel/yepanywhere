# Session Ownership And Shared-Transcript Writers

> Ownership is YA's mtime-based guess at who is currently driving a provider
> session file, and the contract for the two "someone else may be writing"
> banners. It exists because a session transcript is a plain file multiple
> processes can append to with no lock — so YA can observe a collision risk
> but cannot prevent the collision.

Related: provider-specific multi-writer findings live in
[claude.md](claude.md) (§ Concurrent External Writers). Turn/progress
liveness — a different axis — is [session-liveness.md](session-liveness.md).
Recovery/fork/handoff actions are
[session-context-actions.md](session-context-actions.md). Background research
on the Claude file shape: `docs/research/archive/claude-session-jsonl-structure.md`.

## The ownership model

`SessionActivityOwner = "self" | "external" | "none"`
(`packages/client/src/lib/sessionActivityUi.ts`):

- **`self`** — a live YA Supervisor process owns this session's turn. YA has a
  real pid and can steer, interrupt, switch model, answer prompts.
- **`external`** — the session jsonl was modified recently (within an ~30s
  decay window) by something that is *not* a YA process. Set in the session
  read routes (`packages/server/src/routes/sessions.ts`, `projects.ts`,
  `global-sessions.ts`); decay constant in `packages/server/src/app.ts`.
- **`none`** — nobody is currently detected as driving it: no live YA process,
  and no foreign write inside the decay window.

**A session YA just forked reads `none`, never `external`.** The fork's
transcript is written by this server, and a cold fork has no process to own it,
so the file activity of its own creation used to arrive as "another program is
writing this session" and raise the amber banner on a session nothing else had
touched. `Supervisor.forkSession` emits `session-forked`, and
`ExternalSessionTracker` records it as one of this server's own writes, as it
does a `session-aborted` stop: one grace per session with its reason, because
our own writes are not evidence of a foreign writer. For ~30s after a fork
(`forkGraceMs`) the session is still discovered — summary read,
`session-created` emitted — but reported unowned rather than externally active;
for ~30s after an abort (`abortGraceMs`) its cleanup writes are ignored. After
the grace, a writer that is not YA is external again, exactly as for any other
session.

**Ownership is derived purely from file mtime.** It is a *recency* signal, not
a *liveness* signal: it cannot see processes, pids, or locks. This is the root
limitation behind every caveat below.

**Boot process presence is a separate projection.** After retained runtime
reattach, YA can state exactly which sessions have a known YA process and which
do not. One bounded same-user harness inventory at boot and on a single
process-wide cadence may additionally find external provider processes. It may
associate one with a session only through an exact provider-native session id,
pid/lock record, or protocol fact. Until such a join exists, “no YA process” is
not “no process”: an uncorrelated external harness or a process outside the
observable namespace may still exist. Do not weaken the mtime ownership wording
or upgrade `owner: "none"` into proven process absence.

Command-name recognition, native session-id extraction, and bounded
total/recent activity reads belong to provider adapters. The generic boot
coordinator joins those facts with Supervisor ownership and does not infer from
cwd, mtime proximity, CPU, or candidate count. See
[provider-abstraction](provider-abstraction.md) and
[agents-process-observability](agents-process-observability.md). The bounded
inventory and its prohibition on unrelated transcript scans are in
[session-catalog-observation](session-catalog-observation.md).

**YA never concurrently appends to a live shared transcript.** It reads these
files read-only, and the one write path — fork — writes a *new*
`<targetId>.jsonl` with rewritten ids rather than appending to the shared file
(`packages/server/src/sessions/fork.ts`). So a YA *send* into an externally
owned session is a second writer only because the **provider's** resume appends
to the same file, not because YA does.

## Provider append discipline (point: "what discipline, if any?")

**Claude — verified: none, and the failure is known.** A Claude session is one
`~/.claude/projects/<project>/<session>.jsonl` with a `parentUuid` DAG. There
is no lock and no cross-process coordination; `--resume` (without
`--fork-session`) continues in place and appends to the same file. Individual
line appends are atomic enough that even a 4-writer race left zero malformed
lines — so the damage is *logical* `parentUuid` branch divergence, not byte
corruption, and a later resume keeps one branch and silently drops the rest.
Full empirical repro and contracts: [claude.md](claude.md) § Concurrent
External Writers. <!-- verified there: claude 2.1.177, 2026-06-13 -->

**Codex — partly verified, key behavior open.** Verified from code: Codex
stores sessions as *linear* (non-DAG) `rollout-*.jsonl` under
`~/.codex/sessions/YYYY/MM/DD/`
(`packages/server/src/sessions/codex-reader.ts`), and YA drives Codex through
the app-server thread-resume protocol, not by appending to the file itself
(`packages/server/src/sdk/providers/codex-session.ts`, `startOrResumeThread` /
`ThreadResumeParams`). **Unverified and consequential:**

- Does Codex take any lock on the rollout file? (Assume not until checked.)
- Does resuming a Codex thread *append to the same rollout file* or *start a
  new dated rollout*? This changes the multi-writer model entirely: a new file
  per resume cannot fork a shared DAG the way Claude does, but may instead
  fragment one logical conversation across rollouts.

Resolve by mirroring the Claude repro with the `codex` CLI (present at
`~/bin/codex`): seed a thread with a codeword, resume it live, resume the same
thread id from a second process, then inspect whether one rollout file gained
siblings/branches or a new rollout appeared, and whether any lockfile shows up
under `~/.codex/sessions/...`. Record the result here with a `verified:` date.

## The two writer banners

Both render in `SessionPage.tsx` and share the `.external-session-warning`
base style; they signal *different* states.

**Amber — "External session active" (`owner === "external"`).** Live concurrent
writer likely: the file was touched <~30s ago by another process. Component
`packages/client/src/components/ExternalSessionWarning.tsx`, i18n
`sessionExternalWarning`. Not dismissible; fades on its own once the foreign
activity stops *and* the window is focused. Its "what's the risk?" copy is the
multi-writer fork story above. This is the well-grounded case.

**Blue — "may be waiting for input in another process (VS Code, CLI)".** Trigger
(`SessionPage.tsx`):

```
hasPendingToolCalls = status.owner === "none" && hasPendingRenderedToolCalls
```

`hasPendingRenderedToolCalls` is true when the transcript's items include a
`tool_call` with `status === "pending"` — a `tool_use` with no matching
`tool_result` (`packages/client/src/lib/sessionActivityUi.ts`). So the blue
banner means: **no active owner, yet the transcript ends mid-turn on an
unanswered tool call.** YA infers that another program (a TUI/IDE/CLI) opened a
tool call and is parked at an approval/input prompt — quiet enough that its
last write aged out of the `external` window, so ownership reads `none`. i18n
`sessionPendingElsewhereWarning`; **dismissible** per session
(`localStorage`), restorable from the session menu. The named "VS Code, CLI"
is fixed illustrative copy — YA never actually identifies the other program.

The risk it guards: if you send from YA, (1) you do not answer what it is
blocked on (the approval lives in the other process's prompt, not as a
transcript user turn), and (2) you append a user turn onto a tip that is an
incomplete tool call, so when the other process resumes from the tool call it
remembers, the histories fork — the same silent-branch-loss outcome as the
amber case, reached by a different trigger.

## The killed-mid-tool-call false positive (point: detection limits)

The blue banner's weakness: a process **parked at a prompt (alive)** and a
process **killed mid-tool-call (dead)** leave *byte-identical* on-disk state —
a dangling `tool_use`, file frozen. Nothing derivable from the file (mtime,
age, content) can tell them apart. Distinguishing them requires an
**out-of-band liveness probe of the writer**, and YA tracks pid/liveness only
for its *own* Supervisor processes (`Supervisor`/`Process`, `codex isAlive()`)
— never for a foreign TUI/IDE.

Candidate detectors, with honest limits:

- **A lock/pid the foreign CLI exposes** — cleanest. If Claude Code / Codex
  hold a per-session lock or pidfile, YA could probe it (it already depends on
  `proper-lockfile`) and suppress on dead. **Hinges on an unverified fact:**
  whether those CLIs lock their session files at all. Do not assume they do.
- **Same-host fd/process scan** (`lsof` / `/proc/*/fd`) — works only if a
  parked CLI keeps the file *open*; an open-append-close writer would read as
  "dead," trading one false positive for another. OS-specific, racy, costly.
- **Age decay** — a human can sit at an approval prompt for hours, so any
  timeout both false-suppresses real waits and false-keeps dead ones. A
  backstop, not a detector.

**Conclusion: detection should re-label, not blanket-suppress.** A
killed-mid-tool-call session is *not* safe to send into either — resuming a
transcript whose tip is an unanswered tool call is its own hazard (the
provider must error or synthesize a `tool_result`, and the dead run's work is
gone). So a reliable "writer is dead" signal argues for a *different* banner
("a previous run left an unfinished tool call; sending will resume and may
discard it"), not for hiding the warning. Until a provider lock/pid is
confirmed, the current hedged-copy + per-session-dismiss design is a
defensible equilibrium: the false positive's cost is low and bounded.

## Invariants

- Ownership is mtime recency, never proof of process liveness. UI must not
  upgrade "recently written" to "a live process is steering this."
- A persisted provider transcript remains viewable without a live provider
  attachment. Session detail and metadata reads may enrich the disk projection
  from an owned process, but an unavailable optional process control such as
  dynamic command discovery falls back to static provider facts rather than
  failing the read. Resume, fork, and send actions keep their own attachment
  and concurrent-writer gates.
- YA must stay a non-appending reader of live provider transcripts; the only
  write path is fork-to-a-new-file.
- The blue pending-tool banner is a heuristic inference from a dangling tool
  call, not a detected fact about another process. Keep its copy hedged and
  keep it dismissible until an out-of-band liveness signal exists.
- Any future "the other writer is dead" suppression must first establish real
  writer-liveness evidence (a foreign lock/pid or confirmed-gone process), and
  should re-message the resume-from-dangling-tool hazard rather than silently
  hide the banner.

## Tests / experiments that should pin contracts

- Codex multi-writer repro (above) recorded with a `verified:` date, settling
  append-in-place vs new-rollout and lock presence.
- An `owner === "none"` session whose latest turn ends on a pending `tool_use`
  shows the blue banner; answering the same `tool_use` (gaining a
  `tool_result`) clears it.
- A forked transcript (two `parentUuid` siblings) resumes to exactly one
  branch — the cross-check for the silent-drop claim, owned by [claude.md](claude.md).

## Native file ingress and YA ownership

For scoped Claude/Codex identities, native file events are translated before
Supervisor ownership, abort/fork grace and external-decay joins. A filename is
not a public-session claim. Verified legacy discovery adopts its source before
ownership events; a conflicting or unbound public claim is not a legacy fallback.
Events and summary observations use the YA id and effective working project,
while original transcript projects and physical paths continue to address native
history. This changes identity joins, not the evidence threshold for external
ownership or the read-only nature of foreign processes.

Native source work is coalesced and bounded before acquisition. Overflow does
not manufacture an ownership transition. Observer disposal cancels resolution,
queued work and publication; a delayed native head cannot adopt a session after
application/database shutdown. Host OS process observations retain their
separate documented native-session field meaning and correlation contract.
