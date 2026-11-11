# Where settings / UI options live

Topic: settings-ui-placement

Status: contract note. Two questions for any new user-facing option: **which
category** it appears under, and **which persistence mechanism** backs it. This
captures the precedents so new options land consistently instead of wherever
the nearest code happened to be.

See also:
[vanilla-defaults](vanilla-defaults.md) (novel user-visible behavior ships
configurable + default-off — governs whether an option is even default-on),
[fork-from-turn](fork-from-turn.md) (the worked example below: fork-after-summary
auto-open),
[storage-settings](storage-settings.md) (server-wide storage location and
tool-result preservation),
[settings-search](settings-search.md) (how options are found: the shared
`SettingsItem`/`SettingsSection` row layer every pane's rows should use so
they stay searchable),
[project-settings-overrides](project-settings-overrides.md) (the project tier
below the global one that § Server-definitive settings and constants defines),
[client-global-store](client-global-store.md) and
[server-capabilities](server-capabilities.md) (the retained-query coverage keys
and capability gating that § Server-definitive settings and constants reasons
about).

## Settings Pane Conventions

Toggles, sliders, and selects apply changes immediately; continuous controls
such as sliders debounce their saves. Explicit Save flows are reserved for
free-text or configuration forms where partial input should not be applied.

Panes register undo through `useSettingsUndo` / `useSettingsUndoBaseline` in
`pages/settings/SettingsUndoContext.tsx`. `SettingsLayout` renders the single
Undo button at the top-right of the header, outside scrollable pane content.
Panes adopting immediate apply should register undo so accidental changes remain
recoverable.

Undo is one step at pane granularity, without a per-action history or redo
chain. The header button and `Ctrl+Z` / `⌘Z` invoke the same active-pane
registration. Its tooltip and accessible label name the pane and explain that
it undoes changes made since opening it. In text-editable controls, the shortcut
remains native text undo.

Snapshot panes, including immediate-apply panes and simple Save forms, restore
the pane-open snapshot via `useSettingsUndoBaseline`. Local Access uses
`useSettingsUndo` to discard only unapplied edits: restoring an old network
binding automatically could sever the operator's connection, so applying stays
behind the explicit button. Status/action panes have no undoable settings.

Providers retains independent sub-forms with their own drafts, validation, and
Save/cancel lifecycles, so a pane-wide Undo has no clear scope. Do not add it
unless the pane is restructured to make that scope clear.

### Local Access forms

**Listening & hostnames** groups the listening port, network access/interface
and allowed hostnames in one explicit-save form. Changes take effect only on
**Apply connection changes** or Enter in that form. Its action row appears only
with effective pending edits (and stays during application), names the edited
settings, and offers **Discard**. Discard restores this form to the currently
reported server values without writing, changing password drafts or undoing
independently saved settings. CLI-owned and unavailable listener controls cannot
create pending edits. A custom-IP edit counts only while network access uses it.
On narrow screens the action row sticks to the bottom of the viewport within
its connection section; it does not follow users into other settings groups.
Port validation appears beside the port field; failed or declined writes retain
unapplied edits. Connection-impact confirmation and redirects follow
[connection-safe settings](connection-safe-settings.md).

**Password & authentication** has its own Enable password, Change password or
Disable password confirmation. Enter submits only that form; Discard clears only
its unapplied choice and password fields. Applying connection changes never
validates or applies a password draft, and confirming a password never applies
connection edits. Desktop **Allow localhost access** saves immediately and
reports failures in its row. **Agent access** switches and file-access controls
save independently; they cannot reveal the connection Apply row. Settings
searches matching a form title or its field labels keep that form’s fields and
actions together.

## Persistence mechanisms (pick one deliberately)

YA has three, and the choice is about *scope of persistence*, not convenience:

