# Codex Bash without turn cwd or with execution settings can still duplicate

The explicit-workdir, output/yield-only case is repaired by the literal Bash
fingerprint described in [render convergence](../topics/codex-code-mode-render-convergence.md#2026-11-05-native-bash-identity-convergence).
The broader pending-plus-complete complaint is not fully resolved.

A durable `exec_command` can omit optional `workdir`; the live command item
still has a concrete `cwd`. Calls can also include `login`, `tty`, `shell`,
`justification`, `sandbox_permissions` or other execution settings. The current
client deliberately falls back to its older exact-input comparison when cwd is
absent or extra settings are present. The different wrapped/unwrapped input
shapes then remain unmatched, so an additional pending row can persist beside
the completed durable row. The retained browser/fixture covers explicit
absolute workdir and only output/yield controls; it does not qualify these
ordinary omitted/default or execution-setting cases.

Qualify separate native captures before broadening the matcher. For omitted
workdir, a candidate is the authoritative cwd for that exact native turn;
never match any directory or borrow a later turn's/project's cwd. The durable
reader exposes turn-context records; normalization and its incremental/tail
state would need to preserve that proof before using a canonical Bash cwd.
For `login`, retain the actual decoded shell flag and accept the setting only
when a current-native capture proves agreement (`-lc` versus `-c`); do not drop
it as an output control. Other execution settings retain their own proof needs.

The existing same-turn, ten-second start window, display semantics and
one-to-one constraints remain. Near-simultaneous identical calls can still be
ambiguous under the existing nearest-start policy; presentation correlation is
not creator, permission, or relationship authority. No new transcript store or
broad corpus scan is required for this follow-up.

Found 2026-11-05 during Opus review of the explicit-workdir native Bash repair.
