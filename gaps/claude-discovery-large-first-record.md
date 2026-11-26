# Claude project discovery can miss a directory with large first records

A new profile containing ten Claude transcripts in one project and 50
unrelated Codex rollouts published only the Codex project. Every Claude
transcript began with a user record containing its cwd and four inline PNGs
(1,163,340 decoded bytes). Moving a short cwd-bearing record ahead of the
images made all ten sessions discoverable in the same Inbox navigation fixture.

`readCwdFromSessionFile` in `packages/server/src/projects/paths.ts` accepts
complete JSONL records within a 256 KiB prefix. A focused file probe found
the cwd in a 240,210-byte first record and returned null for 300,210 and
1,551,330 bytes, even with cwd before the image. Adding a short first record
returned the correct cwd in every case. When no transcript yields a cwd,
`readClaudeProjectDirectory` tries the remaining files and omits the
directory. The probe establishes a discovery failure; time attributable to
it in the live stall logs is unknown.

Found 2026-11-26 while qualifying session-scoped issue reads with inline images.