1. **Browser-local preference** — `localStorage` via a `UI_KEYS` or
   `BROWSER_LOCAL_KEYS` entry (`lib/storageKeys.ts`) and a small hook returning
   `[value, setValue]`. Models: `useAttachmentUploadQuality`,
   `useOutputAppearance`, and `useModelSettings`'s local model/thinking/speech
   overrides. Use for a local view/UX or client-side default that need not
   follow the user to another browser profile.

2. **Source-scoped client storage** — local browser storage keyed by
   `ClientSummarySourceKey` in the owning helper (`clientSummaryStore`,
   `sessionDraftStorage`, `useDrafts`, session UI storage). Use when a hosted
   or multi-server client needs independent client-side state per source, such
   as drafts and source-specific session UI handoff state.

3. **Server-persisted setting** — `useServerSettings` / `updateSetting`
   (`settings.*`). Model: `newSessionDefaults` (in `ModelSettings.tsx`). Use for
   config applied at session start that is genuinely server/session state
   (default model, permission mode, delivery windows) and must survive on the
   server.

Decision rule: pure local rendering/UX or a browser-profile default → (1).
Client state that must not collide across hosted/remote sources → (2).
Session/server config that seeds new sessions or must survive on the server →
(3).

### The category rail is an index, not a column to fill

In the two-column layout the rail is capped (18rem) and its descriptions wrap;
only the category label stays on one line. A category description is a phrase
for scanning, and the rail must never be sized by the longest one: when it was,
a single sentence-long description took 60% of a 1000px window and starved the
pane behind it, collapsing Session Defaults to one column and overflowing the
speech setup panel. Write short descriptions, and keep the cap.

### Explicit browser-settings transfer

The Settings category navigation exposes **Transfer browser settings** beneath
the category list, in both its desktop rail and narrow-screen list. It has one
server-stored slot for portable browser preferences. This is a manual transfer
mechanism layered over (1), not continuous synchronization or a fourth
persistence scope. **Save from this browser** replaces the single server
snapshot. **Apply to this browser** applies that snapshot to the current
browser, even when another device created it, replaces the allowlisted local
preference set, and then reloads the client. Server-persisted settings in (3)
already survive and are not duplicated into the transfer slot.

The client owns an explicit allowlist. Browser identity, relay/auth and speech
credentials, source-scoped state, drafts, cache contents and runtime
measurements, hardware device ids, recent-project history, and legacy migration
keys never enter the server copy. Hosted clients show the controls only when
the connected server advertises `browser-settings-backup`; older servers retain
the ordinary local settings behavior.

Because the slot lives on one server, it cannot carry preferences between
servers. **Copy settings between servers**, beneath the slot controls, moves
the same allowlisted set as text instead. It is purely client-side, so it
shows for every resolved principal regardless of server capabilities.

- **Copy settings** writes one JSON document,
  `{ kind: "ya-client-settings", version: 1, sourceHost, copiedAt, settings }`,
  to the clipboard. `sourceHost` is the copying page's host, shown only as a
  label. Where clipboard write is unavailable (plain-HTTP origins), the text
  appears in a read-only field for manual copying.
- **Paste settings** reads the clipboard; where reading is unavailable or
  denied, it opens a text field and **Review changes** instead. Text that is
  not such a document, or names a newer version, is refused with a message.
  Keys outside this client's allowlist are dropped, never applied, and
  counted in the preview; a non-string value refuses the whole document.
- The preview lists every portable setting whose value would change, with
  `default` for an unset value. Applying replaces the whole portable set
  exactly as **Apply to this browser** does, including resetting portable
  keys the copy lacks, and then reloads. Nothing changes until the user
  applies, and an already matching copy reports so without a preview.

Server-persisted `clientDefaults` and every other server setting stay out of
the text: they configure one host, and server-settings transfer is not
pursued.

## Documentation links

