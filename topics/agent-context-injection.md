# Agent Context Injection

> Agent context injection is the provider-specific contract for placing YA,
> harness, and project instructions into model context, preserving designated
> sources across compaction, and refreshing mutable facts without destabilizing
> reusable prompt prefixes.

Topic: agent-context-injection

Status: current provider placement and compaction contract. Unimplemented boot
managers, request-conditioned compilers, protected capsules, and their full
evidence trail live in
[`agent-context-injection.sketches.md`](agent-context-injection.sketches.md).

Related topics: [cache-aware session bootstrap](cache-aware-session-bootstrap.md),
[provider context economics](provider-context-economics.md),
[agent command runtime sketch](agent-command-runtime.sketches.md),
[emulated slash commands](emulated-slash-commands.md),
[injected-message visibility](injected-message-visibility.md),
[synthetic-turn injection](synthetic-turn-injection.md), and
[federated super sessions](federated-super-sessions.md).

## Scope and vocabulary

This topic uses *agent context injection* rather than *prompt injection*. The
latter commonly names an adversarial instruction attack; this topic is about
intentional context supplied by YA or a provider harness.

Provider context sources have different durability and authority:

- base/system instructions and host-appended system/developer instructions;
- project instructions discovered by a harness, such as `AGENTS.md` or
  `CLAUDE.md`;
- mutable world state such as cwd, date, shell, permissions, and tools;
- ordinary user text plus any YA wrapper placed at user-message authority; and
- tool-read routed policy such as `RESEARCH.md`, `RUNS.md`, and topic docs.

For each source, distinguish exact reconstruction from current source, exact
carry-forward, bounded provider reinjection, lossy conversation summary, and a
later action-triggered reread. “The model probably remembers it” names none of
these mechanisms.

## Contributor instruction files in this repository

[AGENTS.md](../AGENTS.md) directs agents to the contributor guide and relevant
topics. If `AGENTS.local.md` exists, agents must read it before acting; its
machine-local instructions take precedence over AGENTS.

[DEVELOPMENT.md](../DEVELOPMENT.md) owns the common contributor rules and
explicit task-reading triggers. [Development guides](../docs/development/README.md)
own contributor procedures and operational reference; existing topics retain
their product and technical contracts. Agents must read the root guide before
implementation planning or repository changes, including documentation and
configuration edits, and read
every applicable guide/topic named by the root task table before choosing an
approach. Recheck the table when scope expands; reading the entire development
directory is not required. General discussion and read-only orientation do not
require the full development workflow; applicable topic
triggers still apply. This is an instruction to read the guide, not a guarantee
that a harness automatically injects or preserves its contents.

## Current YA placement

