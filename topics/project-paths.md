# Project Paths And Links

> A project is a folder. A symbolic link is a way to reach one, never a
> project of its own: work a person starts through a link belongs to the
> folder the link names at that moment, and stays there.

Topic: project-paths

Status: **implemented (2026-11-14)** for adding a project and starting a
session from the UI, on macOS and Linux. Qualified with real Claude and Codex
processes on both; see [limits](#limits).

## Why

A process started in a path that passes through a link runs in the real
folder. Claude records that real folder, while Codex records and re-reads
whatever path it was given. Treating the link's spelling as the project
therefore produced a second project card for the real folder, counts that
disagreed with lists, history that returned 404 once a link changed, a
warning that never cleared, and conversations that silently moved to another
folder when a link was retargeted. Resolving the path once, at the moment a
person selects it, removes the disagreement instead of reconciling it
afterward.

## Contract

- **Adding a project** registers the folder the given path names. Adding
  `~/work` when it is a link to `/Volumes/ext/work` adds the project
  `/Volumes/ext/work`; the link is not listed as a project. The response
  carries that project, and the client continues with its id.
- **Starting a session from the UI** in any project starts it in the folder
  that project's path names now, and saves it under that folder's project.
  The creation receipt names that project. For a project that is a folder
  this changes nothing.
- **A saved session keeps its folder.** Its project, its provider's working
  folder and every later resume use the path saved when it started.
  Retargeting, renaming or removing a link afterward changes none of them.
  A link retargeted from folder A to folder B sends only sessions started
  afterward to B.
- **Two spellings of one folder are one project.** `/tmp/x` and
  `/private/tmp/x` on macOS, a link, and a chain of links all name the same
  project when started or added.
- **A folder replaced at the same path is the same project.** YA does not
  track a folder's filesystem identity. Deleting a folder and creating
  another at that path gives the saved sessions the new folder.
- **Saved history does not need the folder.** Opening a saved session reads
  its transcript whether or not the project folder, or a link to it, still
  exists. A missing folder never makes a saved session "not found".
- **Continuing work needs the folder.** Sending to a stopped session whose
  folder is gone is refused with HTTP 409 and
  `reason: "project-folder-missing"`. The message names the folder, says the
  history is still available and that restoring the folder allows continuing.
  Nothing is started somewhere else. A session whose process is still running
  keeps accepting input.
- **A Claude session keeps its saved project when its link changes.** A
  session saved under a link is listed under that saved project even after
  the link is retargeted or removed, and no "could not be matched" warning is
  raised for it. See
  [session identity](session-identity.md#current-implementation).

## Upgrades

No stored record is rewritten. Resolving an old link today says where it
points now, not where a session ran, so sessions saved under a link's
spelling keep that project and their public ids. After upgrading:

- A project whose path is already a folder behaves exactly as before.
- A project saved under a link's spelling keeps its card and its old
  sessions. Sessions started in it from the UI land in the real folder's
  project, so such a project divides once into the old card and the real
  folder's card, and nothing moves afterward.
- This applies to every project on a host whose home directory is itself
  reached through a link (Fedora Atomic's `/home`, a network home), because
  each such path differs from its real path.

## Limits

- **Limited users.** Their ownership and grants name a project by its
  selected path ([limited users](limited-users.md#project-creation)). A
  project a limited user owns, a session a limited user starts, and an added
  path a limited user may already reach all keep the selected path. A
  superuser's own session in a link-spelled project shared by grant lands in
  the real folder's project, which that grant does not cover.
- **Automation keeps the project it was given.** The Project Queue, the
  [HTTP v0](http-api-v0.md) create operation, review launches and
  continuations of an existing session (fork, clone, restart) start in the
  project they name. Each is keyed to that project or continues one of its
  sessions.
- **Windows** paths are not resolved. A Windows process keeps the path it was
  given, and resolving there rewrites mapped and `subst` drives to network
  paths.
- **Other providers** take the same resolved path, since resolution happens
  before a provider is chosen, but only Claude and Codex are qualified with
  real processes.
- The remaining defects for projects saved under a link before this contract
  are recorded in the
  [narrowed gap](../gaps/link-spelled-projects-saved-before-path-resolution.md).

## Verification

`packages/server/test/native-app/app-project-link.test.ts` runs the pinned
Claude and Codex executables through the real application: a session started
through a link is saved and listed under the folder, resumes in that folder
after the link is retargeted (asserted from the shell's own `pwd` output),
stays readable with the folder deleted, and is then refused on resume.
`test/projects/launch-project.test.ts` covers the resolution rule,
`test/routes/projects.test.ts` adding through a link, and
`test/sessions/catalog-identity-projection.test.ts` a saved Claude session
whose link changes.

## See also

- [Session identity](session-identity.md): bindings, the saved project and
  conflict containment.
- [Project names](project-names.md): the name a project shows.
- [Project directory storage](project-directory-storage.md): none of this
  writes into a project.