A settings section or row whose effect is not evident from its title and
one-line caption ends that caption with a brief **See _document_** link.
Pass the repository path to `SettingsSection` or `SettingsItem` as
`doc="topics/recaps.md"` (optionally with a `#heading-slug`); `custom`
layouts render `SettingsDocLink` themselves. The link opens the document's
published copy at `https://github.com/kzahel/yepanywhere/blob/main/<path>`
in a new tab, so installed and hosted clients reach the same page without a
local checkout. The link text names the document after its file, or after
an explicit `{ path, label }`.

Choose the target a user can act on: the user guide in
`site/src/content/docs/` when one covers the setting, otherwise the topic
that owns its behavior contract. Link at section level when one document
explains the whole section, and do not repeat that link on its rows. Leave
self-evident settings unlinked: a link on every row is noise. Link only a
document that is already on upstream `main`; a document added in the same
change is not published until it lands there.

The link is not search text and does not lengthen the caption past its
one-line aim. It remains independently operable inside search results:
the row's jump-on-click ignores links. `SettingsDocLink.test.ts` fails when
a linked path no longer exists, so renaming or retiring a document must
update its settings links in the same change.

## Reviewed settings behavior

**Appearance → Slide animations** is a browser-local preference, enabled by
default to preserve sidebar motion. It also controls the right pane's own
show/hide animation and desktop space allocation. Turning it off makes sidebar
and right-pane changes immediate. Reduced-motion preferences also suppress
these animations without changing the saved setting. It does not change which
panes open, their widths, or unrelated animations. The preference applies
immediately, supports Appearance undo, and transfers with browser settings.

**Apps** owns artifact delivery, expiry/deletion options, static vhosts and
app-link protection. Remote Access provides a link there; Local Access omits
the migration notice.
**Appearance → Session right pane** remains a default-off browser preference;
it places session file viewers and detected apps in the same right pane,
without changing hosting or access policy. Apps configuration is
server-persisted, while discovered session App chips are source/session-scoped
browser state.
Apps text/number fields save on defocus (Enter also commits); toggles, slider
commits and row removal save immediately. There is no bottom Save button.
Writes are serialized while typing remains enabled, and server metadata refresh
must not remount the form or replace another field's in-progress draft.
Manual domains and project apps use compact tables with one selected item's
options in a neighboring pane. On narrow screens the pane replaces the table
until **Back to list**. [Growable settings collections](settings-collections.md)
owns this convention for settings lists with per-item options.

The following controls and descriptions were checked against their current
implementation on 2026-08-16. These are the user-visible contracts the Settings
UI should state directly.

- **Settings search.** Matching rows render their real controls, so ordinary
  immediately-applied settings can be changed in place and take effect there.
  Selecting a category clears the query before opening the normal pane. Each
  result carries an explicit jump link that centers and briefly outlines the
  destination row, and clicking that row's inactive text or background performs
  the same jump. A setting that deliberately requires Save keeps that action in
  its matched row or complete matched form section, and single-line fields
  submit with Enter, so an explicit-save setting edited from search can be
  committed there. [settings-search](settings-search.md) owns both contracts.
- **Source Control → Review history and outcomes.** On by default for new
  installs. It stores exact source captures, review submission history, agent
  outcomes, and unread review responses; those records power the Source Control
  Reviews view and Inbox outcomes. Turning it off leaves line comments,
  Pending Comments, and review submission available, but stops creating exact
  submission records and checking outcomes automatically. It hides existing
  Reviews and Inbox outcomes without deleting their stored records. Automatic
  response observation is a bounded implementation detail of this parent
  feature; Refresh performs a later manual check.
- **Agent Context → Tell agents this client renders LaTeX math.** Off by
  default. The row previews the exact `[Client capabilities]` fragment before
  opt-in. The fragment recommends explicit `\( ... \)` inline and `\[ ... \]`
  display delimiters; rendering still accepts dollar delimiters for
  compatibility. YA composes the fragment before free-form global
  instructions at provider launch. Claude uses its system-prompt extension;
  other adapters prefix the first provider-facing user message, with current
  resume coverage differing by provider.
