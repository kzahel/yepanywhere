# Private harness homes omit global instruction files

The requested contract is that a sandboxed project can read its symlinked
`AGENTS.md` targets and the harness's instruction/configuration directories,
including legitimate targets outside the project. Future vendored YA facilities
will need the same read access. YA currently ships no such facility bundle;
the maintainer identified the optional LaTeX-output instruction as the present
injection and described vendored `~/agents` material as future work.

The Local Access custom path lines are **not sandbox grants**:

- `packages/client/src/pages/settings/LocalAccessSettings.tsx` converts the
  textarea to `fileAccess.custom`.
- `packages/server/src/middleware/file-access.ts` computes the HTTP file
  allow-set; `packages/server/src/app.ts` supplies it to file/media routes.
- `PrepareSessionSandboxOptions` and the provider launch-policy construction
  do not consume that allow-set. This is acceptable for browser file viewing
  and workflow schema fetches through the existing file route; sharing that
  setting with harness policy is not required by the present broad-read policy.

Current behavior already permits many outside reads: the Linux Bubblewrap
policy in `packages/server/src/session-sandbox.ts` mounts the host root
read-only, then overlays private temporary/runtime areas. Do not describe it
as a project-only read sandbox or claim ordinary outside symlink targets are
blocked. Provider-native restrictions still compose with that policy.

The unresolved part is reliable discovery through the relocated harness home.
`bootstrapProviderState` copies a selected set of config, plugin, rule, and
skill entries once, then `sandboxEnv` redirects `CODEX_HOME` or
`CLAUDE_CONFIG_DIR`. The copied lists omit `AGENTS.md` and `CLAUDE.md`.
There is no complete acceptance test for discovery of these global instruction
files across real harness startup and its native sandbox. Relative bootstrap
symlinks already retain their source-parent meaning, including when the
configured harness home itself is a symlink; their read/write behavior is
covered through the production Bubblewrap wrapper. See also
[session boot instructions](../topics/session-boot-instructions.md), which lets a
new session choose whether inherited harness instructions are present at all.

With broad host reads retained as standard, fix private-home construction and
discovery rather than adding a redundant read allow-list. Prefer automatic
preservation of the required instruction/configuration entries or a deliberate
read-only projection. Verify that the real sandboxed harness discovers project
and harness-global instructions, including symlinked instruction sources.

Only if a stricter read policy needs exceptions, offer an optional application
of the file-reader allow-set or a separate path list. Any manual fallback must
be a persisted **project setting**, used when sandboxing is enabled. It must
not require re-entry at New Session and must not live in global Session
Defaults. Preserve outside-project write denial, private provider state, and
the network boundary. This request records the gap; it does not widen the
launch policy now.

Related contracts: [session sandboxing](../topics/session-sandboxing.md) and
[workflow view](../topics/workflow-view.md).

Found 2026-09-07 while correcting workflow schema-file activation tests.
Contributing-model: 6-Astra
