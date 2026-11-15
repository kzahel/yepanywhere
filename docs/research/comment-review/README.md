# Repository comment review

Snapshot: `3fe898ce56fc1ffa885d8b7ebf12bab0024e3e5c` · 2026-11-15

**29,646 contiguous comment blocks**, in 3,920 files, split into 92 checklists of at most 500 blocks. **0 reviewed in this inventory.** The earlier 18 comment deletions are already in this snapshot and are not counted again.

The maintainer requested a repository-wide comment checklist and suspects roughly 90% can go. Treat that as a hypothesis: aggressively inspect narration and redundant documentation, record actual decisions, and report the resulting removal rate. It is not an automatic deletion rule or a required quota.

## Review each block

1. Read the comment and surrounding code using its source link and recorded location. Before changing anything, locate it in the current file and verify the text and context still match.
2. Change **unreviewed** to **remove**, **keep**, or **rewrite/move**, with a brief reason. Check the box when the decision has been applied and verified; a keep decision can be completed immediately.
3. Remove narration that merely repeats names, types, or nearby operations. A keep decision must identify information the code does not already express. Useful explanations may be shortened or moved to the owning contract.
4. Preserve legal notices, tool directives, required retention/warning explanations, protocol constraints and non-obvious invariants when they still have a purpose. A misleading comment can reveal a behavior defect; inspect it before deciding which side is wrong.
5. Work in coherent batches of about 50–100 blocks, with source changes separated from behavior repairs. Avoid files with concurrent edits. Verify comment-only edits preserve emitted code, run applicable repository checks, and commit bounded batches.

Follow [the comment policy](../../../topics/comments.md). Existing behavior defects around [artifact input ownership](../../../gaps/artifact-capture-input-ownership.md) and [early composer typing](../../../gaps/session-early-typing-waits-for-transcript.md) keep their own owners; deleting an explanation does not close those defects.

## Scope and extraction limits

- Scanned all **7,056 files tracked at the snapshot**, including runtime code, tests, tooling, native code, configuration, generated files and checked-in fixtures. Untracked files, ignored dependencies, archives and future edits are outside this snapshot.
- Used Tree-sitter language pack 0.13.0 with Tree-sitter 0.26.1 in a temporary environment; no repository dependency was added. Comments are syntax nodes, including inline comments and documentation comments. Adjacent comment nodes separated only by whitespace on the same or immediately next line form one chunk. Blank lines or intervening code start a new chunk.
- Parsed embedded script/style comments in HTML and Astro, Astro front matter, and HTML comments in Markdown. Documentation prose, Python docstrings, Markdown fenced examples, strings containing comment-like text, and patch/JSONL payloads are not source comments. Plain assets and data are listed in file accounting.
- Windows batch files use line-leading REM/:: recognition; the single NSIS file uses line-leading semicolon recognition and was inspected for other forms. Block excerpts retain all comment text with whitespace collapsed for compact checklists. Source files retain the original formatting and context. Links follow the current tree; line numbers are from the snapshot and can drift. Use `git show 3fe898ce5:path/to/file` when the original context is needed.
- **223 files had parser errors.** Their detected blocks are included, but completeness remains unverified. Complete the [separate file checks](coverage.md) before claiming every block was found. All tracked files, including zero-comment files and assets, appear there.
- IDs derive from the path, full comment text and its occurrence among identical comments in that file. They survive line movement but are snapshot identifiers; repeated identical blocks still need context checks. This is a frozen review inventory, not a runtime scanner, CI gate, or auto-delete tool.
- Extraction spot checks covered comment-like strings and regexes, JSX text/expressions, Python strings, Markdown fences, Astro front matter and embedded script/style, and Kotlin strings. These checks support the extraction method and do not establish the usefulness of any comment.

## Checklists

