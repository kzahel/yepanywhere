# Project templates

> Config-driven project creation from composable capability bases, with
> vendored instructions, deterministic setup, and an automatic preparation
> session. Superusers and permitted limited users can create projects;
> retained App access uses the project service contract.

Topic: project-templates

Status: **Superuser and limited-user creation implemented; broader integration open (2026-09-28).**
The implementation handoff is
[usable template projects](../docs/tactical/132-project-template-implementation.md).
The authoring library is the `project-templates` directory of the default
source, [graehl/agents](https://github.com/graehl/agents/tree/master/project-templates).
The App canvas closure was admitted in agents commit `090e72b`; Web page and
Storybook and their remaining bases were admitted in `cf829b4`. All three
default templates now pass fresh setup without allowing drafts.
YA now has a native library loader and composer in `packages/server/src/projects/template-library.ts`, with no Python
runtime dependency. It validates the complete inventory without executing setup,
retains the loaded file bytes, and refuses drafts through its creation accessor.
Settings now fetches ordered GitHub sources into private, revision-stamped
snapshots, reads local overlays directly, and shows their combined inventory.
Fresh-target materialization, setup, Git initialization, registration and
preparation dispatch are connected for both principal kinds. Template permissions
and project-confined setup are implemented. Retained App access and project
address settings are implemented under separate capabilities; personal-workspace
scope and project-local identity remain open. See the
[stand-up integration gap](../gaps/project-template-standup.md).

### Implemented creation boundary

`limited-user-project-templates` separately gates Settings → Users template
grants and the limited-user chooser. Administrators select None, Selected
templates (source ID plus template ID), or Any configured template. Existing
records migrate once to Any when a creation root exists, otherwise None;
subsequent administrator restrictions survive restart. The same defaults apply
to new users. The older superuser capability does not imply this extension.

The server filters choices, enforces the grant and configured root before
allocation, and rechecks current grants before setup, registration and launch.
Limited users supply name and intent without an editable parent directory.
Setup uses the existing Linux project-write sandbox with the network firewall;
unsupported or broken confinement fails without executing setup unconfined.
Preparation inherits the normal provider locks and project-write policy.
Operation reads/retries are owner-scoped; the superuser can inspect every
operation. Browser recovery is scoped to both server and acting username.

`project-template-creation` gates the superuser radio palette in Projects and
the inline New project expansion in New session. Older servers receive none
of its requests. Choices include only ready closures. Optional composed
`.project-template/icon.svg` and `.project-template/preview.svg` are rendered as
images, never inline markup. Reopening a chooser rereads its choices while
preserving edited fields. Local source edits are revalidated on that read;
GitHub sources still require an explicit Fetch / update before new bytes appear.

`POST /api/project-templates/operations` accepts a client UUID, source/template
identity, fresh project path, name, intent and session settings. The operation
retains its validated bytes, allocates the directory exclusively, executes setup
as argv with bounded output, verifies the built starter, initializes Git using
the existing project-creation identity policy, and calls the normal project and
session routes. Preparation now uses one deterministic keyed
[durable admission](session-identity.md#creation-consolidation--november-3) with
the full composed prompt and staged files before native startup. It retains a
public session id when queued or failed; there is no create/upload/send engine.
The selected provider/model and launch policies therefore use
the normal session boundary, and those routes act as the creating login: a
limited user's preparation session is sandboxed with its network firewall on,
held to their lock, and recorded as a session they started (`createdByUser`),
while the superuser's records no creator. Local execution with bounded
account-owned staged attachments is the current creation boundary; the form explains incompatible selections
before submission.

Operations persist beneath `dataDir/project-template-operations`. Repeating an
identical UUID returns its existing outcome; changing its request is refused.
The tab retains its pending request across reloads. Existing and partial
directories are never overwritten. A server restart reports unfinished work as
interrupted rather than replaying side effects. Graceful shutdown stops owned
setup process trees. `started` means preparation was durably accepted with a
public session id; native startup and completion are visible independently on
that session. Live preparation, project-operation association recovery and
abrupt-crash setup cleanup still need the broader acceptance work.

## Current contract — config-driven templates

YA's loader implements format version 1 as summarized below. The authoring
reference for that format is `FORMAT.md` in a source's content directory; the
default source's
[FORMAT.md](https://github.com/graehl/agents/blob/master/project-templates/FORMAT.md),
with its `composition.py` conformance tests, defined the initial version. This
YA topic owns the product integration, not a second evolving schema.
The user-facing [Project templates guide](../site/src/content/docs/project-templates.md)
(published at `/docs/project-templates`) explains how to create and share a
source; the default source's
`project-templates/README.md` is its synchronized copy. Keep cache and
protocol details here rather than in that guide.
The superseded prompt-first proposal and the stacks and reach paths set aside
for the first template are in
[project-templates sketches](project-templates.sketches.md).

### Sources and inventory

A configured source has a stable source identity, a local repository or GitHub
repository/ref, and a repository-relative content directory. The overridable
default is the public repository `https://github.com/graehl/agents` with
`project-templates`, fetched like any other GitHub source; no checkout on the
host is consulted. The feature defaults off, so the default source is fetched
only after the superuser enables it. Fetch on enable and on an origin change
while enabled; repository, content root and revision identify that origin. Save
disabled configuration changes without fetching, then validate on enable.
Reject a missing content directory during admission. Resolve remote refs to a
fixed revision and validate and instantiate
that same revision. An unreachable source is an error, not an empty library.
Validate inventory, manifests, dependency order and referenced files without
executing scripts; revalidate a mutable local source before creation.

Use a private source cache outside YA's checkout; a full clone initially
preserves references to sibling topics and skills. A standalone repository or
YA submodule is not required. Efficient retrieval of the configured path plus
its transitive dependencies is tracked in the
[selective retrieval gap](../gaps/project-template-selective-retrieval.md).
The settings use an ordered list of GitHub and local sources. Each row has
one **GitHub or local dir** field; append a GitHub content path to the repository
URL, or enter an absolute/`~/` local directory. GitHub revision is separate.
An edited field also accepts GitHub's own directory link,
`…/tree/<ref>/<path>`, or a link to that directory's `library.json`,
`…/blob/<ref>/<path>/library.json`; leaving the field or saving moves the ref
into the revision field and keeps the repository plus path. GitHub's link does
not delimit a ref containing `/`, so the revision already entered is used when
the link continues with it, and otherwise the first segment. A link to any
other file is refused with a message naming the directory form. A saved
content directory whose first segment is `tree` or `blob` is left as it is
until its field is edited; after an edit it must be entered as a `/tree/` link.
The wire contract retains repository, relative content path (empty means root),
revision and stable source ID. `graehl/agents/project-templates` is the default;
vendoring it in YA later remains an option.

Local directories are read directly, never copied or rewritten. A containing
Git worktree supplies the repository boundary and informational HEAD; without
Git, the selected directory supplies the boundary and the commit is null.
Every update revalidates local working files, even at an unchanged HEAD.
There is no local content-hash verification. Mixed local/GitHub overlays use
the same definition ordering and composition rules. Creation must revalidate
mutable local input rather than treating HEAD as an immutable content pin.

**Layering:** later sources replace earlier base/template definitions with the
same ID. A base cannot change into a template or vice versa. Validate the
combined dependency graph, allowing community templates and bases to extend
YA-default bases without copying them. Source-file references stay inside the
repository owning that definition. Root file composition still requires exact
bytes/modes or explicit overrides; source layering is not implicit overwriting
of project files. The inventory reports each effective template's source ID.
Future creation grants must match that origin plus template ID, so shadowing a
template does not silently redirect a limited user's saved grant. An intentional
base replacement changes templates depending on it and requires source review.

**Retrieval and relocation:** `GET`/`PUT /api/project-template-source` are
superuser-only source administration. The feature defaults off. Fetch resolves
each configured GitHub ref to a commit before downloading, then validates the whole
combined library without executing setup. The ref check and the download run
Git in one environment that ignores the host's system and global Git config,
so a user's URL rewrites, credential helpers, proxy and CA settings apply to
neither; process environment such as `https_proxy` applies to both. A name
that is both a branch and a tag is refused until qualified as `refs/heads/` or
`refs/tags/`, and an annotated tag resolves to the commit it points at. Raw shallow Git checkouts remain
unchanged under `dataDir/project-templates-source`; a separate translated
snapshot rewrites explicit `~/repository-name` text references to the matching
retrieved repository. Later sources supply duplicate repository-name aliases.
Binary files and source symlinks are not rewritten. A dependency update rebuilds
translation from raw content, including cached community dependents. Project
export must subsequently relocate references to vendored project destinations;
cache paths are not a generated project's runtime dependency.

**Manual updates:** display each fetched SHA and the effective inventory.
`HEAD` selects the remote default-branch tip at explicit fetch time. A named
branch/tag or full SHA selects another revision. Update checks remote refs
first; unchanged commits and source order reuse the admitted snapshots and
report Already up to date without downloading repository content. Local
sources are re-read on every update, but their file edits never re-copy or
re-translate the GitHub snapshots, since translation targets only each local
source's directory; only a changed local directory does. Updating
from the default branch sets that source's revision to `HEAD`. Poll only while
a retrieval is active, and preserve in-progress field edits during status
updates. Failed/interrupted retrieval is explicit and does not admit a partial
library; the last successful snapshot may remain visible as prior content.
Saved source state that cannot be read, parsed or validated is moved aside as
`state.unreadable-<time>.json` in the private cache; the settings then show
the default sources in an error state naming that file, and a Save replaces
them without hand repair. State that cannot be moved aside is never
overwritten except by that Save. Automatic chooser-triggered checks are only a
[sketch](../gaps/sketches/project-template-automatic-updates.md).

**Compatibility:** capability `project-template-sources` owns only retrieval,
source configuration and inventory. Older servers show no source controls and
receive no source requests. This does not advertise the still-unimplemented
creation/workspace or identity contracts. Approved optional corpus:
v0.8.0/v0.8.1, both without these routes.

```text
project-templates/
  PROGRAM.md, FORMAT.md, library.json
  bases/<id>/template.json       # reusable capability + explicit file list
  templates/app-canvas/template.json
  templates/web-page/template.json
  composition.py                # local reference implementation
  project-template.py            # authoring CLI, not a YA runtime dependency
```

`library.json` has `formatVersion: 1` and finite `bases` and `templates` ID
lists. Each manifest declares `formatVersion`, `kind`, `status`, `id`, `title`,
`description`, ordered `extends`, `files`, and `overrides`. A file maps `from`
to `to`, with optional `executable` (default false). Source paths are relative
to their manifest. `../` and source symlinks are permitted only within the
source repository; output contains ordinary copied files. Broken links,
repository escapes, Git metadata, invalid destinations and case-folded or
file/directory destination collisions fail before materialization.

Templates can also vendor project-visible skills in conventional harness
discovery directories, with their complete scripts/resources. They use the
same explicit file maps and collision rules, not a separate YA skill registry.
The README introduces their purpose and normal invocation so beginners,
including limited users, can learn to use them. Verify harness discovery in
addition to checking that files were copied.

An optional composed `.project-template/preview.svg` supplies the chooser's
template illustration without running setup. It follows ordinary file maps,
collision rules and vendoring. Render the self-contained SVG as an image with
the template title as accessible text; do not inject its markup into the page.
App canvas supplies the drawing graphic from the reviewed mockup. This asset
represents the template type, not the eventual app's screenshot.

The optional compact icon is `.project-template/icon.svg`. Source authors keep
`icon.svg` beside `template.json` and explicitly map it to that destination,
just as `preview.svg` maps to `.project-template/preview.svg`. Both are ordinary
format-version-1 files, not new manifest fields. App canvas, Web page and
Storybook supply the approved 24×24 vector marks. The same self-contained,
image-only rendering contract applies; the template icon is distinct from the
created application's favicon and branding. YA renders these mapped images.

### Composition and collisions

Multiple bases are an ordered dependency graph. Apply each shared ancestor
once, before its dependents, while respecting each `extends` order. Stable
topological sorting uses first encounter in a left-to-right depth-first walk
to break unconstrained ties. Cycles and incompatible ordering constraints are
errors; the selected template contributes last.

- Ordinary files at the same destination coalesce only when their bytes and
  executable mode are identical. Different paths remain separate even if
  their contents match. Differing bytes or modes are conflicts, never an
  implicit last-writer-wins overlay.
- Exact root `AGENTS.md` is special: hash each complete fragment's original
  bytes with SHA-256, retain the first occurrence of each hash, then concatenate
  in resolved order with blank-line boundaries. Do not normalize or deduplicate
  paragraphs. Nested `AGENTS.md` files are ordinary files.
- The selected template applies explicit ordered overrides after composition:
  `replace`, `prepend`, `append`, or `omit`. Replacement and omission can
  resolve a conflicting destination; appending/prepending cannot choose a
  predecessor from conflicting content. Text operations require an existing
  UTF-8 destination. There is no JSON deep merge or implicit glob expansion.

The reserved `base` contains only universal instructions. The populated
capability bases are `software-engineering`, `testing`, `typescript`, `web-ui`,
`web-app`, `canvas`, and `server`; their dependencies select the relevant union.
`legacy-boot` is a separate draft authoring reference to the global boot,
excluded from App canvas. Full global research/run/session-management policy
is not part of an instantiated app's instructions. Systematic editorial and
experimental tightening is tracked in the default source's
[portable capability bases gap](https://github.com/graehl/agents/blob/master/project-templates/gaps/portable-capability-bases.md).

### First template: App canvas

The stable ID is `app-canvas`, display name **App canvas**. It creates a static
Vite + TypeScript Canvas2D app, with run/test/build tooling and vendored
instructions. It has no application server initially. The server base supplies
an inactive add-on: `npm run server:add` later installs the supplied Node
server and health endpoint, updates runtime configuration, and refuses to
overwrite an existing server. Instantiated projects stand alone; neither
their instruction routes nor build/test/run/add-on commands require the
template source or any checkout of it.

`.project-template/app.json` describes `kind`, static bundle `dir`, argv arrays
for `setup`, `build`, `test`, `preview`, a vendored `prepare` prompt, and
`addons.server`. Activating the server adds `start`. Commands run in the
project directory without shell interpolation. `.project-template/project.json`
records entered name/description and composition provenance. The initial CLI
consumes setup; YA creation now consumes it too. YA adapts the legacy static
declaration for App viewing. Process serving requires the versioned service
declaration below; legacy preview/start commands are not inferred.

### Standard app and service declaration

The approved product extension is specified in
[project service](project-service.md#standard-declaration-where-start-status-stop-serving):
an optional versioned `service` object in `.project-template/app.json` with
explicit **where**, **start**, **status**, **stop**, and **serving** sections.
Static App canvas declares its built root and entry without inventing a
process; the activated server add-on declares a foreground command, readiness
probe and owned-process stop policy. Existing setup/build/test and composition
fields remain compatible. YA's loader validates the optional declaration and
the `project-service` capability admits its lifecycle and App viewer. The
creation capability alone does not advertise project-service support. Source
authors should emit this declaration when upgrading a server add-on.

That topic also owns main-pane **Open app**, preferring the declared app and
otherwise the latest authorized project artifact, and project Settings for
service controls and an optional retained vhost association. Vhost controls
appear only when server vhost serving is enabled. A reservation does not start
or publish an app. Sandboxed limited-user projects stay project-confined for
every service launch, including when exposed through a vhost tunnel.

The build has relative asset URLs and works over static HTTP(S), including
artifact grants. ES modules do not promise `file://` execution. The portable
template includes deployment guidance but no personal publishing destination
or automatic publish. The existing static server binds loopback. Live tablet
console forwarding, PWA packaging, and pane annotation are future integration,
not capabilities of the current template. Browser verification uses Playwright.

### Web page and shared tooling

The second content prototype is **Web page** (`web-page`), a content-led DOM
starter for prose, documents, stories and collections. Its working sample has
searchable/filterable cards. Interactivity and multimedia remain available;
its instructions emphasize reader purpose and content structure. Both starters
inherit `web-app` for deterministic Vite setup, run/test/build, preparation and
the inactive server add-on. Web page does not inherit canvas instructions.

The default source's
[content authoring gap](https://github.com/graehl/agents/blob/master/project-templates/gaps/content-authoring-capabilities.md)
owns optional writing skills and guidance (plot, characters, worldbuilding,
continuity), plus shared static-publication onboarding. Publication defaults
to a host-provided URL such as GitHub Pages; account/domain onboarding is
future work, and buying/configuring a custom domain is optional.

### Creation and preparation

Projects gains a **New project** surface. For the superuser, the plain
path/name entry comes first and the template chooser follows it; typing any
path, name or code into that entry hides the chooser, and clearing it brings
the chooser back (an in-progress template creation stays visible). There is no
mode toggle to find. Limited users see only the template chooser. Template
creation asks for name, intent, and parent directory. Always show the template
radio palette, including one available template (preselected); do not hide it
or replace it with a dropdown. Existing-directory registration keeps its
present behavior. The current
proposal fixture lives in `packages/client/mockups/project-templates/` and
reuses the real existing-directory form and settings section component.

The 2026-09-28 placement revision lives in
`packages/client/mockups/project-template-placement/`. In New session, the New
project panel (owned by [project names](project-names.md)) leads its palette
with **Empty folder**, selected by default, followed by the ready templates;
an unmatched path typed into the project search opens the same panel. The
panel owns the name and palette; choosing a template shows only that
template's Create & prepare action and progress, which use the panel's name
and settled path and the composer prompt as the intent. Keep the entered
prompt, project name, provider and model when expanding, collapsing or
switching choices. Creation must not navigate away and require returning to
the session form. One Create & prepare action creates the project and its
preparation session; it must not create a second empty session. The
2026-10-08 proposal for this panel is
`packages/client/mockups/new-project-flow/`.

[Template artwork](../gaps/sketches/project-template-artwork.md) sketches
source-provided thumbnails and compact icons beyond the existing preview image
contract. The source icon convention is adopted; runtime artwork delivery and
thumbnail presentation remain proposed.

**Create & prepare** explicitly authorizes the following sequence:

1. Validate permission, source revision, prerequisites, fresh target and app
   name reservation before executing source-controlled setup. Resolve and
   vendor the complete selected content into the new directory.
2. Run deterministic setup, initialize Git and register the project with its
   ownership. Make the starter visible in the App pane as soon as its build
   is usable; do not wait for the agent's preparation turn.
3. Open a project-context session and automatically send the vendored prepare
   prompt with the entered intent as user data. Use the user's provider/model
   settings and enforce limited-user locks and sandboxing. The turn customizes
   project instructions, refines the README lede, verifies run/test/build,
   and reports readiness to build the requested app.

The preparation session's display title comes from the entered user intent,
using the normal title-length limit. The full composed preparation prompt
remains the provider's first turn and the stored recovery prompt; template
setup text must not become the displayed session title.

Setup seeds a reasonable README summary immediately, so the project description
does not remain blank while preparation runs. The shipped base instruction
keeps documentation current, including revising that lede when the project's
purpose changes. Preparation failure leaves the usable starter and session
visible with a failure state; it must not silently recreate the project or
send a duplicate first turn. Setup failure reports the partial directory and
logs without registering a successful project or deleting user content.
Creation grants no authority to deploy or publish.

The universal base vendors the **redoc** skill. It improves the documentation
hierarchy for human and agent readers, checks truth against current contents,
and creates/refreshes a project-specific `docs/brand.svg` leading the README.
It is ordinary autodoc, not an authorship tracker or protected-prose system,
except that it honors the approved, unimplemented
[project-local identity record](project-captions.md#approved-project-local-identity-extension-not-implemented),
which covers all YA projects rather than only templates.

### Limited-user permissions

Settings → Users extends the existing local principal's grants, rather than
introducing a second user system. The server enforces a per-user choice:

| Choice | Creation permission |
|---|---|
| None | No new projects. Existing project access is unaffected. |
| Selected templates | Only saved source-qualified template IDs. Empty means none. |
| Any configured template | Every enabled, ready template, including future additions. |

A limited user who may create projects (a project root is configured)
defaults to Any configured template, so creation works with whatever the
enabled sources offer; a user without one defaults to None (user-directed
2026-09-28, replacing the 2026-09-21 default of Selected with the three then
current templates). Narrowing to Selected or None is the superuser's explicit
choice. Show every permitted available choice in the radio palette, even when
only one is available. A removed/unavailable/draft template never
silently falls back to another. Limited users cannot supply a source, script,
arbitrary directory or permission grant: the superuser's configured project
root is enforced at creation, and the new project belongs to that user.
Missing project root prevents creation even when a template is allowed.
[Limited users](limited-users.md#approved-workspace-direction-2026-09-21-not-implemented)
owns the one-time migration of existing limited users to these defaults, the
Create in workspace and sandbox modes, and the **Private apps only** ceiling
this creation flow enforces.

The proposed chooser uses compact radio cards in the creation form: title,
one-line purpose, and a visible selected state. The selection updates the
template details and preserves the entered project name/intent. Both superuser
and limited-user flows always show it when a permitted template is available;
limited users still supply only name and intent. Both content prototypes exist
in the authoring library; neither draft is production-admitted yet.

When a public vhost root is configured, the template creation form also offers
**Public app — no link required**, unchecked by default. It is available to the
superuser and to a limited user whose Private apps only ceiling is off. The
choice is part of the server creation request and atomically sets the reserved
row's `public` state; hiding or disabling the control is presentation, not
authorization. With the ceiling on, the disabled control explains that the
administrator requires private app links.

Project lists show ownership as `alex / Sketch garden`, separately from the
project's name, following the existing owner display convention (a configured
code name still takes precedence). A limited user's projects are created in
their **Create in** directory; the directory and display name need not encode
the creator. Creation fields use muted examples as placeholders, not
prefilled app specifications.

### Persistent app-name reservations

Settings → Apps owns the superuser's wildcard-domain configuration and reserved
names, alongside existing app routing. For a configured wildcard such as
`*.example.com`, the first successful reservation wins. Claim names atomically
on the server, normalized within the configured namespace; a conflict asks
for another name rather than renaming silently. Service-owned names are
unavailable. A name reservation is separate from a running port or process.

Reservations persist across restarts, stopped apps and project deletion, until
explicitly cleared by the superuser. Preserve enough project/owner information
to explain orphaned entries. Limited users can claim available names for their
authorized projects but cannot release or take over reservations. The superuser
view shows hostname, project/owner, serving-or-reserved status, and a Clear
action that confirms release and the resulting loss of that app address.
Clearing does not delete project files. Namespace removal/reconfiguration must
not silently release claims. This is a YA namespace contract, not a claim to
control arbitrary DNS names outside its configured routing.

The reservation stores the creation-time public/private choice. A private row
uses the existing app-scoped bearer; selecting Public is an explicit opt-in to
hostname-only access and is refused for an owner whose Private apps only
ceiling is enabled.

Persistent reservation storage, concurrency and authorization are implemented
under `project-app-reservations`. Project App Settings shows current and prior
namespace associations. Serving is available to administrators and limited
users with Allow public apps; release remains administrator-only. The owner's
current permission is the publication ceiling, defaulting to private-only,
as described in [project service](project-service.md#app-address-in-project-settings).
Creation-time claim and global orphaned-name inventory remain in the stand-up
gap. Host-provided static publication does not require this wildcard.

### Next delivery boundary

The source library and local stand-up prototype exist. The user approved all
existing UI prototypes on 2026-09-21: New project, template choices, preparing
project, Settings → Users and App names. Proceed from the
[implementation handoff](../docs/tactical/132-project-template-implementation.md),
including capability gating for older servers and server-side authorization.
The separate supported-release capability/fallback plan is approved in that
handoff; implement its gates without broadening existing capability meanings.
The [gap](../gaps/project-template-standup.md) owns the remaining
integration and acceptance checks. Import/export, save-as-template, extra
templates, landing slash commands and advanced template authoring remain later
work. Basic Settings → Project templates source configuration and explicit
feature enablement are prerequisites for the initial usable flow.

The superuser authoring follow-up lives in
[project-template editor](../gaps/project-template-editor.md): Settings → Project
templates enables the feature, accepts the default `graehl/agents` bundle or an
alternative local/GitHub/submodule source, edits the source location in place,
and composes ordered bases plus extra AGENTS text. An explicit Update action
validates upstream HEAD and advances the selected revision; it does not silently
update instantiated projects. This editor has not been mocked up or implemented.

## See also

- [[interactives]], [`interactives-architectural-review.md`](interactives-architectural-review.md)
  — app reach, isolation posture, and the hosting boundary.
- [[active-content-security]] — artifact grants, vhost rows, private app
  links, and the CSP that bounds static wasm/JS bundles.
- [[session-right-pane]] — where a created project's app appears beside the
  session; owner of the iframe `allow` grants and the pane half of the
  console/comment channel.
- [`project-templates.sketches.md`](project-templates.sketches.md) — the
  superseded prompt-first design, its pane/runtime proposals, and the stacks
  and reach paths weighed and set aside, with the reasoning.
- [[project-directory-storage]] — what YA may write inside a project after
  creation.
- [[vanilla-defaults]], [[session-ui-customization]], [[server-capabilities]]
  — gating for the new UI surfaces and endpoint.
