# One local token opens every routed Antigravity session's proxy

Routed `agy acp` sessions share one profile directory,
`<dataDir>/agent-auth-router/antigravity-home`, so native history stays in at
most two stores. `prepareAntigravityRoutedProfile` in
`packages/server/src/sdk/providers/antigravity-routed-profile.ts` writes one
stand-in login there, and every session's loopback proxy
(`router-loopback-proxy.ts`) accepts it. Each proxy holds a different binding
token on a different port.

On macOS and Linux the stand-in is in a `0600` file under a `0700`
directory, so another OS user cannot read it. Windows applies no such mode,
and routed sessions are not offered there. A browser page does not have the
stand-in. A process
running as the same OS user can read the file, find a listening port, and
send inference through any running routed Antigravity session's binding
until that session's `agy` exits. A stand-in copied by one session's `agy`,
or by anything `agy` runs, opens the other sessions' proxies the same way.
The same process can also read YA's private state, which holds the binding
tokens, so this adds reach between sessions more than it adds reach for a
same-user attacker.

Not fixed in place because the remedy is a profile per session, which
multiplies the native stores the history reader, watcher and resume
validation must find. The likely fix: a per-session profile whose
`conversations` directory is the shared one, if `agy` accepts that split,
with a stand-in generated per launch and removed at exit. Check first
whether `agy` rewrites its token file or resolves `conversations` through a
symlink.

Found 2026-11-25 while making the proxy provider-neutral for plan 198 step 3.
