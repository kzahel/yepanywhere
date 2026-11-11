# Git fixture subprocesses inherit repository-routing variables

Several Git fixture helpers invoke `git -C <temporary-directory>` without
removing inherited `GIT_DIR`, `GIT_WORK_TREE` or `GIT_INDEX_FILE`. Those variables
take precedence over the temporary directory. Examples include
`packages/server/test/augments/project-path-links.test.ts`,
`packages/server/test/projects/projectWorktreeScan.test.ts` and
`packages/server/src/git/authorPalette.test.ts`.

On 2026-11-11, I incorrectly ran workspace tests for an exported source snapshot
with `GIT_DIR` pointing to the real checkout and a separate index. Fixture
initialization and commits changed the real branch ref, worktree configuration
and local identity. The separate index did not protect refs or configuration.
I stopped that run and restored the original main ref and configuration;
the original index and working files were preserved. Verification then used
private Git metadata and no inherited repository-routing overrides.

The immediate mistake was in the verification invocation. Defensive fixture
isolation should also remove repository-routing variables before every Git
subprocess, including initialization and configuration, through a shared helper.
An integration check should poison those variables and prove an outside
repository's refs, index and configuration remain unchanged. Consolidating the
existing fixture helpers is separate from the composer preview correction.

Found 2026-11-11 while correcting the design playground's synthetic waveform.
