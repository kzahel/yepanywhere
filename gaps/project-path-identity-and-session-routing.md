# Project path changes can split project lists, hide history and redirect resumes

Updated 2026-11-14. This is a cross-provider project/session identity gap, with
real Claude and Codex evidence on macOS. Renamed from the Claude-specific gap
after Codex qualification reproduced changed execution folders and mixed-folder
project membership, with different history/list behavior. Other supported
providers, platforms and sandbox variants still need qualification.

The maintainer requested that all findings and coverage limits be recorded,
then that Codex be investigated and this gap renamed if affected too. The
intended behavior is still to be decided later. No project merge, path migration,
automatic repair, resume policy or warning UX is selected here.

## What is fixed, and what remains open

The original failure was a collection-wide HTTP 500, with `Session identity
conflicts with an existing native binding`, when a Claude session selected
through `/tmp/...` was rediscovered through `/private/tmp/...`.

Commits `1f6ebad4e` and `212e1fc74` recognize resolving Claude aliases for an
exact saved native binding and isolate conflicting discovered rows. Healthy
collection rows remain available, saved YA ids/project ownership are preserved,
and incomplete results are reported rather than crashing the collection.
Affected retained rows are rechecked. An existing managed session can remain
listed from its saved creation record even when discovery cannot reconcile it.
Unexpected storage errors and strict identity adoption are not suppressed.

That containment does not resolve duplicate project cards, history routing,
changed working folders, or persistent warnings. Codex did not reproduce the
original collection identity conflict in the matrix below; its confirmed
execution-folder problems do not depend on that conflict. Containment is not an
automatic repair workflow. Backend incomplete-result reporting and the newer
client warning UI are separate rollout concerns; an older hosted client may
not show that UI.

## Observed cases: ordinary Claude on macOS

These observations use real Claude sessions (SDK/CLI 0.3.322), temporary private
profiles and scripted local model responses via
`packages/server/test/native-provider/app-fixture.ts`. No user projects,
credentials or paid model calls were used. Sessions were stopped after saving
replies; collection and history checks were repeated after backend restarts.
The working-folder checks used actual Bash `pwd` tool results.
The fixture enables the shared provider host; these are ordinary unsandboxed
sessions, not qualification of the default macOS in-Hono ownership variant.

Notation: `L` is the selected symlink, initially pointing to real folder `A`;
`B` is a different real folder; `M` is a renamed symlink. `S1` starts through
`L -> A`. The table describes existing behavior, not the desired contract.
"Warning" means the server reports an incomplete collection/refresh error.

| Case | Project cards and session placement | Saved history | Warning |
| --- | --- | --- | --- |
| Create S1 through L -> A | Both L and A can show cards with count 1. S1 appears once, under L. A's session list is empty despite its count. | Opens, including after stop/backend restart. | No |
| Change to a symlink chain L -> intermediate -> A | Same placement and duplicate cards. | Opens. | No |
| Remove the intermediate link, breaking L | S1 remains listed under L; the L project session route returns 404. | 404 although the transcript still exists. | Yes |
| Also create S2 directly in A | S1 stays under L; S2 appears under A. The two paths are separate projects, not a merged project or duplicate session. | Both open. | No while L still points to A |
| Retarget L from A to B, before creating another session | S1 stays under L; any S2 stays under A. | Existing saved replies still open. | Yes |
| Create S3 through L -> B | S1 and S3 share L's list despite starting in different real folders. B can have a count-1 card with an empty list. | Both open. | Yes |
| Rename L to M without registering M | Old L cards and membership remain; M does not automatically replace L. L's session route returns 404. | Old L sessions return 404. | Yes |
| Start S4 through M | A separate M project appears with S4. Old L sessions remain under L. B can show count 2 with an empty list. | S4 opens; old L sessions still return 404. | Yes |
| Delete L but keep A | S1 remains listed under the old L project. | 404 although the transcript still exists. | Yes |
| Restore the original L -> A, with only S1 present | Original placement remains. | Opens again. | Clears |
| Restore L -> A after both S1-in-A and S3-in-B exist | Both remain under L. No one target agrees with both sessions' original physical paths. | Both open again. | Remains |
| Move A to a new name, breaking L | Old project labels and membership remain. | L sessions return 404. A directly created session's saved history still opened in the tested case. | Yes for the alias conflict |
| Update L to point to the moved A | Old labels and membership remain; L's session list works again. | Opens again. | Remains even with only S1: the original observed A path no longer exists. |
| Delete a directly selected folder without an alias mismatch | Saved session can remain listed. | Saved history opened in the tested case. | Deletion alone did not cause an identity warning. |

Removing M while B remains also leaves S4 listed under M but unable to open
(404); deleting B afterward does not remove the saved conversation. Claude
transcripts in these probes live in the private provider profile, outside the
selected project folders. A 404 here is failed routing, not proof of lost data.

Warm discovery caches can temporarily mask duplicate cards or delay warnings.
The cold checks above restart and await discovery; do not use one warm read as
proof of recovery. In the tested changed-path cases the affected collection
endpoints still returned 200 with healthy rows, rather than the original 500.

