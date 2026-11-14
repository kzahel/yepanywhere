# Codex Permission Mode

> Codex permission mode has two clocks: YA's selected standing approval policy
> applies immediately, while the matching Codex approval and native sandbox
> policies apply together at a turn boundary without restarting app-server.

Topic: codex-permission-mode

Status: **implemented and covered (2026-08-08).** Thread start/resume and every
real turn map the effective mode to matching Codex approval and sandbox
settings. Live Ask/Bypass switching uses the next `turn/start` on the existing
app-server process for native policy, while YA applies the selected approval
policy immediately.

See also:

- [permission-mode](permission-mode.md) — provider-independent mode storage,
  capability filtering, and `Auto` fallback.
- [session-sandboxing](session-sandboxing.md) — YA's separate, optional outer
  filesystem boundary.
- [provider-runtime-status](provider-runtime-status.md) — normalization of
  Codex `sandboxError` and other runtime failures.
- [steer-queue-provider-differences](steer-queue-provider-differences.md) —
  why `turn/steer` is not a new turn boundary.
- [session-reactivation](session-reactivation.md) — message-less process
  reactivation before the next real turn.
- [provider-refresh](provider-refresh.md) — pinned Codex app-server protocol
  and source-audit procedure.

## Separate Policy Layers

Five similarly named values must remain separate:

1. **YA permission mode** is the user-facing per-session choice: Ask
   (`default`), Accept edits (`acceptEdits`), Plan (`plan`), Bypass
   (`bypassPermissions`), or `auto` where the selected model supports it.
2. **Codex approval policy** decides whether Codex requests approval for an
   operation. YA currently uses `on-request` or `never`.
3. **Codex native sandbox policy** decides what Codex's own operating-system
   sandbox permits. YA uses the read-only, workspace-write, or
   danger-full-access variants.
4. **YA session sandbox level** is the optional outer `project-write`
   Bubblewrap boundary created around the provider process. It is default-off,
   provider-independent product state and cannot be widened by a Codex mode.
5. **Provider-reported sandbox** is transcript evidence from Codex
   `turn_context.sandbox_policy`. It helps diagnose what Codex believed was in
   effect but is not proof that either native or outer enforcement succeeded.

An approval is not a filesystem capability. A native sandbox policy is not an
approval preference. For Codex, however, the two provider-native values form
one effective permission contract and must be selected atomically.

## Mode Mapping Contract

For every new Codex thread and every real `turn/start`, the effective YA mode
maps as follows:

| Effective YA mode | Codex approval | Codex native sandbox | YA approval behavior |
| --- | --- | --- | --- |
| Ask (`default`) | `on-request` | workspace-write | Read-only actions may pass; mutating or elevated actions ask according to YA rules and Codex requests. |
| Accept edits (`acceptEdits`) | `on-request` | workspace-write | Recognized reads and file edits may be auto-approved; other elevated actions still ask. |
| Plan (`plan`) | `on-request` | read-only | Planning/read actions may pass; mutation is not silently enabled. |
| Bypass (`bypassPermissions`) | `never` | danger-full-access | Ordinary tool actions do not ask, subject to explicit deny rules and any outer YA sandbox. |
| Unsupported `auto` | `on-request` | workspace-write | Resolve to effective Ask while preserving the saved all-provider `auto` preference. |

Workspace-write must be rooted in the active Codex workspace/project.
Structured turn policies must preserve the same writable-root, temporary-path,
read-access, and network semantics as the corresponding thread policy. A
permission-mode repair must not accidentally redefine network policy. Bypass
selects Codex's unrestricted native policy; it still cannot widen an enabled
outer YA session sandbox.

The app-server protocol may represent the native sandbox differently at thread
and turn scope. The current checked-in protocol uses thread-level `sandbox`
values and a structured turn-level `sandboxPolicy`. That wire difference does
not change the mapping.

Future Codex versions may offer a named `permissions` profile instead of an
explicit sandbox policy. YA may use one only after a pinned-version capability
audit proves equivalent semantics. `permissions` and `sandboxPolicy` are
mutually exclusive in the current protocol; they must never be sent together,
and a profile must not weaken the table above.

