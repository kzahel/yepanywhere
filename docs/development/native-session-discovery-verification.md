# Native session discovery verification

Scope: transient reads, Claude replicas, Codex metadata rewrites, native archives.
No model request or provider credential is needed.

## Automated real-file acceptance

Use supported Node with native zstd (verified on Node 24.22.1):

```sh
pnpm install --frozen-lockfile
node --import tsx --conditions source packages/server/scripts/verify-native-session-discovery.mjs
```

The harness creates its own temporary home, files and indexes, exercises actual
readers/scanners/index service and real loopback HTTP project routes, then prints
the retained fixture directory. Windows cases acquire a real exclusive OS lock;
lock-only cases explicitly skip elsewhere. It never reads personal histories,
starts coding agents, or calls model APIs. Fixtures stay for inspection; normal
index lock-file cleanup still runs.

## Manual acceptance in the application

Use a separate test installation/home and data directory, not real CLI history.
Start this branch with `pnpm dev` following the normal local-development guide.
Point `CLAUDE_SESSIONS_DIR`, `CODEX_SESSIONS_DIR`, and `YEP_DATA_DIR` at the test
tree. Copy a harmless real CLI transcript there or reuse generated fixtures.
Never edit or move production transcripts for these tests.

### 1. Temporarily unreadable history

1. Open a test project and session list once so rows are accepted.
2. On Windows, append a newline to its test JSONL, then hold an exclusive lock
   in another PowerShell window (replace the path):

```powershell
$file = 'C:\test-history\session.jsonl'
$handle = [IO.File]::Open($file, 'Open', 'ReadWrite', 'None')
Read-Host 'Refresh the session list, then press Enter to release'
$handle.Dispose()
```

3. Refresh while locked. Accepted project/session titles remain; uncached
   message content may honestly report that it is unavailable.
4. Release, then refresh after the ordinary cache interval (about five seconds).
   New content appears without restarting YA or a second edit. Repeat for both
   Claude and Codex.
5. Move the fixture outside discovery. Successful validation removes it; a
   truly missing file must not remain indefinitely as a retained row.

### 2. Claude duplicate replicas

1. Use two merged Claude directories with identical project cwd and session ID.
   Keep another valid session in the first directory so the project is known.
2. Make the target first replica empty; keep its second replica complete.
3. Open project list and detail: one target session, correct title and messages.
4. Repeat with incomplete JSON in the first replica. Correcting that first
   copy must not create duplicate IDs.

### 3. Codex in-place head replacement

1. Warm discovery for a fixture whose `session_meta.payload.cwd` points to
   project A. Stop only the test server to exercise its durable discovery index.
2. Overwrite the same file in place: change A to same-length project B, preserving
   session ID. Repeat separately with a longer cwd. Do not reset timestamps.
3. Restart with the same test data directory. The session moves to B, disappears
   from A, and its messages and ID remain readable.
4. Unchanged files still use discovery-cache hits; the harness checks metrics.
   Rewrites preserving every observed stat field are outside this contract.

### 4. Codex native archives

1. Put a standalone rollout in `archived_sessions`, sibling of `sessions`.
   Also test with no active `sessions` directory.
2. Projects, session list, and detail must show this history.
3. Copy the same rollout into `sessions`: it appears once and prefers active
   content. Move it between roots while the test server runs; refresh/reopen.
4. Repeat with a compressed-only `.jsonl.zst` on zstd-capable Node. A plain plus
   compressed pair also appears once.
5. Native physical archive storage is distinct from YA's Archive toggle; this
   patch does not alter that toggle's filtering policy.

## Validation record and limits

- Windows / Node 24.22.1: 17 real-file/HTTP acceptance scenarios passed
  in about ten seconds, including watcher-to-index archive discovery and
  incremental lock recovery without a second watcher event.
- Focused upstream regression: 15 files, 282 tests passed, 3 skipped.
- Shared build, server TypeScript, and touched-source lint passed.
- Broader project-scanner tests have 3 Windows failures reproduced unchanged
  on baseline `805edd3a3ef81b3d01d13be81ca229c39eee4e16`: registered-directory
  retention, workstream grouping, and id-only sandbox directories. These are
  not silently skipped or changed in the patch.
- Root lint is blocked by an unchanged generated simple-client contract check
  in this Windows checkout (also reproduced on the baseline). Root tests stop
  at the generated frame-find-agent check after 967 shared tests pass; that
  generated-file check also fails on the unchanged baseline. Root
  typecheck encounters an uninstalled optional
  desktop workspace (React/Tauri declarations absent). Server checks are green;
  this is not a claim of a green complete monorepo suite.
- Root format checking reports CRLF-versus-LF differences across untouched
  tracked sources with this checkout's `core.autocrlf=true`. Only the exact
  changed source/test files were formatted and checked; no repository-wide
  line-ending rewrite is included.
- Full-app Windows startup previously failed at `icacls /setowner`. This patch
  does not weaken permissions to bypass it. Actual HTTP routes were exercised,
  but full-browser visual QA and Linux/macOS checks remain reviewer work.
- No deployment, Pi integration, or provider execution changes are included.
