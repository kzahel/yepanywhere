# Antigravity sessions launched in Bypass cannot be tightened

`agy` has no native bypass mode, so a session launched with YA's Bypass
starts its `agy acp` server with `--dangerously-skip-permissions`
(`packages/server/src/sdk/providers/antigravity.ts`, the `skipPermissions`
launch argument). The flag lasts for the server's life. YA now applies a
mid-session mode change at the next prompt with `session/set_mode`
(`packages/server/src/sdk/providers/antigravity-permission-mode.ts`), but
choosing Ask, Edit, Auto or Plan in a Bypass-launched session changes only
the native mode: the flag still approves every tool without a permission
request, so YA never sees one to ask about. The UI then says Ask while
`agy` runs unasked, against the tightening invariant in
[permission mode](../topics/permission-mode.md#provider-adapter-invariants).

The reverse direction is fine: a session launched without the flag and
switched to Bypass is approved by YA's own bridge.

Fix: when a prompt's mode is not Bypass and the server was launched with
the flag, restart the owner without it and continue with `session/resume`
(the resume path already restarts `agy` with the conversation's context),
then apply the mode. Until then, a user who needs to tighten a Bypass
session should start a new session.

Found 2026-11-26 while mapping YA permission modes to `agy`'s native modes.