## Atomicity And Safety Invariants

- `approvalPolicy` and the native sandbox selection are one atomic value at
  every Codex turn boundary. YA must never update only one half.
- For each newly started turn, the mode stamped on the delivered message,
  `turn/start` parameters, and resulting provider-reported turn context must
  agree. A later UI selection may change YA's approval response while those
  provider-native turn settings remain fixed.
- A tightening transition is at least as important as a loosening transition.
  Bypass to Ask must not leave danger-full-access active behind an Ask label.
- Ask to Bypass must not leave workspace-write active with
  `approvalPolicy: never`; that combination removes the approval path while
  retaining the sandbox that needed it.
- Permission allow/deny rules are evaluated before mode-based auto-approval.
  An explicit deny remains a deny in Bypass.
- Provider-native interviews and user questions are not permission prompts.
  Bypass and allow rules must not silently answer them.
- Approval handlers must consult the current selected standing mode. The
  request turn's frozen mode remains evidence of provider-native policy, not an
  override of a newer user selection.
- A one-off UI approval uses the narrowest provider scope that satisfies the
  request, normally the current turn. A session-scoped grant requires an
  explicit persistent user choice and must not survive a later tightening
  transition merely because Codex cached it.
- Logs and Process Info must report the effective turn mode and the actual
  approval/sandbox fields sent. Launch-time values are insufficient after a
  live switch.

## Pre-Snapshot Resume Recovery

Codex `turn_context` is also the compatibility source for a YA session created
before `SessionMetadata.effectiveLaunchSettings` existed. Only the latest valid
context is relevant: a session may change model, effort, and permission mode
between turns.

The reverse mapping is deliberately narrower than launch mapping:

| Latest Codex evidence | Recovered YA mode |
| --- | --- |
| `never` + danger-full-access | Bypass |
| `on-request` + read-only | Plan |
| `on-request` + workspace-write | Ask |
| incomplete, mismatched, or unknown values | Ask |

Ask and Accept Edits share the same Codex-native pair, so a rollout cannot
prove which YA selection produced it. Recovery chooses Ask. No partial or
unfamiliar transcript evidence may grant Bypass. This use of provider-reported
policy preserves the last requested behavior when the pair is unambiguous; it
does not turn the rollout into proof that native or outer sandbox enforcement
succeeded.

The latest context is read backward from the end of the rollout within the
[point-read budget](provider-history-facts.md). A fork that references its
parent's history (`history_base`), a compressed rollout or a final turn longer
than the budget takes the named complete read instead: an unanswered recovery
would launch with the default permission mode rather than the one the rollout
records.

Reading recovery evidence does not mutate session metadata. Once a cold resume
successfully starts Codex with the resolved settings, that actual process state
is authoritative and the ordinary complete launch snapshot is persisted. A
failed launch persists nothing, and a complete existing snapshot always wins
over transcript inference, including its intentional provider-default values.

## Turn-Boundary Semantics

Codex app-server supports approval and sandbox overrides on `turn/start`.
Specified overrides become sticky defaults for later turns on the same thread.
It does not accept those overrides on `turn/steer`. Therefore:

- Changing mode while the Codex process is idle applies to the next
  `turn/start` on the existing app-server process. It must not require process
  teardown, Kill, resume, reactivation, or a new public session id.
- Changing mode while a turn is active does not retroactively change that
  turn's sandbox or Codex approval policy. The selected value is pending for
  those provider-native settings at the next real turn, but YA applies it
  immediately to any approval request Codex does emit.
- The closed mode selector remains the normal compact control while a turn is
  active. Its tooltip and the timing note at the top of the opened menu explain
  that a selection applies to the next turn. After a selection actually
  diverges from the mode at the latest successful provider policy boundary,
  the compact label appends `(pending)` until a matching `turn/start`
  succeeds. It must not show a persistent passive next-turn badge when the
  values already agree.
- `appliedPermissionMode` is optional backwards-compatible server evidence.
  When an older server omits it, the client retains the tooltip/menu timing
  explanation and does not guess at or show a pending state.
- The UI must not imply that an active Bypass turn has already been tightened
  merely because Ask was selected for the next turn. Immediate tightening
  requires interrupting the active turn and beginning a new one.
