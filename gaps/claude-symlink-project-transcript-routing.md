# Project path changes can split project lists, hide history and redirect resumes

Updated 2026-11-14. This is a cross-provider project/session identity gap;
the filename is retained for existing links and historical evidence. The
current end-to-end evidence is Claude on macOS. **Codex was not exercised in
this investigation: its behavior remains unknown, not safe or equivalent by
assumption.** Qualifying Codex and other supported providers is part of this gap.

The maintainer requested that all findings and coverage limits be recorded and
that the intended behavior be decided later. No project merge, path migration,
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
changed working folders, or persistent warnings. Nor is it an automatic repair
workflow. Backend incomplete-result reporting and the newer client warning UI
are separate rollout concerns; an older hosted client may not show that UI.

## Observed cases: ordinary Claude on macOS

These observations use real Claude sessions (SDK/CLI 0.3.322), temporary private
profiles and scripted local model responses via
`packages/server/test/native-provider/app-fixture.ts`. No user projects,
credentials or paid model calls were used. Sessions were stopped after saving
replies; collection and history checks were repeated after backend restarts.
The working-folder checks used actual Bash `pwd` tool results.

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

## Related sandbox behavior and missing qualification

The separate [sandbox membership gap](symlinked-sandboxed-session-leaves-its-project-list.md)
records Linux project-write sandbox launches/resumes that move a session's
working-project membership from the selected link to the real path. Forks,
clones and restart continuations have different recorded outcomes. That issue
is still open; the ordinary macOS Claude matrix does not supersede it.

Before choosing or closing a shared fix, build the same matrix for **Codex**
and each other supported provider. Check actual native discovery/storage,
public YA identity, Projects cards/counts, project/global/Inbox membership,
history after stop/restart, and actual execution folder after resume. Include
provider-native imports as well as YA-created sessions; saved creation rows
can mask a discovery conflict for the latter. Do not infer Codex behavior from
Claude's transcript-directory conventions or alias-specific fix.

Also qualify sandboxed and ordinary launches, provider-host survival versus
fresh provider processes, forks/clones/restarts, filesystem watchers, macOS
`/tmp` versus `/private/tmp`, symlink chains, missing targets, rename/move,
retargeting, deletion/recreation at the same path, and supported Linux/Windows
path behavior. Reusing a pathname for a different directory is a separate
identity question, even without a symlink. These untested cases are coverage
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
  changed selected path. Audit Codex's own reader/launch behavior independently.
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

Found 2026-09-12 while validating tactical 128 with real Claude sessions on macOS.
Expanded 2026-11-14 while investigating localhost:3400 collection failures and
the maintainer's project-path/symlink questions; cross-provider policy deferred.
