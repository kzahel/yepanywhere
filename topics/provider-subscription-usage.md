# Provider Subscription Usage

The manual [Agent Auth Router integration](agent-auth-router.md) exposes granted
account quota snapshots under **Settings → Providers** through its private
control socket. These explicit refreshes are separate from direct-login usage
and do not change the existing model-scoped utilization calculation. Routed
session controls read the pinned AAR account through its passive overview;
explicit Refresh targets that account only. They never use native-login quota
observations. Native
Codex `/usage` and `/status` are refused on routed sessions so they cannot report
another account's native-home state.

> Provider subscription usage is YA's normalized, read-only view of provider
> account rate-limit windows, combining provider-wide and model-scoped quotas
> without treating session token accounting as subscription capacity.

Topic: provider-subscription-usage

Related topics: [provider refresh](provider-refresh.md),
[provider abstraction](provider-abstraction.md),
[server capabilities](server-capabilities.md), and
[provider context economics](provider-context-economics.md).

## Observable contract

- A usage read never sends a provider prompt or creates a user conversation.
  Claude uses the Agent SDK's read-only control query, and Codex uses app-server
  `account/rateLimits/read`. Antigravity reads the official CLI's status-line
  quota snapshot. Subscription capacity comes from the provider's quota data.
- The server returns `ProviderSubscriptionUsage | null`. Each normalized window
  carries percent used, optional duration/reset time, and either provider-wide
  scope or an explicit set of YA model ids. Provider-specific response fields
  do not cross the server provider boundary.
- A model's compact value is the maximum percent used among every applicable
  provider-wide and model-scoped window. This is the binding quota: highest
  utilization, equivalently the smallest remaining capacity. The detail view
  shows every applicable window.
- Unknown model-specific buckets are omitted rather than applied to every
  model. Accounts or auth modes without subscription quotas, unsupported
  providers, and failed upstream reads return null and add no usage UI.
- Usage is demand-fetched, cached briefly per source and provider on both sides
  of the client/server boundary, and explicitly refreshable from the detail
  view.
- Direct-demand surfaces acquire usage immediately. New Session classifies only
  its first acquisition as supplementary startup work, after earlier route
  tiers such as selected-provider readiness. Explicit Refresh bypasses that
  startup gate, including while the initial acquisition is still waiting; the
  shared cache prevents a later duplicate when Refresh already supplied the
  value.

## Antigravity quota