- **Message Delivery → Keep Mobile Keyboard Open After Delivery.** A portable
  browser-local preference, off by default. Pointer delivery on a touch layout
  always retires the old browser editing host so pending Android IME composition
  cannot become a new draft. Off leaves the replacement composer unfocused and
  lets the keyboard collapse; on refocuses the replacement host after the
  delivery boundary. Desktop keyboard delivery is unaffected.
- **Performance → Reverse-search pages per attempt.** A portable browser-local
  integer from 1 through 1000, defaulting to 100. It limits how many bounded
  older-history responses one active search shortcut or Up continuation may
  chain while seeking the next match. One page normally covers at most two
  compaction boundaries and has no fixed message count. Manual **Search older**
  and **More** activations continue to read one page each. On narrow panes, the
  title and numeric control share the first row while this longer description
  uses the full card width below them.
- **Remote Access → Host Marker.** Optional and unset by default. Presets apply
  immediately; a valid custom emoji applies on Enter or blur; Clear removes it.
  Connected clients show the marker in host-identifying headers and browser
  tabs.
- **Remote Access → YA hosted client.** Informational prose beside the URL
  settings shows the effective hosted-client and public-share routes. It is not
  an editable settings row.
- **Remote Access → Remote login credentials.** Lists reusable SRP login
  credentials, not live sockets and not relay-only connections. Revoke prevents
  that credential from reconnecting; it does not terminate an already-open
  socket. Persist remote login credentials controls whether eligible credentials
  survive a server restart. Persistence defaults on; saved opt-outs remain off.
- **Providers → Compact context early.** Off means YA sends no threshold or
  `/compact` request and leaves provider defaults unchanged. A percentage asks
  YA to initiate compaction at that context-window threshold.
- **Providers → Continue after compaction.** Off for every provider. When a
  provider checkbox is on, YA injects a hidden continuation turn after
  compaction settles and the session is idle. The turn ends with `continue.`
  The N slider (0–20) copies that many recent user/assistant prose turns in
  **Handoff from…** format and labels them as a replay when N > 0. This is
  often redundant with the provider's own compact summary; Codex in particular
  commonly keeps working through compaction. Older servers omit the field and
  the client hides the row.
- **Providers → Idle harness lifetime.** Sets how long an idle provider harness
  with no viewer and no feature-owned retention may remain in memory. Running
  and waiting sessions are outside this timer; `-1` disables idle reaping.
- **Providers → Claude Gateway.** Gateway URL, optional start command, Agent
  denial policy, and plan-mode exclusion are nested in the Claude Gateway
  provider card. URL and command edits require explicit confirmation because
  they control provider launch; Save or Enter submits both fields together.
- **Providers → Codex reasoning summaries.** The server-persisted Codex app-server
  mode is one of `auto`, `concise`, `detailed`, or `none`, displayed as Automatic,
  Concise, Detailed, and Off. Automatic preserves YA's previous fixed behavior.
  The saved mode applies when a Codex thread starts, resumes, or forks; an already
  active thread keeps its current mode. Detailed is not supported by every model.
  Hidden recap/title helpers stay on their explicit helper mode, and Codex OSS is
  unchanged. Since the 2026-10-29 retirement, this is a v0.8.0 baseline
  setting; its former per-control version gate is removed.
- **Speech → Speech backends.** Chooses speech-recognition routing. Smart Turn
  timeout, command grace, and follow-up listening are durations shown in `ms`.
  Keep Mic Warm is browser-local and default-off; while a visible tab holds the
  idle stream, no audio is sent, but mobile on-screen keyboard or voice-input
  controls may be unavailable.
- **Environment → Environment variables.** Read-only startup inventory. It
  shows set documented variables by default and can show the full documented
  registry. Secret classification and redaction happen on the server before the
  response reaches the browser; credential-suffixed names can reveal at most
  their final four characters.
