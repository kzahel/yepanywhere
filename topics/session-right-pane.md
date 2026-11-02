# Session right pane

> The session right pane is an opt-in, session-owned column that shows
> auxiliary content beside the transcript: a right-edge drawer on a
> narrow viewport, and a resizable side-by-side column on a wide one,
> with the left sidebar collapsing while the pane is expanded.

Topic: session-right-pane

Status: implemented for static-vhost tool URLs, artifact links, session file
viewers, and the session's tool-detail panels. Multiple viewer tabs remain a
sketch.

See also:

- [`parked-file-viewer.md`](parked-file-viewer.md) — file-viewer lifetime and
  park/restore, shared by the covering modal and the enabled right pane.
- [`provider-agnostic-btw-asides.md`](provider-agnostic-btw-asides.md) —
  existing session right-column split for a focused `/btw` aside
  (≥1100px, collapsible handle, composer stays in the session column).
- [`source-control.md`](source-control.md) — workbench splitters: edge
  handles, keyboard resize, live reflow, persisted width.
- [Session UI](session-ui-customization.md#desktop-sidebar-display-modes) —
  desktop sidebar expanded/collapsed/minimized modes.
- [`vanilla-defaults.md`](vanilla-defaults.md) — YA-novel chrome ships
  configurable and default-off.
- [`active-content-security.md`](active-content-security.md) — vhost Host
  dispatch and isolated origins for loopback HTTP apps.
- [`settings-ui-placement.md`](settings-ui-placement.md) — Appearance
  category; browser-local persistence.
- [`agent-self.md`](agent-self.md#view-inspection) — with agent self
  inspection enabled, each tab reports the pane's viewer so the session's
  agent can read it with `ya-agent view`.

## Product

The session page has one optional **right pane** owned by the visible
session. It is a layout, not a second transcript renderer. The session
column (messages, composer, status) stays mounted and remains the
primary conversation surface.

Consumers include loopback HTTP apps discovered from tool output (Plannotator
is the worked case), artifact links, session file viewers, and the detail
panels tool rows publish — the long-edit diff, full bash output, write and
grep details, and a fullscreen [MCP App view](mcp-apps.md). All of them reuse
the pane instead of covering the transcript when the setting is on.

## Enablement

Two independent gates:

1. **Appearance → Session right pane**, browser-local, **default off**.
   When off, existing covering modals and park/restore stay as they are,
   and a discovered vhost URL is offered as a new-window link in the
   session App action. Opening requires a user gesture.
2. **Vhost-tool integration** requires a non-empty artifact vhost table.
   An empty table means YA has no Host to proxy, so loopback tool-output URLs
   are not rewritten. Configured artifact grant links remain eligible.

File viewers and tool-detail panels use this pane whenever the Appearance
setting is enabled, including when the vhost table is empty. File viewers use
the existing project file API and React viewer, with no vhost hostname or
proxy. Placement is one decision for every session-owned viewer
(`sessionViewerUsesRightPane`), so a panel written for the covering modal needs
no knowledge of where it is shown. Standalone file pages, public shares, and
the separate media lightbox retain their presentations.

All Sessions search also honors the Appearance setting: retained-match lists
and turn context occupy a search-owned right column on desktop or a drawer on
narrow screens. They share modal chrome and keep navigation to the matched
turn available; they do not populate the session pane's viewer tabs. See
[all-session content search](all-session-content-search.md).

## Layout

The wide/narrow cutoff is the same 1100px used for desktop chrome and
the `/btw` split (`DESKTOP_BREAKPOINT`).

### Wide (≥1100px)

Side-by-side columns: the complete session header (including provider badge),
transcript, status and composer stay on the left; the pane owns the right
column's full height. The transcript and embedded content each own their
scrollbar; scrolling either does not scroll the other or the outer document.
A vertical splitter between
them is keyboard-operable (arrow keys, Home/End) and pointer-draggable.
Its hit area occupies a separate strip inside the pane, outside the session
scrollbar's hit area. With two scrolling surfaces, wheel input goes to the
surface under the pointer. Forwarding wheel input from a non-scrolling
cross-origin frame requires cooperation from that app; YA cannot inspect or
intercept arbitrary embedded app events.
Pane width is persisted per browser. The session column may shrink to a
readable minimum but is never removed.
The session column clips only vertically, so popovers anchored in it (the
context-usage detail, composer menus) draw over the pane rather than being
cut off at the column edge (2026-09-24).

A detected-app action opens the latest discovered app, including after Close.
A file viewer's interactive play activation also announces its grant as the
session's latest app (2026-09-23): the reader can close the viewer and recall
the running document from the App action without having minimized it first.
Such a viewer-activated app keeps a `play:` announcement id in the saved
latest-app entry, which is the one entry storage seeds back into a reopened
session's app list, since transcript scanning cannot rediscover it. It was the
latest app when saved, so it stays the App action's target above the history
loaded with the reopened session, and like loaded history it is offered but
never opened automatically: storage cannot establish that its grant is alive.
Opening an artifact link from session prose announces the same way
(2026-09-25). File viewers the session hosts, in the pane or as a modal, sit
inside the session's App-link context so their play activation reaches it. A
viewer-activated announcement never auto-opens the pane: the announcing viewer
is already showing that document.
While the pane is expanded, that App action closes it completely without
creating a bottom-bar entry. The separate minimize button still parks it.
With the setting off it is a new-window link. V1 has one managed viewer:
opening another replaces it. Browser-style multi-view tabs and keyboard
switching are deferred to [the tab sketch](session-right-pane.sketches.md).

App discovery and access failures never render error text in the session
header or displace its title, including when no app is available. Connection
failures use the normal connection-status UI; app-access details remain in
Apps settings, and failures checking an open app appear in its pane.

The sidebar shows a small App chip for sessions with a discovered app in this
browser. Discovery state is persisted per session/source; no background scan
of unopened session transcripts is needed. Replay restores link availability,
not an expanded pane.

Only a session with something to remember — a discovered app or a dismissal —
occupies browser storage. Visiting an ordinary session writes nothing, and a
session whose state returns to the default releases its entry, including one
left by an earlier release. Every reader shares one store over that key family,
so sidebar cost does not grow with the session count and one session's
discovery does not re-render unrelated rows.

Discovery publishes only when this tab's discovered latest app changes.
Receiving another tab's saved App entry must not publish this tab's older
entry back: tabs can hold different transcript windows. Dismissals are merged
from the current store when publishing, without making storage notifications
an input to the publication effect.

Minimize parks the pane at the existing bottom viewer controller, returning
its width to the transcript. The iframe stays mounted so restore does not
reload it. App toggle dismissal destroys the pane content and removes the
bottom controller but retains the discovered app for reopening.

For a proxied app, the red × means **Kill app and close**. It dismisses the
pane immediately, without waiting for the stop request. The server first
identifies the configured listener; stop rechecks its process identity before
sending SIGTERM. It refuses another user's process, YA itself, YA's ancestors,
or a listener that replaced the observed process. Verification allows up to
five seconds for SIGTERM cleanup, without holding the UI open. It never
escalates to SIGKILL. Kill clears the session's known announcements and App
chip even if signalling fails, with the failure shown in an error toast after
the pane closes. New tool announcements can establish an app again. There is
no app-data deletion. Kill is separately gated by `vhost-app-control`; initial
host support is Linux with `/usr/bin/lsof` and `/proc`. Other hosts and older
servers retain App/minimize but show no Kill and make no control requests.

Artifact links use the same pane but have no process to kill. Their × clears
only the selected pane controller; it does not dismiss the artifact from the
session's discovered links. The same artifact can therefore be reopened from a
previous turn or remain open in other browser tabs. The existing grant expiry
and explicit revocation lifecycle remains authoritative. The URL token is not
the grant's management id, so closing a discovered artifact URL does not send a
guessed revocation request.

### Narrow (<1100px)

A right-edged overlay drawer, analogous to the mobile left sidebar:
expanded it covers the session with a small exposed left edge. No splitter.
Escape or the backdrop minimizes the drawer to the bottom controller.
Minimize/close semantics match the wide pane.
The expanded drawer covers the composer and its bottom controller; dismissal
lives in the drawer header until it is minimized. Wide panes leave composer
actions usable without automatically minimizing the pane. Modal-viewer
toolbar elevation and automatic parking apply only to covering viewers.

### Left sidebar

When the pane **expands**, the desktop left sidebar collapses to the
icon rail if it was expanded. That collapse is a layout override: it
does not write the stored sidebar preference. Closing or hiding the pane
restores the stored mode. The reader may expand the sidebar again while
the pane is open.

### Occupancy

At most one right-column occupant. While this pane is expanded,
a focused `/btw` aside does not also take the
right column; it keeps the composer sticky-card presentation. Opening
the pane does not change aside focus or lifetime.

## Vhost tool URLs

While a provider tool result (including still-running output) contains
an `http://localhost:<port>` / `127.0.0.1` / `[::1]` URL whose port
matches a vhost row, YA rewrites it to the browser-reachable vhost
origin:

- local YA (`localhost` / loopback client): use the configured local artifact
  origin's scheme and forwarded port with `<name>.localhost`
- hosted / public client with a vhost public root: `https://<name>.<root>/…`

`share.plannotator.ai` links are not the pane target; they are a
vendor share blob, not the live local app.

Only tool-result text is eligible; user prose, assistant prose, tool inputs,
and vendor share links cannot launch a pane. Discovery retains original
transcript bytes and creates a separate rewritten view. Old servers without
vhost metadata require no new request and expose no integration. Public
clients without a configured public root expose no unreachable loopback link.

Initial loaded output makes its latest discovered app available through the
App action without automatically opening it: historical URLs may point to
processes that have already exited. Reloading therefore does not resurrect a
closed or expired app pane. Initial tool URLs are remembered even when their
vhost, bearer access or sandbox mapping resolves later; metadata arrival alone
is not a fresh tool announcement.
Tool-result rows also display clickable app links, reconstructed from the
original output on replay without changing the provider transcript. Ordinary
click opens that app in the pane when enabled; with the setting off or a
modified click, the link opens a browser tab. The header App action remains
an additional shortcut to the latest app.

Subsequent tool announcements select and expand the newest app when enabled.
An announcement is identified by its source message and URL; replaying it
never opens it again. A fresh tool result can announce the same URL after an
app restarts. Loading older history must not supersede the current latest app.
Changing sessions isolates discovery and selection; inactive retained sessions
cannot collapse the current route's sidebar or open its drawer.

Source-code template placeholders are not app announcements, including their
URL-encoded forms. A fresh announcement reloads the frame even when its URL
matches the previous app; minimizing and restoring the same viewer preserves
its mounted content.

When `vhost-app-control` is available, expansion checks the configured listener
before loading the frame. A missing listener shows an unavailable-app message.
After a live frame has loaded, listener disappearance dismisses the pane
without parking it. Listener checks run every three seconds only for the
active, expanded pane in a visible tab; hiding, parking, navigating away or
closing releases the timer. Check failures show an error rather than claiming
the app exited. Older servers retain direct frame loading without new requests.

The pane header shares the file and artifact viewer window-action group:
**link, move to new tab, minimize, close**, in that order and style. An ordinary
left-click on the chain-link icon copies the viewer URL; Shift-left-click or
middle-click opens it in a new tab while retaining the pane. The separate
move-out icon opens the URL in a new tab and removes the pane. These are
user-gesture links with no opener or referrer. File viewers use their stable
YA viewer URL, including share scope where applicable, never a raw active file.
For a proxied app with a public vhost root, Copy link uses the public URL and
its app bearer, even when the pane itself is using the local origin.
The compact header retains the shared control sizes. YA tooltips belong to
the header controls, never to the embedded content area; entering the frame
dismisses any remaining YA tooltip. The frame keeps an accessible label
without a native hover title.

The pane hosts the rewritten origin in an iframe. Parent `frame-src`
already allows `http:`/`https:`. The frame uses no opener, no referrer,
and no YA credentials supplied by YA. It is sandboxed on the separate origin.
An observable parent CSP violation shows an explanation. Cross-origin frame
errors, app shutdown, and remote framing policies cannot all be detected by
the parent, so an Open-in-window action is always present.

### Sandboxed session apps

A session running behind the sandbox network firewall has a private loopback,
so a server it starts is reachable only through the sandbox's port broker
([network boundary § Inbound](session-sandbox-network-boundary.md#inbound-the-loopback-port-broker)).
When such a session's tool output names a loopback URL whose port no operator
row serves, the client asks YA once per session and port
(`POST /api/projects/:projectId/sessions/:sessionId/sandbox-apps {port}`). YA
mints a random private app name, `sbx-<hex>`, for that session and port and
returns it with its app bearer; from there the URL is offered exactly as an
operator row's would be: `<name>.localhost` locally, `<name>.<public root>`
through a public page, with `ya_access`. The link label is the host and path
the agent printed, since the minted name means nothing to a reader.

- The name resolves at each request to the session's current provider
  process, so it follows the session across a provider restart once the agent
  restarts its server; with no live firewalled process it answers 503.
- Names are in memory, reused for the same session and port, and capped at
  256 (oldest dropped). A YA restart forgets them; the client asks again.
  Every minted name stays excluded from YA's host, CORS and WebSocket trust
  until process exit, like an operator row's host. An operator row for the
  same port or name always wins.
- A session without a firewalled sandbox, or with no broker, is refused with
  409 `no-sandbox-broker`, and so is a server with no app serving configured
  (`apps-unconfigured`); the URL then stays an ordinary transcript link. The
  client asks only for sessions whose live process reports the firewall.
- A limited user may mint for a session they may act in (the `join` access of
  [limited users](limited-users.md)), and sees these apps and artifact links
  though operator app links stay withheld from them.
- WebSocket upgrades remain unsupported, as for every app host.

## Design decisions

- **Transferable durable app bearers** protect proxied content from hostname
  scans. [Active-content security](active-content-security.md#private-app-links)
  owns token issuance, restart durability, revocation and the separately gated
  old-server fallback. Apps settings owns hosting; Appearance owns this layout.

- **Reuse existing version vhost metadata** rather than introducing a route or
  broadening an existing capability; absent metadata disables integration.
- **The existing single-viewer controller** rather than a second retention
  model: minimize goes to the bottom and Close unloads, as with modal viewers.
  Multiple viewer windows are a later, separately selectable display option.

## File viewers and detail panels

When the Appearance setting is on, file links in the session open in the
right pane. The stable session host owns the document independently of the
link's transcript row. While the pane is open there is no composer
controller: the pane's own header carries minimize and close. Minimize parks
at the existing composer controller, which appears only then;
restore reuses the same mounted viewer and preserves reading state. Close
destroys it and dismisses its originating link's open state, allowing that
same link to open it again.

The wide pane leaves the transcript live and composer actions do not park it.
On narrow screens the drawer covers the composer until minimized or closed.
In-document file links retain their dismissal stack within the pane: Back or
Close returns to the still-mounted parent document.

The file viewer retains its file-specific header controls and shares the final
link, move-out, minimize, and close group with App viewers. Its header adapts
to the allocated viewer width, including a narrow pane on a wide screen.

A tool-detail panel takes the same pane on the same terms, rendering the
covering modal's own header — its own actions, select-all, minimize, close —
and content chrome (`ModalChrome`), so the panel body renders identically in
either placement.

Escape follows the placement, for panels and file viewers alike. The narrow
drawer covers the session, so it is a modal layer: Escape pressed anywhere
dismisses the topmost viewer, and it holds a share of the document scroll lock
([parked file viewer](parked-file-viewer.md) owns that stack). The wide pane is
a column beside a live session, not a layer over it: Escape dismisses its
viewer only when pressed inside the viewer, after the viewer's own controls
have had it, and it takes no scroll lock. An Escape pressed in the composer or
transcript reaches that control — dismissing a composer menu, for example —
and leaves the pane open.

## Slide animations

**Appearance → Slide animations** defaults on. It controls sidebar motion,
right-pane show/hide, and the desktop column's space allocation for both App
and file viewers. Reduced-motion preferences also disable these transitions.
Turning the setting off uses zero duration and renders the final visibility,
content, and column allocation in the same update: no animation-frame or
zero-delay timer is needed to finish opening or closing. With animations on,
closing content stays mounted only through the exit transition; minimized
content stays mounted for later restore. Splitter dragging remains immediate.
On wide screens the session column and pane are explicitly assigned to the
first and second grid tracks. A zero-duration update therefore cannot place the
pane in the session track while the browser resolves the new column allocation.

## Non-goals

- Dynamic `ya-vhost` PATH helper (still postponed).
- Auto-`window.open` without a user gesture.
- A second transcript renderer, or moving the composer into the pane.
- Changing default-on file viewing for users who leave the setting off.

## Implementation and verification

`sessionVhostApps` parses tool results and rewrites configured ports;
`useSessionRightPane` discovers apps only for the active route and publishes
the selected app to the existing single-viewer controller. `SessionRightPane`
owns the iframe, file-content target, and resize interaction. The stable
`SessionManagedViewerHost` renders the file into that target;
`sessionViewerUsesRightPane` defines placement for the controller, transcript
gate, and composer. `SessionPage` owns the two-column workspace, and
`NavigationLayout` owns the temporary sidebar override.
`ViewerWindowActions` supplies the common header controls.

The browser regression in `packages/client/e2e/session-right-pane.spec.ts`
uses a 240-message transcript and a separate-origin review page. It covers
default-off persistence, header placement, separate scrolling and divider hit
areas, resize, minimize/restore without iframe reload, explicit close and
reopen, link gestures, and sequential composer typing during incoming updates.
File-viewer tests retain stable authenticated/share URL behavior.
`panel-slide-animations.spec.ts` checks file placement, same-instance
minimize/restore, close/reopen, and the zero-duration final state before the
next animation frame, plus desktop and phone header captures. Live
Plannotator's own Done/feedback lifecycle remains owned by that application;
the browser fixture does not claim end-to-end coverage of its CLI.
