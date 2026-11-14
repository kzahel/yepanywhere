# Sessions saved under a link's spelling keep their old path defects

Since 2026-11-14 a project is the folder its path names: adding a project and
starting a session from the UI resolve a link once, and a saved session keeps
that folder ([project paths](../topics/project-paths.md)). That closed the
cross-provider gap this entry replaces (`project-path-identity-and-session-
routing.md`) and the Linux sandbox membership gap
(`symlinked-sandboxed-session-leaves-its-project-list.md`) for everything
started under the rule. Git history keeps both entries and their full
Claude/Codex matrices.

What remains is confined to sessions and projects that are still saved under
a link's spelling: those created before the rule, and those the rule
deliberately leaves alone. No stored record was rewritten, because resolving
an old link today says where it points now, not where a session ran.

## Still wrong for a session saved under a link

Measured on macOS with real Claude 0.3.322 and Codex 0.167.0 processes, on a
profile whose session was created by the previous server and then served by
the new one (`.artifacts/diagnostics/alias-matrix/probe-upgrade.mts`, a local
disposable probe, not a retained test):

- **A resume follows the link.** Retarget the link from folder A to folder B
  and the stopped conversation resumes in B, under its old project label.
  Resume passes the saved project path, which is the link. Claude's
  transcript records the folder it ran in, so a Claude resume could use
  that; Codex recorded only the link, so nothing says where it ran.
- **Claude shows a second card.** The real folder has its own project card
  whose count includes the session while its list is empty, because the card
  comes from the native transcript directory and the session is listed under
  its saved link project (`projects/catalog-projects.ts`).
- **The link project's own page is 404 while the link is missing.**
  `GET /projects/:id` and `/projects/:id/sessions` still need the folder
  (`routes/projects.ts`). The session itself stays listed in All Sessions and
  Inbox, opens, and reports no warning.
- **Linux, project-write sandbox:** a later resume records the working
  project as the real path, so the session moves from the link's project list
  to the real folder's (`persistProcessSandboxOrAbort` in `Supervisor.ts`
  saves `process.projectId`, which the resume derives from the run path). The
  characterization in `test/routes/session-launch-records-sandboxed.test.ts`
  now pins the consistent records of a session started under the rule, so
  nothing pins this older case any more.

## Left alone on purpose

- **Limited users** keep the selected path for projects they own and
  sessions they start, since ownership and grants name that project
  ([limited users](../topics/limited-users.md#project-creation)). The
  superuser's own session in a link-spelled project shared by grant lands in
  the real folder's project, which that grant does not cover.
- **Automation** (Project Queue, HTTP v0 create, review launches, and fork,
  clone or restart of an existing session) starts in the project it names. In
  a link-spelled project it therefore still saves under the link. Moving
  those launches needs each feature's project-keyed state to follow.
- **Windows** paths are not resolved.

## Not yet qualified

- The missing-folder refusal (`409`, `project-folder-missing`) covers the
  interactive resume and reactivate routes. Automatic resumes (queue
  dispatch, wake, heartbeat) and the fork, clone and restart routes still
  reach the provider, where the hosted Codex fixture previously answered
  `Provider worker closed during attach`. The client shows the refusal
  through its ordinary send-failure toast and keeps the draft; that
  presentation was read in code, not exercised in a browser.
- Providers other than Claude and Codex receive the same resolved path but
  have no real-process run. Sessions imported from a provider's own TUI were
  not probed. The fixture enables the shared provider host, so the default
  macOS in-Hono ownership variant is unqualified.
- Hosts whose home directory is reached through a link see every existing
  project divide once into its old card and the real folder's card. That
  follows from the upgrade rule; no such host was tested.

A cheap next step, if these sessions matter in practice: group a link-saved
project under its real folder when listing, without changing any stored
record.

Found 2026-09-12 while validating tactical 128 with real Claude sessions on
macOS; the sandbox case found 2026-11-07 on the Linux testbed during plan 177
step 5. Narrowed 2026-11-14 when the project path rule landed.