`buildEffectiveAgentContext` in `packages/shared/src/agent-context.ts` composes
enabled `[Client capabilities]` fragments before the free-form
`[Global instructions]` block. The server passes that result as
`globalInstructions`; provider adapters decide where it enters model context.
A [session-sandboxed](session-sandboxing.md#boundary-statement-in-launch-context)
Claude or Codex launch appends a `[Session sandbox]` boundary statement to
that context before placement; the Claude prompt-cache keepalive appends the
same text so its prefix still matches.

Candidate command-advertisement behavior is recorded in the
[agent command runtime sketch](agent-command-runtime.sketches.md); it is not
part of the current LaTeX-only implementation.

| Provider path | Placement | New process | Resumed process |
|---|---|---:|---:|
| Claude and Claude Ollama | `systemPrompt` preset `append` | yes | yes |
| Codex app-server | `[Global context]` prefix on first ordinary user message | yes | no |
| Codex OSS and legacy Gemini | same ordinary-user prefix | yes | no |
| Pi, OpenCode, Grok ACP, Gemini ACP | same ordinary-user prefix | yes | first message after process launch |

Shared-hosted provider processes also receive `AGENT_LAUNCHER`,
`AGENT_LAUNCH_HARNESS`, `AGENT_LAUNCH_MODEL`, and `AGENT_LAUNCH_EFFORT`. The
latter two record the explicit initial selections, with a model alias resolved to
its concrete id when the catalog reports one, and do not change after live model
or effort updates. These markers are launch facts only; they do not alter
instruction placement or implement a compiled boot. They are unprefixed because
the shared child filter strips `YEP_*` — see `topics/ya-env-vars.md`.

The non-Claude prefix has this provider-facing shape:

```text
[Global context]
<effective agent context>

---

<actual first user message>
```

YA's optimistic live echo normally hides the adapter echo as a duplicate. That
presentation behavior does not remove the wrapper from provider history or
raise its authority. The current placement discrepancy and Settings wording
remain tracked in [`gaps/sketches/confusing-settings.md`](../gaps/sketches/confusing-settings.md).

## Provider compaction contracts

### Codex

Pinned Codex source combines host-provided global instructions and discovered
project `AGENTS.md` files into one user-role `AgentsMdState` world-state
section. Manual and pre-turn compaction clear its reference so the next turn
injects the full cached state; mid-turn compaction inserts it before the last
real user message.

That cache is a process/environment-selection snapshot, not a live file
watcher. Ordinary turns do not reread changed or removed files. A cold root
resume, root fork, or changed environment selection loads current sources and
can emit a replacement/removal notice. This is exact reconstruction of the
selected AGENTS snapshot at contextual user authority; it does not protect
arbitrary policy files that AGENTS caused the model to read later.

Codex also rebuilds contextual environment state for each step. In the pinned
source it covers cwd, shell, date, timezone, filesystem and permission context,
and subagent information. `include_environment_context = false` suppresses the
bundle as a whole. No normal model-context injection of Git HEAD/status was
found.

Codex has no verified auto-compaction disable switch. Its default soft limit is
at most 90% of the model context window; setting the limit to zero compacts
immediately. YA may request earlier compaction, but one large turn can still
cross both a soft threshold and the hard context bound.

### Claude Code

Claude Code natively discovers `CLAUDE.md`, not `AGENTS.md`. A repository may
import or symlink AGENTS content from its root CLAUDE file, after which the
CLAUDE loading contract applies.

Anthropic documentation says compaction leaves the system prompt and output
style unchanged; reloads project-root `CLAUDE.md`, unscoped rules, and auto
memory; reloads path-scoped/nested instructions only after a matching file
read; reinjects invoked skills within token caps; and summarizes ordinary
conversation and tool reads. It does not establish the same reinjection
guarantee for user-global CLAUDE.

YA passes `globalInstructions` through the Agent SDK's `claude_code` preset
`append`, so it remains in the system prompt for new and resumed provider
processes. YA does not enable `excludeDynamicSections`. Claude supports that
option to move cwd/platform/shell/Git-presence facts to the first user message,
and separately supports `includeGitInstructions: false`, which also removes
built-in Git workflow text. Those are behavior changes, not free cache knobs.

Claude supports `DISABLE_AUTO_COMPACT=1` for manual-only compaction and
`DISABLE_COMPACT=1` for no automatic or manual compaction. Either still needs a
hard-context recovery path in any YA experiment.

### Other providers

YA's adapters establish current placement for Pi, OpenCode, Grok, Gemini, and
Codex OSS. Their native compaction, fork, and instruction-file durability have
not been verified to the Codex/Claude standard and remain unknown.

## Harness-owned explicit state

Structured state outside transcript history is model-reliable across
compaction only when all three properties hold:

1. an authoritative store independent of summarized messages;
2. fresh model injection or a mandatory model query after compaction/resume;
3. explicit replacement, completion, and clearing semantics.

### Slash commands are not one state mechanism

A `/name` surface may be fixed harness logic, a prompt-backed skill, a
provider-control state update, or a hybrid. Inventory its lasting prompt,
transcript, hook, setting, and provider-state effects separately.

Claude's `/goal`, for example, combines local status/injected turns with a
session-scoped prompt-based Stop hook and a separate evaluator call. Codex
goals are persisted thread state with app-server get/set/clear operations and
hidden model-context fragments for automatic continuation. Conversely,
Codex's `update_plan` emits a historical plan event but has no verified
current-plan world-state reinjection. Similar names do not imply similar
durability.

### Native compaction is not fork-summary compaction

Provider-native compaction can invoke harness-owned reconstruction. Forking a
transcript and asking a new session for a summary is a new-session transition.
It is equivalent only when every provider-owned goal, mode, plan, memory, hook,
and other state family has an explicit carry, replacement, or visible clearing
path.

Pinned Codex demonstrates the distinction: app-server can copy an active goal
to a fork only with `deferGoalContinuation: true`, while YA's current
`createThreadForkParams` does not set that flag. A YA fork may therefore retain
transcript history while dropping provider-owned goal state.

## Routing rules are not routed policy bodies

An always-loaded AGENTS rule can exactly survive compaction while the routed
file it caused the model to read survives only in a lossy summary. Exact
reconstruction of “read `RESEARCH.md` before research” does not prove that an
earlier `RESEARCH.md` read remains exact.

Current agent policy therefore requires routed sources to be reread at the next
governed action boundary after compaction/resume unless the harness verifiably
reconstructs the exact current packet. The optional restoration below tracks
observed file reads within an explicit boundary. It does not infer which policy
topics govern the current task or protect arbitrary routed files.

## Optional instruction restoration

**Settings → Providers → Restore instructions after compaction** enables this
independently for each provider; every provider defaults off. Set an absolute
or home-relative prefix, a relative `.md` pattern (`*` matches within a directory,
`**` across directories), and a delay of 0–10 completed subsequent turns
(default 2). Preview lists canonical matching sources without arming them.
The optional `instructionRestoration` settings field is also the client feature
gate: older servers do not show these controls.

Only local, unsandboxed sessions are supported. All matching uses symlink-resolved
paths inside the configured prefix, including each source named by a packet.
Aliases share an identity; escaped paths are rejected. Enabling the setting
does not grant filesystem access, scan files into model context, or insert
`AGENTS.on-compact.md`.

### Read evidence and approximate completeness

The provider-owned `InstructionRestoration` ledger observes normalized explicit
Read/read_file calls and command arguments, including normalized Codex code-mode
batches. Requests identify candidate paths; successful returned text establishes
read evidence. On resume, YA supplies persisted session-reader data before the
live stream, rather than relying on the worker's short replay buffer. Other
controllers can supply the same `instructionReadHistory` launch option. Hosted
launches transfer it in acknowledged worker-RPC batches, with live observation
held until hydration finishes; transcripts never enter the host's 1 MiB launch
request. Reattaching a retained worker preserves its existing ledger.

At least **80% of nonempty source lines** delivered in the current compaction
epoch is accepted as a sufficient reread. This is a coverage heuristic for the
user's “80% likely full read” allowance, not a calibrated probability. A delivered
head or tail of 100 of 125 lines qualifies. Matching range unions count at the
same file hash; repeated source lines require corresponding output occurrences.
Line-number prefixes and logged command-result JSON are decoded before matching.
Verification can therefore use persisted command output when available, without
asking the agent to repeat the command merely because it used `head` or `tail`.

Partial matching reads arm a source for restoration even below that threshold.
Filenames alone, command success alone, coverage headers, failed reads, streaming
fragments, and subagent-only reads do not establish delivery. Unknown command
syntax is not parsed as shell execution; commands without a recoverable literal
Markdown path cannot establish an association. Missing output remains uncertain.
Truncation only earns credit for the visible matching lines.

### Packets and lifecycle

The source compiler marks essential spans between standalone
`<!-- reread:begin -->` / `<!-- reread:end -->` lines. Direct companions named
`<topic>.mandatory-reread.md` contain that source's essential content. Recursive
companions additionally inline reachable marked sources. Restoration validates
the current full-source and essential-text SHA-256 manifests and inline bodies;
it never trusts coverage headers alone. A recursive read satisfies each included
source independently according to its delivered essential lines.

Each observed compaction rearms previously opened sources. Zero delay restores
at the first completed-turn boundary; N allows N subsequent completed turns.
Compaction and restoration turns do not consume the allowance. Duplicate event
identities count once. The wrapper serializes history, live evidence, and delivery
decisions. File changes invalidate coverage. Missing/stale packets produce a
diagnostic and are not replaced with unrestricted full-file reads.

The provider worker owns the ledger and delivery, independently of Hono or the
browser; the in-process provider path uses the same wrapper. Supervisor supplies
settings, history, and pause state. Disable/path changes clear stale work; pauses
remove still-queued restoration. Ordinary queued user work takes priority.
There is no background idle poll. Enabling on an already live worker begins
observing future reads; a resumed provider reconstructs historical evidence.

### Provider force-read primitive

`AgentSession.configureInstructionRestoration({settings, paused})` and
`forceReadInstructions(sourcePaths)` are available through the provider owner's
controller RPC when its `instructionRestoration` capability is advertised.
The latter validates direct companions and returns `native-history` or
`user-turn`. This controller primitive is usable by other host clients without
the YA web interface; it is not a new unauthenticated control-socket operation.

Native `appendConversationContext` is preferred. Explicit lack of support falls
back to a queued synthetic turn marked `instruction-restoration`, hidden from
ordinary user-turn projections. A thrown/uncertain native insertion is never
retried through that fallback. Acceptance proves transport delivery, not model
consumption. The inserted message says the packet is already in context and
does not need another read in this epoch.

Reads are bounded to 1 MiB per file, 128 armed sources, and 256 KiB per insertion.
Preview stops after 2,000 directory entries or 100 matches. Automatic delivery
makes at most one attempt per epoch; diagnostics require fixing the packet or
configuration before a later epoch or an explicit force-read request.

Tests in `packages/server/test/instruction-restoration.test.ts` exercise the
real provider wrapper, supervisor path, controller RPC, history recovery,
approximate/range/recursive reads, cancellation, and settings persistence.
The client settings and browser tests cover older-server gating, typing during
concurrent updates, and desktop/phone layouts.

## Cache-compatible context

Prompt-cache reuse requires exact prefixes, but correctness outranks prefix
identity. A reusable lineage would need to include provider, model,
effort/thinking, harness/protocol version, base and appended instructions,
tools, plugins/apps, permissions, endpoint/account/cache scope, and all dynamic
fields before the reuse boundary.

Dynamic facts can be omittable and tool-queryable, movable to a later message,
or authority-sensitive and unsafe to repair from a weaker suffix. Codex
app-server exposes cached-token usage but no YA-controlled prompt-cache key or
breakpoint. Cache warmth is an observed outcome, not a current control plane.

## Task transitions and fresh state

When YA reuses or forks provider history, live facts must be refreshed in this
order:

1. provider-native current-world-state reconstruction/diff;
2. same-authority replacement of inherited dynamic instructions;
3. a lower-authority stale-state warning plus mandatory tool check only when
   the higher-level source permits that correction; or
4. rejection of reuse and a cold start.

A suffix saying “check live state” is an instruction to repair, not proof that
a stale higher-authority fact was neutralized.

YA's existing **Queue as New Session Shortcut** offers a clean new session from
the current composer. It has a visible `+` control and no dedicated keyboard
accelerator. Any future chord must reuse the same Project Queue operation and
avoid existing delivery bindings.

## Implications for instruction authors

- Keep action-time read triggers in the always-loaded root source and name the
  governed action plus routed path.
- Treat the trigger and routed file as separate context objects.
- Keep authoritative detail in one routed source; summaries carry provenance
  and essential constraints, not a divergent second policy.
- Put load-bearing text first where a harness may truncate or cap reinjection.
- Use executable hooks/permissions for invariants that must hold independent of
  model memory.
- Preserve exact user constraints at explicit handoff/compaction boundaries
  where wording matters; mark completed requests as history.

## Dormant designs

YA has not implemented or approved the following mechanisms:

- [prepare-only boot manager](agent-context-injection.sketches.md#prepare-only-boot-manager);
- [request-conditioned boot compiler](agent-context-injection.sketches.md#request-conditioned-boot-compiler);
- [protected compaction capsule](agent-context-injection.sketches.md#protected-compaction-capsule);
- [active governed-supplement manifest](agent-context-injection.sketches.md#routing-rules-are-not-routed-policy-bodies);
- optional personal `~/agents` launch integration; or
- a setting enabling any of them.

The sketches companion preserves their proposed protocols, evidence notes,
validation gates, and open decisions. Those sections are candidate design, not
current behavior or authorization to implement.

## Primary evidence

Current claims are grounded in provider documentation, YA adapter code, and
the pinned Codex source under `references/codex`. Key YA entry points are
`packages/shared/src/agent-context.ts` and provider adapters under
`packages/server/src/sdk/providers/`. The detailed source list and observed
trace evidence remain in the sketches companion.

## HTTP v0 bootstrap placement

The default-off **Agent API discovery** setting uses the exact shared
`agentApiBootstrapInstructions` fragment shown in Local Access. Claude receives
it with global instructions in the system-prompt append. API-enabled Claude
launches use `snapshot: false`, including cold resume and prompt-cache keepalive,
so an earlier recorded prompt cannot freeze stale bootstrap guidance.

Codex receives the fragment through `developerInstructions`, preserving effective
operator configuration and sandbox instructions without replacing its base
prompt. A resumed thread also receives an explicit developer history insertion
before user input: the resume configuration override alone does not immediately
replace previously materialized context. The configured fragment is reconstructed
by native compaction. Failed configuration reads or uncertain insertions fail
the launch rather than falling back to a visible user-message prefix.

The fragment is stable across management/peer grants, uses variable references
instead of credential values, and supersedes earlier YA bootstrap guidance.
Agents must obtain current authority from `/v0/me`, advertised access and
capabilities. An instruction or a notice is never evidence of a current grant.
General global instructions keep their existing provider-specific placement;
API reachability remains qualified only for the existing eligible launches.

When a Codex rollout contains the exact native developer fragment, YA exposes
one collapsed **Agent API instructions added** informational row for that entry.
Expanding shows the exact fragment as plain text. Unrelated developer instructions
stay hidden. No notice is invented when retained history lacks that evidence;
raw diagnostic/native history may still include instructions. Existing
informational messages and their optional `details` field carry this notice:
current clients on older servers simply have no new notice, and older clients
on new servers retain their existing informational-row behavior. There is no
new request, capability gate or change to an existing capability's meaning.

Historical Codex user messages and derived titles have only the exact known
YA prefix plus its blank-line delimiter removed for presentation. User prose,
unknown/partial lookalikes and provider-native files stay intact. The correction
also applies to already-persisted summary indexes without flushing or rewriting
them. This does not normalize the separate general `[Global context]` wrapper.

Native no-inference regression scenarios qualify creation, effective Codex
operator instructions, queued compaction, changed-grant cold resume, clean
live input and reopened history/title on pinned Codex 0.167.0 and Claude
2.1.322 / SDK 0.3.322. Earlier probes also established native instruction
channels for Codex OSS (`developer_instructions`), Pi (`--append-system-prompt`)
and OpenCode (message `system`), but YA has not adopted those for general context
or widened API eligibility. Grok/Antigravity ACP extensions and cross-platform
acceptance remain separate qualifications.
See [HTTP v0](http-api-v0.md#local-agent-bootstrap).
