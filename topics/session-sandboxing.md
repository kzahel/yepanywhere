# Session Sandboxing

> A YA session sandbox is a default-off, all-provider launch-time toggle whose
> enabled policy uses host-OS enforcement to keep ordinary persistent
> agent-controlled filesystem mutations inside the canonical session project.
> Fixed YA-private provider-state, cache, and temporary roots support provider
> replay and common tools; provider-native controls are additional defense.

Topic: session-sandboxing

Status: **Linux v1 mechanism implemented.** Local Claude-family and Codex
sessions use trusted Bubblewrap plus a default-on, separately selectable
public-egress network firewall. Local operator authentication is not required;
without it New Session warns (see [Product Decision](#product-decision)).
Persisted browser session material is non-bearer verifier data, and provider
environments exclude YA operator credentials. Other providers,
remote executors, and non-Linux hosts still fail an enabled launch before
provider work begins.

[Durable creation](session-identity.md#creation-consolidation--november-3)
saves requested sandbox policy before preparation; unsupported or unavailable
enforcement leaves a saved failed session without native launch. The actual
prepared private transcript root supplies the native namespace. The private
`session-creation-sandbox-v1` host/worker gate refuses older loaded owners
without an unconfined fallback. Copy admission retains its inherited exact
source/state root. This changes identity/startup ownership, not the supported
Linux enforcement matrix or the threat model below.

**Pending limited-user extension:** the approved
[personal workspace direction](limited-users.md#approved-workspace-direction-2026-09-21-not-implemented)
uses a limited user's configured Create in directory (default `~/username`)
as the default writable root, with project-only confinement as a stricter
choice. Outside reads keep the existing policy. This is not implemented by
the project-write mechanism described below; the
[stand-up integration gap](../gaps/project-template-standup.md) includes its
launch, resume/join and enforcement work.

See also:

- [session-defaults](session-defaults.md) — the saved all-provider value that
  seeds New Session.
- [session-sandbox-network-boundary](session-sandbox-network-boundary.md) —
  public-only IPv4 egress and private host/control-plane isolation.
- [permission-mode](permission-mode.md) — approval policy is independent from
  filesystem confinement.
- [codex-permission-mode](codex-permission-mode.md) — Codex's own coupled
  approval/native-sandbox mapping and live turn boundary.
- [security](security.md) — authenticated, public, and future delegated-access
  trust boundaries.
- [active-content-security](active-content-security.md) — files written by a
  confined agent must remain data when inspected and cannot execute with the
  operator browser's YA authority.
- [subprocess-environment](subprocess-environment.md) — process-creation
  environment and inheritance boundaries.
- [agent-working-directory-tracking](agent-working-directory-tracking.md) —
  the effective project directory must remain explicit.
- [provider-child-sessions](provider-child-sessions.md) — provider-launched
  child work must inherit the parent boundary.
- [bang-commands](bang-commands.md) — YA-owned command execution is a separate
  path and is not automatically covered by a provider process sandbox.
- [remote-hosted-compatibility](remote-hosted-compatibility.md) — clients must
  capability-gate any new launch field against older servers.

## Product Decision

YA should expose one provider-independent **Sandbox session** toggle at new
session creation. Settings > Session Defaults exposes the matching **Sandbox
new sessions** toggle. Both are off by default.

The toggle appears only when the server advertises an actively available
session-sandbox backend and the selected execution target is an implemented
local Claude-family or standard Codex backend. New Session hides it on macOS,
Windows, and other unsupported platforms, for unimplemented providers, and
while a remote executor is selected; those cases get no explanatory
placeholder copy.

On Linux, where the operator can fix the host, a failed preflight instead
shows the **Sandbox session** heading in Advanced options with a one-line
reason in place of the toggle. When the server names a
[blocker](#status-and-evidence) the reason is actionable: the missing packages
to install, or the AppArmor user-namespace restriction to lift. Otherwise it
states the availability state (untrusted or outdated Bubblewrap, a failed
namespace probe, or an older server's auth prerequisite). A limited user sees
no reason, since their fixed launch already states the sandbox, and no case
sends a sandbox field.

Local operator authentication does not gate the sandbox (maintainer direction,
2026-09-27, replacing a launch prerequisite that also refused to relax auth
while a sandbox ran). When local requests need no authentication — no password
or desktop auth, localhost-open on, or `--auth-disable` — and the sandbox is
selected, a warning stays under the toggle regardless of caption visibility:
an agent that reaches YA can drive it and escape, and the network firewall is
what keeps it out.

The toggle has short informational text:

> Limits persistent writes to this project; other host files stay readable.
> Keep installable environments here (e.g. `.venv` or `.pixi`).
>
> Requires Linux + Bubblewrap.

More detailed help may explain that the sandbox also supplies private temporary
and cache space. This is product/UI guidance, not a message injected into the
provider conversation.

The controls are toggles, not level pickers or path-policy editors. The two
conceptual and persisted states are:

```ts
type SessionSandboxLevel = "none" | "project-write";
```

Toggle mapping:

- off — `none` (provider behavior, with no YA filesystem boundary);
- on — `project-write` (Project writes only, plus fixed private
  scratch/cache).

`project-write` means the agent may mutate the selected project tree but may
not mutate filesystem objects outside it. It does not mean read-only, and it
does not by itself constrain reads outside the project. The separately settled
network firewall is selected by default whenever `project-write` is selected;
turning it off preserves the prior shared-network behavior and its captioned
escape risk.

The value is an all-provider session default:

```ts
interface NewSessionDefaults {
  // Existing fields...
  sandboxLevel?: SessionSandboxLevel;
  sandboxNetworkFirewall?: boolean;
}
```

Settings > Session Defaults configures the standing toggle. New Session shows
the effective toggle and lets the user settle it for that session before the
provider process is created. It is not provider-keyed merely because providers
offer different native sandbox mechanisms. The initial scope has no
project-level default; adding one later would follow
[project-settings-overrides](project-settings-overrides.md).

The first version is deliberately one fixed policy, not a path-policy editor.
It has no per-session exceptions for additional writable roots, even when a
session's purpose would make one convenient. Such exceptions would complicate
the security claim, status, persistence, and test matrix before the base
boundary is proven.

The built-in and legacy fallback is `none` until a separate product decision
promotes a sandboxed default. This follows [vanilla-defaults](vanilla-defaults.md):
the feature is visible and selectable, but an absent value on an existing
installation must not unexpectedly change provider behavior.

Configuration precedence is:

1. explicit selection in New Session;
2. `newSessionDefaults.sandboxLevel`; then
3. built-in `none`.

An invalid value is rejected. A requested `project-write` level that the
selected execution host cannot enforce blocks process creation with an
actionable error; it never falls back to `none`.

## Compatibility Boundary

The sandbox setting, launch field, and effective-status fields use the
permanent, dynamically advertised `session-sandboxing` server capability,
introduced in 0.7.1. The additive network selection uses the permanent,
version-implied `session-sandbox-network-firewall` capability. A current client
requires both plus the status capability and an available result before it
shows either control. Without the complete set, it hides both controls, sends
neither field, and retains existing launch behavior. Existing clients omit the
network field; a new server defaults it on only when their requested sandbox
level is `project-write`.

The separate permanent `session-sandboxing-status` capability gates the
structured `version.sessionSandboxing` preflight result. A client requires
both capabilities plus an `available` result before rendering or sending the
control. This deliberately hides the feature against intermediate development
servers that advertised only protocol understanding on unsupported hosts.
Missing status support has the same no-field fallback as a missing sandbox
capability.

Preflight is advisory and cached briefly for routine version reads; it has no
background polling loop. A fresh version request rechecks it. The probe covers
Bubblewrap, `unshare`, `slirp4netns`, the route utility, and a real namespace
setup built from the same Bubblewrap arguments a firewalled Claude launch uses:
the project descriptor bind, private provider-state, cache and temporary
binds, the provider-host runtime mask, and the private resolver mount. It
mounts throwaway directories created under the launch's private-state root
and removes them whether or not the probe passes, so a host whose launches
would all fail at a mount is not advertised as available. Every requested
`project-write` launch repeats the authoritative checks
with the final project, private-state, and network policy. Capability or
preflight staleness must therefore produce a closed launch failure, never an
unlocked provider process.

The pre-implementation stable-release audit covered v0.7.0 and v0.6.2. Neither
release has the YA `sandboxLevel` launch field or capability. The exact routes,
request and response fields, and no-capability fallback are pinned in
`SERVER_CAPABILITIES.sessionSandboxing`.

## Distinct From Permission Mode

Permission mode answers whether a provider or YA asks before a tool action.
Session sandbox level answers what the operating system will allow even after
the action is approved.

The two policies compose by intersection:

- `Bypass` + `Project writes only` auto-approves actions but keeps the project
  write boundary.
- `Plan` + `Project writes only` remains effectively read-only where the
  provider honors Plan.
- A provider denial remains a denial even when the OS sandbox would have
  allowed the write.
- An approval can never widen the OS sandbox.

Prompt instructions, approval callbacks, tool-name deny rules, and setting the
provider `cwd` are cooperative controls. None satisfies `project-write` on its
own.

### Boundary statement in launch context

A sandboxed session's launch context carries a short `[Session sandbox]`
statement of today's boundary, appended to YA's effective agent context
([placement](agent-context-injection.md#current-ya-placement)): the Claude
system-prompt append on every provider process, and Codex's hidden
first-message `[Global context]` prefix. An unsandboxed session gets none. It
states that:

- the sandbox encloses the entire provider process and everything it runs, so
  provider-native "disable sandbox" tool options (Claude's Bash
  `dangerouslyDisableSandbox`) do not leave it, and host-side previews are not
  to be offered;
- writes outside the project fail and `/tmp` is private; and
- with the network firewall, loopback is private, the YA server and other host
  services are unreachable, and a server the agent starts is not reachable
  directly from the user's browser or an SSH forward; printing its
  `http://127.0.0.1:<port>/` URL from a command (for example with `echo`) is
  how the user gets it, since YA takes app URLs only from tool output and
  offers such a URL in the session's App pane through the sandbox's port broker
  ([sandboxed session apps](session-right-pane.md#sandboxed-session-apps)).
  It must not claim to verify host reachability from inside. Without the
  firewall it says only that networking is shared with the host.

It states facts, not policy: it does not discourage serving inside the
sandbox, which is the intended way to show a built app. Motivation: an agent in a firewalled
session (2026-09-28) offered to run a preview "outside the sandbox" with
Claude's Bash option, planned to confirm it with `ss` from inside its own
namespace, and wrote that model into project instructions. The OS boundary
held; only the agent's account of it was wrong.

The statement belongs to the sandbox the user already chose, which is
default-off, so it adds no default behavior under
[vanilla defaults](vanilla-defaults.md). It describes that choice's effect
rather than adding a feature, and it reaches Codex only through the hidden
prefix YA already uses for global instructions. Ordinary denied operations
still surface through normal command/tool failures.

## Additional launch restrictions and instructions

### Claude MCP and connectors

Every sandboxed Claude-family launch disables configured MCP servers and
auto-fetched Claude.ai connectors. Fresh launches, resumes, prompt-cache
refreshes and fork-backed helpers apply the same restriction, including homes
bootstrapped before this feature existed. The SDK receives strict MCP config
with an empty server map, `disableClaudeAiConnectors: true`, an empty server
allowlist, a remote-server deny rule, and `mcp__*` disallowed tools. Ordinary
unsandboxed sessions retain their provider configuration. This restriction is
independent of the editable instructions below.

### Limited-user instructions

Settings → Users lets the superuser edit shared instruction blocks for all
limited users and additional blocks on each user's record. Blocks concatenate
in displayed order with a blank line between nonempty blocks: shared first,
then per-user. Text is preserved; each list permits at most 32 blocks and
10,000 characters in total. Invalid saves fail without truncation. An empty
list deliberately contributes no text. Per-user lists default empty.

The editable shared default is two blocks:

> When using any external image/video generation API or MCP tool, enable the provider's safety filtering at its strictest setting (e.g. moderation="auto", enable_safety_checker=true, safety_filter_level="block_most"). Never disable a safety checker. Prefer providers with server-side filtering.

and an App block (`DEFAULT_LIMITED_USER_APP_INSTRUCTION` in
`packages/shared/src/limited-users.ts`) telling the agent to make what it
builds open from the App button by declaring `.project-template/app.json`
([project service](project-service.md#standard-declaration-where-start-status-stop-serving)),
never by handing over a loopback link the user's device cannot reach
(user-directed 2026-09-28). A test holds its static and server examples to the
declaration schema. A saved shared policy still equal to an earlier shipped
default is upgraded to the current default on load; any edit is kept as
written.

**Start from default**, checked initially, retains the provider's base prompt.
Unchecked requests replacement. Claude uses its preset plus append or a custom
prompt, with prompt snapshots disabled for limited users so relaunches adopt
edits. Codex uses developer instructions for editable text and an empty base
prompt for a newly created replacement session. Codex persists its original
base prompt in saved threads: changing the checkbox requires a new Codex
session; text edits still apply on resume. Forks retain the source base choice.
The UI states this distinction.

Project instruction files (`CLAUDE.md`, `AGENTS.md`), provider-managed policy,
and the sandbox boundary statement remain separate from the base prompt.
These controls neither rewrite those files nor remove their instructions.
The safety text is cooperative guidance, not an OS security boundary.

The session creator selects the per-user list, independent of who later joins
the session. New direct, queued and template-preparation launches resolve the
trusted acting username before provider creation. Resumes, background wakes
and helpers use persisted `createdByUser`. A deleted account cannot silently
resume with its instructions omitted. Saving settings does not mutate a
running process; the next launch resolves current text. The provider worker
receives a per-launch value, never a per-user write to the project-shared
provider home, preventing cross-user prompt contamination.

The permanent `limited-user-instructions` capability covers shared
`limitedUserInstructions: { startFromDefault, blocks }` in `/api/settings`
and `instructionBlocks` in user records and create/update requests. Supported
stable releases 0.9.0, 0.9.1 and 0.9.2 lack these fields. Older servers show no
new controls and receive neither field; existing capabilities keep their
meaning. The maintainer approved this compatibility plan on 2026-09-28.

**Decision:** use provider launch parameters rather than rewriting a sandbox
home's global boot file. Homes are shared by project, whereas these blocks
belong to a principal and must be resolved afresh per process. Native launch
parameters also keep user-editable prompt text distinct from provider config.

## Existing Sandbox Vocabulary

YA already has two related but narrower mechanisms:

1. `SessionSandboxPolicy` in session summaries is a read-only projection of
   Codex `turn_context.sandbox_policy`. It records what a provider transcript
   reported; it is not a YA launch request or enforcement proof.
2. `CodexProvider.mapPermissionModeToThreadPolicy` maps ordinary modes to
   provider-native `workspace-write`, Plan to `read-only`, and Bypass to
   `danger-full-access`. Thread start/resume and each real turn apply both the
   matching approval policy and native sandbox. The mapping remains coupled to
   permission mode and does not define a cross-provider sandbox level;
   [codex-permission-mode](codex-permission-mode.md) owns its next-turn
   contract.

Do not repurpose either as the new source of truth. A later implementation
should keep separate concepts:

- **requested YA sandbox level** — the persisted session choice;
- **effective YA enforcement** — what the execution host actually installed;
  and
- **provider-reported policy** — optional provider-native status, including the
  existing Codex projection.

Process Info should label the last item **Provider-reported sandbox** once YA
also has its own sandbox status, so a `workspace-write` transcript value is not
mistaken for verified host confinement.

## Project-Write Filesystem Contract

### Boundary root

Before process creation, YA resolves and validates the selected project
directory. Enforcement anchors to that canonical directory, not to a textual
prefix and not merely to the child process's current working directory.

If the selected project path is itself a symlink, its target becomes the
canonical root. Replacing or retargeting the path after validation must not
move the active boundary; the backend needs an inode-, mount-, handle-, or
equivalently stable anchor.

### Allowed mutations

The agent-controlled execution domain may create and mutate ordinary files and
directories beneath the canonical project root, subject to normal OS
permissions and the stricter permission/provider policies in effect.

The backend should consume a normalized, canonical writable-root policy rather
than provider- or mechanism-specific path flags. Each root needs an explicit
lifetime:

- **persistent** — host data that survives the session; v1 contains only the
  canonical project root; or
- **private** — sandbox-owned scratch/cache state that is discarded or retained
  under a bounded YA lifecycle and cannot name an arbitrary host path.

The list is an internal enforcement input, not a v1 user-facing path editor.
Every root is resolved before launch and passed to the backend through an
argument-safe API, never concatenated into a shell command.

The write boundary covers at least:

- create, open-for-write, truncate, append, and memory-mapped writes;
- remove, rename, exchange, and move;
- symbolic link and hard-link creation;
- permission, ownership, timestamp, extended-attribute, and ACL changes;
- Unix-domain socket and named-pipe creation; and
- equivalent provider-native edit/write operations that do not happen through
  a visible shell command.

### Denied mutations

The same operations are denied outside the canonical project root, including
when reached through:

- absolute paths;
- `..` traversal;
- a symlink inside the project whose target is outside it;
- a symlinked parent exchanged after validation;
- a helper process, shell, compiler, package script, language runtime,
  provider subagent, or other descendant; or
- a provider's in-process edit tool.

A path such as `project/link-to-home/.ssh/config` is outside the allowed write
tree after symlink resolution even though its first component is inside the
project.

Creating a new hard link across the boundary is denied. A pre-existing regular
file with one name inside and another outside is different: writing either
name mutates the same inode. The first Bubblewrap backend may reject such
multiply-linked project files or document them as an explicit v1 limit; it
must not claim that a mount-path policy can discover which existing link is
the “outside” object.

Reads outside the project remain permitted in this first level. The UI must say
so; **Project writes only** is not a confidentiality boundary.

### Runtime state and scratch space

Provider CLIs commonly write transcripts, caches, sockets, and state outside
the project. A whole-process sandbox that simply makes every other host path
read-only may therefore break startup or resume, while a broad exception for
the provider's home directory gives agent-controlled children a bypass.

Ordinary scripts also assume writable temporary and cache locations. The
enabled v1 policy provides fixed, sandbox-private writable locations and
redirects `TMPDIR`, `TMP`, `TEMP`, `XDG_CACHE_HOME`, and established
HuggingFace, pip, uv, npm, and Yarn cache variables to them. A later backend
may mount a private writable view over conventional cache paths such as
`~/.cache` when that is more compatible than environment rewriting. These
roots must be:

- private to one canonical project sandbox or an equivalently isolated
  execution domain;
- retained under YA's data directory so every sandboxed session and fork for
  that project remains replayable across server restarts;
- unable to resolve, rename, link, or mount their way to host-persistent paths;
  and
- reported as private scratch/cache rather than as another persistent writable
  root.

Globally shared persistent caches are not part of v1. They add cross-project
poisoning, quota, ownership, and cleanup questions. V1 does share its private
cache among sandboxed sessions for the same canonical project; the project
boundary is the isolation and retention unit.

Conda, Pixi, and similar environments need the same distinction. An
environment beneath the project is already writable. An environment outside
the project remains read-only unless a backend can present a private writable
overlay or copy to that session. YA must not grant write access to a shared
external environment merely so package installation succeeds: replacing code
that the owner later executes would be a durable boundary escape. Package
installation into an outside environment may therefore fail on a backend that
cannot isolate it.

An acceptable backend must resolve that control-plane/tool-plane tension
explicitly. Possible shapes include:

- provider cooperation that sandboxes tool/edit execution below an
  unsandboxed control process;
- a broker that owns provider persistence while the provider execution domain
  stays confined;
- private per-session runtime state that is writable by the control plane but
  not addressable by agent tools; or
- a stronger OS process split.

Linux v1 gives each canonical project that has used sandboxing one YA-owned
private provider-state, temporary, and cache root beneath the YA data
directory. Its stable key is derived from the canonical project path and is
persisted in session metadata so a YA server restart keeps using the same
state. Claude and Codex have separate provider subtrees within that root:
Claude receives a private `CLAUDE_CONFIG_DIR`; Codex receives a private
`CODEX_HOME`.

A path a sandboxed session prints under `/tmp` or `/var/tmp` therefore names
a file in that private root, not the host's. The session-scoped file doors
(`/api/sessions/:id/local-file`, `/local-image`, and the interactive preview
grant `POST /api/sessions/:id/artifacts`) read a path as its session sees it:
those two prefixes map to the session's private temp directories, except
inside the project, which the sandbox binds at its own path. Artifact reads
admit every sandbox's private temp directories, never the provider state or
cache beside them. The host-wide doors keep reading host paths. Limited-user
confinement of these doors is in [limited users](limited-users.md).

Those provider trees contain the authoritative live transcripts. Each session
and explicit fork still has its own provider transcript file; they share the
project's provider configuration, agents/skills, cache, and temporary space,
not one JSONL. YA does not copy or append a concurrently written JSONL into the
provider's global tree.

The first initialization bootstraps a narrow provider-specific set of auth,
configuration, plugin, rule, and skill entries. Regular mutable files are
copy-on-write filesystem clones when supported, with a normal-copy fallback.
They are never hard links: a hard link would be the same inode and would grant
the sandbox write access to the original. Symlinks may be preserved for
deliberately read-only assets; the Bubblewrap contract keeps an outside target
read-only, and the regression suite verifies both the target and bootstrap
source remain unchanged. Session transcripts, logs, cache, and temporary files
start private rather than being linked from global state.

When bootstrapping a new private home, relative symlinks are anchored to the
real source parent, even if `CLAUDE_CONFIG_DIR` or `CODEX_HOME` is itself a
directory symlink. Top-level config/skill links and links inside copied plugin
directories retain their original targets. They remain symlinks: bootstrap
does not turn an outside read-only asset into a private writable copy. Existing
initialized homes retain their configuration; bootstrap does not overwrite
them on resume.

The Claude login is the one exception to private copies. Claude rotates
its refresh token on every refresh and the old one stops working. A copied
`.credentials.json` therefore failed as soon as the host refreshed, and
every later launch of that sandbox, whoever resumed it, failed with "OAuth
session expired and could not be refreshed". A sandbox that refreshed
first logged the host out instead. Every Claude launch now bind-mounts the
host's `.credentials.json`, writable, over the private path, including
sandboxes that already hold a stale copy. With one shared login, whichever
side refreshes, the other re-reads the new tokens. With no host credentials
file, nothing is mounted. The sandbox gains write access to the host login
it could already read; that exposure, Codex's still-copied `auth.json`, and
a proposed optional read-only mode with YA-brokered refresh are in the
[shared credentials gap](../gaps/sandbox-shared-provider-credentials.md).

A generic writable exception for the real `$HOME`, provider state directory,
`/tmp`, cache root, or shared language environment is not equivalent to
Project writes only. If a provider cannot function with the private-state
shape, it is unsupported for this level until the boundary is redesigned.

Project-local temporary/cache directories may be used when doing so preserves
provider behavior and does not rewrite unrelated user configuration.

### Session environment bridge

A sandboxed session's Bash tool shells read `AGENTCTL_SESSION_ID` and the
other session-scoped outputs from YA's `BASH_ENV` bridge
([subprocess environment](subprocess-environment.md#shell-startup-contracts)),
the same as an unsandboxed session. The bridge lives in host temp, which the
private `/tmp` hides, so each Claude or Codex launch mounts its own bridge
directory, and no other, read-only at `/run/ya-agentctl-session` inside the
sandbox's private `/run`. It is a directory mount, so an id the server
publishes after the provider started, or a later replacement of it, reaches
the next shell. A resumed launch's shells see its id at once. The sandbox
cannot write the bridge, and other launches' bridges and host temp files stay
hidden.

### Future global transcript integration

V1 keeps Claude and Codex transcripts in their project-private provider-state
directories and merges those directories into YA's ordinary session readers.
This preserves one authoritative file while providing list, detail, replay,
resume, and same-session process recreation after a YA server restart.
Every project read carries its Claude sandbox transcript directories among
its merged session directories, joined per read rather than cached, so a
sandboxed session appears in the project's session list and count, the
All Sessions and sidebar catalog, and the focused-session watcher after its
process stops, exactly as a host-tree session does. Codex sandbox roots
reach the same lists through the Codex reader's own file listing.

A follow-up should continuously integrate sandboxed Claude and Codex
transcripts into each provider's conventional global session tree. Besides the
main YA view, that makes provider-native discovery, external diagnostics, and
manual session identification work normally. Do not implement this as an
assumed-safe copy or second writer. First establish each provider version's
actual locking and persistence protocol using available source plus targeted
decompilation and `strace`/`truss`-style filesystem tracing. The evidence must
cover open flags, advisory or mandatory locks, append behavior, rename/replace,
flush and close boundaries, sidecar/index files, crash recovery, and concurrent
reader behavior. The integration design must then preserve the provider's
single-writer and lock semantics while a transcript is live, and its regression
tests must detect provider upgrades that invalidate those findings.

There is also a retention-policy knowledge gap. YA does not yet know what
sunset, age, total-disk, per-session quota, compaction, or index-pruning policy
Claude and Codex currently apply to their global session state, nor what a
future harness release may add. Private v1 transcripts are deliberately outside
those conventional trees, which reduces their exposure to provider rotation;
YA's private-state retention policy is therefore a separate decision. V1 keeps
that state rather than aging it out automatically and may report its disk usage.
Before later publishing transcripts into conventional provider trees, establish
how provider cleanup recognizes live, indexed, and removable state so that the
integration does not make a replayable sandbox session unexpectedly eligible
for provider rotation.

## OS Enforcement Contract

The quality target is basic OS-enforced containment: the kernel or another OS
security primitive makes the decision, rather than instructions asking the
model to behave. Plain `chroot` is not the target or a security boundary. The
policy preserves outside reads and is not represented as hostile multi-tenant
container isolation.

Linux v1 uses Bubblewrap. A future non-Linux backend may use a restricted
process launcher, filesystem policy, namespace/container helper, capability
system, or another native facility. Regardless of mechanism, it must:

1. install the restriction before provider- or agent-controlled code runs;
2. apply to direct edits and every descendant execution path;
3. be non-widenable by the child, its permission mode, or later prompts;
4. close or narrowly account for inherited writable file descriptors;
5. prevent path-resolution, symlink-swap, mount, and rename escapes within the
   claimed filesystem contract;
6. report setup success from the execution host rather than assuming it from a
   requested flag;
7. fail process creation closed when setup is unavailable or incomplete; and
8. clean up per-session mounts, namespaces, helpers, and runtime directories
   after termination without leaving a privileged background process.

The sandboxed execution domain must also have no path back to the host
identity's privilege-escalation authority. This includes `sudo` under a
passwordless sudo policy, setuid/setgid executables, file capabilities,
retained capabilities, and inherited control sockets or file descriptors that
can ask an unsandboxed YA process to act on its behalf. A backend may use a
separately installed, narrowly scoped privileged helper, but the
agent-controlled child must not be able to widen or directly invoke that
authority.

Whole-YA privilege hardening is a separate precaution: YA should attempt to
disable later privilege gain by default, with an explicit operator opt-out,
even when every session selects `none`. It is therefore not part of the
meaning of `project-write`. Linux v1 drops capabilities and installs
no-new-privileges for the sandboxed provider domain; applying the precaution
to the already-running YA server and every unsandboxed provider launch remains
separate work.

For an SSH or other remote executor, enforcement must be installed and
attested by the remote execution host. Sandboxing the local SSH client does not
confine the remote provider.

Provider-native sandboxing is welcome as defense in depth and may be necessary
to cover provider-internal edit APIs. It does not replace the OS-enforcement
requirement, and YA must not claim `project-write` merely because a provider
accepted a flag named `workspace-write`.

## Session Lifetime

The selection is settled before the first provider process is created and
persisted as session-scoped metadata. Every process creation for that session,
including idle resume and crash recovery, must reapply the same level before
the provider receives work.

The level is not a live toolbar toggle. Changing the write boundary of a
running process would create an ambiguous interval and provider-specific
state. A different level requires a deliberately created replacement session
or another future restart flow that terminates the old process before applying
the new boundary.

Existing sessions with no stored value resolve to `none`. A process discovered
as externally owned has no verified YA sandbox level, even if its provider
transcript reports a native sandbox policy.

New-session derivatives must not silently weaken confinement:

- an explicit transcript fork, clone (including a `/btw` aside),
  fork-after-summary target, retitle helper, recap fork, handoff, or
  restart-as-new flow inherits the source level;
- a new session started from a session's composer (start now or Project
  Queue) and a Source Review session opened from a session carry the
  source's level and firewall, which session payloads report as
  `sandboxLevel`/`sandboxNetworkFirewall`; from the composer the sandbox
  follows to another provider that can run inside it and is refused for one
  that cannot, and the composer refuses while the source has not loaded
  (plan 183);
- an explicit fork cannot override the source level;
- a separately created New Session settles its own visible pre-launch choice;
  and
- resuming the same session uses its persisted level, not the user's newer
  global default.

The supervisor enforces the last rule itself rather than trusting each caller
to restate the level. Every resume or reactivation of a session whose metadata
records `project-write` launches with that level, its firewall selection,
state key and sandbox project path. That covers internal relaunches that name
no sandbox: wake, heartbeat turns, deferred messages after a hard abort, and
effort or provider restarts. A request that names `none`, or turns off a
recorded firewall, is refused rather than applied, whoever makes it, including
through `POST …/reactivate`. A weaker boundary takes a new session.

Provider children created beneath the provider process inherit its Bubblewrap
namespace. Same-session process recreation reloads the persisted level and
private state key. Every derivative for the same canonical project uses that
project's same private provider-state root while its provider-native transcript
file remains distinct.

Linux v1 runs explicit transcript forks, retitle-via-fork, fork-summary
generation and target creation, and fork-mode recaps through the inherited
private provider-state launcher. A clone of a sandboxed Claude session copies
its transcript verbatim from and into that project's private transcript
directory and records the source's level, firewall, state key and project
path, so the readers that merge that directory list and open it. Host-side
Claude transcript copying opens the private transcript directory component by
component without following agent-controlled symlinks, and never writes
through a link or over an existing file. YA-simulated `side-session` recaps remain
unavailable and are rejected before launch; Off, Native, and fork recaps remain
available.

## Status And Evidence

A requested value is not enough for security-facing UI. The server exposes a
normalized host-availability concept before launch:

```ts
interface SessionSandboxAvailability {
  state:
    | "available"
    | "auth-required"
    | "unsupported-platform"
    | "missing-bubblewrap"
    | "untrusted-bubblewrap"
    | "unsupported-version"
    | "probe-failed";
  platform: string;
  backend?: "bubblewrap";
  version?: string;
  localAuthEnforced?: boolean;
  blocker?:
    | { kind: "missing-packages"; packages: SessionSandboxHostPackage[] }
    | { kind: "userns-restricted" };
}
```

`localAuthEnforced` reports whether local YA requests currently require
authentication; `false` drives the New Session warning and never blocks.

`blocker` names the host fix when the probe can identify one, from a fixed
vocabulary only: the version route is readable before authentication, so raw
probe output never crosses it. `missing-packages` lists every absent package
(`bubblewrap`, `slirp4netns`, `util-linux`, `iproute2`) at once, so one install
clears it. `userns-restricted` means the namespace probe failed while
`kernel.apparmor_restrict_unprivileged_userns` is `1` (the Ubuntu 23.10+
default). Bubblewrap ships its own AppArmor exemption there; the network
firewall's `unshare` helper does not. Older servers omit the field, and a
client then names Bubblewrap for `missing-bubblewrap`.

Only `available` permits the `session-sandboxing` capability. `auth-required`
comes only from servers before 2026-09-27, which withheld the sandbox when
local authentication was absent; current servers report `available` with
`localAuthEnforced: false`. Separately, an enabled
process exposes normalized enforcement evidence:

```ts
interface SessionSandboxEnforcement {
  requested: SessionSandboxLevel;
  effective: SessionSandboxLevel;
  state: "enforced" | "unsupported" | "setup-failed";
  hostBackend?: string;
  providerPolicy?: string;
  networkFirewall?: boolean;
}
```

- configured vs. active;
- YA host enforcement vs. provider-reported policy; and
- local vs. remote execution host.

The namespace probe establishes the complete filesystem and default network
mechanism, and every launch repeats it. The supervisor derives each new or
resumed process's sandbox request in one place for the real and provider
create and start paths; fork keeps its own. One process-to-metadata serializer owns level, firewall selection, state
key, project identity, and provider identity for ordinary persistence,
reactivation, and provider-created helper forks. A requested confined session
must never launch with only part of the claimed boundary.

The server persists the requested level, project-scoped state key, canonical
project path, and effective backend status. It does not expose or persist the
full provider or Bubblewrap command line as sandbox status.

## Threat Model

Assume a frontier model or agent-generated program may intentionally search for
an escape, and that model competence will improve. Cooperative prompting is
not a control.

The initial level protects one narrow asset: filesystem integrity outside the
session project against ordinary agent-controlled filesystem mutations. It
trusts:

- the host kernel and selected enforcement primitive;
- the trusted `unshare`, `slirp4netns`, and route helpers;
- YA's pre-exec launcher and policy construction;
- the canonical project root supplied by the authenticated owner; and
- any privileged helper that the selected backend requires.

It does not promise protection against:

- kernel or sandbox-primitive vulnerabilities;
- reads or secret disclosure outside the project;
- network exfiltration or mutation through remote APIs;
- pre-existing writable file descriptors or privileged IPC unless the backend
  explicitly closes/blocks them;
- pathname Unix sockets outside the backend's private runtime/temp roots and
  explicitly masked provider-control directory;
- devices and kernel interfaces outside the ordinary filesystem policy;
- a compromised YA server or authenticated owner; or
- hard-linked files, nested mounts, and other aliasing cases until the chosen
  backend's contract and tests define them.

These are not reasons to replace OS enforcement with warnings. They are the
line between a useful basic project-write boundary and a product claim of
general host isolation.

## Future “Locked To This Session” Share

The motivating future surface lets a novice or delegated guest interact with
one session/project pair without receiving ordinary authenticated YA access.
Project-write confinement is a prerequisite for that surface, not the whole
authorization design.

Before a share may be described as **locked to this session**, it must also:

- admit requests only to one exact session and project;
- require the session's sandbox status to be actively `enforced`;
- prevent navigation and API access to other sessions, projects, settings,
  devices, host diagnostics, and source-control surfaces;
- make any guest-visible YA-owned execution path, including `!!` commands,
  run inside the same boundary or remain unavailable;
- define whether the guest may answer approvals, interrupt, restart, upload,
  or create files;
- be revocable and auditable; and
- state plainly that Project writes only still permits outside reads and
  public remote network access.

If the future guest threat model includes confidentiality or malicious
prompting, it needs a stronger level that restricts reads, network, IPC, and
host APIs. Do not overload `project-write` or its UI copy to imply those
protections.

This future share is distinct from today's public read-only bearer links. It
requires a new authenticated/delegated admission contract and must not turn an
existing public-share secret into session write authority.

## Verification Contract

Deterministic backend tests must attempt real mutations, not only inspect
configuration:

- a normal create/edit/delete inside the canonical project succeeds;
- absolute and relative writes outside fail;
- a project-local symlink to an outside file or directory cannot be used to
  mutate it;
- rename, new hard-link, metadata, and memory-mapped write variants cannot
  escape;
- a pre-existing hardlink alias is either rejected at launch or reported as a
  known unenforced case rather than counted as protected;
- descendant shells, package scripts, provider children, and direct provider
  edits receive the same boundary;
- inherited descriptors and writable IPC do not provide an undeclared escape;
- permission mode Bypass cannot widen the boundary;
- provider transcript/state persistence and same-session resume still work;
- the production launch policy works with Bubblewrap 0.4.0 and does not assume
  an unprobed newer option;
- unsupported local and remote hosts fail before the first provider turn;
- macOS, Windows, missing, untrusted, outdated, and runtime-unusable
  Bubblewrap preflights do not advertise the usable capability;
- a missing `bwrap` error names Bubblewrap and includes the detected
  distribution's installation command, while a failed runtime probe reports
  its different cause;
- setup failure leaves no provider child or privileged helper running; and
- the server reports requested/effective/backend state accurately.

Keep an outside sentinel tree and verify its contents and metadata are
byte-for-byte unchanged after the escape suite. Add adversarial agent runs as
supplemental evidence, not as a replacement for syscall-level tests: a model
failing to discover an escape does not prove the boundary.

The current automated Linux baseline in
`packages/server/test/session-sandbox.test.ts` executes the production
Bubblewrap wrapper. It proves project, provider-state, and temporary writes
succeed while direct outside writes, project-to-outside symlink writes, and
bootstrap-symlink writes fail. It also proves that each provider launch mounts
the already-open project directory descriptor, refusing a launch when the
configured pathname has been renamed and replaced after preflight. It verifies
copied configuration has a different inode, missing, untrusted, and unusable
Bubblewrap diagnostics stay distinct,
relative config/skill/plugin links from symlinked Claude and Codex homes remain
readable while outside target writes fail,
unsupported providers and remote executors fail, project state keys are
stable, Claude forks create separate JSONL in the inherited private root,
agent-controlled transcript-directory symlinks are rejected, and persisted
metadata reconstructs a replayable private reader after service reload.
The escape case also verifies no-new-privileges, empty effective and permitted
capability sets, and refusal to create an outside-file hard link through the
writable project mount. A localhost integration case reads persisted session
verifier material from inside the real Bubblewrap domain, verifies that YA
operator credentials are absent from the provider environment, and proves the
verifier receives 401 rather than operator authority. Network cases verify
public IPv4 DNS and routing; deny private and IPv6 routes, loopback, the slirp
host alias, and the host's concrete IPv4 address; isolate host abstract
sockets; and mask an explicitly configured provider-host runtime directory.
Bridge cases run Bash inside one long-lived sandboxed process before and after
publication and after a replaced id, for fresh and resumed launches, including
through the Claude and Codex adapters' own spawn paths, and verify that
another bridge and unrelated host temp files stay hidden.

## Linux Backend Evidence

The dated Rocky 8 mechanism survey, Bubblewrap source notes, and rejected
backend candidates live in
[`session-sandboxing.evidence.md`](session-sandboxing.evidence.md). Read that
evidence before changing the Linux backend, its minimum Bubblewrap version, or
the Rocky/RHEL support claim. The product contract and current backend decision
remain below.

### Linux v1 decision

Linux v1 requires trusted non-setuid Bubblewrap 0.4.0 or newer plus trusted
`unshare`, `slirp4netns`, and `ip` helpers. Use it when the version check and
complete runtime probe pass; otherwise fail an enabled launch before provider
process creation with an actionable error. Absence of `bwrap` includes an
installation command, while an old version, missing helper, or failed runtime
probe names the relevant prerequisite.

Never substitute provider cooperation, plain chroot, PRoot, or an unlocked
process merely because Bubblewrap is missing.

The implemented provider matrix is intentionally small:

- local `claude`, `claude-gateway`, and `claude-ollama` sessions use the
  Claude private-state launcher;
- local standard `codex` sessions use the Codex private-state launcher;
- `codex-oss`, Gemini, OpenCode, Grok, Pi, ACP, and other providers reject
  `project-write`;
- SSH/remote executors reject it because confinement must run on the remote
  host; and
- non-Linux hosts reject it until a backend satisfies the same contract.

YA accepts only root-owned helper binaries at fixed system paths that are not
group- or world-writable. Host preflight checks the paths, Bubblewrap version,
and real filesystem/network namespace policy before advertising availability.
The launcher then probes the complete final shape with `/bin/true` before it
starts the provider. The enabled process gets a read-only host root, writable
canonical project and private state binds, private `/tmp` and `/var/tmp`, a
private `/run`, new process/device/network views, public-only IPv4 egress, a
dropped capability set, a new terminal session, parent-death coupling, and
sanitized broker environment variables. The argument set is exercised against
Rocky 8's Bubblewrap 0.4.0. Each provider launch opens and identity-checks the
project directory, mounts that descriptor rather than resolving the pathname
again, and changes to the project only after the mount is installed. Explicit
network-firewall opt-out retains the same filesystem policy with shared host
networking, so operator-chosen local authentication (warned about when absent)
and non-bearer persisted session verifiers remain defense in depth for every
project-write session.

## Backend Integration Gate

Before changing the Bubblewrap policy or adding a future platform backend,
validate it on:

- unprivileged availability and installation burden;
- Linux, macOS, Windows, and remote-host coverage;
- symlink/rename/mount/file-descriptor semantics;
- direct provider edit and descendant inheritance coverage;
- provider transcript, cache, and resume compatibility;
- whether a privileged long-lived daemon is required;
- auditable setup success and fail-closed behavior; and
- maintenance risk as kernels and provider launch paths evolve.

Record each chosen backend and provider matrix here before code claims
`project-write`. A provider-cooperative-only prototype may be useful for
learning, but its UI/status must say provider policy rather than YA-enforced
Project writes only.

## Open Questions

- Which OS primitive gives the simplest reliable write-only boundary on
  non-Linux platforms without a privileged always-on daemon?
- Can provider control-plane state be separated from agent-controlled tool
  execution for every provider YA launches?
- Should a later stronger level hide outside reads and disable network, or
  should those be independent capabilities?
- How should ordinary repositories, linked worktrees whose Git directory is
  outside the project, nested mounts, and pre-existing hard links behave?
- Which temporary/cache locations can be made project-local without changing
  provider semantics?
- What exact admission, approval, and audit contract should the future locked
  share use?
