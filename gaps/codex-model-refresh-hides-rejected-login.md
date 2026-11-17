# Codex model refresh hides rejected sign-in

New Session's model Refresh can report that the catalog was just updated
when Codex could not authenticate. `getAuthStatus` in
`packages/server/src/sdk/providers/codex.ts` uses the exit status of
`codex login status`, which confirms that a login is saved. Codex app-server's
`model/list` can return bundled models after the authenticated catalog request
fails. YA treats the nonempty response as live and shows the normal update
timestamp in `NewSessionOptionsPanel.tsx`.

Reproduced with Codex CLI 0.169.0. `codex login status` reported a ChatGPT
login, `account/read` returned `account: null` with `requiresOpenaiAuth: true`,
and `account/rateLimits/read` returned an unauthorized error. Codex logged
`401 invalid_jwt` while refreshing models, but `model/list` returned nine
entries without an RPC error or GPT-6.2 Sol. YA's forced provider refresh
returned `source: live`. The existing usage probe discards its failure and
returns no usage, so it also supplies no feedback.

For direct Codex, surface a confirmed login rejection beside the New Session
model picker with the existing provider sign-in action. On refresh, reuse
bounded account verification without starting a session or sending a prompt.
Show an inconclusive status for timeouts or network failures and keep the
model choices visible. Keep this scoped to the selected host and direct login.
The provider and UI changes are deferred while the affected host is moved to
router-backed Codex.

Found 2026-11-17 while investigating missing GPT-6.2 Sol on New Session.
