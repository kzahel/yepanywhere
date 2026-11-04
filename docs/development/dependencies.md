# Dependency maintenance

[Contributor guide](../../DEVELOPMENT.md) · [Development docs](README.md)

Commands and code paths below are relative to the repository root unless stated
otherwise.

## Dependency Security Maintenance

CI runs `pnpm audit` on every pull request and push to `main` (the
`audit` job in `ci.yml`) and it must exit 0. Pay special attention to the
`web-push -> asn1.js -> bn.js` chain.
Keep `bn.js` patched (currently via pnpm override) until `web-push` ships an
upstream fix.

The audit includes development tools installed by CI. Native provider test
executables are an explicit workspace with a `workspace:*` development edge;
pnpm's audit omitted their transitive graph when that edge used `file:`.
Their separate package keeps CLI bins off the application's development PATH.
The 2026-11-04 repair upgrades Pi's test executable to 1.5.0 (Undici 8.12.3),
Vite to 6.4.5 and React Router to 7.18.2. The Router 7.x backport removes
its previous advisory exception. Gemini CLI and its native regression cases
are removed; Antigravity remains the maintained Google CLI test path.

The same job audits both standalone npm lockfiles (`site/` and
`sharing-worker/`), including development dependencies, and the pinned STT
recovery snapshot with `pip-audit`. The Python audit queries the complete
snapshot's indexed versions without installing its CUDA stack. Its exceptions
must match the Python rows under **Known-unreachable advisories** below.
The sole commit-pinned Transformers Git requirement has no PyPI version to
query and is explicitly excluded; changes to that source pin still require
review. Other unscannable requirements fail the audit. This gate does not audit
unpinned optional speech environments or qualify installed GPU environments.

When a transitive dep has no direct upgrade path, prefer a pnpm override. Pin it
exactly if a newer major would escape the parent's declared range — `fast-uri`
is pinned to `3.1.9` rather than `^3.1.9` because 4.x is published and `ajv`
declares `^3.0.1`. When the parent's declared range already contains the patched
version, no override is needed: refresh the lockfile with
`pnpm -r update <pkg> --depth=Infinity` (plain `pnpm update` skips transitive
deps). That refresh can leave a stale transitive copy in place and bump the
direct dependents instead: `jsdom@25` (client tests only) stayed on
`ws@8.19.0`, inside two `ws` advisories, although its `^8.18.0` range admits
the patched 8.21. The scoped `"jsdom>ws": "^8.21.3"` override moves only that
edge. Drop it when a newer jsdom resolves a patched `ws` without it.

The 2026-09-29 audit refresh moves `fast-uri` to 3.1.7 and the MCP SDK's
`express-rate-limit -> ip-address` edge to 10.7.2 (within its `^10.2.0`
range). This resolves GHSA-qw65-cvwx-89v3, GHSA-58mr-gqgx-xq4g,
GHSA-rpw4-54j3-4h4q, and GHSA-2vr4-cq9g-pvrc without new audit exclusions.

