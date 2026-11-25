# Provider profile directories

Status: direction agreed, not started, 2026-09-21. No implementation exists;
this document records the vetted design so implementation can begin from it.
Contributing-model: fable-5-1.

See also: [session boot instructions](../../topics/session-boot-instructions.md),
whose per-client Codex boot homes link `sessions/` back to the operator's
home; its design decisions record why that differs from the rejection below.

The separately opted-in
[Agent Auth Router integration](143-agent-auth-router-integration.md) now plans
router-owned account pools and balancing behind YA's native client runtimes.
This plan remains the direct-CLI profile path: separate homes, no credential
reads/copies in YA, and no automatic profile switching. The router proposal
does not replace these direct-profile semantics or establish cross-account
conversation continuation.

## Problem

Yep Anywhere runs every Claude session against one Claude Code state
directory, and every Codex session against one Codex home. A user with more
than one subscription (for example work and personal) has no supported way to
choose which account a session uses. The prior workaround outside YA copied
and restored credential blobs, which fails because Claude Code rotates the
refresh token: saved snapshots go stale and restoring them with `--force`
risks reinstating an already-rotated credential.

Both CLIs officially support an environment variable that selects a complete,
isolated state namespace: `CLAUDE_CONFIG_DIR` for Claude Code and `CODEX_HOME`
for Codex. Each directory holds its own credentials, settings, skills,
plugins, and session transcripts. Separate directories also allow concurrent
sessions on different accounts without two processes rewriting one shared
credential.

## Decision

Support user-configured **profile directories** per provider. A profile is a
named, enable-able directory that the provider's CLI treats as its home. A
session is created under exactly one profile and stays bound to it for its
whole life. YA never reads, copies, or rotates credentials. It only chooses a
directory and lets the official CLI own authentication.

Explicitly rejected:

- Credential copying, Keychain reads, or `CLAUDE_CODE_OAUTH_TOKEN` per
  profile. Setup tokens are inference-only and cannot establish Remote Control
  sessions or fetch claude.ai connectors, so isolated full logins are the more
  capable default. The parked note in
  [`topics/copilot-oauth-claude.md`](../../topics/copilot-oauth-claude.md)
  stays parked.
- Symlink "shadow home" overlays that share transcripts between accounts while
  keeping only `auth.json` private, as t3code does for Codex
  (`docs/competitive/t3code.md`). They mutate the user's real directory tree,
  break when the CLI changes its layout, and are not available for Claude on
  macOS anyway because its credentials live in Keychain keyed by config
  directory. Fully separate homes are simpler and equally supported.
- Any automatic profile selection or failover driven by usage percent. YA
  shows the numbers; the user picks. This keeps the feature inside the posture
  in
  [`docs/research/anthropic-tos-compliance.md`](../research/anthropic-tos-compliance.md).

## Consequences accepted

- Transcripts live under the profile directory (`<dir>/projects/` for Claude,
  `<dir>/sessions/` for Codex). Session discovery must scan one root per
  enabled profile, and resume must use the recorded profile.
- Skills, plugins, `settings.json`, and `CLAUDE.md` are per profile. Users who
  want them shared can symlink those entries themselves; YA does not manage
  that.
- Each profile needs its own browser login once, and again when its refresh
  authorization expires. Inactive profiles are not kept warm.

## Design

### Settings model

`ServerSettings` gains a per-provider profile list, roughly:

```ts
providerProfiles: {
  claude?: ProviderProfile[];
  codex?: ProviderProfile[];
};
interface ProviderProfile {
  id: string;        // stable slug, never reused
  name: string;      // display name
  dir: string;       // absolute path; `~` expanded on the server
  enabled: boolean;
  accentColor?: string;
}
```

An implicit `default` profile always exists per provider and resolves to the
CLI's normal home (`CLAUDE_CONFIG_DIR` from the server environment, else
`~/.claude`; `CODEX_HOME`, else `~/.codex`). It cannot be removed or
disabled. Sessions without a recorded profile are the default profile, so
existing data needs no migration.

