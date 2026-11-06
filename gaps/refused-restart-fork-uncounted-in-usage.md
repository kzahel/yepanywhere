# A refused restart fork leaves its new session out of the usage count

`POST .../restart` with `restartMode: "fork"` in
`packages/server/src/routes/sessions.ts` forks the source transcript, then
resumes the fork. When the resume is refused (the worker queue is full, or
the launch could not start at once and was cancelled), the route answers 503
naming the fork, which is kept. The user's session count in Settings ->
Users (`userUsageService.recordSession`) is written only after the resume
starts, so that kept fork is never counted.

The fork-summary job counts its target session as soon as the target fork
exists, before its launch, so a refused fork-summary launch is counted.
`18ae0a87f` chose both placements: fork-after-summary counts "once its fork
exists", restart counts on success. Whether a kept but never-started restart
fork should count was not decided, so it is left for the maintainer.

Not fixed in place: step 3 of
[the session launch service plan](../docs/tactical/177-session-launch-service.md)
only consolidated how routes read a launch result. The cheap fix, if the
fork should count, is to move the restart fork's `recordSession` call from
after the resume starts to right after `forkSession` succeeds, as the
fork-summary job does.

Found 2026-11-06 while consolidating the launch-outcome mapping (plan 177
step 3).
