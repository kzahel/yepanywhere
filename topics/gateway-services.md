# Gateway Services

[Agent Auth Router](agent-auth-router.md) is a separate opt-in route for native
Claude/Codex subscription accounts. It has its own private control connection,
account catalog and per-session token; it does not reuse a dummy gateway token
or turn the account into a generic model service.

> A gateway service is one configured model-serving endpoint: an OpenAI- or
> Anthropic-compatible HTTP server, optionally one YA may start and stop, with
> stated context and output sizes and its own harness narrowings. Claude Gateway
> and CodexOSS both launch against these entries.

Topic: gateway-services

Related topics: [claude](claude.md), [provider-abstraction](provider-abstraction.md),
[server-capabilities](server-capabilities.md), [ya-env-vars](ya-env-vars.md),
[backward-compat](backward-compat.md).

See also: [Codex OSS](../docs/codex-oss.md) for the Codex CLI side of local
model serving.

## Client baseline

Since the 2026-10-29 retirement, Gateway configuration, autostart and agent/plan
controls use their v0.8.0 baseline contracts without per-setting version checks.
Provider detection and configured values still govern actual execution. The
older single-Gateway editor continues to serve v0.8 hosts without Gateway
services; its start command is always editable. The separate services
capability, persisted-setting migration and old-client server mirrors remain.
The client waits for settings and version metadata before choosing the legacy
editor, so late metadata cannot replace an editor while input is underway.

## Contract

### Configuration

- `settings.gatewayServices` is a list of entries; `settings.defaultGatewayServiceId`
  names the one Claude Gateway treats as default. An entry states an `id`
  (lowercase slug, stable, referenced by qualified model ids), a `url`, and
  optionally a `label`, a compact `shortName` for showing where a model runs, a
  `serviceCommand`, `autoStop` with `autoStopAfterSeconds`, `contextWindowTokens`
  and `maxOutputTokens`, `maxModels`, `effortLevels` with `defaultEffortLevel`,
  `disableAgent` / `disablePlanMode` overrides, `codexEnabled`, and
  `codexWireApi`.
- `codexWireApi` defaults to `responses`. Current Codex refuses to load a
  provider that says `chat` ("`wire_api = \"chat\"` is no longer supported",
  codex-cli 0.154.0); the value stays selectable only for an older CLI, and an
  explicit choice is passed through rather than silently upgraded.
- The list and the older single-gateway settings (`claudeGatewayUrl`,
  `claudeGatewayStartCommand`) are two views of one configuration. The default
  entry mirrors those keys in both directions, so a client without the
  `claude-gateway-services` capability keeps editing the gateway actually in
  use. An installation that has never seen the list gets its configured gateway
  migrated into a `default` entry. The older keys describe an endpoint and how
  to start it and nothing else, so every remaining field of that entry takes
  the same default a list entry gets for stating none — auto-stop off, at the
  standard idle delay, with Codex opt-in off.
- Only a non-empty legacy value overrides the entry it mirrors, except when the
  update explicitly writes the legacy key: clearing `claudeGatewayUrl` from an
  older client removes that one entry rather than resurrecting it. An absent
  legacy value never clears a configured command.
- A malformed list is rejected whole rather than partially applied, so a user
  never silently loses a service they believe is configured.
- A `serviceCommand` is accepted only for a loopback URL. A non-loopback entry
  is an endpoint YA merely talks to: never started, stopped, or signalled.
- The editor has no Save button. A typed field writes the whole list when it
  loses focus and a checkbox, radio, select, reorder, or remove writes it
  as it is operated, which is the convention everywhere else in settings. A
  Save at the foot of a list of endpoints is scrolled out of sight exactly when
  there is enough configured for it to matter.
- An added entry is the exception: it starts with no endpoint and stays out of
  every save until its endpoint field loses focus holding one. It is enabled
  for both providers, so saving it at once would reload the providers and send
  catalog and effort probes, and with the export on write terminal files, for
  an address nobody chose. Until then it can be edited, including its
  checkboxes, or removed without anything being written, but not made the
  default. When admitted it takes an id derived from its endpoint unless it
  was already named.