- **Lifecycle Webhooks.** Default-off, one-shot JSON HTTP delivery when a
  session becomes idle or ends with an error. The payload includes session and
  project details plus latest message text. Dry Run still sends the request and
  marks `dryRun=true`; the receiver owns automation and must honor that flag.
- **Devices → Browser Profiles.** Shows server-saved browser identity and origin
  history plus current connected state. Delete history removes only that saved
  profile/origin record; it does not disconnect or sign out the browser, revoke
  remote login, or remove Web Push, and a reconnect may recreate the row.
- **Local Access → File access.** Limits paths authenticated YA file viewers may
  fetch; it does not restrict agents or terminals. Project folders means every
  project root discovered by the server. Public shares do not inherit this
  broad allow-set: their separate route permits only transcript-linked project
  files and bounded assets referenced by a linked Markdown or HTML file. The
  built-in hostname allow-set includes localhost, private-network IP addresses,
  and Tailscale MagicDNS names ending in `.ts.net`. File-access toggles save
  immediately. Custom folders save when the editor loses focus or when the user
  chooses **Save folders**; the pane-header **Undo** restores the file-access
  values from when the pane opened.
- **Local Access → Approval audit log.** Saves explicit approve and deny
  decisions, including the associated tool inputs or commands, to
  `logs/approval-decisions.jsonl`. It does not currently audit bypass-mode
  selection or transitions. Current clients edit the persisted logging toggle
  on the v0.8.0 server baseline; the former legacy read-only fallback was
  retired on 2026-10-28.
- **Remote Executors.** This server-wide host list is the sole enablement for
  the New Session **Run via SSH** chooser. Adding or removing a host updates an
  already-mounted New Session form immediately; no page reload or server restart
  is required. The chooser appears only for provider adapters that implement
  remote execution; unsupported providers cannot retain an ignored executor
  value. Hosts are aliases in the server account's `~/.ssh/config`. A
  home-relative local project maps the suffix below that operating-system
  account's home to the remote SSH account's home. Containment follows the
  local platform's path identity, including case-insensitive Windows drive
  paths; the mapped suffix uses the remote home path's separators. A project
  outside local home requires the exact same absolute path remotely. The remote
  provider CLI owns authentication and may differ in version from the local
  runtime.
- **Development / About.** Development is always visible immediately before
  About; About is last. Restart Server appears only when the development wrapper
  supports manual backend reload. Its warning counts interruptible active
  sessions and queued messages; a session is excluded only when its reload-safe
  provider host can detach without losing YA-owned queued input.

## Proposed setting placement

- Candidate private-input controls and placement are recorded in the
  [agent command runtime sketch](agent-command-runtime.sketches.md).

## Server-definitive settings and constants

Status: **contract, not yet implemented (2026-08-05).** No option or constant
has been migrated. This section fixes the rule before values accumulate on the
wrong side of it.

**The principle: a client must not send its own constant to an API that suffers
from variation in it.** An API suffers when a different value bloats what the
server holds, or when work done for one value cannot be reused for another.
Values feeding such an API are **server-definitive** — a server-owned constant,
or a server-owned configurable option — never a number each client happens to
carry.

The two words in play are not synonyms: *server-definitive* says who decides
the value (the server, not the client), and *server-wide* says what its scope
is (one value for the whole install). A server-definitive value is necessarily
server-wide; the reverse framing is what the rest of this section uses when
talking about scope rather than ownership.

The three mechanisms above are chosen by *scope of persistence*. That rule is
incomplete: it asks where a value should survive, never what the value costs
the server to honour. So ask first: **does the receiving API suffer from
variation in this value?** If yes, the value is server-definitive — mechanism
(3), one value for the whole install — even when it reads like a view
preference and would otherwise land in (1), and even when it is a constant
today rather than a setting.

### Why "affects server work" forces a single value