| Area | Part | Blocks | Checklist |
| --- | ---: | ---: | --- |
| `.github` | 1 | 3 | [Review](github-01.md) |
| `.github/workflows` | 1 | 208 | [Review](github-workflows-01.md) |
| `.husky` | 1 | 3 | [Review](husky-01.md) |
| `artifact-host` | 1 | 28 | [Review](artifact-host-01.md) |
| `docker` | 1 | 24 | [Review](docker-01.md) |
| `docker/reviewer` | 1 | 3 | [Review](docker-reviewer-01.md) |
| `docs/competitive` | 1 | 1 | [Review](docs-competitive-01.md) |
| `docs/tasks` | 1 | 23 | [Review](docs-tasks-01.md) |
| `packages/android` | 1 | 218 | [Review](packages-android-01.md) |
| `packages/android-device-server` | 1 | 50 | [Review](packages-android-device-server-01.md) |
| `packages/android-host` | 1 | 127 | [Review](packages-android-host-01.md) |
| `packages/browser-extension` | 1 | 16 | [Review](packages-browser-extension-01.md) |
| `packages/client` | 1 | 500 | [Review](packages-client-01.md) |
| `packages/client` | 2 | 500 | [Review](packages-client-02.md) |
| `packages/client` | 3 | 500 | [Review](packages-client-03.md) |
| `packages/client` | 4 | 500 | [Review](packages-client-04.md) |
| `packages/client` | 5 | 500 | [Review](packages-client-05.md) |
| `packages/client` | 6 | 500 | [Review](packages-client-06.md) |
| `packages/client` | 7 | 500 | [Review](packages-client-07.md) |
| `packages/client` | 8 | 500 | [Review](packages-client-08.md) |
| `packages/client` | 9 | 500 | [Review](packages-client-09.md) |
| `packages/client` | 10 | 500 | [Review](packages-client-10.md) |
| `packages/client` | 11 | 500 | [Review](packages-client-11.md) |
| `packages/client` | 12 | 500 | [Review](packages-client-12.md) |
| `packages/client` | 13 | 500 | [Review](packages-client-13.md) |
| `packages/client` | 14 | 500 | [Review](packages-client-14.md) |
| `packages/client` | 15 | 500 | [Review](packages-client-15.md) |
| `packages/client` | 16 | 500 | [Review](packages-client-16.md) |
| `packages/client` | 17 | 500 | [Review](packages-client-17.md) |
| `packages/client` | 18 | 500 | [Review](packages-client-18.md) |
| `packages/client` | 19 | 500 | [Review](packages-client-19.md) |
| `packages/client` | 20 | 500 | [Review](packages-client-20.md) |
| `packages/client` | 21 | 384 | [Review](packages-client-21.md) |
| `packages/desktop` | 1 | 81 | [Review](packages-desktop-01.md) |
| `packages/device-bridge` | 1 | 500 | [Review](packages-device-bridge-01.md) |
| `packages/device-bridge` | 2 | 500 | [Review](packages-device-bridge-02.md) |
| `packages/device-bridge` | 3 | 245 | [Review](packages-device-bridge-03.md) |
| `packages/ios` | 1 | 33 | [Review](packages-ios-01.md) |
| `packages/ios-sim-server` | 1 | 1 | [Review](packages-ios-sim-server-01.md) |
| `packages/mobile-core` | 1 | 49 | [Review](packages-mobile-core-01.md) |
| `packages/mobile-core-proof` | 1 | 19 | [Review](packages-mobile-core-proof-01.md) |
| `packages/push-broker` | 1 | 11 | [Review](packages-push-broker-01.md) |
| `packages/relay` | 1 | 345 | [Review](packages-relay-01.md) |
| `packages/server` | 1 | 500 | [Review](packages-server-01.md) |
| `packages/server` | 2 | 500 | [Review](packages-server-02.md) |
| `packages/server` | 3 | 500 | [Review](packages-server-03.md) |
| `packages/server` | 4 | 500 | [Review](packages-server-04.md) |
| `packages/server` | 5 | 500 | [Review](packages-server-05.md) |
| `packages/server` | 6 | 500 | [Review](packages-server-06.md) |
| `packages/server` | 7 | 500 | [Review](packages-server-07.md) |
| `packages/server` | 8 | 500 | [Review](packages-server-08.md) |
| `packages/server` | 9 | 500 | [Review](packages-server-09.md) |
| `packages/server` | 10 | 500 | [Review](packages-server-10.md) |
| `packages/server` | 11 | 500 | [Review](packages-server-11.md) |
| `packages/server` | 12 | 500 | [Review](packages-server-12.md) |
| `packages/server` | 13 | 500 | [Review](packages-server-13.md) |
| `packages/server` | 14 | 500 | [Review](packages-server-14.md) |
| `packages/server` | 15 | 500 | [Review](packages-server-15.md) |
| `packages/server` | 16 | 500 | [Review](packages-server-16.md) |
| `packages/server` | 17 | 500 | [Review](packages-server-17.md) |
| `packages/server` | 18 | 500 | [Review](packages-server-18.md) |
| `packages/server` | 19 | 500 | [Review](packages-server-19.md) |
| `packages/server` | 20 | 500 | [Review](packages-server-20.md) |
| `packages/server` | 21 | 500 | [Review](packages-server-21.md) |
| `packages/server` | 22 | 500 | [Review](packages-server-22.md) |
| `packages/server` | 23 | 500 | [Review](packages-server-23.md) |
| `packages/server` | 24 | 500 | [Review](packages-server-24.md) |
| `packages/server` | 25 | 500 | [Review](packages-server-25.md) |
| `packages/server` | 26 | 500 | [Review](packages-server-26.md) |
| `packages/server` | 27 | 498 | [Review](packages-server-27.md) |
| `packages/shared` | 1 | 500 | [Review](packages-shared-01.md) |
| `packages/shared` | 2 | 500 | [Review](packages-shared-02.md) |
| `packages/shared` | 3 | 500 | [Review](packages-shared-03.md) |
| `packages/shared` | 4 | 500 | [Review](packages-shared-04.md) |
| `packages/shared` | 5 | 500 | [Review](packages-shared-05.md) |
| `packages/shared` | 6 | 7 | [Review](packages-shared-06.md) |
| `requirements` | 1 | 8 | [Review](requirements-01.md) |
| `research/content-worker-localhost-spike` | 1 | 3 | [Review](research-content-worker-localhost-spike-01.md) |
| `research/extension-artifact-spike` | 1 | 17 | [Review](research-extension-artifact-spike-01.md) |
| `research/relay-artifact-frame-spike` | 1 | 10 | [Review](research-relay-artifact-frame-spike-01.md) |
| `root` | 1 | 48 | [Review](root-01.md) |
| `scripts` | 1 | 405 | [Review](scripts-01.md) |
| `scripts/agent-api-eval` | 1 | 23 | [Review](scripts-agent-api-eval-01.md) |
| `scripts/fixtures` | 1 | 24 | [Review](scripts-fixtures-01.md) |
| `scripts/lib` | 1 | 16 | [Review](scripts-lib-01.md) |
| `scripts/perf-repro` | 1 | 95 | [Review](scripts-perf-repro-01.md) |
| `scripts/perf-suite` | 1 | 13 | [Review](scripts-perf-suite-01.md) |
| `scripts/unicode-math` | 1 | 41 | [Review](scripts-unicode-math-01.md) |
| `sharing-worker/src` | 1 | 3 | [Review](sharing-worker-src-01.md) |
| `site/public` | 1 | 27 | [Review](site-public-01.md) |
| `site/src` | 1 | 14 | [Review](site-src-01.md) |
| `topics` | 1 | 22 | [Review](topics-01.md) |