- Interrupt plus a new turn is the provider-native recovery boundary when the
  user needs the new mode immediately. YA must not automatically replay an
  interrupted prompt because partially completed tool side effects could be
  duplicated.
- A steering message joins the active turn and inherits that turn's effective
  permission contract. It must not try to carry a new sandbox override.
- A queued/deferred message that will create a new turn retains the effective
  mode selected for that submission. Promotion must apply that mode at its
  eventual `turn/start`, not leak it into the currently active turn.
- A message-less resume/reactivation establishes an initial thread policy but
  performs no model turn. A mode changed after reactivation must still apply at
  the next `turn/start` without another process restart.

The mode selector is standing policy and also governs approvals already on
screen. Selecting Accept edits resolves pending edit/write approvals but leaves
command approvals waiting. Selecting Bypass resolves every pending permission
approval. Questions and interviews remain explicit user-input requests.
Changing the selector cannot retroactively widen or tighten the active Codex
sandbox; interrupting and starting a new turn remains the immediate boundary
for that provider-native change.

## Approval And Elevation

When Codex emits a command, file-change, or permissions-profile approval
request, YA must route the UI's decision back to that same request. An approved
one-off elevation should run without restarting the Codex process.

There are three distinct failure classes:

1. **Denied approval** — the user or a rule declined a request.
2. **Sandbox setup/execution failure** — Codex could not establish or use its
   native sandbox, reported as `sandboxError` or equivalent diagnostic.
3. **Pre-approval helper failure** — Codex failed while inspecting or preparing
   an operation and never emitted an approval request.

YA must not relabel the latter two as user denial. It also cannot manufacture
an approval for a request Codex never emitted. It should preserve the provider
diagnostic, show that the failure is sandbox/environment related, and leave the
user able to interrupt and select an explicit usable mode for the next turn.

## Linux And Bubblewrap

Codex's native read-only and workspace-write sandboxes use Bubblewrap plus
seccomp on Linux. Ask and Plan may therefore fail when the host cannot run
Codex's `bwrap` path, even if the binary is installed.

YA must not make a working Bubblewrap installation a prerequisite for all
Linux Codex use:

- explicit Bypass with YA's outer session sandbox off must remain usable
  without a functioning Codex native `bwrap` setup;
- YA must never silently turn Ask or Plan into Bypass when native sandbox setup
  fails;
- the failed turn must surface a sandbox/environment diagnostic and allow the
  user to choose Bypass for the next turn on the same app-server process; and
- if the user explicitly enabled YA's outer Project writes only sandbox, that
  independent Bubblewrap preflight and non-widenable boundary still apply in
  every permission mode.

The optional outer sandbox's capability probe must not be used as proof that
Codex's independently selected native sandbox will work, and a Codex native
sandbox failure must not be reported as failure of the optional YA feature.

## As Built

As of 2026-08-08:

- `CodexProvider.mapPermissionModeToThreadPolicy` computes the intended pair:
  ordinary modes use `on-request` plus workspace-write, Plan uses
  `on-request` plus read-only, and Bypass uses `never` plus
  danger-full-access.
- Thread start/resume sends both `approvalPolicy` and legacy `sandbox`.
- `Process` stamps the effective mode on provider-bound messages. The shared
  `MessageQueue` preserves it through concatenation and keeps differing modes
  in separate provider turns. Deferred join groups also stop at a mode
  boundary.
- `createTurnStartParams` derives a fresh policy from that message and
  `buildTurnPermissionParams` sends both `approvalPolicy` and the corresponding
  structured `sandboxPolicy`, replacing both sticky values atomically. When
  thread start/resume reports an effective workspace-write policy, Codex caches
  and reuses that complete structure so configured network, writable-root, and
  temporary-path behavior survives Ask to Bypass to Ask switching.
- `Process.setPermissionMode` updates YA state, multi-tab versioning, and the
  live approval bridge. It does not mutate an active app-server turn. The
  complete native pair is sent at the next real `turn/start`, while steering
  inherits the active turn.