- Saving never costs a keystroke. Saves do not overlap: a write requested while
  one is out waits for it, then sends the list as it stands by then. When a
  save's answer arrives, an entry changed since that save was sent keeps what
  was typed, and only entries untouched since then take the saved copy, which
  may differ where the server normalized a value. A list changed elsewhere
  replaces the editor's copy only where nothing here is unsaved.

### Lifecycle

- Loopback classification is the boundary for every lifecycle action: exact
  `localhost` / `localhost.`, IPv4 `127.0.0.0/8`, or IPv6 `::1`. A name that
  merely resolves to loopback does not qualify.
- A bounded TCP probe decides whether a service is running. Any listener
  suppresses launching the command, even when the catalog read then fails.
- A command written as `<script> start` declares itself a service script: the
  trailing verb is stripped and `start`, `status`, and `stop` are used
  throughout. Otherwise YA asks the command what it is — `<command> status`
  exiting cleanly means verbs; a status invocation that keeps running means the
  command is the server itself, which YA then owns as a foreground child and
  terminates by process group; an ambiguous answer tries the start verb once
  and then the bare command.
- Stopping asks the command, then re-probes the port after a delay and signals
  the listener only if it is still there. A service that defers shutdown until
  its own last client goes idle is not cut short, and a command with no `stop`
  verb still ends up stopped. Signalling uses the shared port-listener control:
  a unique, same-user listener that is never YA or one of its ancestors.
- `autoStop` schedules that stop request once no live session uses the service,
  after the entry's idle delay; any later use cancels it. Use counts live
  processes from both providers that reach these endpoints, so a CodexOSS
  session holds its endpoint open exactly as a Claude Gateway one does. A
  CodexOSS session counts against the endpoint its launch was bound to (see
  § Catalogs and model identity), which no later catalog read or server reload
  changes; a Claude Gateway session, and a CodexOSS process that carries no
  binding, counts against the service its launch model resolves to now. The
  two differ where a model resolves to nothing: a Claude Gateway session is
  attributed to the default service, since it must be using some service,
  while a CodexOSS session launched against the local provider holds no
  service open at all.
- Each service owns its own launcher: reconfiguring or removing one never
  disturbs another's process, and a removed entry's child and pending stop
  check are torn down with it.
- A server restart hands over *every* service child YA owns, not one of them:
  each is retained by the wrapper or the provider runtime host before its
  launcher gives up ownership, so no service is stopped merely because another
  service was handed over first. A child whose handoff fails stays owned and is
  stopped with the server, which is also what keeps the failure visible.

### Catalogs and model identity

- Each service's own `/v1/models` is authoritative for that service. Claude
  Gateway returns the union across enabled services and never merges Claude's
  built-in aliases or borrows another service's rows.
- The union follows the configured order of the entries, and so does the model
  picker; both providers order it the same way for the same services. That
  order is the user's to set by moving entries in the services editor. The
  default entry is not hoisted: a read's authority to start a service is
  decided by comparing its id against the default, and the reads run
  concurrently, so position never affected anything but the picker.
- A model id stays exactly as its service advertises it while only one service
  offers it. When two do, both gain a `<serviceId>::<model>` prefix; `/` is
  unusable as a separator because a vLLM server with no `--served-model-name`
  advertises a Hugging Face repo id that already contains one. A launch always
  reaches the owning service under the plain name that service knows.
- A CodexOSS session is bound to one endpoint when it launches, because each of
  its turns is a separate `codex exec`. The server process resolves the model
  against the catalog it holds, reading that catalog first when the model is
  not in it (nothing has read it yet after a server restart), and every turn
  uses the result — under the provider host too, whose worker reads no catalog
  and is handed the endpoint with the launch. A model no endpoint serves is
  bound to the local provider. When the bound endpoint is later removed or
  stops offering CodexOSS, the next turn fails with an error naming it rather
  than moving to the local provider.
- A catalog read may start only the default service. A non-default service that
  is not already listening contributes nothing until one of its models is
  selected, and that selection is what authorizes its start.
- A service that could not be read — a timeout or an error status — keeps its
  last good catalog and routes, for CodexOSS as for Claude Gateway; only a
  successful read publishes a change.
- `maxModels` truncates one service's contribution in catalog order, defaulting
  to 100.

### Declared sizes and backend identity

