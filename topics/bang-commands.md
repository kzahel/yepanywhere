# `!!` Bang Commands (composer-run local shell commands)

> `!!command args` in the session composer runs a local shell command in the
> project directory, entirely outside provider context; the run persists
> inline as a transcript display object with markdown/JSON/ANSI/TOON-aware
> rendered output, echo-to-session and recall (Ctrl+↑ history) actions,
> shell-style tab completion (PATH + project commands, path arguments,
> allowlisted acli tools), and a top-level cross-session history view.

Topic: bang-commands

Status: implemented v1, explicit opt-in (2026-07-24). Server:
`BangCommandService`, `bangCompletions`, `createBangCommandsRoutes`
(`packages/server/src`). Client: `lib/bangCommands`,
`BangCommandDisplayObject`, `MessageInput` `bangSupport`,
`BangCommandsPage` (`packages/client/src`). Shared TOON reader:
`packages/shared/src/toon.ts`. Tests: `packages/server/test/bang/`,
`lib/__tests__/bangCommands.test.ts`, `ui/__tests__/toonFixedFont.test.tsx`.

See also:
[transcript-display-objects](transcript-display-objects.md) (the persistence
and placement mechanism these blocks reuse),
[provider-agnostic-btw-asides](provider-agnostic-btw-asides.md) (precedent for
composer input that is YA-routed rather than sent to the session agent, and
for the visible-routing-before-submission invariant),
[synthetic-turn-injection](synthetic-turn-injection.md) (the contrast: that is
about putting content *into* model context; bang blocks never touch context),
[message-control-steer-queue-btw-later-interrupt](message-control-steer-queue-btw-later-interrupt.md)
(the delivery-intent contract `!!` deliberately sits outside),
[emulated-slash-commands](emulated-slash-commands.md) (the other composer
prefix-routing layer; `!!` is routed before that layer ever sees it),
[rich-text-rendering](rich-text-rendering.md) (the sanitized markdown and
fenced-output render paths the block output flows through),
[subprocess-environment](subprocess-environment.md) (environment hygiene for
YA-spawned processes),
[public-share-content-censorship](public-share-content-censorship.md) and
[security](security.md) (exec surface gating and share exposure),
[architecture-mandates](architecture-mandates.md) (bounded storage/render
obligations the history view inherits),
[acli-ui](acli-ui.md) (proposal: acli capability detection and the richer
completion/help UI for allowlisted tools in this composer).

## Current compatibility baseline

The `bang-commands` fixed client gate was retired on 2026-10-28. Current
clients route explicit bang execution on the v0.8.0 server baseline without
waiting for capability discovery. The discoverable history view still requires
`clientDefaults.bangCommandsEnabled === true`; its default remains off. The
server keeps the old capability identity and advertisement for older clients.

## Motivation