- `Process.appliedPermissionMode` starts with the successful Codex thread
  start/resume policy and then records each successful `turn/start`, separately
  from the standing selector value. Ownership status, stream connection state,
  and `mode-applied` events expose it as an optional field, allowing new
  clients to render `(pending)` while remaining compatible with older servers.
- Codex freezes the provider-native mode before `turn/start` and passes it
  through every approval callback as turn context. `Process.handleToolApproval`
  uses the current selected standing mode for YA's decision. A mode change
  re-evaluates queued approvals immediately: Accept edits grants recognized
  edits and Bypass grants every non-question permission request.
- Accepted `item/permissions/requestApproval` grants use turn scope. Bypass
  auto-granting and Ask prompting consult the current selected standing mode;
  neither relies on launch-time options.
- Codex `item/tool/requestUserInput` is surfaced through YA's question panel
  and returned to app-server by question id. Secret free-form answers use a
  password input and remain in component memory rather than persisted drafts.
- While Codex is active, the mode selector's tooltip and opened menu explain
  that changes apply to the next turn without changing the compact closed
  control. Turn-start logs include the effective YA mode and both native policy
  fields; Process Info continues to expose Codex's reported `turn_context`
  policy.

## Regression History And Evidence

- Commit `69529c72` (2026-04-24, Codex 0.124 refresh) introduced per-message
  turn policy and, when supported, sent an unrestricted turn-level
  `permissionProfile` for Bypass alongside `approvalPolicy: never`.
- Commit `669edbb5` (2026-05-06, Codex 0.128-era protocol cleanup) removed the
  deleted upstream `permissionProfile` shape. The replacement
  `buildTurnPermissionParams` retained only `approvalPolicy`, which is the
  likely live-switch regression boundary.
- During the 2026-07-30 investigation, the installed Codex 0.144.1 generated
  schema and YA's checked-in 0.145.0 protocol both exposed structured
  `turn/start.sandboxPolicy`. The current protocol documentation states that
  per-turn overrides become later-turn defaults and that `turn/steer` does not
  accept sandbox overrides. A process restart is therefore not required
  between completed turns.
- The motivating Ask-mode resume reproduced a native Bubblewrap failure.
  Approving an escalated Bash request in the UI succeeded outside the sandbox,
  proving the one-off command approval path was functional. A patch operation
  failed earlier in Codex's filesystem verification path, before an ordinary
  patch approval could be emitted. Killing and resuming in Bypass worked, but
  that process restart is the workaround this contract removes.

Official protocol reference:
[Codex App Server](https://learn.chatgpt.com/docs/app-server.md).

## Verification Contract

The implementation has deterministic coverage for:

- thread start and resume mapping every supported YA mode to both sides of the
  provider-native policy;
- `turn/start` mapping Ask, Accept edits, Plan, Bypass, and unsupported `auto`
  without an approval-only update;
- Ask to Bypass and Bypass to Ask on one live app-server process, with the same
  YA process id and Codex thread id;
- provider-observed turn context agreeing with the requested next-turn mode;
- mode selection during an active turn applying only to the next real turn and
  never through `turn/steer`;
- the pending selector marker appearing only while selected and applied modes
  differ, clearing after a successful matching `turn/start`, and remaining
  absent against an older server that supplies no applied-mode evidence;
- deferred messages retaining their submission mode until the turn they
  create;
- Accept edits resolving queued edit/write approvals while leaving commands
  pending, and Bypass resolving all queued permission approvals while leaving
  provider questions pending;
- newly arriving approvals consulting the selected standing mode even when the
  requesting turn's provider-native mode differs, especially after Bypass to
  Ask;
- one-off permission grants defaulting to turn scope and a stricter later mode
  not inheriting an undeclared session-wide grant;
- deny rules and provider-native user questions retaining precedence over
  auto-approval, with Codex interviews surfaced rather than answered empty;
- native sandbox failure remaining a visible failure rather than silently
  falling back to full access;
- explicit next-turn Bypass working on a host with unusable native Bubblewrap,
  without process restart when YA's outer sandbox is off; and
- Bypass remaining unable to widen an enabled outer YA Project writes only
  boundary.

At least one integration test should use a fake app-server that models sticky
turn defaults. A unit test that only inspects the mapping helper will not catch
another approval-only regression.