Server work in YA is deduplicated by *identity*: the retained-query controller
shares an in-flight request when available coverage satisfies requested
coverage; `SourceVersionedSingleFlight` joins callers on a source version; the
session catalog answers from a shard digest. Every one of those is a cache
keyed by what was asked for. So a preference that reaches the server does not
cost one client's worth of work — it partitions the cache. Two browsers with
different values are two coverage keys, two derivations, two retained results,
and neither satisfies the other. Ten clients with a free choice are up to ten
copies of work that has one right answer.

The live demonstration is already in the tree, and it is instructive precisely
because no user chose it: `limit` is part of the global-sessions query key, so a
50-row Sidebar fetch and a 100-row All Sessions fetch do not satisfy each other
(`docs/tactical/031-client-query-controller.md` § Coverage Model). That fan-out
is code-owned and bounded — two constants. Exposing the same knob as a
browser-local preference would make it unbounded and per-client.

### A client constant is not the safe option either

Being a constant is not what makes a value safe; being *one* value is. A
constant compiled into the client partitions the cache exactly as a preference
does, only along client-build lines instead of user-choice lines. Two clients
of different vintages against one server — a freshly published hosted bundle
and a browser still serving a cached one, a `localhost` dev client beside the
hosted client, a native app pinned to an older release — hold different
constants and issue non-satisfying coverage keys, and the server derives both.
That is the same divergence synchronized publishes are meant to prevent, but
arising from cache lifetime rather than release timing, so release discipline
does not close it.

So for any value that reaches the server, prefer a **server-owned constant**
over a client one, whether or not it is user-configurable. The server states
the value and the client consumes it; every connected client then agrees by
construction rather than by everyone having shipped the same number. Making it
configurable afterwards is then a UI change over an existing contract, not a
re-plumbing. `limit` is the obvious first candidate — the value is the server's
own pagination decision, and the client has no independent basis for choosing
50 or 100.

Ordering, cheapest first: server-owned constant → server-owned constant exposed
as a server-wide setting → per-client value with the duplicated work recorded
deliberately. Reach past the first only for a reason stated at the time.

**Current state, stated so nobody over-migrates.** A search of `UI_KEYS` and
`BROWSER_LOCAL_KEYS` found no user-configurable setting that today multiplies
server caching: the client-owned options are appearance, layout, output
rendering, speech capture, client-side transcript caching, and similar, all of
which the server never sees. This section is therefore a rule for *new* options
and for any existing one that grows a server-visible effect — not a backlog of
migrations. Audit before migrating anything; do not assume a candidate list.

### The test

Ask, of the value:

1. Does it reach the server at all — as a request parameter, a query-key
   component, or a field the server stores or branches on? Purely local
   rendering (fonts, spacing, collapse state, tooltip style) never does.
2. Does the receiving API suffer from variation in it? It suffers if a
   different value means work that cannot be reused (a distinct coverage key,
   a distinct derivation, a distinct single-flight identity) or state the
   server must hold per value. A value echoed back unchanged, or one the server
   only records, does not make the API suffer.

Both yes → server-definitive. Either no → the existing scope rule governs,
unchanged.

Note that (2) is a property of the *endpoint*, not of the value's name. The
same number can be harmless on one route and cache-partitioning on another, so
answer it against the specific API the value is sent to.

### What choosing server-wide forecloses

A server-wide setting is not a preference. One client changing it changes it
for every connected client and every other user of that install, including
mid-session. That is the point — it is what makes the single cache entry
correct — but it means the option can no longer express personal taste, and a
setting genuinely wanted per-person cannot be resolved by making it
server-wide. When a value is both per-person and server-affecting, the honest
resolutions are to bound the domain to a few discrete server-owned values, so
the fan-out is small, known, and identical across clients; or to keep it
per-client and record the duplicated work as a deliberate cost. Neither is
"leave it a client constant and hope every client ships the same one".

This also interacts with the local rule that a new feature must not silently
re-default existing behavior (`CLAUDE.local.md` § UI Changes Preserve Non-Buggy
Defaults). Migrating an existing browser-local option to server-wide *is* such
a re-default for every client whose local value differed from the new shared
one. Such a migration needs the maintainer's explicit go, and should carry the
previous local value forward as the initial server value where a single
sensible one exists.