YA is a mobile-first supervisor: the operator often has no terminal at hand.
Today a quick `git status`, `pnpm test`, `agentctl active`, or ad-hoc report
script requires either interrupting/steering the agent ("please run X for
me" — a token-costly round-trip that also perturbs the session) or leaving
the phone for a shell. Bang commands give the supervisor a direct hand on the
project directory:

- **Zero session interference.** A bang command never becomes a turn, never
  enters provider context, is never replayed on resume, and is invisible to
  the agent unless the user explicitly echoes it in. It therefore runs
  immediately regardless of session state — busy, waiting, compacting — with
  no steer/queue/defer semantics.
- **A persistent inline record.** The command and output appear at the
  transcript position where they were run, documenting what the human
  checked and when, interleaved with the agent work it was checking.
- **Agent-tool synergy.** The same acli-style tools built for agents
  (`~/agents` `topics/acli.md`; `agentctl` is the flagship) are exactly
  the compact, non-interactive commands a phone-bound supervisor wants.

## Contracts

- **Execution always-on; the history surface default-off.** Wherever the
  current v0.8.0 server baseline is in use, `!!`
  execution, completions, and the per-session object routes are always
  available (vanilla-defaults.md § Known Exceptions: an established,
  deliberately invoked shell-escape adds no default-visible surface).
  Only the discoverable "!! Commands" surface — the sidebar entry and the
  top-level `GET /api/bang-commands` history view — is gated on
  `clientDefaults.bangCommandsEnabled` being explicitly `true`; absence
  means hidden, and the server returns 404 from that route while hidden.
  The toggle stays in Message Delivery settings next to the composer
  routing it documents.
- **`!!` is YA-routed, never provider ingress.** Routing happens in the
  composer (`MessageInput` resolves the draft before its trim/send step,
  because the leading-space escape depends on pre-trim text) and only on
  composers given `bangSupport` — today the session-page footer composer.
  Composers without a wired bang path do not advertise the prefix and treat
  the text as ordinary drafts.
- **Visible routing before submission.** While the draft starts with `!!`,
  the composer shows a routing chip ("local command — not sent to agent"),
  mirroring the `/btw` invariant that routing state is shown, not inferred.
  The escaped form shows its own chip.
- **Leading-space escape.** A draft starting with a space followed by `!!`
  is not routed: the single leading space is stripped and the remainder
  (beginning `!!`) goes to the provider as ordinary prompt text. There is
  deliberately no further escape — a turn whose literal text must begin
  with space-then-`!!` cannot be sent, an accepted non-case. A bare `!!`
  with no command is a silent no-op (the chip already explains the mode).
- **Submission empties the composer; its outcome settles the draft.** As
  with Send, submitting a bang command empties the composer at once, so
  keys typed while the run request is in flight start the next draft and
  are never cleared with the command; browser draft storage keeps the
  command as the recovery copy meanwhile. A completed bang-run request
  removes that copy only while the composer is still empty. A failed request
  puts the submitted command back so the user can correct or retry it, unless
  the user has already begun a newer draft, which is kept; the failure toast
  then remains the only record of the command. See
  [composer acknowledgement safety](message-control-steer-queue-btw-later-interrupt.md#composer-acknowledgement-safety).
- **Execution.** Server-side `bash -lc` loads the user's login startup,
  including functions and aliases (pipes, globs, redirects work — the
  acli composition story assumes pipeable verbs), `cwd` = the session's
  project directory, child in its own process group so kill reaches the
  whole pipeline. Command resolution: PATH first, then the project
  directory as an implicit final PATH entry, applied after login startup
  along with the project working directory (a project-root executable
  `foo` runs as `./foo`; no subdirectory search). Login startup is not an
  interactive shell: aliases and functions a `.bashrc` defines after the
  usual interactive guard (`[[ $- == *i* ]] || return`) do not load, even
  when `.bash_profile` sources that `.bashrc`.
- **Login startup is not part of the run.** What login startup writes — a
  banner, `fortune`, a warning — is dropped from the run's output and
  previews; the run records only what follows it. A run whose login startup
  never hands control to the command, because a login file replaces the
  shell (`exec zsh`) or exits, settles as an error saying so, even when the
  shell exited 0, and keeps startup's output as its only evidence. Startup
  that has not returned within 30 seconds (an auto-attaching `tmux`, a
  prompt waiting on input) is killed with that reason. Side effects of
  login startup still happen on every run.
- **Trust boundary.** No new one: YA already executes arbitrary code as the
  server user via agent sessions. Bang exec is gated by the same
  authentication as sending a turn (owner clients over direct or E2E relay
  transport) and a
  project/session ownership check on every session-scoped route. A URL cannot
  pair a session from one project with another project's working directory.
  Bang APIs and display objects are absent from public share surfaces; until
  display-object censorship exists, the share sanitizer omits the complete
  `transcriptDisplayObjects` collection.
- **Environment hygiene.** Inherit the server's baseline subprocess
  environment, but scrub agent-session identity markers
  (`AGENTCTL_SESSION_ID`, `CLAUDE_CODE_SESSION_ID`, `CLAUDECODE`) **and
  `BASH_ENV`** — an agent launcher's `BASH_ENV` bridge script would
  otherwise be re-sourced by the child bash and re-inject the identity vars
  just scrubbed (caught by test; a bang-run `agentctl` must never adopt an
  agent session's identity). Clear these markers again after login startup.
- **Result block.** Shows the command line, exit code, duration, and output;
  stderr stays distinguishable and expanded, hidden only when empty.
  Newly noticed runs in an open session expand automatically: previews show
  during execution and completed rendered output loads without a click.
  Runs already present when revisiting the session start with bounded previews.
  Non-zero exit gets error styling. A running block shows a streaming
  preview with a cancel control; streamed updates are coalesced server-side
  (metadata-changed events at most every 750 ms) before reaching React —
  bursty command output is exactly the high-rate path the client
  performance rules cover.
  A delayed start response cannot overwrite newer streamed output or terminal
  status, or remove another concurrent run.
- **Persistence.** Transcript display object kind `bang-command`, anchored
  by `placementAfterMessageId` at the displayed transcript tail when run;
  transient completion events are never anchors. The live window recovers
  older bang records whose anchors disappeared by placing them at their saved
  creation time, provided preceding timestamped content is loaded. Historical
  search windows retain exact-anchor placement. An empty
  anchor renders before the first item, for empty sessions. User-authored,
  so deletion is allowed once finished (409 while running). Output does not
  bloat session metadata: the object stores the command line, exit
  metadata, and bounded preview tails (4 KiB stdout / 2 KiB stderr); full
  output lands in `{dataDir}/bang-commands/<sessionId>/<objectId>.stdout` /
  `.stderr` (8 MiB cap per stream, truncation flagged), fetched on demand
  (2 MiB response cap per stream, 4 MiB combined). Full output loads
  automatically for newly noticed session runs, or after an explicit user
  action for revisited runs; the 500-entry history view retains at most one
  expanded full-output response at a time. Per-session bang objects are pruned
  oldest-first past 100, but a running object is never pruned. Truncated
  display states that it was cut — the acli truncation principle applied to
  our own UI.
- **Concurrency and lifecycle.** At most four commands run concurrently per
  session. The app owns one service instance. Graceful restart/shutdown
  terminates every running process group, waits for each completion, and
  records a visible shutdown reason. A 10-minute wall-clock cap records a
  timed-out kill reason; cancel is always available. Write-stream and metadata
  failures settle the run as an error rather than crashing the server or
  leaving its completion pending. On an abrupt server death, startup recovery
  marks persisted `running` objects `killed` ("Interrupted by server
  restart"); an uncatchable process death can still leave an OS child until it
  exits or an external supervisor reaps it.

## Output rendering: classify, then the standard render paths

`classifyBangOutput` (server) classifies stdout once, then forks to the
render path the repo already has — no bang-private renderer:

- **Uniform JSONL runs render as tables, regardless of surrounding
  prose.** Before the markdown/json fork, any run of >= 2 consecutive
  JSON-object lines sharing an identical key set is rendered as a GFM
  markdown table via the shared `jsonlTablesToMarkdown` →
  `toonDocumentToMarkdown` path (mode reported as `markdown`), with every
  non-tabular line — prose before, between, or after the runs — passed
  through verbatim. The run itself is the trigger; a prose-led document
  still tabulates. This is the common list-shaped acli output (e.g.
  `almanac query`); the per-block Raw toggle still shows the original
  lines. Output with no qualifying run falls through to its classified
  path below.
- **markdown** (the default): rendered as-is through the assistant-text
  markdown pipeline (`renderMarkdownToHtml`).
- **json** — a whole-document JSON parse or first-lines JSONL parse (the
  acli spec mandates compact JSONL for non-TTY callers, so spec-compliant
  tools land here): fenced as ```json for shiki highlighting. Single
  objects, JSON arrays, and non-uniform JSONL keep the plain ```json
  fence.
- **ansi** — CSI escapes detected: fenced as ```ansi; the augment layer's
  existing ANSI renderer produces colored HTML. acli tools that respect a
  TTY-ish TERM and emit color render correctly.
- **toon** — the acli opt-in flat-table format, strictly parsed
  (`packages/shared/src/toon.ts`): fenced as ```toon; the augment layer
  converts to a markdown table, so it renders as a real table. The same
  shared parser also powers a TOON block in the client fixed-font chain
  (`renderFixedFontRichContent`), so agent Bash tool output containing a
  strict TOON table renders as a table under the sigma toggle too. Quoted
  cells must close, doubled quotes are the only quote escape, and no bytes may
  trail a closing quote before the delimiter.
- **raw** — anything else (including TOON-looking-but-malformed): plain
  fence.

Heuristic misfires are covered by the per-block Raw/Rendered toggle. The
augment-generator TOON branch fires for ```toon fences and untagged fences
whose content strictly parses, benefiting all fenced command output, not
just bang blocks.

## Tab completion

Tab always completes inside a bang draft, shell-style: accept the
highlighted candidate if the menu is open; otherwise fetch immediately,
apply a single match (or extend to the longest common prefix), and open the
menu on ambiguity. Typing also auto-suggests (150 ms debounce) once the
token is non-empty. Touch keyboards have no Tab key, so while the draft is
a bang draft the mobile-keyboard compact action row gains a temporary
"Tab ⇥" button that triggers the same completion action.

Completion responses are draft-versioned: a response for an older full bang
line is discarded even when the trailing token is unchanged.

- **Command position** — the first token, and the first token after `|`,
  `;`, or `&`: candidates are executable names from the server's PATH plus
  project-root executables (`GET
  /api/projects/:id/bang-completions?kind=command`), served from a 30 s
  cached scan.
- **Global command history — ranked first.** Typing `!!` then Tab (the
  `! ! Tab` sequence) offers, before the PATH / project-executable / path
  candidates, prior *whole* `!!` command lines that prefix-match the
  current `!!` body. The source is YA-global: every bang command run
  across all sessions and all time — the same corpus the top-level "!!
  Commands" view lists (`collectGlobalBangCommands` over
  `listTranscriptDisplayObjectSessions`), deduped by command line,
  most-recent-first, prefix-filtered server-side through a cached prefix
  index (`BangHistoryIndex`, rebuilt at most every few seconds rather than
  rescanning per keystroke). The
  completion endpoint returns `{ completions, history }`; the client merges
  them into one menu (history rows first, `bang-history-item`), and
  selecting a history row replaces the whole `!!` body, while a token row
  keeps token replacement. This is the bang-side twin of the composer
  recall drawer (composer-recall-drawer.md): same menu UI, but the corpus
  is bang history and selecting *completes the command* rather than
  drafting a turn. Known limit: history engages on the same gate as token
  completion (non-empty trailing token), so `!!git` offers history but
  `!!git ` (trailing space) does not — loosening that is a separate change.
- **Argument tokens** (not starting with `-`): per-tool acli completion
  first, then project-relative path completion (directories suffixed `/`,
  `..` escapes refused).
- **acli per-tool completion**: the server invokes
  `tool --acli-complete <argv-prefix...>` (protocol defined in `~/agents`
  `topics/acli.md` § Completion protocol) for the last pipeline
  segment's command — but **only for allowlisted tools**
  (`YA_BANG_ACLI_COMPLETERS` env, comma-separated basenames, plus the
  built-in `harness-check`). Tab must never execute an arbitrary program: a
  lax non-compliant tool could ignore the unknown flag and run its default
  action. Zero acli candidates fall back to path completion.

## Block actions

- **Echo to session.** Fetches the output and sends a single ordinary user
  turn (provenance-labeled, command and output dynamically fenced beyond any
  backtick run in the content, 16 KiB clip per stream) through the normal
  send path. Always an explicit user action —
  mirroring the `/btw` rule that result injection is never automatic. The
  display object remains.
- **Recall to composer.** Drafts `!!<command>` into the composer for
  revision — history records stay immutable and the composer remains the
  single editing surface. Keyboard path: Ctrl+ArrowUp cycles back through
  this session's prior bang commands (newest first, deduplicated),
  Ctrl+ArrowDown forward, but only from a text-and-attachment-empty composer or
  an active `!!` draft; any divergent edit resets the cycle. The same shortcut
  is expected to be useful beyond bang commands; general composer
  message-history recall is a natural later extension.
- **Re-run.** Runs the unchanged command as a new block at the current
  tail; the old block stays as the record of what was true then.
- **Cancel** (while running) and **Delete** (when finished; removes the
  object and its stored output).

## Top-level history view

`/bang-commands` (sidebar: "!! Commands") lists all bang runs across
sessions, newest first (capped 500), with time, project directory, an
open-session link, and the same block component fetching rendered output on
demand. The route exists in both the local client and each connected-host
remote-client scope; links back to source sessions retain the remote host
prefix, and the page's requests remain bound to that host. It starts from
bounded previews and keeps at most one entry's full output expanded and
retained. Reads only the bounded metadata already in session metadata plus that
single on-demand output fetch.

**Per-entry actions — three small icons.** Each entry knows its source
session id, bang object id, and project directory (cwd), so it offers,
all scoped to that entry's **project cwd via its source session** (no
session-less or project-less run), each navigating to the source session
with `SessionNavigationState` fields consumed once on mount (then cleared
via a `replace` so Back/refresh does not replay them):

1. **Edit / re-issue** (`composerPrefill: "!!<command>"`) — opens the
   source session and prefills its composer for modification/resubmission.
2. **New** (`focusComposer: true`) — opens the source session and focuses
   the composer without changing any existing draft.
3. **Jump** (`scrollToRenderId: object.id`) — scrolls the source session to
   the bang block's pseudo-turn (its row's `data-render-id` is exactly the
   display object id), reusing the composer-recall `scrollToTurnRequest`
   path. Lands only if the target row is within the loaded active window
   (bang blocks anchor at the tail, so a fresh load normally shows it).

Icon aria-labels are inline literals pending en.json keys
(`bangHistoryAction{Edit,New,Jump}`) and the action-row CSS is a follow-up
(`styles/index.css` was peer-held this session).

## Fork views may omit bang blocks

Anchors are message ids, and providers that remap ids on fork (Claude) drop
the blocks from the forked view. Accepted: the agent context never
contained them, so a fork loses nothing the model saw; the source session
remains the record.

## Open questions

- **PTY allocation.** Running under a PTY would flip acli tools to their
  pretty-JSON human branch and make TTY-only tools behave; ANSI is already
  rendered. Default no-PTY; revisit if fenced JSONL proves annoying in
  practice.
- **Bare `!!` recall.** Submitting `!!` alone could re-run the previous bang
  command (the shell pun). Currently a silent no-op; decide later.
- **Single-`!` reservation.** Claude Code's own TUI uses `!` for bash mode.
  YA does not intercept `!`; keep it unclaimed so a future provider-native
  passthrough is not shadowed.
- **Surface scope.** v1 is the session-page footer composer only (disabled
  while it routes to a focused `/btw` aside); the history view may cover
  the sessionless case better.