- Configuration is authoritative for context and output size. An advertised
  value is used only where configuration states none: a copilot-style
  `capabilities.limits` first, then vLLM's top-level `max_model_len`, which is a
  whole window rather than a prompt-only ceiling. A declared output size
  reserves room inside the declared context window for the compaction window.
- Backend identity is observed from the response, never configured: copilot-api
  through its explicit `X-Copilot-API` header, vLLM through `owned_by` on its
  model rows. Model names, ports, vendors, advertised windows, and generic
  endpoint compatibility never imply either: `max_model_len` sizes a model,
  and any server free to advertise it is free to be something other than vLLM. A launch publishes `AGENT_LAUNCH_BACKEND`, and copilot-api
  additionally keeps its legacy `YEP_COPILOT_API=1` marker for out-of-repo
  readers.

### Thinking effort

- An OpenAI-compatible catalog row normally states nothing about reasoning — a
  vLLM row carries an id, an owner and a window — so a model that accepts effort
  is indistinguishable from one that does not. Levels come from the entry's
  `effortLevels` first, then from a row's
  `capabilities.supports.reasoning_effort`, then from the model families YA
  knows, then from what the endpoint answered when asked. A model no source
  describes offers no effort control at all rather than a guessed one.
- One resolution serves both transports. Claude Gateway and CodexOSS reach the
  same endpoint over different wires; a model offering effort through one offers
  it through the other, so both read the same four sources. Only what each wire
  can *say* differs, which is the "none" distinction below. CodexOSS therefore
  advertises the thinking control at the provider level and lets each model
  decide: a model no source describes states `supportsAdaptiveThinking: false`
  and shows none, which is what every Ollama-listed model states.
- A launch cannot re-derive the per-model and per-endpoint sources, which exist
  only in a catalog response. CodexOSS keeps each service-qualified model's
  resolved effort from its last catalog read and places the selected level
  against that, falling back to configuration and the built-in families.

### Asking an endpoint what it accepts

- `settings.gatewayServiceEffortDetection` is a default-on setting: YA sends one
  chat request naming an unrecognized effort, and request validation rejects it
  with the accepted vocabulary spelled out. Observed against vLLM 0.11 serving
  DeepSeek-V4-Flash: `Input should be 'none', 'minimal', 'low', 'medium',
  'high', 'xhigh' or 'max'`. Validation runs before scheduling, so this stage
  costs no inference and no accelerator time.
- The answer describes the *endpoint's request schema*, not the model behind it:
  a vLLM server hosting a model that ignores the field still answers with the
  full vocabulary. That is why a probe answer ranks last, and why the entry's
  own `effortLevels` — which win over everything — remain the correction for an
  endpoint that overclaims.
- Request validation and the chat template are two gatekeepers, and only the
  second describes the model. A second probe stage therefore asks with the
  highest level the schema listed and reads the template's rejection, which
  names both the set the model distinguishes and the level it applies by
  default. Observed against vLLM 0.29 serving Qwen3.8-Flash-Next, whose schema
  accepts all seven literals: `Unexpected reasoning effort high. Supported types
  are xhigh (default), medium, and low.` Without it the picker offered `high`
  and `max`, and choosing either failed the user's turn.
- A template answer replaces the schema answer entirely rather than intersecting
  with it, `none` included: a level the template does not list only buys a turn
  that fails. A template that *accepts* the highest schema level is not
  narrowing from the top, so the schema answer stands — at the cost of one
  prefill and one token, which is the second stage's whole price and the one
  case where asking is not free. A template stage that fails, most likely by
  outlasting its deadline behind real work after accepting, also leaves the
  schema answer standing.
- The template is a property of each model, not of the endpoint: one server can
  front several models with different templates. The schema stage is asked once
  per endpoint; the template stage is asked of each listed model whose levels
  the answer would supply — one that no configuration, catalog row, or known
  family describes — a few at a time, and each such model gets its own answer.
  Any other listed model gets the schema answer, which can still say whether
  thinking can be turned off.
- An entry stating its own `effortLevels` is never asked: configuration wins for
  every model of that service, so no answer could change the outcome.
- Answers are shared between the two providers. Schema answers are cached per
  endpoint URL, 30 minutes for an answer and one minute for a silence, since the
  usual silence is an endpoint that is not up yet. Template answers are cached
  per endpoint URL and model for 30 minutes whatever they said, so a failed or
  accepting template is not asked, and paid for, again on the next catalog
  read. A reconfigured services list drops the cache, because the same address
  may now front a different server.
