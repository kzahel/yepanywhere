# Context breakdown

> The context breakdown is the context-usage popover's section showing what
> fills a live session's context window, by category, with per-file and
> per-skill rows — the data behind Claude Code's `/context`.

Topic: context-breakdown

Related topics: [session usage accounting](session-usage-accounting.md) (the
last-turn token rows below it in the same popover),
[provider context economics](provider-context-economics.md),
[server capabilities](server-capabilities.md), and
[vanilla defaults](vanilla-defaults.md#known-exceptions).

## Behavior

Opening the context-usage popover (left click on the composer's context pie)
on a session with a live YA-owned process requests the breakdown once per
opening. While the request runs the section shows "Counting context…". When it
answers, the section shows, above the existing quota and last-turn rows:

- the used total against the provider's window, its percentage, and free
  space;
- a window meter, with any compaction reserve hatched and a tick at the
  automatic-compaction point when the provider reports one;
- a composition bar scaled to the used tokens only, so small categories stay
  visible at low occupancy, with a faint dashed connector from the used
  window meter's endpoint to the composition bar's right edge;
- one row per used category with its tokens and share of the used total.

Rows carry YA labels for the provider's categories: Harness prompt, Tool
definitions, MCP tools, Custom agents, Instruction files, Skill index and
Conversation. A provider row YA does not recognize appears under the
provider's own name. Rows that carry detail expand in place: instruction files
by path (home-relative), skills, tool definitions, MCP tools and agents by
name, largest first. Past six items, the remainder collapses into one
"N more" row. Conversation expands into the provider's own estimates of tool
calls, tool results, agent text and your text when the provider reports them,
labelled as separate estimates that need not sum to the row. YA performs no
transcript scan of its own. Out-of-window (deferred) tool schemas appear as a
"Not loaded until used" line outside the used total.

The section renders nothing when no live process owns the session or its
provider cannot report a breakdown. A provider failure shows "Breakdown
unavailable: <message>" in the section; the rest of the popover is unchanged.
On a short viewport the popover caps its height to the space above the pie and
scrolls.

The breakdown is on by default as a recorded
[vanilla-defaults exception](vanilla-defaults.md#known-exceptions): it mirrors
`/context`, appears only when the user opens the existing popover, and adds no
visible chrome.

## Provider support

Claude sessions answer through the Agent SDK's `Query.getContextUsage` with
`detail: "full"`, which counts each category with the token-count API (about
0.3 s). The `summary` mode was measured on Agent SDK 0.3.283 at 15% above the
API-reported input and with a near-zero Messages row, so YA does not use it.
`normalizeClaudeContextUsage` in
`packages/server/src/sdk/providers/claude-context-breakdown.ts` maps the SDK's
English row names to stable keys by prefix; the SDK documents `kind` as its
only stable classification, so a renamed row degrades to plain text rather
than breaking.

Other providers do not implement `AgentSession.getContextBreakdown` and get no
section. The method crosses the provider host and managed SSH runners as an
optional session capability; a host started before it existed simply omits it.

## Wire contract

`GET /api/sessions/:sessionId/context-breakdown` returns
`{ breakdown: ContextBreakdown | null }`, or 502 `{ error }` when the provider
request fails. Limited users need view access to the session, as for every
session-scoped read. The `context-usage-breakdown` server capability (ID 108,
version-implied from 0.9.4) gates the client: without it the popover sends no
breakdown request and shows only its existing rows.
