# Comment review: root, part 1

[Index and review procedure](README.md)

Snapshot: `3fe898ce5`. 48 blocks. Every item starts unreviewed.

Check an item only after recording **remove**, **keep**, or **rewrite/move** and a brief reason. Then apply and verify the corresponding source change.

- [ ] `a98405da0d0b2b1f` [.env.example:1–2](../../../.env.example#L1-L2) — **unreviewed** — ` # Yep Anywhere Development Environment # Copy to .env and modify as needed `
- [ ] `9e74faa591d25eea` [.env.example:4–8](../../../.env.example#L4-L8) — **unreviewed** — ` # Logging (file logging is off by default) # LOG_TO_FILE=true # Enable server log file ({dataDir}/logs/server.log) # LOG_LEVEL=debug # trace, debug, info, warn, error, fatal # LOG_FILE_LEVEL=debug # Separate level for file logging # LOG_PRETTY=false # Disable pretty console output (default: true) `
- [ ] `a4b1578ef32bd340` [.env.example:10–11](../../../.env.example#L10-L11) — **unreviewed** — ` # Ports (derived from PORT: server=PORT, maintenance=PORT+1, vite=PORT+2) # PORT=3400 `
- [ ] `0894300f0843bdab` [.env.example:13–14](../../../.env.example#L13-L14) — **unreviewed** — ` # Profile for data directory (~/.yep-anywhere-{profile}/) # YEP_PROFILE=dev `
- [ ] `21b71d8778f0c5c6` [.env.example:16–17](../../../.env.example#L16-L17) — **unreviewed** — ` # Enable HTTPS using an auto-generated self-signed certificate # HTTPS_SELF_SIGNED=true `
- [ ] `d8d58835498d2ad0` [.env.example:19–20](../../../.env.example#L19-L20) — **unreviewed** — ` # Raw SDK message logging (writes to {logDir}/sdk-raw.jsonl) # LOG_SDK_MESSAGES=true `
- [ ] `bea7be3c68a9a662` [.env.example:22–24](../../../.env.example#L22-L24) — **unreviewed** — ` # Codex session watcher fallback rescan (ms). Default on macOS: 5000, other OS: 0 (disabled). # Set to 0 to disable periodic fallback rescan. # CODEX_WATCH_PERIODIC_RESCAN_MS=5000 `
- [ ] `0f83e8b7b04878ee` [.env.example:26–27](../../../.env.example#L26-L27) — **unreviewed** — ` # Session index full validation interval (ms). 0 = validate every request. # SESSION_INDEX_FULL_VALIDATION_MS=30000 `
- [ ] `2152a925b91ac6d0` [.env.example:29–30](../../../.env.example#L29-L30) — **unreviewed** — ` # Project scan cache TTL (ms). 0 = rescan on every request. # PROJECT_SCAN_CACHE_TTL_MS=5000 `
- [ ] `37b507c1b8cc617c` [.git-blame-ignore-revs:1](../../../.git-blame-ignore-revs#L1) — **unreviewed** — ` # Repository-wide Biome 2.4.16 formatting pass (2026-06-24) `
- [ ] `2467c19f3d302e2f` [.git-blame-ignore-revs:4](../../../.git-blame-ignore-revs#L4) — **unreviewed** — ` # Biome formatting of sources touched since harsh review (2026-08-05) `
- [ ] `6ed79547808d00e2` [.git-blame-ignore-revs:7](../../../.git-blame-ignore-revs#L7) — **unreviewed** — ` # Repository-wide Biome 2.5.6 formatting baseline (2026-08-06) `
- [ ] `65c7d3650d3b4eb6` [.git-blame-ignore-revs:10](../../../.git-blame-ignore-revs#L10) — **unreviewed** — ` # Repository-wide Biome formatting pass (2026-08-07) `
- [ ] `36bd0197b6c89d54` [.gitattributes:1](../../../.gitattributes#L1) — **unreviewed** — ` # Keep Node ESM scripts executable and their shebangs parseable by Vite on Windows. `
- [ ] `0f7ddfa4e777c579` [.gitattributes:4](../../../.gitattributes#L4) — **unreviewed** — ` # Signed fixture payloads must retain their exact bytes on every platform. `
- [ ] `4a0f9fa2831a4d35` [.gitignore:1](../../../.gitignore#L1) — **unreviewed** — ` # Dependencies `
- [ ] `a3e3bc61d5187f59` [.gitignore:5](../../../.gitignore#L5) — **unreviewed** — ` # Build outputs `
- [ ] `fd7b30b0c2544ddb` [.gitignore:13](../../../.gitignore#L13) — **unreviewed** — ` # Environment `
- [ ] `ab70f417bbe6e347` [.gitignore:18](../../../.gitignore#L18) — **unreviewed** — ` # IDE `
- [ ] `0ab82c62f7147ad4` [.gitignore:26](../../../.gitignore#L26) — **unreviewed** — ` # OS `
- [ ] `3384cb5cd8046598` [.gitignore:30](../../../.gitignore#L30) — **unreviewed** — ` # Logs `
- [ ] `440ad780cbd5e9a7` [.gitignore:35](../../../.gitignore#L35) — **unreviewed** — ` # Test coverage `
- [ ] `67e51c4eecd4569b` [.gitignore:38](../../../.gitignore#L38) — **unreviewed** — ` # Test artifacts `
- [ ] `6855af7d768d35c9` [.gitignore:44](../../../.gitignore#L44) — **unreviewed** — ` # Temp files `
- [ ] `51a504c9249b41f6` [.gitignore:51](../../../.gitignore#L51) — **unreviewed** — ` # Yep Anywhere local data `
- [ ] `a74965a2ab124d74` [.gitignore:60](../../../.gitignore#L60) — **unreviewed** — ` # Checkout-local topic notes (personal/maintainer policy that must not ship) `
- [ ] `87722e3dc208b3f9` [.gitignore:64](../../../.gitignore#L64) — **unreviewed** — ` # Agent session/run state (local, any depth: root + packages/*) `
- [ ] `8e6bfd293e920e23` [.gitignore:67](../../../.gitignore#L67) — **unreviewed** — ` # Codex sample sessions (local dev data) `
- [ ] `3521b7f060ee0a48` [.gitignore:70](../../../.gitignore#L70) — **unreviewed** — ` # Large local Codex protocol dumps (script now keeps only provider subset) `
- [ ] `545ae4c3ab1b0089` [.gitignore:73](../../../.gitignore#L73) — **unreviewed** — ` # Text files in repo root `
- [ ] `a826c5f7ce45731b` [.gitignore:81](../../../.gitignore#L81) — **unreviewed** — ` # Reference repos (cloned for source reading) `
- [ ] `783c06670a260220` [.gitignore:84](../../../.gitignore#L84) — **unreviewed** — ` # Local software factories research `
- [ ] `ce075ccf96fdc137` [.yepignore:1](../../../.yepignore#L1) — **unreviewed** — ` # Dependency trees. Entries are literal project-relative directories. `
- [ ] `58a4bfe00478770a` [.yepignore:12](../../../.yepignore#L12) — **unreviewed** — ` # Local environments, checkouts, generated artifacts, and runtime state. `
- [ ] `4465518b0b4ba662` [README.md:204–206](../../../README.md#L204-L206) — **unreviewed** — ` <!-- Chart images come from star-history.dera.page, a third-party fork of star-history.com (source: https://github.com/Mubelotix/simrepo). The original stopped rendering when GitHub shut down its stargazer API. --> `
- [ ] `5b30d36056bee364` [eslint.config.js:1–3](../../../eslint.config.js#L1-L3) — **unreviewed** — ` // ESLint lints only authored CSS here; Biome owns TypeScript/JavaScript lint // and all formatting. Rule choices and rejections: topics/css-architecture.md // § CSS lint rules. `
- [ ] `0a96240067e08cda` [eslint.config.js:7](../../../eslint.config.js#L7) — **unreviewed** — ` // packages/desktop is outside Biome's scope as well; mockups are throwaway. `
- [ ] `179f297dc1b335eb` [eslint.config.js:18](../../../eslint.config.js#L18) — **unreviewed** — ` // Rejected as style churn with no defect prevented. `
- [ ] `146cf29f6703a4f0` [pnpm-workspace.yaml:5–7](../../../pnpm-workspace.yaml#L5-L7) — **unreviewed** — ` # scripts/biome.cjs intentionally uses Biome's static musl binary on Linux so # lint and formatting also work on hosts with an older glibc. pnpm otherwise # installs only the current libc's optional package. `
- [ ] `3673e21f78757fdf` [pnpm-workspace.yaml:13–19](../../../pnpm-workspace.yaml#L13-L19) — **unreviewed** — ` # pnpm settings live here, not under a "pnpm" key in package.json: pnpm 11 # stopped reading that key, and a pnpm 11 invocation of an install in this # repo reports all three of these as ignored. Silently losing # onlyBuiltDependencies would re-enable arbitrary dependency install scripts, # so keep them where every supported pnpm reads them. Rationale for the # individual entries is in docs/development/dependencies.md # ("Dependency Security Maintenance"). `
- [ ] `e6c91d393b3d2cfb` [pnpm-workspace.yaml:31–32](../../../pnpm-workspace.yaml#L31-L32) — **unreviewed** — `` # Vetted no-op build scripts, blocked on purpose. Listing them records that # decision, so installs stop warning and `pnpm approve-builds` stays empty. ``
- [ ] `15f1b03f35880dfb` [pstree.sh:1](../../../pstree.sh#L1) — **unreviewed** — ` #!/usr/bin/env bash `
- [ ] `d1edf88583e35462` [pstree.sh:40](../../../pstree.sh#L40) — **unreviewed** — ` # /proc/PID/stat fields after the parenthesized comm start at field 3. `
- [ ] `f5a530e97f479a1c` [verify.toml:1–8](../../../verify.toml#L1-L8) — **unreviewed** — `` # The repository's standard checks, by name. Each `run` is an ordinary # command; run it directly, or run them all with the `verify` runner # (https://github.com/graehl/agents, scripts/verify), which runs the quick # tier by default and adds `tier = "deep"` checks with --deep. # # `warn` matches lines that break the zero-warning rule # (docs/development/code-quality.md § Zero-Warning Commits). The check still # passes, and the matching lines are reported. ``
- [ ] `3fd1d5be55af41c0` [verify.toml:19](../../../verify.toml#L19) — **unreviewed** — ` # Reports standing ungated console calls as debt by design; no warn pattern. `
- [ ] `7345c2154936a279` [verify.toml:32–33](../../../verify.toml#L32-L33) — **unreviewed** — ` # \b leaves out Node's ExperimentalWarning for its built-in SQLite, which the # relay and push-broker use by choice. `
- [ ] `86a65d58b47e411a` [verify.toml:46](../../../verify.toml#L46) — **unreviewed** — ` # Browser suites start isolated servers; run them one at a time. `
- [ ] `af6e8abc2753fe29` [vitest.config.ts:1–12](../../../vitest.config.ts#L1-L12) — **unreviewed** — `` /** * Root-invoked vitest resolves each test file through its owning package's * project below, so `pnpm vitest run <files>` from the repo root behaves * exactly like that package's own runner — client files get jsdom + globals * (React Testing Library registers auto-cleanup only when test globals exist) * plus its setup file; server files get the hermetic-env setup. Without this, * root runs silently dropped every per-package test option and could fail * spuriously (RTL DOM accumulating across tests). `pnpm test` (pnpm -r test) * runs per package and is unaffected. The root package does not depend on * vitest, so this config exports a plain object rather than importing * `vitest/config`. */ ``