- The setting governs every process that reads a catalog, not only the server's
  own reads. A hosted session runs in a provider worker with its own module
  state, so the launch snapshot carries the setting and the worker applies it
  before configuring services; a worker that did not would ask the endpoint
  while the user had switched asking off.
- A 2xx to the probe means the endpoint validates nothing and has therefore said
  nothing; it is not read as accepting every level.
- `POST /api/settings/gateway-services/effort` asks one endpoint on demand,
  about the first model its catalog lists, and reports that model's id. It
  bypasses both the cache and the setting, and its URL must be loopback or
  already configured: unlike catalog discovery it sends a chat request, so it
  stays pointed at endpoints the server already talks to. The requested URL is
  normalized the way a stored service URL is before that comparison, so the
  configured endpoint is recognized however the address was typed — a trailing
  slash or an explicitly spelled default port names the same service. The answer is written
  into the draft entry's level checkboxes for review rather than applied
  invisibly, along with the default level when the template named one.
- The editor presents an entry's two states as a choice between asking the
  endpoint and stating the levels, because that is what they are: an entry
  holding no list defers, and one holding a list decides. Nothing new is
  stored for it. Choosing to state the levels asks the endpoint first and ticks
  the answer, falling back to every level YA names, so the list is never left
  empty — an empty list would mean the opposite of the chosen mode. Choosing to
  ask turns the detection setting on, since leaving it off would make the
  choice mean "use the built-in families only".
- `defaultEffortLevel` states what the endpoint applies to a request naming no
  effort. It is meaningful only alongside `effortLevels` and must be one of
  them; a list stating nothing is no list at all, which restores the advertised
  or built-in levels.
- A selected level is sent, and only a selected level: a turn that states no
  effort leaves the endpoint's own default in place. A level the model does not
  list snaps down to the nearest listed one, never up, so a session carrying an
  effort from another model cannot buy more thinking than was asked for.
- What each transport can say differs. Claude Gateway carries effort as the
  Anthropic `output_config.effort`, whose values are the named levels alone:
  there is no "none", so thinking cannot be turned off over that transport even
  for a model that accepts it. CodexOSS passes Codex's
  `model_reasoning_effort`, which becomes the Responses API `reasoning.effort`
  and does carry "none", so thinking-off is expressible there.
- DeepSeek V4 is the family YA ships knowing. Its chat encoder collapses seven
  request values onto four behaviors — `none` off, `minimal`/`low`/`medium` low,
  `high`/`xhigh` high, `max` max — and thinks at high when a request states
  nothing. Only the levels reaching a distinct behavior are offered (low, high,
  max), so no two menu entries do the same thing.

### Harness narrowings

- `disableAgent` and `disablePlanMode` are per-entry overrides that inherit the
  server-wide settings when unset. They exist because a gateway-served model is
  often weaker at delegation and plan-mode protocol, which is a fact about one
  model server rather than about every gateway at once.

### CodexOSS

