# A sandboxed session opened through a symlinked folder leaves its project's list

On Linux, a project-write sandboxed session started in a project opened
through a symlinked folder runs in the folder's real path. The sandbox
resolves the path (`prepareSessionSandbox` in
`packages/server/src/session-sandbox.ts`), while the session's record names
the link's project as its working project. Several launches then record the
real path's project in its place, and the session drops out of the session
list of the project the user opened. It appears under the real path's project
instead.

`packages/server/test/routes/session-launch-records-sandboxed.test.ts` pins
what each launch records today:

- Any later resume of the source or of a copy rewrites the working project
  to the real path's (`persistProcessSandboxOrAbort` in `Supervisor.ts`
  saves `process.projectId`, which `resumeSession` and `reactivateSession`
  derive from the run path), and the session is then listed under the real path.
- A clone, a restart handoff, a restart fork and a fork-summary continuation
  are listed under the real path from the start: each is copied or started in the real
  path, and nothing names the link's project for it.
- A fork and the retitle and fork-summary helpers keep the link's project
  until their first resume, because the route names it for them.

Not fixed in place because it changes which list shows these sessions, and
the change that found it kept every stored record as it was. The likely fix:
the clone and restart paths pass the source's working project as fork
already does, and a resume keeps the session's saved working project rather
than deriving one from the run path. Then rerun the Linux cases, whose
listed-under snapshots should all name the link.

Found 2026-11-07 while capturing the sandbox records of plan 177 step 5 on
the Linux testbed.

2026-11-10: CI 42888098385 now lists these sessions under the real project,
rather than nowhere. The characterization snapshots follow that observed
behavior. Keeping them in the originally selected linked project's list remains
unresolved; this update does not change launch or sandbox policy.
