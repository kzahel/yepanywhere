# Fresh npm dependency resolution can exceed the Node 20 runtime floor

The generated npm package copies `sanitize-html: ^2.17.5` from the server
manifest. A fresh installation on 2026-09-08 resolved 2.17.7, which requires
Node 22.12 and fails on Node 20.12.2 with `ERR_REQUIRE_ESM` while requiring
`htmlparser2`. The repository lockfile still selects 2.17.5, so normal locked
workspace tests do not reproduce this published-install failure.

Plain npm installation also rejects `@mdit/plugin-katex@1.0.2`'s optional
markdown-it 14 peer against the selected markdown-it 15. The workspace
deliberately overrides those peers in `pnpm-workspace.yaml`; the generated
package does not carry that pnpm policy. `--legacy-peer-deps` allows the install
to reach the sanitizer startup failure but is not a complete packaging fix.

Reproduce by building the npm staging package, installing its production
dependencies with fresh npm resolution, and launching `dist/index.js` under
Node 20.12.2 in a disposable profile. Fix the published dependency contract and
validate an actual clean install separately from the locked workspace. Keep
the sanitizer security/advisory analysis in `CLAUDE.md` and
`gaps/production-dependency-audit-advisories.md` in mind when selecting a fix.

Optional SQLite tests exercise the packaged modules with locked workspace
dependencies so unrelated registry drift does not change the runtime matrix.
This issue predates SQLite support; no dependency range was changed there.

Found 2026-09-08 while validating optional SQLite storage and Node 20 fallback.