Scoped continuation validates the native session before model-route resolution
or installation-lease acquisition. It retains the launch-selected endpoint for
later turns; native UUID addressing and lifecycle behavior follow
[Codex session ownership](codex-sessions.md#scoped-codex-oss-continuation).

- CodexOSS launches against the entries with `codexEnabled`, listing their
  models from `/v1/models` and passing Codex `model_providers.<key>` overrides on
  the command line — base URL and `wire_api` — rather than editing the user's
  `~/.codex/config.toml`. YA never rewrites a CLI's own settings files.
- One service has one Codex provider key, `ya_<service id>` with the id's
  hyphens replaced by underscores. A launch override and the exported profile
  name that same key, so a terminal session started from the profile and a YA
  session reach the same provider entry.
- Every value YA interpolates into an override or an exported profile is quoted
  as a TOML string. A label only has to be trimmed and free of control
  characters and a model id is whatever the endpoint's catalog row says, so a
  `"` or `\` in either reaches Codex as written instead of ending the string
  early and failing the launch.
- The services editor checks `codexEnabled` by default on a newly added entry
  (saved once it names an endpoint; see § Configuration):
  an endpoint added to the list is usually the reason CodexOSS is being turned
  on at all. Existing entries keep whatever was saved, and the single-gateway
  legacy paths still default to off.
- With no such entry configured, CodexOSS keeps its existing behavior exactly:
  `codex exec --oss --local-provider <ollama|lmstudio>`, with models enumerated
  from `ollama list`.

## Compatibility

The `claude-gateway-services` capability gates the client's services editor.
Without it, the client shows the single Claude Gateway URL and start-command
form and writes only the older `claudeGateway*` settings, which the server keeps
mirrored to the default entry.

## Launches never edit the user's provider config

A launch writes nothing. (The opt-in terminal export is a separate act, and its
pi half is the one place YA does merge into a CLI's own file — see above.)
Claude Gateway supplies its transport through the Claude SDK's per-launch
flag-settings layer and the child environment; CodexOSS
passes `-c model_providers.<key>.…` overrides on the command line. A YA session
therefore cannot disturb a concurrently running TUI.

## Terminal export

`settings.gatewayServiceExportEnabled` is an opt-in, default-off setting that
publishes the configured services for the provider CLIs, so the same models are
selectable from a plain terminal session.

- pi is the one exception to the rule below, because pi gives no way to keep
  it. `ModelConfig.load()` reads exactly one registry, `<agent dir>/models.json`,
  and `PI_CODING_AGENT_DIR` relocates the whole agent directory — auth,
  sessions and settings with it — rather than the registry alone (verified
  against installed Pi 0.85.1). The export therefore merges into the user's own
  file: every provider named `ya-<service id>` belongs to YA and is rewritten or
  removed with the services list, every other key is preserved, and the file is
  copied once to `models.json.ya-backup` before the first rewrite. pi accepts
  comments and trailing commas in that file; a registry YA cannot read, or
  cannot parse as plain JSON, is left alone rather than rewritten from a guess,
  with a logged warning when YA had providers to write or withdraw. That never
  fails startup, a settings save, or a catalog read. With the export off, a
  registry that names no `ya-` provider is not parsed at all, and no registry
  is created where pi has none. The command is `pi --provider ya-<id>`.
- pi's registry states each model outright, so it can only name what an
  endpoint has advertised: it is refreshed from each catalog read, and a
  service whose catalog has not been read yet keeps the models pi was last
  told rather than being emptied.
- Per enabled service, YA writes `$CLAUDE_CONFIG_DIR/ya-<id>.settings.json`
  carrying the transport environment, and — for a service CodexOSS may use —
  `$CODEX_HOME/ya-<id>.config.toml` carrying a `model_providers` entry. The
  commands are `claude --settings <that file>` and `codex -p ya-<id>`, and the
  settings UI states them verbatim per service.
- The Claude file also carries the window, because a terminal session gets no
  other statement of it: Claude assumes 200K for a model its catalog does not
  know, which would silently truncate a 252K local model. A declared context
  size becomes `CLAUDE_CODE_MAX_CONTEXT_TOKENS` plus the derived compaction
  window; with nothing declared, the file turns the assumption off rather than
  inventing a number.
- Both are YA-owned files distinct from the ones the user edits. `settings.json`
  and `config.toml` are never read, modified, or merged: Claude loads the extra
  file through `--settings`, and Codex layers the profile through `-p`.
- The export re-syncs whenever the services list is known or changes, not only
  when the setting is toggled. Each file is written to a temporary path and
  renamed, since the directory is shared with a tool the user runs.
- Files for services that disappear are removed, and turning the setting off
  removes everything the export wrote. Only files carrying YA's managed marker
  are ever deleted, so a hand-written file that happens to match the naming is
  left alone.
- `GET /api/settings` reports the resolved `gatewayServiceExportPaths` so the
  client can state exact commands; it is server-derived and never accepted from
  a client.

## Known gaps

- vLLM serves `/tokenize` and a native Anthropic `/v1/messages/count_tokens`
  (`input_tokens`, plus a `context_management` block), which would allow exact
  pre-turn token budgeting rather than relying on the harness's own estimate.
  YA reads neither yet.
- Per-service credentials: catalog reads send a literal `Bearer dummy`, so an
  endpoint that needs a real key has nowhere to put one.
