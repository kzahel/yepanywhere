# pi Provider Sketches

> pi is Mario Zechner's provider-agnostic coding agent. This companion holds
> candidate designs for YA's pi integration that are not current behavior.

Companion to: [pi-provider](pi-provider.md)

Status: candidate design only. Nothing here is implemented, enabled by a
setting, or authorization to implement.

Related topics: [agent context injection](agent-context-injection.md),
[agent own-session inspection](agent-self.md),
[new-session agent tooling](new-session-agent-tooling.md),
[provider host API](provider-host-api.md),
[provider abstraction seam](provider-abstraction.md),
[session sandbox network boundary](session-sandbox-network-boundary.md),
[vanilla defaults](vanilla-defaults.md).

## Pi 1.x adoption candidates

Surfaces Pi added between 0.84.2 and 1.1.0 that YA could use but does not.
The 2026-10-11 refresh adopted only the `prompt` disposition, for handled
commands ([pi-provider](pi-provider.md#settled-turn-boundary--compatible-through-pi-110)).

- **Cancelled versus finished turns.** Pi 1.1.0 adds `aborted` to
  `agent_settled`. YA could show a stopped Pi turn as interrupted rather than
  completed, the way it treats other providers' interrupted turns.
- **Steer and follow-up dispositions.** `steer` and `follow_up` responses also
  report `handled` or `queued`. YA's queued-message UI could confirm that Pi
  actually queued a steer instead of assuming it.
- **Windows launch entry.** The published bin is now `dist/bundle/cli.js`. YA's
  Windows descriptor still launches the unbundled `dist/cli.js`, which works.
  Prefer the bundle when present, if its startup is measurably faster on
  Windows.

## YA-supplied web tools for tool-light providers

### Problem

pi ships seven built-in tools: `read`, `write`, `edit`, `bash`, `grep`,
`find`, `ls` (`~/pi` `packages/coding-agent/src/core/tools/`). Its usage doc
says it intentionally omits built-in MCP, sub-agents, permission popups, plan
mode, to-dos, and background bash, and expects users to add such workflows as
extensions or packages. There is no web search or web fetch tool.

Every other YA provider path has a native web tool that YA already maps to
its canonical `WebSearch` / `WebFetch` renderer contract
(`packages/client/src/components/renderers/tools/displayContracts.ts`):

| Provider | Native web tools YA recognizes |
|---|---|
| Claude | `WebSearch`, `WebFetch` |
| Codex app-server, Codex OSS | `web_search` (`codex-oss.ts` maps to `WebSearch`) |
| OpenCode | `websearch`, `webfetch` (`opencode-tools.ts`) |
| Grok | backend web search, `web_fetch` (`grok.md`) |
| Gemini ACP | a fetch tool mapped to `WebFetch` (`gemini-acp.ts`); search unverified |
| pi | none |
| Copilot CLI, Claude Ollama | not checked |

So a pi session launched by YA cannot look anything up unless the user has
installed a pi extension that adds it. Any harness with a shell tool can of
course `curl`, but that is not a first-class tool with a schema, a result
contract, or a renderer.

### The crux: injected instructions cannot add a tool

Model-native tool use needs the tool's schema in the request's tool list. pi
builds that list from built-ins plus extension-registered tools
(`pi.registerTool()`); registered tools are then advertised in pi's own system
prompt via `promptSnippet` / `promptGuidelines`. YA's provider layer only sees
pi's RPC surface: `prompt`, `steer`, `follow_up`, `abort`, `compact`,
`set_model`, `get_state`, and the extension UI request/response pair. Nothing
on that surface registers a tool.

The `[Global context]` user-message prefix YA already injects (see
[agent context injection](agent-context-injection.md) § Current YA placement)
and pi's `--append-system-prompt` can therefore describe a *procedure* to the
model, but neither can make a callable tool appear. Transparent native tool
use for pi requires pi-side customization, which YA can supply but which must
run inside pi.

The non-customizing alternative is shell-mediated: a command on PATH plus a
capability fragment telling the model it exists. The model calls `bash`. That
works for any provider with a shell tool and changes nothing in the provider,
at the cost of discoverability, reliability, and rendering.

### Tiers

The tiers are ordered by how much of the user's pi environment YA touches.
Tier 0 is always respected; the others are candidates.

**Tier 0 — the user's own pi configuration.** A user may already have
installed a web-tool extension or package in `~/.pi/agent/extensions/` or a
project's `.pi/extensions/`. YA does not weigh in. Any YA supplement must yield
to an existing tool of the same name; a YA extension can check
`pi.getAllTools()` at load and skip registration. Detecting a same-purpose
tool under a different name is heuristic and is not attempted; a user who has
their own tools simply leaves the YA setting off.

**Tier 1 — PATH command plus capability fragment (provider-neutral).**
Ship `ya-agent web-search <query>` and `ya-agent web-fetch <url>` through the
private per-server command directory that
[agent own-session inspection](agent-self.md) already creates and adds to the
child PATH, and advertise them through a `[Client capabilities]` fragment from
`buildEffectiveAgentContext` (`packages/shared/src/agent-context.ts`). The
YA server executes the search or fetch, so API keys and egress policy stay in
YA. This is exactly the
[new-session agent tooling](new-session-agent-tooling.md) pattern with one
more command family; it needs no pi change and would serve any future
tool-light provider identically.

Costs: the model must notice the fragment, and for pi that fragment rides the
first user message after process launch and is not reinjected on resume or
after pi's native compaction, so the capability can silently vanish from
context. Calls render as `Bash` rows. A later display projection that
recognizes a `ya-agent web-search` command line and presents it as a
`WebSearch` card is a display-only mapping on the existing tool-display seam,
not part of a first slice.

**Tier 2 — a YA-bundled pi extension loaded per launch.** Add
`-e <path-to-ya-web-tools-extension>` to the `pi --mode rpc` launch line
(`PiProvider` composes launch args through `buildPiLaunchArgs`). The extension
calls `pi.registerTool()` for `web_search` and `web_fetch` with `promptSnippet`
and `promptGuidelines`, so pi's own system prompt advertises them every turn
and across pi's compaction; no YA context injection is involved. pi documents
that CLI `-e` extensions load before the project trust decision and work with
`--no-extensions`, and the RPC mode source handles extension UI requests, so
extensions do load in RPC mode; the `-e` plus `--mode rpc` combination has not
been exercised by YA <!-- assumed -->. The extension is launch-scoped: it is
never written into `~/.pi/agent/extensions/`, so the user's pi TUI outside YA
is unchanged.

Execution has two candidate homes. The extension can do the work itself with
`fetch()` inside pi's process, honoring `ctx.signal` for abort; that is
trivial for fetch but leaves search needing a backend and a key inside pi's
environment. Or the extension can call back into the YA server over loopback
with a per-session credential delivered on the same environment channel as the
wake credential pair ([session wake](session-wake.md)), so YA owns keys,
egress policy, caching, and truncation. The callback shape is the one the
[provider host API](provider-host-api.md) already exposes for same-user local
tools; a sandboxed provider that cannot reach loopback (noted in
[agent own-session inspection](agent-self.md)) would need the in-extension
path.

Rendering: extend `PI_TOOL_NAME_MAP` in
`packages/server/src/sdk/providers/pi-tools.ts` with `web_search` →
`WebSearch` and `web_fetch` → `WebFetch`, and have the extension return
`details` shaped to `WebSearchDisplayResultSchema` /
`WebFetchDisplayResultSchema` so both the live `PiProvider.mapEvent()` path
and the durable `PiSessionReader` path reach the existing renderers through
the shared `normalizePiTool()`. The tool-display coverage gap
[`gaps/tool-display-native-provider-coverage.md`](../gaps/tool-display-native-provider-coverage.md)
already names pi extension-defined tools as lacking observed specimens; this
extension would be the first YA-owned one and should ship its own fixture.

Delivery: either a file shipped inside YA's server package and referenced by
absolute path, or a bundled extension in the `graehl/pi` fork, which
[pi-provider](pi-provider.md) already proposes for the permission bridge. The
YA-shipped file keeps the supplement independent of which pi the user
installed; the fork bundle keeps pi-API coupling next to pi's version. pi's
extension API changes between minor versions, so `pi-contract.e2e.test.ts`
should also load the extension and fail on a load error.

**Tier 3 — install into the user's pi.** Write the extension to
`~/.pi/agent/extensions/` or install it as a pi package so the user's own pi
TUI gains the tools too. This changes state YA does not own and outlives YA,
so it is only ever an explicit user-invoked action with a matching removal
action, never a side effect of a setting. It is listed for completeness; Tier
2 gives YA sessions the same capability without it.

### Search backend

YA has no web search facility today, and no HTML-to-text or readability
helper in the server (checked 2026-09-15). Candidates, none chosen:

- a user-supplied search API key stored in YA settings; which vendors are
  suitable is not yet verified;
- keyless HTML scraping of a public engine, which is fragile and likely
  against terms of service; or
- borrowing another provider's native web search through a bounded auxiliary
  session turn on the [provider host API](provider-host-api.md). This is
  keyless for a user who already has a Claude or Codex login, but costs a
  model call per search and inherits that provider's rate limits.

Fetch needs only server-side HTTP plus an HTML-to-text pass and a size cap.
Under Tier 2 the extension should truncate like pi's own tools (pi's
`truncated-tool.ts` example shows the helper) so long pages do not flood
pi's context.

### Policy

- **Default off.** Per [vanilla defaults](vanilla-defaults.md) this is
  YA-novel behavior: one setting, default off, scoped to providers YA knows
  lack the tools. A user with their own pi tools never sees a change.
- **Egress policy.** [Session sandbox network boundary](session-sandbox-network-boundary.md)
  applies to Claude-family and Codex sessions only, and a YA-server-executed
  fetch runs outside any provider sandbox. When the requesting session is
  sandboxed, the server-side fetch must apply the same rule: public Internet
  only, no YA host, local networks, or private control sockets.
- **Permissions.** pi runs tools autonomously and YA's approval bridge for pi
  is still a follow-up, so web tools would run unprompted. Fetch and search
  are read-only egress; the real exposure is that fetched content is
  untrusted model input. YA cannot neutralize that in general and should not
  claim to; the [active content security](active-content-security.md) posture
  for rendering fetched HTML in YA's own UI is a separate question.
- **No text rewriting.** Tier 1 uses the existing capability-fragment channel;
  YA must not alter the user's submitted text to invoke a tool.

### Beyond pi

Only pi is verified tool-light. If a second provider qualifies, the client
should learn it from a provider capability rather than a hard-coded name set,
the direction
[`gaps/sketches/provider-neutral-remote-executors.md`](../gaps/sketches/provider-neutral-remote-executors.md)
already gives for executor support. Tier 1 is provider-neutral by
construction; Tier 2 mechanics are pi-specific, and OpenCode or Copilot would
need their own plugin or MCP route if they ever needed a supplement.

### Open decisions

1. First slice: Tier 2 for pi (transparent to the model, renders natively) or
   Tier 1 (provider-neutral, no pi coupling). Recommendation: Tier 2 for pi,
   with Tier 1 kept as the fallback shape for any provider without an
   extension API.
2. Search backend: key, scrape, or borrowed provider search.
3. Extension execution home: inside pi with `fetch()`, or callback into YA.
4. Extension delivery: YA-shipped file or `graehl/pi` fork bundle.
5. Whether YA-supplied results should carry an origin marker in the transcript
   so a reader can tell a YA tool from a native one.

### Verification when implemented

- Zero-token: the pi contract test launches `pi --mode rpc --no-session -e
  <ext>` and confirms the process starts and exits cleanly with the extension
  loaded.
- Paid, one turn: a prompt that must search or fetch, checked through the
  running app for a `WebSearch` / `WebFetch` card live and after reload
  through `PiSessionReader`.
- Focused: `pi-tools.test.ts` name and result mapping; a `pi-reader` fixture
  containing a `web_search` tool call and result.
- Negative: with the setting off, the launch line carries no `-e` and a pi
  session behaves exactly as before.