For the normal direct `agy` login on macOS and Linux, YA reads the
[status-line quota JSON](https://antigravity.google/docs/cli/statusline#available-json-fields)
in a short-lived terminal via the host's `script` utility. It supplies a
session-only callback, uses the existing login, and discards the terminal
output and temporary files after the read. The probe sends no prompt, enters
no slash command, and leaves the user's CLI settings untouched. Concurrent
reads, including explicit refreshes, share one running probe. The standard
60-second subscription cache applies to the normalized snapshot.

Gemini, separately metered Gemini models, and the shared Claude and GPT quota
are scoped to their matching catalog models. Known five-hour and weekly
windows carry the provider's absolute reset timestamp when available. Unknown
buckets and the generic default model alias have no quota mapping. Missing
terminal support, a timeout, and explicitly routed or API-key configurations
return no quota snapshot.

## Codex local account commands

Codex `/status` and `/usage` are local account commands, not model prompts.
YA advertises and intercepts them only for active Codex sessions:

- `/status` combines the resolved session model, working directory,
  permission mode, provider thread id, latest cumulative session-token
  snapshot, `account/read`, and `account/rateLimits/read`. A failed account or
  rate-limit probe leaves the local session fields available and marks only
  that section unavailable.
- `/usage [daily|weekly|cumulative]` reads `account/usage/read`. Empty, `day`,
  and `daily` arguments select the daily view; `week` and `weekly` select the
  weekly view. Invalid arguments report the accepted forms. Unlike the Codex
  TUI's interactive no-argument picker, YA's non-interactive `/usage` defaults
  to daily. YA exposes only this read-only branch; it does not consume account
  rate-limit reset credits.
- Account token activity from `/usage` is historical activity, not remaining
  subscription capacity. Rate-limit windows remain the source of subscription
  capacity, while per-session token notifications remain the source of context
  consumption.
- `account/usage/read` requires ChatGPT-backed Codex authentication. API-key,
  signed-out, and Amazon Bedrock accounts receive `Sign in with ChatGPT to use
  /usage.` and do not make the usage request.

Neither command creates a model turn or provider transcript entry. YA emits the
result as a synthetic `local_command` row into the active session's live and
short replay streams; it does not claim provider persistence for that row.

## Client surfaces

The compact binding percentage appears beside model choices in New Session,
Model Settings, live Model Switch, and Handoff Session.

The session header's model dialog includes a **Usage** tab whenever subscription
usage or last-turn token details are available for the session. The tab lists
every applicable window for the current model first (ordered shortest window to
longest, e.g., five-hour above weekly, with reset times and a manual Refresh
control), shows any other model buckets on the same provider below under a
separate heading, and renders the session's context breakdown and token
accounting underneath when available.

The session context indicator has two distinct interactions:

- left click, Enter, or Space opens all applicable subscription windows and
  reset times when usage is available;
- right click or touch long-press opens the existing per-model compact-threshold
  editor. The usage detail also links to that editor so it remains keyboard
  accessible.

The context trigger and either dialog are separate interactive surfaces.
Keyboard or pointer activation of Refresh, Edit, or another dialog control
acts on that control without retriggering the context indicator.

The existing context percentage remains context-window consumption, not
subscription usage.

## Operator quota watchdog

`scripts/codex-quota-watchdog.py` is a one-shot Python 3.9+ script for an
operator-owned five-minute schedule. It uses `aar account quotas` to read one
explicitly selected Codex enrollment and checks the local YA instance record
against the configured server ID. It requires all-project operator access to
the ordinary loopback API.

The script acts on a fresh account-wide quota. Explicit permission for
included usage takes precedence over displayed percentages. Without that
permission field, either general Codex window at zero triggers the watchdog.
Failed or missing quota observations leave sessions running. The default
reports what it would do. With `--apply`, the script requests a verified
stop of every active session it sees on that local server, across projects
and providers, and reports the result from each stop receipt. Session history
remains available. A later run can stop sessions started since the last check.

```sh
python3 scripts/codex-quota-watchdog.py \
  --account "$AAR_CODEX_ACCOUNT_ID" --server-id "$YA_SERVER_ID"
```

Use `--aar-state` and `--ya-instance` for nondefault profiles. When using a
packaged AAR runtime or source checkout, pass the command after `--`, for
example `-- node /path/to/agent-auth-router/src/cli.ts`. Add `--apply` to the
scheduled invocation to enable stops. Credits may still be spent between checks
or outside that YA server.

## Compatibility

Routed reads use the existing `agent-auth-router-pools` capability and cache by
source, provider and pinned account. Older routers may omit the additive
`ordinaryUsageAllowed`, `planCapacityUnits` and per-window
`remainingCapacityUnits` fields. Missing capacity metadata is unknown, never a
full USD 200 subscription. The router owns allowance weights; YA does not
derive them from subscription prices. Windows overlap and are not summed.
When Codex explicitly permits usage despite a 100% display reading, the detail
view explains that permission and leaves the remaining amount unknown.

Pre-provider router refusals retain the bounded, sanitized router message in
the session-creation attempt's optional `failureDetail`. Both session detail
and list projections preserve it; a new retry starts without the prior detail.
Older servers simply retain the generic refusal copy.

`provider-subscription-usage` is a permanent server capability covering
`GET /api/providers/:name/subscription-usage`. A client must observe the
capability before making the request. Without it, the client makes no
unsupported request, shows no subscription-usage badges or detail, and
preserves the passive context tooltip plus compact-threshold interaction.

The implementation was reviewed against stable releases `v0.7.0` and
`v0.6.2`, neither of which has the capability or route. This narrow optional
feature does not raise `remoteCompatibilityLevel`.

## Provider boundaries

Claude Agent SDK `0.3.220` marks its subscription-usage control method
experimental. `ClaudeProvider` contains that instability: the normalizer
accepts only the fields YA needs and any unavailable or changed response
degrades to null.

Codex CLI `0.147.0` exposes single- and multi-bucket rate-limit snapshots,
account token-activity reads, and account identity reads.
The general `codex` bucket is provider-wide; named buckets are model-scoped
only when their provider label resolves to a current catalog model. Existing
`account/rateLimits/updated` events remain non-terminal telemetry and never
become synthetic turn errors.