Disabled profiles remain in settings but are hidden from the selector and
skipped by the scanner. Removing a profile never deletes its directory.

Which providers offer profiles is a per-provider capability in the provider
layer. Only providers whose CLI supports a home-directory variable advertise
it; Claude and Codex first.

### Settings UI

A "Profiles" block per supporting provider in `ProvidersSettings.tsx`, beside
the existing per-provider toggles such as legacy Claude models. It lists
profiles with name, directory, enabled switch, auth status, and remove. An
add form takes a name and a directory. A profile whose directory is not yet
logged in shows the login command in the existing `withLoginCommand` style,
for example `CLAUDE_CONFIG_DIR=~/.claude-profiles/work claude auth login`.

### Session creation

`CreateSessionBody` in `routes/sessions.ts` gains an optional
`providerProfileId`. `NewSessionForm.tsx` shows a profile selector only when
the chosen provider has more than one enabled profile and the executor is
local. The default profile is preselected so the form looks unchanged for
users with no extra profiles. The model cards keep showing subscription usage,
now for the selected profile.

Remote SSH executors hide the selector in the first version. Profile
directories are local paths; a per-executor path mapping can come later.

### Spawn

`getEnv()` in `sdk/providers/claude.ts` sets `CLAUDE_CONFIG_DIR` from the
session's profile; the Codex provider does the same for `CODEX_HOME`, which
it already sets from `config.codexHome`. The sandbox bootstrap in
`session-sandbox.ts` copies its seed entries (`.credentials.json`,
`settings.json`, `plugins`, `skills`, and the Claude global config file) from
the profile directory rather than the process-level environment. Verify where
Claude Code places `.claude.json` when `CLAUDE_CONFIG_DIR` is set before
relying on the current `~/.claude.json` assumption.

### Session discovery and binding

`CLAUDE_PROJECTS_DIR` in `projects/paths.ts` and `CODEX_DIR` in
`projects/codex-scanner.ts` are module constants evaluated at import. They
become lists of roots derived from settings, refreshed when the profile list
changes without a server restart. Roots are deduplicated by directory
identity so a profile pointing at the default home is scanned once.

Every discovered session records its `providerProfileId`. Projects merge by
working directory across roots. The `CLAUDE_SESSIONS_DIR` test-isolation
override keeps working as the default root's override only.

Resume, fork, clone, and restart always use the recorded profile, never the
current default. A resume under the wrong home fails silently as "session not
found" from the SDK, so this binding is the most important invariant. Cross-
profile fork is rejected in the first version.

### Session info

The session detail payload includes `providerProfileId` and the resolved
display name from the first version, and the session info modal shows it.
A profile badge on session cards and a profile filter in the all-sessions
list are deferred; the recorded id and accent color make them cheap later.

### Auth status and usage

Auth status and subscription usage already exist per provider. Both become
per profile by running their probe under the profile's environment.
`GET /api/providers/:name/subscription-usage` gains a profile parameter, and
`useProviderSubscriptionUsage` caches by provider and profile instead of
provider alone. Probes spawn a CLI process, so fetch lazily for the selected
profile with the existing refresh semantics; never probe every profile on
page load.

Account identity (email, subscription type) should come from the SDK init
message rather than credential files. This retires the hardcoded
`~/.claude/.credentials.json` existence check in `claude.ts`, which is already
wrong under `CLAUDE_CONFIG_DIR` and on macOS Keychain.

### Capability advertisement

A `providerProfiles` bit in `OPTIONAL_SERVER_CAPABILITY_BIT_ALLOCATIONS`
(`packages/shared/src/server-capabilities.ts`) gates the settings block, the
selector, and the session-info field. A frontend talking to an older server
treats every session as the default profile and shows nothing new.

## Steps