### Making the nature visible

A user cannot be expected to infer that one row in a pane is shared with
everyone while its neighbours are not. Group server-wide options under their
own settings category rather than marking them individually: a category carries
the explanation once, in its description, instead of repeating a badge per row
and leaving unbadged rows ambiguous. `storage` is the existing precedent — it
is already server-wide in fact (storage location, tool-result preservation; see
[storage-settings](storage-settings.md)) — so the category should be the site
where that fact is stated, and new server-wide options should join it or a
sibling rather than being scattered by feature area.

Rows must still use the shared `SettingsItem`/`SettingsSection` layer so they
stay findable by search ([settings-search](settings-search.md)); grouping is
about explaining scope, not about hiding options from search.

### Deployment assumption

The hosted client is published together with the server code it talks to, so a
server-owned value ordinarily reaches every client in one release and a
migration does not need a negotiated dual path. That lowers the cost of moving
a value server-side; it does not remove the capability gate. Skew still happens
by accident — an un-updated Android client, a half-landed Pages deploy, a
cached bundle, a forgotten publish — and a client that hard-fails when the
server-owned value is absent turns each of those into a broken app rather than
a degraded one. Give a new server-owned value a defined client-side behavior
when the server does not supply it, which for a value like `limit` means the
client's current constant serving as the fallback rather than a required field.

Details, failure modes, and why this is an intent rather than a guarantee:
[remote-hosted-compatibility](remote-hosted-compatibility.md) § Synchronized
distribution is the intent, not the guarantee. Changes shipped upstream to
`origin` follow DEVELOPMENT.md's review unchanged.

### Relationship to project overrides

Server-definitive is the global tier of the resolution order sketched in
[project-settings-overrides](project-settings-overrides.md) (project override →
global setting → built-in default). A setting that is server-wide *because* it
partitions a cache is a poor candidate for a project override later, since a
per-project value re-partitions the same cache along a different axis. Note
that when adding one.

## Categories (what each is *for*)

The category registry is `CATEGORY_COMPONENTS` in
`packages/client/src/pages/settings/SettingsLayout.tsx`; labels, descriptions
and order come from `getSettingsCategories` in
`packages/client/src/i18n-settings.ts`. Current inventory: `appearance`,
`performance`, `toolbar`, `model`, `message-delivery`, `source-control`,
`issues`, `storage`, `computer-control`, `agent-context`, `notifications`,
`webhooks`, `devices`, `local-access`, `users`, `project-templates`, `apps`,
`remote`, `providers`, `cache-miss-billing`, `speech`, `remote-executors`,
`environment`, `development`, `emulator`, `about`.

A category whose pane needs server support declares it in its own entry
(`requires`: the capabilities, any one of which serves the pane, and the
message for a server with none). Settings, not the pane, answers an older
server: the category is absent from the list and from search, and a typed
URL shows that message under the category's title without mounting the pane,
so the pane sends that server no request. While the server version is still
unknown, the typed URL shows loading rather than calling the server
unsupported. A pane therefore needs no whole-pane capability check of its own;
capabilities that gate individual rows inside a served pane stay in the pane.
Today `issues`, `computer-control`, `users`,
`project-templates` and `emulator` are gated this way. Source Control settings
are baseline v0.8.0 after the 2026-10-29 retirement: category navigation and
search no longer await their former fixed capability. Its settings retain
their existing defaults, stored values and live-monitoring version refresh.

Placement precedents (the load-bearing ones — choose by *what the user is
conceptually adjusting*, not where the code lives):

- **Appearance** — visual presentation (fonts, spacing, visibility toggles like
  show-thinking's display, and the style/timing of transient presentation such
  as tooltips). Most Appearance effects are visible at rest; a presentation
  preference does not move to Toolbar merely because hover reveals it.
  `AppearanceSettings.tsx` / `useOutputAppearance`; see
  [tooltip-interactions](tooltip-interactions.md).