### A changed link can change where a resumed conversation works

After changing `L -> A` to `L -> B`:

- An already-running Claude process continued executing in A.
- A stopped conversation resumed successfully and executed in B, using its
  existing history. Its project label remained L.

The same conversation can therefore operate on different folders depending on
whether its process survived. This is a concrete wrong-folder risk for resumed
work, beyond list presentation or warning annoyance. Merely allowing history
to open does not establish that a resume uses the intended project.

## Observed cases: ordinary Codex on macOS

The same native full-app fixture ran the pinned Codex CLI **0.167.0**, matching
`package.json` and local upstream reference tag `rust-v0.167.0`. These are real
app-server processes, native JSONL transcripts and shell tools against scripted
local Responses API replies. Shared provider hosting was enabled, sandboxing
was bypassed, and all owned profiles/processes/listeners were cleaned up.
The cold matrix finished in about 42 seconds, working-folder qualification in
5 seconds, and the additional path-reuse/missing-folder probe in 13 seconds.
These are diagnostic durations, not performance or CI acceptance claims.

Codex wrote the selected spelling L into `session_meta.payload.cwd`; it did not
replace L with A as Claude did. This changes which failures are visible:

| Case | Project cards and session placement | Saved history | Collection warning |
| --- | --- | --- | --- |
| Create S1 through L -> A | Only L appears, count 1, with S1. No extra A card or duplicated S1. | Opens after stop/backend restart. | No |
| Use L -> intermediate -> A, then remove intermediate | S1 stays under L; the project session route still works even with the broken link. | Opens in both cases. | No |
| Also create S2 directly in A | Separate L and A projects, each containing its own conversation. | Both open. | No |
| Retarget L from A to B | S1 stays under L. | Opens. | No |
| Create S3 through L -> B | S1 and S3 share L, count 2, despite starting in different real folders. No extra B card. | Both open. | No |
| Rename L to M without registering M | Old L remains with its sessions; M does not automatically appear. L's session route still works. | Old L histories open. | No |
| Start S4 through M -> B | M appears with S4; old L membership remains. No extra B card. | All saved histories open. | No |
| Restore L -> A after S1-in-A and S3-in-B | Both remain under L; restoration does not separate their membership. | Both open. | No |
| Move A, breaking L; then update L to the moved A | Saved project labels/membership remain. | Alias and directly created histories open before and after relinking. | No |
| Delete a link but keep its target, then delete the target too | Old project cards/membership remain. | Saved histories still open. | No |
| Create through both /tmp/... and /private/tmp/... spellings of the same L | Two selected-path projects, each with its own session and matching count. No automatic alias merge. | Both open. | No |
| Delete directly selected A, then create a new directory at the same A path | The original A project/session remain; no distinction is shown for the replacement directory. | Original history still opens. | No |

Across all 13 cold-matrix stages, Projects, global Sessions and Inbox returned
200 and reported complete results with no refresh warning. Saved-history reads
returned 200 with their expected persisted replies, including after missing
links/targets. This does not establish that the folder is safe for continued
work: completeness of transcript discovery is not physical-folder identity.

### Codex execution can follow a changed link even without a resume

With L initially pointing to A, change it to B after the native process has
started and while its first model response is held open. Then ask its real
`exec` tool to run `tools.exec_command({cmd:"pwd"})` without a workdir override:

- A stopped S1 resumed after retargeting executed in **B**.
- The next shell command in the **already-running** conversation also executed
  in **B**. This differs from Claude's already-running process, which used A.

Both results were confirmed from the actual shell output sent back to the
model endpoint, not inferred from metadata. This does not claim that a shell
command already executing in A is moved to B; it qualifies the next tool spawn.
No project-list warning accompanied the retargeting in the cold matrix.

The direct-path replacement probe also resumed an old A conversation after A
was deleted and recreated. The resume returned 200 and its shell read a marker
present only in the replacement directory. Thus changed-folder execution is
not confined to symlinks.

When L was deleted altogether, resuming the old L conversation returned
**HTTP 500, `Provider worker closed during attach`** in the hosted fixture.
Its saved history still returned 200 afterward. This is a separate poor
missing-folder error/recovery experience; it did not crash the collections.
The exact failure for in-Hono ownership or other platforms remains unqualified.

## Related sandbox behavior and missing qualification

The separate [sandbox membership gap](symlinked-sandboxed-session-leaves-its-project-list.md)
records Linux project-write sandbox launches/resumes that move a session's
working-project membership from the selected link to the real path. Forks,
clones and restart continuations have different recorded outcomes. That issue
is still open; the ordinary macOS Claude matrix does not supersede it.

Before choosing or closing a shared fix, extend the matrix to each other
supported provider and the unqualified Codex/Claude variants. Check actual
native discovery/storage,
public YA identity, Projects cards/counts, project/global/Inbox membership,
history after stop/restart, and actual execution folder after resume. Include
provider-native imports as well as YA-created sessions; saved creation rows
can mask a discovery conflict for the latter. The November probes cover
YA-created sessions only. Do not infer Codex behavior from Claude's
transcript-directory conventions or alias-specific fix; the measured
differences above demonstrate why separate qualification is required.

