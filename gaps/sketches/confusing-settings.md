# Remaining confusing-settings design gaps

The reviewed and verified controls now have their user-visible contracts in
`topics/settings-ui-placement.md`. The items below need product, data-model, or
cross-pane interaction decisions before their Settings presentation can be
truthful.

## Devices, credentials, and live connections

Remote Access currently lists reusable remote-login credentials, while Devices
lists browser identity/origin history and current connected state. Devices is
the natural home for identity plus live connection state, but one composite row
needs a security-client information model that can join profile history,
current sockets, Web Push, and revocable credentials without treating a display
name or user agent as proof of one physical device.

Decide whether this becomes one composite Devices pane or two adjacent panes.
Revoke must remain distinct from disconnect and Delete history. Kyle added
browser profiles in `0dfba7e6` (2026-01-13) and memory-only-by-default remote
credentials in `7de3cb45` (2026-02-21).

Richer per-device settings counts, storage bytes, or cumulative session
activity have no current ownership model. Efficient duration accounting needs
a stable authenticated identity plus aggregation rules for concurrent tabs and
sessions. Choose a concrete user decision these metrics would support before
adding ongoing tracking.

## Unsaved provider-launch configuration

Claude Gateway URL and start-command edits correctly require explicit Save;
Enter also submits them. Leaving with edits needs a consistent Save / Discard /
Stay contract, but Settings has no shared dirty-form navigation guard. A full
guard must cover category clicks, sidebar links, browser Back, and tab close;
browser unload cannot await an asynchronous server save.

Decide whether Save may delay all in-app navigation and whether tab close uses
only the browser's native discard warning. A Gateway-only guard would establish
inconsistent form behavior. graehl introduced the optional Gateway URL in
`2d570447` (2026-07-27) and start command in `ea00bcbd` (2026-07-28).

## Environment registry completeness

Credential suffixes are now mandatorily redacted, and several confirmed
operator inputs were added, but the Environment registry remains hand-kept.
Requiring every `process.env` read would be wrong: HOME, PATH, launch markers,
child outputs, and internal test/control variables are not operator settings.

Choose either a typed operator-input registry consumed by config readers or an
explicit exclusion ledger checked against static environment reads. Without
one, new debug and development variables can silently miss the pane. graehl
added the Environment pane in `038b0e1c` (2026-06-19).

## Bypass-mode audit coverage

Approval audit logging now accurately describes explicit approve/deny events,
but bypass mode is at least as security-relevant and is not logged. Define one
event schema for sessions created or resumed in bypass and live permission-mode
transitions, including actor/source where known without duplicating state for
every tool call.

Decide whether the broader security audit shares the approval-log toggle/file
or has independent retention. graehl added the original audit in `d1d46d3b`
(2026-05-03); Kyle made it configurable and default-off in `02fc240d`
(2026-07-05).

## Ambient provider keys and metered billing

Grok Build requires an explicit opt-in before inheriting `XAI_API_KEY`, but
Claude and Codex still inherit `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` without an
equivalent decision. Those keys may take precedence over subscription login
and silently move work to metered billing. Adding equivalent opt-ins is safer
but can break installations that intentionally depend on ambient keys.

Decide migration/default behavior, how provider auth status reports the
credential that will win, and whether remote executors follow the same choice.
graehl added the Grok opt-in in `5efd593e` (2026-06-01).

## Cache Billing cannot explain an empty result

The final record path exists, but observations are silently dropped when
provider usage fields are absent, no warm/fork expectation exists, input is
below the 50k threshold, or hit/miss evidence is ambiguous. Two empty lists
therefore cannot distinguish a broken provider signal from no eligible
expectation, an under-threshold classification, or a broken monitor.

Add bounded stage counters and last-observation diagnostics before changing the
classifier: usage-bearing messages, expected-warm entries, missing usage,
threshold/unclassified drops, and emitted records per provider. Then use those
observations to decide whether the byte-identical/fresh-window policy is valid.
graehl added the default-off monitor in `1a50f72f` (2026-06-30).

## Agent Context placement differs across providers

The LaTeX capability row says the fragment applies on every provider start or
resume and is absent from the visible conversation. Claude does append it to
the system prompt on both paths. Codex, Codex OSS, and the legacy Gemini adapter
prefix it only for a new provider session, while Pi, OpenCode, Grok ACP, and
Gemini ACP prefix the first new user message even after resume.

For adapters currently using the user-prefix path, the fragment is not a separate
hidden turn: it is prepended to the provider-facing first user message. YA's
optimistic live echo retains the original text and deduplicates the adapter
echo, but no stripping contract guarantees that provider-persisted transcript
text cannot expose the prefix during later reconciliation.

Choose whether to normalize resume injection and durable transcript
presentation across providers or make the Settings copy provider-specific.
The current provider and compaction evidence is maintained in
[agent context injection](../../topics/agent-context-injection.md#current-ya-placement).
Kyle introduced the default-off setting and current provider composition in
`77d8f697` (2026-06-13); graehl added the always-visible fragment preview and
expanded placement copy in `9e35d054` (2026-08-11).

The separate Agent API bootstrap now uses native instruction context; its
[placement contract](../../topics/agent-context-injection.md#http-v0-bootstrap-placement)
records native evidence and resume caveats. This does not change the general
Agent Context setting described above.

Found 2026-08-11 while reviewing Settings clarity with graehl.