- **Toolbar** — which **commands / affordances** are shown in the toolbar.
  A presentation value with no meaning outside one toolbar affordance may stay
  nested under that affordance when its live specimen is the evaluation
  surface; **Button background opacity over waveform** is the narrow precedent.
  `ToolbarSettings.tsx`.
- **Model + new-session defaults / options** — things **set on session start**:
  default model, permission mode, thinking config, and UI elements that seed a
  new session. `ModelSettings.tsx` hosts `newSessionDefaults`; `showThinking`
  (browser-local, with a live toolbar toggle) lives in this cluster via
  `useModelSettings`.
- **Providers** — provider-specific availability, authentication, and catalog
  policy. Opting exact previous/custom Claude ids into the server's available
  model catalog belongs in `ProvidersSettings.tsx`, even though the resulting
  entries later appear in model choosers. It is server-persisted and
  capability-gated because a hosted client edits the connected server's
  provider catalog. The provider list presents Codex first, Claude second, then
  the remaining registered providers; see
  [older-claude-models](older-claude-models.md).

Introduce a **new category** only when a sizable cluster of options doesn't fit
an existing one; a single niche toggle joins the nearest existing category.

### Storage category — approved, pending implementation

**Storage** appears immediately after **Source Control** and owns two
independent server-wide choices: where YA-managed project data may live and
whether YA preserves new tool-result images from managed sessions. This earns
a category despite its small initial control count because it is a filesystem
trust and retention boundary, neither control fits an existing category
honestly, and older-server limitations must remain visible. It does not absorb
browser-local cache tuning from **Performance**.

The exact radio choices, defaults, persistence fields, capability gates, and
missing-capability states are in [Storage Settings](storage-settings.md).

## The default + live-override pattern

A persistent default may be paired with an **ephemeral, in-context toggle** that
seeds from it. `showThinking` is the canonical case: a browser-local default
(settings) plus a live toolbar switch for the current session. The override is
**not itself a setting** — it is transient session/job state. Reach for this
pattern when the user may want to flip the behavior for *this* session/action
without changing their standing default.

## Worked example: fork-after-summary auto-open

The fork-after-summary "open the forked session in a new tab when ready" option
(see [fork-from-turn](fork-from-turn.md)) is, in the project owner's words,
"analogous to show thinking, a little more niche." It belongs near the
model / new-session cluster (`ModelSettings.tsx`) if a persisted default is
added, but the install-id localStorage excision deliberately did **not** add
that persistence. Current behavior remains **default-off and non-persistent**;
adding a browser-local or source-scoped default would be a product behavior
change and should be documented when it lands.

- **Default:** no persisted default today; each new mount seeds the behavior to
  off per [vanilla-defaults](vanilla-defaults.md). A future dedicated "Sessions"
  category could absorb it if that cluster grows; not warranted for one toggle.
- **Live per-fork override:** an ephemeral toggle on the `ForkSummaryIndicator`
  during the *generating* phase, seeded from the default. It is per-fork
  transient state, not a setting.
- **What the toggle does — and does not — control:** the forked session is
  created and *starts* (the summary is submitted as its first user turn) as soon
  as generation completes, unless canceled. The toggle gates only the
  client-side `window.open` to a new tab; the fork/session runs regardless, and
  the indicator's link is how the user reaches the already-running session.
  Because the auto-open decision is read at the *ready* transition (after a long
  await), read the live toggle value from a ref — like the abort ref — so a flip
  during generation is honored.


Server Connections is an owner-only, `peer-connections` capability-gated category
beside Local/Remote Access. It owns server identity, direct/relay pairing,
independent control directions and their audit. Supported-but-disabled profiles
show enablement; absent support hides list/search and typed URLs show update
guidance without mounting the pane. Remote Access retains the human login and
links to Server Connections for separately revoking incoming server control.