Also qualify sandboxed and ordinary launches, provider-host survival versus
fresh provider processes, forks/clones/restarts, filesystem watchers, macOS
`/tmp` versus `/private/tmp`, symlink chains, missing targets, rename/move,
retargeting, deletion/recreation at the same path, and supported Linux/Windows
path behavior. Direct-path replacement and /tmp spelling are now qualified for
the stated Codex fixture only. The remaining untested cases are coverage
requirements, not claimed reproductions.

## Decisions deferred to a later design

- Does a project identify the selected path, the originally selected physical
  folder, or another stable identity? Should aliases merge, and how do existing
  project URLs, session ids and project membership survive that decision?
- When a link changes target, should an old conversation stay with A or follow
  the link to B? What user action, if any, permits that change? How should live
  and resumed processes behave consistently?
- How can saved history remain readable when its former working folder or link
  is missing, separately from permission to start more work there?
- How should project cards/counts agree with their session lists, including
  old aliases and empty projects, without silently moving unrelated sessions?
- What is the bounded, actionable recovery UX for a missing/moved folder or a
  conflicting observation? A permanent generic warning on unrelated pages is
  not a selected solution. Define when warnings clear, who can repair/relink,
  whether that is automatic or explicit, and what happens after dismissal.
- How are current databases migrated and retained observations revalidated
  across restarts without deleting history or changing public session ids?

No cheap local fix is established: changing path normalization alone can merge
distinct projects or redirect execution. Keep this open until intended behavior
is agreed and verified across the provider/platform cases above. Future
implementation must preserve existing YA identities and storage/scope isolation.

## Investigation entry points and historical evidence

- `packages/server/src/projects/paths.ts`: spelling normalization and project
  ids; not a durable physical-directory identity.
- `packages/server/src/projects/scanner.ts` and `routes/projects.ts`: project
  lookup/existence checks can prevent history reads when the selected link is
  missing, even if a saved transcript remains available.
- `packages/server/src/projects/catalog-projects.ts` and
  `routes/creation-session-collections.ts`: discovered physical project cards
  and saved creation grouping can disagree about counts/membership.
- `packages/server/src/sessions/catalog-identity.ts` and
  `sessions/SessionIdentityStore.ts`: saved public/native bindings, alias
  comparison, conflict containment and retained-read revalidation.
- `packages/server/src/sdk/providers/claude.ts`: captured transcript scope can
  remain fixed while a new process resolves its working folder through the
  changed selected path.
- `packages/server/src/sdk/providers/codex-session-config.ts`: both thread start
  and resume pass `options.cwd`. `sessions/codex-discovery.ts` reads the native
  session header's cwd; `sessions/codex-reader.ts` filters by that spelling.
  Unlike Claude's project-directory transcripts, the Codex rollout lives under
  the profile's date-partitioned sessions store, independent of project existence.
  The pinned upstream `codex-rs/rollout/src/recorder.rs` persists cwd, and
  `codex-rs/core/src/unified_exec/process_manager.rs` passes a working path for
  each spawned command. These source observations support, but do not replace,
  the real-tool execution evidence above.
- Existing contracts: [session identity](../topics/session-identity.md),
  [catalog observation](../topics/session-catalog-observation.md), and
  [collection queries](../topics/session-collection-queries.md).

The original September probe used Claude SDK 0.3.258. A `/tmp/ya-live-*/project`
selection wrote complete JSONL under the `/private/tmp/...` native namespace,
but selected-project history was empty or became 404 after terminal restart.
The live worker and pending SDK approvals survived Hono reload. Registering the
physical path did not repair that session. Historical evidence:
`.artifacts/ui-testing/2026-09-12-provider-host/alias-fixture-state.json`, its
isolated native transcript and `evidence/alias-baseline.json`. Correcting the
provider-host test fixture to use `realpath` was not a product fix.

The November ordinary-Claude probes now qualify baseline saved-history lookup
across stop/backend restart while the alias still resolves; they do not prove
all September live-tail/watch/terminal-restart cases fixed. Exploratory scripts
and logs are local disposable evidence, not retained regression tests:
`.artifacts/diagnostics/alias-matrix/probe-cold.mts`,
`probe-single-session.mts`, `probe-working-directory.mts` and the corresponding
`/tmp/ya-alias-matrix-*.log` files. The matrix above preserves their findings
without depending on those ignored artifacts remaining available.
Codex evidence uses the same ignored directory's `probe-codex-cold.mts`,
`probe-codex-working-directory.mts`, `probe-codex-extra.mts` and corresponding
`/tmp/ya-alias-matrix-codex-*.log` files.
All three completed Codex probes reported no model-endpoint failures and joined
cleanup; these exploratory scripts are not newly retained CI tests.

Found 2026-09-12 while validating tactical 128 with real Claude sessions on macOS.
Expanded 2026-11-14 while investigating localhost:3400 collection failures and
the maintainer's project-path/symlink questions; Codex then qualified and the gap
renamed at the maintainer's request. Cross-provider policy remains deferred.