During the 2026-09-30 CI isolation campaign, the unchanged lockfile's audit
began reporting four additional advisories. The existing exact `fast-uri`
override moves to [3.1.8](https://github.com/advisories/GHSA-hrr3-gc8f-f4qj),
and the Firestore `minimatch` edge resolves `brace-expansion` to 2.1.7 within
its declared 2.x range. That release fixes
[nested recursion](https://github.com/advisories/GHSA-qhr7-859c-m2p7),
[comma recursion](https://github.com/advisories/GHSA-6j4f-fj2g-mc7p), and
[quadratic expansion](https://github.com/advisories/GHSA-q2hr-2g5m-vwhr).
No new audit exclusions are added; unrelated resolutions remain unchanged.

The 2026-10-01 CI audit repair resolves `@grpc/grpc-js` to 1.14.5 and
`dompurify` to 3.4.16 within their parents' declared ranges, fixing
[the gRPC certificate advisory](https://github.com/advisories/GHSA-m9gg-hp2v-232j),
[gRPC error disclosure](https://github.com/advisories/GHSA-f596-whhp-79r4), and
[the DOMPurify hook advisory](https://github.com/advisories/GHSA-p98j-92pf-mc4p).
A fresh audit also reported [Hono JSX boundary escaping](https://github.com/advisories/GHSA-hxh3-vqpv-xpqv);
all Hono workspace consumers now resolve 4.13.12, above its 4.13.7 patch floor.
No new advisory exclusions or install-script permissions are added.

The 2026-10-03 CI repair resolves Firebase Admin's `@fastify/busboy` edge
to 3.2.2 within its declared range, above the 3.2.1 patch floor for
[multipart resource exhaustion](https://github.com/advisories/GHSA-xjh9-v7x6-24jw)
and [prototype-named headers](https://github.com/advisories/GHSA-x8mw-p69m-v3mx).
Unrelated resolutions and advisory exclusions remain unchanged.

The 2026-10-06 CI audit repair moves three transitive edges within their
parents' declared ranges: the MCP SDK's `express -> proxy-addr` to 2.0.8
([IPv4-mapped IP spoofing](https://github.com/advisories/GHSA-jqcg-44mw-7w3h)),
`postcss -> source-map-js` to 1.2.2
([event-loop denial of service](https://github.com/advisories/GHSA-68fv-2mgg-jv7q)),
and the relay's `pino-pretty -> fast-copy` to 4.1.2
([stack exhaustion](https://github.com/advisories/GHSA-jggr-w7fw-pc2j)).
`pnpm -r update --depth=Infinity` also re-resolved unrelated jsdom CSS
dependencies, so these were moved with temporary exact overrides that were
then removed. [KaTeX's prototype-pollution gadget](https://github.com/advisories/GHSA-238p-pmpm-9mq7)
is patched only in 0.18.2, outside mermaid's `^0.16.47` range (12.1.0 too),
so the scoped `"mermaid>katex": "^0.18.6"` override shares the 0.18 copy the
client and server already use. Mermaid calls only `renderToString` with
`throwOnError`, `displayMode` and `output`, untouched by the 0.17 and 0.18
breaking changes. Drop the override when mermaid declares a patched KaTeX.
No new advisory exclusions are added.

The 2026-10-07 CI audit repair moves the server's exact
`@modelcontextprotocol/sdk` pin from 1.29.0 to 1.32.1, above the 1.31.0 patch
floor for [OAuth credentials sent to an MCP-chosen authorization server](https://github.com/advisories/GHSA-6qxp-vccf-f47h).
YA code imports nothing from the SDK; the pin satisfies
`@anthropic-ai/claude-agent-sdk`'s `^1.29.0` peer range, which 1.32.1 stays
within. No new advisory exclusions are added.

The 2026-10-20 release audit moves the server's exact `markdown-it` pin to
15.0.2 for [quadratic smartquotes processing](https://github.com/advisories/GHSA-r7fv-28h4-cvq7).
YA already sets `typographer: false`; the patch removes the vulnerable
dependency without adding an advisory exclusion.

The same day's CI audit repair moves that pin to 15.0.3 for
[quadratic link reference definitions](https://github.com/advisories/GHSA-gfr2-rv44-r23c)
and [quadratic inline HTML](https://github.com/advisories/GHSA-vfgh-jcmw-g37q),
raises the server's `sanitize-html` floor to 2.18.1 for
[`nonTextTags` early close](https://github.com/advisories/GHSA-x3q4-9hxx-gx8m),
[`meta` refresh URLs](https://github.com/advisories/GHSA-cv27-6wvh-8x7j), and
[SMIL namespace prefixes](https://github.com/advisories/GHSA-374f-7chj-9948),
and resolves `http-proxy -> follow-redirects` to 1.16.1 within its declared
range ([GHSA-q3jh-wrc6-jgq8](https://github.com/advisories/GHSA-q3jh-wrc6-jgq8),
[GHSA-8r9p-f939-6h3c](https://github.com/advisories/GHSA-8r9p-f939-6h3c)).
The refresh also re-resolved jsdom 29's `undici` and `tldts` to patch
releases. No new advisory exclusions are added.

The 2026-10-23 CI audit repair refreshes `mermaid -> dompurify` to 3.4.17
for the [shadow-root template bypass](https://github.com/advisories/GHSA-cg2g-xh64-v4q7),
[detached-subtree event handlers](https://github.com/advisories/GHSA-mrv2-3pqr-j5jr)
and [XHTML SMIL guard bypass](https://github.com/advisories/GHSA-c6gr-qvv4-5v3f),
and the MCP SDK's `express-rate-limit -> ip-address` edge to 10.7.4 for
[quadratic IPv6 zone parsing](https://github.com/advisories/GHSA-rxp7-6hxx-x8q5).
Both patches fit their parents' declared ranges; no new overrides or advisory
exclusions are needed. Unrelated lockfile resolutions remain unchanged.

The 2026-10-24 security refresh raises the Zod floor to 4.6.7 for
[oversized constrained collections](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5),
resolves `express -> body-parser` to 2.4.0 within its declared range for
[compressed request trailing bytes](https://github.com/advisories/GHSA-27r3-jxmh-p828),
and moves the existing exact `fast-uri` override to 3.1.9 for its URI
normalization advisories. Vitest and its mocker move together to 4.1.12 for
[manual mock injection](https://github.com/advisories/GHSA-qxg6-89mg-rqv8)
and [Windows redirect traversal](https://github.com/advisories/GHSA-xp26-3454-mjgp).
Desktop Tokio resolves to 1.51.6 for
[AsyncFd I/O safety](https://rustsec.org/advisories/RUSTSEC-2026-0386.html).
No new audit exclusions or install-script permissions are added.

Zod 4.6.7 requires a key whose schema is `z.undefined()` to be present;
the Write acknowledgement's absent `file` key is explicitly optional so
captured native and live results retain their existing rich presentation.
The pnpm patch for Zod changes only explanatory comments in its ESM and
CommonJS builds: the comments accidentally contain Rollup's pure-annotation
token, which makes the warning-free client build fail. The executable
annotation and runtime code remain intact. Drop this patch when an upstream
release removes the misplaced annotation token.

The same day's mobile security refresh pins `crypto-bigint` to 0.7.6 in
the production Rust core and refreshes the isolated proof lockfile to match,
including its `ctutils` 0.4.5 dependency. This addresses
[RUSTSEC-2026-0387](https://rustsec.org/advisories/RUSTSEC-2026-0387.html),
which identifies secret-dependent branches in operations intended to be
constant-time. The existing SRP compatibility vectors and live connection
checks own the unchanged-server boundary. This dependency patch does not
establish whole-protocol constant-time behavior or a formal crypto audit;
the accepted limits remain in [mobile SRP](../../topics/security.md#mobile-srp-implementation-decision).

The standalone 2026-10-24 refresh resolves the website's `undici` to 8.12.2,
`fast-uri` to 3.1.9 and Zod to 4.6.6 within their parents' declared ranges.
Together these updates address eight website alerts and one sharing-worker
alert. The worker's Miniflare pins Undici exactly, so its
scoped npm override raises only `miniflare -> undici` to 7.30.1 for
[excessive content encodings](https://github.com/advisories/GHSA-xjj6-f33q-929c).
Drop that override when the pinned Miniflare declares a patched Undici.
The override names the exact Miniflare beta version: npm 10 does not apply the
unversioned parent override to this prerelease and rejects the frozen install.
CI verifies the worker's frozen install before auditing it so the deployment's
npm 10 boundary stays covered.

The STT recovery snapshot raises `filelock` to 4.2.1 for its SQLite reader/writer
lock and Windows soft-lock advisories. Linux/Python 3.12 resolution for the
snapshot and its NeMo constraint consumer preserves the pinned Torch and
Transformers builds. This secures subsequent installs; live speech environments
need a separate update and inference qualification.

The 2026-10-27 CI repair raises the snapshot's `msgpack` pin to 1.2.3 for
[strict-map-key parser memory leaks and stale parser-stack references](https://github.com/msgpack/msgpack-python/security/advisories/GHSA-j586-36cw-2gc2)
(CVE-2026-114613). This patches subsequent recovery and constrained NeMo
installs; existing speech environments need a separate update and inference
qualification. Linux/Python 3.12 resolution passes for both consumers,
preserving the pinned Torch and Transformers builds. No audit exclusion is added.

The 2026-10-27 CI repair refreshes the MCP SDK's Express and body-parser
`qs` edges to 6.17.0 within their declared ranges, above the 6.16.1 patch
floor for [comma-array serialization denial of service](https://github.com/advisories/GHSA-6pq8-jhm2-2vcw).
No new override or audit exclusion is added.

### Install-script allowlist

The 2026-10-31 fleet implementation adds exact `jose` 6.2.14 and
`oauth4webapi` 3.8.8 server dependencies for maintained ES256 JWT/JWS,
ECDH-ES JWE and DPoP resource construction/verification. The latter was already
an `openid-client` dependency; no install script or client bundle is added.
Library use does not constitute an audit of YA's enrollment protocol.

The same day's fresh production audit found
[cross-realm redirect credential filtering](https://github.com/advisories/GHSA-mrwp-f3q8-3g9p).
The `http-proxy -> follow-redirects` edge moves from 1.16.1 to 1.16.2 within its
declared range. Unrelated lockfile resolutions remain unchanged. The two
new glob/minimatch advisories are triaged below; no forced major overrides are
introduced for unreachable build cleanup dependencies.

Dependency install scripts (preinstall/install/postinstall) are blocked by
default via `onlyBuiltDependencies` in `pnpm-workspace.yaml`; only
`bcrypt` may run its native build. Relay and push broker used to add
`better-sqlite3` here; they now use the runtime's built-in SQLite through
`@yep-anywhere/shared/sqlite`, so the repository has no SQLite addon to build
or ignore and needs no compiler on any host.
This neutralizes the `"preinstall": "node setup.mjs"` vector used
by npm supply-chain attacks. If a newly added dep needs its build script,
`pnpm install` warns `build scripts that were ignored: <pkg>` and the
package will be missing its native binary at runtime — vet the script,
then add the package name to the allowlist. Blocked today and listed under
`ignoredBuiltDependencies` so installs stay quiet, each verified a no-op with
no performance fallback: `esbuild` (native binary ships via
`@esbuild/*` optional deps; the postinstall only swaps the bin shim, and
there is no silent WASM fallback), `@firebase/util` (bakes
`FIREBASE_WEBAPP_CONFIG` into web-SDK defaults; unset here), `protobufjs`
(prints a version-scheme warning).

### Known-unreachable advisories

Advisories triaged as unreachable are suppressed via
`auditConfig.ignoreGhsas` in `pnpm-workspace.yaml`; that list and this
table must stay in sync — every ignored GHSA needs a row here, and removing a
row means removing the ignore. As of 2026-11-04 four advisories are triaged as
unreachable with no fix compatible with YA's current dependency and runtime
constraints. Re-check when the listed trigger fires rather than re-deriving the
analysis:

| Advisory | Why unreachable | Revisit when |
|---|---|---|
| `minimatch` globparts amplification ([GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249)) | Production audit reaches only push broker `firebase-admin -> firestore -> google-gax@5.0.8 -> rimraf@5 -> glob@10 -> minimatch@9`. The affected preprocessing requires attacker patterns and optimization level 2. The installed Google GAX published `build/` imports neither rimraf nor glob; rimraf is unused cleanup tooling carried as a production dependency. Push broker never invokes it or the glob CLI | GAX begins invoking that dependency at runtime, YA adds a glob/minimatch consumer, or the parent declares a compatible patched range (currently patch requires minimatch 11) |
| `glob` traversal continuing after cancellation ([GHSA-3g3m-2fjr-6pw4](https://github.com/advisories/GHSA-3g3m-2fjr-6pw4)) | Same unused GAX/rimraf chain. No production push-broker path starts this traversal, with an attacker pattern or otherwise. Patched glob 14 is outside rimraf 5's declared glob 10 range; a forced major replacement is unnecessary for build-only code | GAX/YA starts using glob traversal at runtime, or the dependency chain accepts the patched major |
| `uuid` buffer bounds (GHSA-w5hq-g745-h8pq) | Only path is `firebase-admin -> @google-cloud/storage -> gaxios@6`, which calls `uuid.v4()` with no arguments; the defect needs v3/v5/v6 with a caller-supplied `buf`. Patched only in `>=11.1.1`, outside gaxios 6's `^9` range | `firebase-admin`/`gaxios` declare uuid `>=11`, or a 9.x patch release appears |
| `@hono/node-server` static-path double decoding ([GHSA-rmxm-3fg6-px4f](https://github.com/advisories/GHSA-rmxm-3fg6-px4f)) | Affects the package's `serveStatic` middleware. YA never imports or calls that helper: server, artifact server, relay and push broker use `serve`/`getRequestListener`, types or the response sentinel, and YA's file routes own their authorization and serving. The installed `@hono/node-ws` adapter also does not import it. The patched 2.1.3 is outside the current 1.x consumer ranges | Adopting `@hono/node-server/serve-static` anywhere, a 1.x backport, or qualifying the 2.x adapter migration |

Anything not on this list is untriaged — treat a new advisory as actionable.

The development graph also includes minimatch 10 through Pi. Its package
manager calls minimatch with default options, without the affected optimization
level 2. Revisit that assessment when upgrading Pi or changing its matching
options. The audit metadata counts affected package versions, so these four
exceptions currently account for five moderate findings.

`ignoreGhsas` only quiets `pnpm audit`. GitHub's Dependabot alerts for the
same advisories are dismissed per alert, as "vulnerable code not used", with
a comment pointing here. Dependabot also scans manifests outside pnpm. The
table below records additional non-applicable findings, beginning with the
2026-09-28 triage:

| Advisory | Manifest | Why it does not apply | Revisit when |
|---|---|---|---|
| `accelerate` sharded-checkpoint path traversal (GHSA-4j2p-28q2-5m79) | `requirements/stt-known-good-2026-06-16.txt` | The affected functions are `load_checkpoint_in_model` and `load_checkpoint_and_dispatch`. YA's speech workers load models by operator-configured id through `from_pretrained` and never call either function | A speech worker loads raw accelerate checkpoints, or a patched release lands (then bump the pin) |
| `torch` `torch.jit.script` memory corruption (GHSA-rrmf-rvhw-rf47) | same snapshot | Needs crafted input to `torch.jit.script` on the local host; YA only runs inference and never scripts code | Moving the snapshot to torch ≥ 2.13, which also frees the setuptools pin |
| `setuptools` sdist MANIFEST.in bypass (GHSA-h35f-9h28-mq5c) | same snapshot | Affects building sdists on macOS filesystems. The snapshot is a Linux runtime env, and `torch==2.12.0` requires `setuptools<82`, so the patched 83 cannot be pinned | Same torch move |
| `setuptools` Windows legacy wheel path escape ([GHSA-xmj3-9gf7-h52w](https://github.com/advisories/GHSA-xmj3-9gf7-h52w)) | same snapshot | Needs Windows drive-qualified paths in `namespace_packages.txt` during legacy wheel installation. This snapshot is a Linux runtime environment; Torch 2.12.0 also requires `setuptools<82`, excluding the patched 84.1.0 | Supporting this snapshot on Windows, using legacy wheel installation there, or moving Torch so the patched setuptools can resolve |
| `pytorch-lightning` `load_from_checkpoint` pickle loading (GHSA-75m9-98v2-hjpm) | `requirements/stt-nemo.txt` | NeMo 2.0.0 needs `pytorch-lightning==2.4.0`. The NeMo worker loads through `ASRModel.from_pretrained`, never `LightningModule.load_from_checkpoint`. The current NeMo env (`stt-nemo-recent.txt`) resolves 2.6.5 | Retiring the in-place NeMo 2.0.0 add-on |
| `glib` `VariantStrIter` unsoundness (GHSA-wrw7-89jp-8q8g) | `packages/desktop/src-tauri/Cargo.lock` | gtk-rs 0.18 is the last GTK3 binding and Tauri's Linux backend requires it, so no patched `glib` is reachable. Neither the desktop crate nor its Tauri/GTK dependencies iterate string-array variants | Tauri moves its Linux backend off gtk-rs 0.18 |
| `rand` unsound with a custom logger (GHSA-cq8v-f236-94qc) | same `Cargo.lock` | `rand 0.7.3` is used only by `phf_generator` during the build. The defect requires a custom `log` logger that itself draws random numbers | `phf_generator` moves off rand 0.7 |

The patched Python pins in that snapshot (`anyio`, `msgpack`, `pip`) were
dry-run resolved against the live `stt` env before they were committed.

The 2026-10-21 security refresh raises the snapshot's `certifi` pin from
2026.5.20 to 2026.10.19 for
[the compromised emSign CA advisory](https://github.com/advisories/GHSA-6q48-6c7w-9gw2).
Linux/Python 3.12 resolution passes for both the snapshot and its NeMo 2.0.0
constraint consumer, retaining the pinned Torch and Transformers versions.
An isolated Python environment verifies that the affected emSign ECC Root CA
G3 is absent and that `requests` and `httpx` can validate HTTPS with the new
bundle. This pin secures subsequent recovery/NeMo installs; existing speech
environments must update their installed certifi separately. Live environments
were not updated or qualified by this repository change.

## Automated Dependency Updates

GitHub Dependabot is the sole automated dependency PR source, with **security
updates only**. Dependabot alerts and security updates are enabled in the
repository's GitHub settings. There is no `.github/dependabot.yml` or
`.github/dependabot.yaml`, so routine version updates are not configured.
GitHub can [create security updates without that optional file](https://docs.github.com/en/code-security/concepts/supply-chain-security/about-the-dependabot-yml-file).

`renovate.json` explicitly disables Renovate. Its former weekly minor/patch
updates, automatic development-tool and Action updates, monthly lockfile
maintenance and Dependency Dashboard queue are retired. Routine upgrades are
manual work requested by a maintainer.

A security fix may itself require a patch, minor or major version bump; the
linked vulnerability determines whether it belongs in the automated queue.
Security PRs still require review and passing CI. The independent CI audits
remain enabled, including standalone npm manifests and the STT snapshot.
Dependabot may be unable to generate a fix for some alerts; those require
manual remediation or a documented applicability review.

When reviewing a security PR or making a requested upgrade:

- Workflow runtime inputs (`node-version`, `go-version`, `toolchain`,
  `java-version`) are deliberate; CI runs at the supported Node floor.
- Preserve the parent's supported range for security overrides. A major bump
  to the exact `fast-uri` pin can escape ajv's 3.x range.
- `vite` updates must preserve the client's and desktop's different majors.
  Bump their declared ranges when necessary instead of forcing one target
  version across both importers with a recursive lockfile-only update.
- `@playwright/test` remains below 1.61 until the supported Node floor moves
  past its loader fix. From 1.61, `module.registerHooks` fails to load CommonJS
  dependencies on Node 22.16 through 22.22 and on 23.11 with
  `request for './Parser.js' is not in cache`; Node 22.23 and 24 work.
  `PLAYWRIGHT_FORCE_ASYNC_LOADER` avoids that path but is undocumented.
  The held release also cannot install browsers on Ubuntu 26.04, so jobs that
  run `playwright install` use `ubuntu-24.04`. Lift the runner hold and return
  those jobs to `ubuntu-latest` together after qualifying the new Node floor.
  The hold also pins the bundled Chromium (148 at 1.60), which lags Chrome
  security fixes. Every Chromium launch therefore passes
  `chromiumSandbox: true` (enforced by `scripts/check-chromium-sandbox.mjs`
  in `pnpm lint`), and `artifact:capture`, which renders agent-authored
  pages, uses the system's Google Chrome instead of the bundled build.
- Provider SDK changes follow the [provider refresh](../../topics/provider-refresh.md)
  audit, including the Claude SDK version marker. The optional pixi STT
  environment retains its known-good snapshot and separate inference
  qualification; a passing package resolver is not a GPU runtime test.

Renovate 44's validator requires Node.js `^24.11.0`. Before changing the
explicitly disabled `renovate.json`, validate it with that runtime:

```bash
npx --yes --package=renovate@44 -- renovate-config-validator --strict
```
