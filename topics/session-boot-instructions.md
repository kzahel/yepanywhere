# Session boot instructions

> A new session can replace the operator's user-level instruction layer — the
> provider's own `~/.claude/CLAUDE.md` or `$CODEX_HOME/AGENTS.md`, plus user
> skills — with instructions its creator supplies, while keeping project
> instructions, login and the operator's provider configuration. An API caller
> also names itself, so its sessions can be grouped apart from hand-started
> ones.

Topic: session-boot-instructions

Status: specified 2026-11-25; implementation in progress, so no server yet
accepts these fields. Provider mechanics below were verified with marker text
on Claude Code 2.1.330 and Codex CLI 0.172.0 (see [evidence](#evidence)). This
contract supersedes the earlier virgin-session sketch, which the implementing
commit retires.

See also: [HTTP API v0](http-api-v0.md#creation-and-retry-receipts),
[provider host API](provider-host-api.md),
[new-session agent tooling](new-session-agent-tooling.md#instruction-scope-options-virgin-sessions),
[session sandboxing](session-sandboxing.md),
[agent context injection](agent-context-injection.md),
[vanilla defaults](vanilla-defaults.md).

## Vocabulary

- **Boot instructions** are the user-level instruction layer a provider loads
  before project instructions. Absent boot instructions leave that layer as
  the provider normally loads it.
- A **virgin** session has empty boot instructions: no user-level layer at all.
  *Vanilla* still names unchanged first-party behavior, which includes the
  operator's layer.
- **`apiClient`** names the program that created a session through the API.
  It is caller-asserted provenance, not authentication. The name avoids YA's
  usual sense of *client*, the web client.

## Request contract

`POST /v0/servers/{serverId}/sessions` accepts two optional fields:

| Field | Form | Meaning |
| --- | --- | --- |
| `apiClient` | 1–64 characters from `A–Z a–z 0–9 . _ -`, starting with a letter or digit | Recorded on the session; selects its [boot home](#codex-boot-home) |
| `bootInstructions` | absent or `null` | The provider loads the operator's user-level layer unchanged |
| | `{"text": ""}` | Virgin: no user-level layer |
| | `{"text": "..."}` | These instructions replace the user-level layer; at most 200,000 characters |
| | `{"path": "/abs/file"}` | The file's contents replace the layer, read at every launch and resume |

A path must be absolute and name a regular file of at most 200,000 characters
of UTF-8 text when read. It is admitted only from a local principal; a request
forwarded from a peer server may use `text` but not `path`. A path that is
missing, unreadable or oversized at a later resume fails that launch before
the provider starts, rather than resuming with the operator's layer or with no
instructions.

Both fields are immutable after creation. `bootInstructions` is a property of
the session and is reapplied on every resume, restart and fork; changing it
means creating a new session. A fork or restart successor inherits the
source's `apiClient` and `bootInstructions`.

Existing YA instruction text is unaffected: the server-wide
`globalInstructions` setting, agent API and Machine Control fragments still
append as they do for every session. A limited-user sandbox's base-prompt
replacement is a different layer; v0 creation is not available to limited
users, so the two do not combine through this route.

Absence of both fields is today's behavior, unchanged. A server that predates
these fields rejects them, because the v0 creation body is strict; a caller
learns support from `/v0/schema`.

## Claude mechanics

A Claude session with boot instructions needs no separate config directory, so
login, transcripts and session discovery are the ordinary ones:

- YA loads only the `project` and `local` setting sources. Leaving out `user`
  drops `~/.claude/CLAUDE.md`, `~/.claude/skills` and every user setting.
- YA passes the operator's user settings back explicitly through the SDK's
  `settings` option (the CLI's `--settings`), filtered as described in
  [carried configuration](#carried-configuration). Explicitly passed settings
  apply even with the `user` source left out.
- The boot text is appended to the system prompt YA already builds for the
  session, after `globalInstructions`.

Project `CLAUDE.md` and project or local settings still load. Claude's built-in
skills and plugins remain; user plugins return only when the carried settings
enable them.

## Codex mechanics

Codex reads its user-level `AGENTS.md` from `CODEX_HOME` and has no switch to
skip it, so a Codex session with boot instructions runs with `CODEX_HOME` set
to a [boot home](#codex-boot-home) that has no `AGENTS.md`. YA runs one Codex
app-server process per session, so the variable is per session.

- The boot text is the thread's `developer_instructions`, replacing any value
  the carried `config.toml` sets, followed by YA's own launch fragments.
- Codex also loads skills from `~/.agents/skills`, outside `CODEX_HOME`. At
  every launch YA lists `~/.agents/skills/*/SKILL.md` and disables each one
  through the thread's `skills.config`, so skills added later are covered too.
  Codex's built-in and plugin skills remain.

### Codex boot home

The home is `{dataDir}/boot-homes/codex/<apiClient>`, or `_default` when the
request has no `apiClient`. It is stable: every session of one `apiClient`
shares it, which keeps that client's transcripts in one tree.

- If the directory is absent, YA builds it beside its final path, writes the
  marker `.ya-boot-home` last, then renames it into place. Concurrent first
  launches converge on whichever rename lands; the other is discarded.
- If it exists with a matching marker, YA reuses it.
- If it exists with no marker, or a marker naming a different `apiClient` or
  provider, the launch fails. YA never overwrites or relocates a directory it
  cannot prove it made, and never forks a client's sessions into a second home.

The marker is JSON: `{"schema":1,"provider":"codex","apiClient":<exact
name>,"createdAt":<ISO time>}`. The exact name catches two names that would
share a directory on a case-insensitive filesystem.

At every launch YA refreshes the home's carried entries, then starts Codex:

| Entry | Treatment |
| --- | --- |
| `auth.json` | Symlink to the operator's file, so a token refresh is shared |
| `config.toml` | Filtered copy of the operator's file, rewritten at each launch |
| `rules/` | Symlink to the operator's directory |
| `AGENTS.md`, `skills/`, `hooks.json` | Never created |
| `sessions/`, history, logs, caches | Private to the home, created by Codex |

Transcripts under the home's `sessions/` are bound to their sessions as the
native storage scope, the same mechanism a sandboxed session uses, so resume
and history reads find them.

## Carried configuration

Configuration is carried so that permissions, model, provider and MCP setup
match the operator's. Whether a carried entry is a link or a copy is not part
of the contract; a session may observe later changes to the operator's files,
and a write a session makes may or may not reach them.

Filtering removes what would reintroduce instructions or run code at turn
boundaries:

- Claude settings: `hooks`, `outputStyle` and `statusLine`.
- Codex `config.toml`: top-level `developer_instructions`, `instructions`,
  `model_instructions_file` and `experimental_instructions_file`, and every
  `hooks` table.

The filter is best effort. A provider update can add another key with the same
effect; reviewing new configuration keys for that is part of
[provider refresh](provider-refresh.md).

## Hosting, persistence and refusal

Both fields are saved in session metadata at creation, so a resume, restart,
fork or recovered hosted launch rebuilds the same launch from the session
rather than from the request that resumed it.

A hosted launch carrying boot instructions requires the provider host and the
worker to advertise `session-boot-instructions-v1`. An older host or worker
refuses the launch before the provider starts. Without that refusal an older
worker would ignore the unknown option and start the session with the
operator's layer, which is wrong rather than degraded. In-process launches
need no feature check.

Boot instructions are refused for a session that would also run in a session
sandbox. The sandbox has its own private provider home; composing the two is
open work in [the gap](../gaps/sandboxed-boot-instructions.md).

## Sidebar

A session that records an `apiClient` is listed only in a sidebar section
named for that client, collapsed until the reader expands it, below the
limited-user sections. Starring or filing the session in a sidebar category
still moves it there, as with any other session. Sessions without `apiClient`
are listed exactly as before.

Session rows carry `apiClient` as an optional field. A client that does not
know the field, or a server that does not send it, lists the session among
ordinary sessions; no capability or extra request is involved.

## Design decisions

- **Claude drops the user setting source and re-supplies the settings** (vs. a
  private `CLAUDE_CONFIG_DIR`): Claude refuses a symlinked `.credentials.json`
  and rotates its refresh token, so a private directory needs a bind mount or
  a second credential. Staying in the default directory also keeps transcripts
  where the catalog already reads them.
- **Boot text travels per session, not as a file in the home** (vs. writing
  `AGENTS.md` into the boot home): one home serves every instruction variant a
  client runs side by side, and changing the text never alters sessions
  already running.
- **One stable home per `apiClient`, refusing an unproven directory** (vs. a
  home per instruction hash, or a suffixed replacement on mismatch): a
  client's transcripts stay in one tree, and YA never deletes or shadows a
  directory it did not make.
- **Structured `bootInstructions`** (vs. a string where a sentinel means
  "none"): `null`, empty text, text and path stay distinct without reserving a
  file name.
- **`apiClient`** (vs. `client`): *client* already names YA's web client
  throughout code and docs.

## Evidence

Marker-text probes on 2026-11-25, Claude Code 2.1.330 and Codex CLI 0.172.0,
asking the model to quote a heading from the operator's boot and to report a
marker token:

| Setup | Operator boot | Supplied text | User skills |
| --- | --- | --- | --- |
| Claude, all sources | loaded | — | 62 skills, 8 plugins |
| Claude, `project,local` only | absent | arrives via appended system prompt | built-ins only |
| Claude, `project,local` plus `--settings` | absent | — | env and a permission rule applied |
| Codex, operator home | loaded | — | — |
| Codex, home without `AGENTS.md` | absent | arrives via `developer_instructions` | still listed |
| Codex, same, one skill in `skills.config` disabled | absent | — | that skill removed |

Codex accepted a symlinked `auth.json`. Its `skip_host_skill_discovery` and
`omit_skill_descriptions` features did not hide `~/.agents/skills`.
