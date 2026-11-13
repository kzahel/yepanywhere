# A v0-launched session can block on a provider question nobody can answer

Claude's `AskUserQuestion` stops the turn until it is answered. When an agent
launches a session through HTTP v0, nobody may be watching the YA UI, and v0
cannot answer questions. [Plan 192](../docs/tactical/192-v0-session-control-and-peer-contracts.md)
lists questions in `requests` with `canRespond: false`. The scoped API recovery
is to interrupt or stop the session. If interruption keeps the process alive,
a new `prompt` can contain the answer; a hard abort needs the existing YA
resume facilities first. Automatic resume is outside plan 192.

Codex's question works differently: it is a soft prompt, and the turn
continues. It needs no blocking treatment, but an agent should still be able
to notice it.

Why this was not designed alongside plan 192:

- **Claude and Codex questions have different semantics.** One answer shape
  would misrepresent one of them.
- **A launch-time policy conflicts with an existing rule.** The natural policy
  options are: block (today), auto-answer, or deny the tool so the agent
  proceeds without asking. But [Claude provider control](../topics/CLAUDE.md)
  requires that `AskUserQuestion` is never auto-allowed or auto-denied by
  permission mode or permission rules. Any deny or auto-answer option changes
  that rule and needs an explicit decision, probably as an explicit launch
  option that defaults to blocking.
- **Answering through the API needs its own authority.** Free-form "Other"
  answers and multi-select answers need their own schema and an explicit
  authority decision. The reduced plan keeps existing management/operation
  grants and does not introduce an `answer` category.

Found 2026-11-13 while designing v0 session control after a Codex session
launched on a Windows peer blocked unrecoverably.