### 1 — settings model and capability bit

Add `providerProfiles` to `ServerSettings` with validation, the implicit
default profile, and the capability bit. No UI yet.

### 2 — spawn under the recorded profile

Thread `providerProfileId` through session creation, persistence, and
`getEnv()` for Claude and Codex, including the sandbox seed source. Resume,
fork, clone, and restart reuse the recorded id.

### 3 — scan every enabled profile root

Replace the import-time root constants with settings-derived root lists,
attribute discovered sessions to profiles, and expose the id in session
detail.

### 4 — per-profile auth status and usage

Parameterize the auth and usage probes and the client cache by profile.

### 5 — settings UI and new-session selector

Profiles block in `ProvidersSettings.tsx`; selector in `NewSessionForm.tsx`
with per-profile usage on the model cards.

### 6 — documentation

Owning contract in a `topics/` document covering profile semantics, the
resume-binding invariant, the per-profile-state consequence, and the
login flow. Update `docs/development/local-development.md`, whose
`CLAUDE_CONFIG_DIR` note becomes the description of the default profile.

## Constraints and related material

- [`docs/tactical/075-session-fork-clone-unification.md`](075-session-fork-clone-unification.md)
  forbids overriding `CLAUDE_CONFIG_DIR` or `CODEX_HOME` in smoke tests so the
  real CLIs keep their authentication. That remains true for the default
  profile; tests of extra profiles must use disposable directories they log
  in themselves or mock.
- [`topics/provider-subscription-usage.md`](../../topics/provider-subscription-usage.md)
  owns the usage window contract that becomes per profile.
- [`topics/session-usage-accounting.md`](../../topics/session-usage-accounting.md)
  reads transcripts from `{CLAUDE_CONFIG_DIR}/projects/` and must follow the
  session's profile root.
- [`gaps/sandbox-harness-instruction-read-access.md`](../../gaps/sandbox-harness-instruction-read-access.md)
  concerns the same sandbox seed copy that step 2 reroutes.
- [`topics/session-sandboxing.md`](../../topics/session-sandboxing.md) owns
  the private per-session `CLAUDE_CONFIG_DIR` and `CODEX_HOME` the sandbox
  already bootstraps, including symlink anchoring. Step 2 changes only the
  seed source of that bootstrap; the contract for the private tree stays.
- The virgin-session sketch, now [session boot instructions](../../topics/session-boot-instructions.md),
  sketches a YA-owned `CODEX_HOME` replica and a second Codex scanner root.
  Step 3's settings-derived root list should absorb that need rather than
  adding a special-cased root, and the sketch's symlink-sessions-back
  alternative is rejected here for the same reasons as the shadow home.
- [`topics/gateway-services.md`](../../topics/gateway-services.md) exports
  `ya-<id>.settings.json` and `ya-<id>.config.toml` into the Claude config
  dir and Codex home. Decide in step 1 whether the export targets every
  enabled profile or documents itself as default-profile only; the plan
  leans to every enabled profile so a work-profile session can use the same
  gateway services.
- [`topics/ya-env-vars.md`](../../topics/ya-env-vars.md) documents
  `CLAUDE_CONFIG_DIR`; its row becomes the description of the default
  profile in step 6.
- [`docs/tactical/119-managed-ssh-executor-baseline.md`](119-managed-ssh-executor-baseline.md)
  keeps a workspace-owned `CODEX_HOME` authoritative on remote targets,
  which is why the selector is hidden for SSH executors in the first version.
- `docs/competitive/bb.md` records bb's experimental account pooler with
  rotation on limits. That automatic behavior is what this plan rejects.
- Prior art: t3code "provider instances" (`docs/competitive/t3code.md`).
  Adopted from it: per-instance display name and accent color, account
  identity from the SDK init message, scanner deduplication by directory
  identity, and no failover. Not adopted: the Codex shadow-home symlink
  overlay.
