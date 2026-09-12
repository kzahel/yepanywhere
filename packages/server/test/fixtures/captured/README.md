# Captured provider baseline

Real, sanitized sessions captured through an isolated YA data directory on
2026-09-12. These extend tactical 127 and the existing render-parity harness;
they are not converted from UI display fixtures. Replay never starts a provider,
contacts a server, or reads the developer's provider history.

| Capture | Provider path / model | Native / live records | Evidence |
| --- | --- | --- | --- |
| `claude-basic-2026-09-12` | Agent SDK 0.3.258, bundled Claude 2.1.258 / Haiku 4.5 | 48 / 516 | Two user messages; Read, Write, Bash success/failure, follow-up Read; live unfinished-tool prefix |
| `codex-basic-2026-09-12` | Codex 0.154.0 app-server / GPT-5.6-Luna, low effort | 58 / 66 | Same scenario, with code-mode `exec` and nested command/file notifications |

Each directory contains a required `manifest.json`, `native.jsonl`, and
`live.jsonl`. The manifest records source revision, versions, requested prompts,
model, platform, seams, redactions, missing coverage, and hand-reviewed semantic
expectations. The prompts and observed tool results determine the expected facts;
they are not compiler snapshots. Repeated events and provider IDs are retained.
The initial native workspace contained `notes.txt` with `alpha\nbeta\n` and a
README identifying it as disposable. No media/ancestor/child sidecars are needed.

`native.jsonl` is the complete selected provider file at the capture checkpoint
after both user messages. Later provider shutdown metadata is outside that snapshot.
`live.jsonl` contains **all records attributed to that session** by YA's
`LOG_SDK_MESSAGES` logger, in recorded order, with its `_ts`, `_sid`, `_provider`
and `_rawSource` envelope removed. Provider timestamps remain. The logger sits
before `ClaudeProvider.convertMessage` and
`CodexProvider.convertNotificationToSDKMessages`.

The capture is not a full wire recording: Codex requests/responses and startup
notifications attributed to an unknown session are absent. No browser viewer
was attached, so this does not establish viewer-demand delta delivery. The
adapter replay passes recorded events through production conversion,
normalization, augmentation, and transcript compilation; it does not exercise
the provider process/session loop, browser micro-delta accumulation, or transport
authentication. Human input is verified in native history, not manufactured as
provider output to make the live paths match.

## Replay and coverage

```sh
pnpm --dir packages/server exec vitest run test/captured-provider.test.ts
pnpm tools:typecheck
```

Normal `pnpm test` discovers these tests and normal `pnpm typecheck` includes the
fixture helper/importer. Each recording is limited to 512,000 bytes; the initial
four JSONL files total 269,033 bytes. The thirteen tests take approximately
205 ms of test time (about 1.2 seconds including startup) on the capture Mac.
Negative controls prove missing-file, broken-pairing, and rich-to-raw failures.

The original Codex native failure-status discrepancy is repaired: both paths
must mark the exit-code-7 command failed. All assertions now pass normally.
Explicitly synthetic mutations of the recording verify conservative association
of native execution metadata and rejection of misleading printed JSON. The
recordings themselves remain unchanged. A live Codex Edit has partial input
while its native patch is rich; both retain supported presentation. Cross-path
equality of all metadata is not asserted.

Still absent: media, permission/user-input requests, plan/question tools,
subagents/sidecars, detached polling, cold provider resume/fork, compaction,
disconnect/duplicate delivery, unknown API variants, multi-server identity and
issue-discovery-disabled data. Follow-up within the same running session is
captured; it is not a provider cold-resume test. Mounted/browser/native UI and
Linux/Windows provider-process coverage remain separate. This is a useful
first input corpus for experimental API design, not completion of tactical 127.

## Capture and refresh recipe

1. Create a disposable directory outside the YA checkout containing the small
   files above. Use a fresh `YEP_DATA_DIR` and unused `PORT`, with
   `LOG_SDK_MESSAGES=true` and `AUTH_DISABLED=true` for this local capture server.
   Launch the server with `pnpm --dir packages/server dev`.
   Profiles isolate YA data but still share provider credentials/history unless
   provider-specific directories are separately configured. Do not copy auth
   files into fixture output or switch subscription auth to metered API keys.
2. Submit the manifest's first request to
   `POST /api/projects/<base64url-project-path>/sessions`, with JSON and
   `X-Yep-Anywhere: true`. Select the explicit inexpensive model; never use
   `default`/`best` for a paid capture. After completion, submit the second
   message to `POST /api/sessions/<actual-session-id>/messages`.
   Claude can replace YA's temporary session ID: use the SDK init/result ID.
3. Wait for the second completion. Freeze private copies of **only that
   session's** native JSONL and the raw log before importing; providers can
   append shutdown metadata later. Claude uses `<Claude config>/projects/<encoded-project>/<id>.jsonl`;
   Codex uses `<Codex home>/sessions/YYYY/MM/DD/rollout-...-<id>.jsonl`.
   Record the actual bundled/runtime versions; the standalone Claude binary on
   this machine was 2.1.238 but the SDK used 2.1.258. Copy any required sidecars
   for future scenarios explicitly; the importer does not discover them.
4. Prepare a private import config outside the repository, then run:

   ```sh
   pnpm exec tsx packages/server/scripts/import-provider-capture.ts /absolute/private-import.json
   ```

   Config shape:

   ```json
   {
     "provider": "claude",
     "sessionId": "the-actual-provider-session-id",
     "nativeFile": "/absolute/selected-native.jsonl",
     "rawLog": "/absolute/isolated-data/logs/sdk-raw.jsonl",
     "outputDirectory": "/absolute/new-capture-directory",
     "replacements": [
       { "from": "/actual/disposable/project", "to": "/fixture/project" },
       { "from": "exact private injected text", "to": "[redacted capture environment]" }
     ]
   }
   ```

   This is a literal replacement importer, **not an automatic privacy filter**.
   Replacements apply to string values and path-bearing dictionary keys across
   both files, longest first. Preserve field names/types, arrays, null versus
   omission, IDs, order and tool joins; the supplied mapping must not target
   protocol field names. File-change map keys must follow the same path mapping.
   Keep the private mapping out of Git. Review injected system/developer text,
   Claude attachments/prompt snapshots/hook output, Codex world-state metadata,
   machine paths, hostnames, server inventories, and credential-like fields.
   Preserve classification markers such as `<environment_context>` and
   `# AGENTS.md instructions ... <INSTRUCTIONS>` when redacting their contents.
   Do not redact synthetic task text, tool inputs/results or error evidence.
5. Review output before publishing it. Add the manifest and independent facts;
   rerun production reader/adapter tests **after** sanitization. Check no private
   paths/tokens remain and no relationship was broken. Do not call reconstructed
   or synthetic additions real capture evidence. Keep old version fixtures when
   refreshing; use a new directory. Stop only the capture server/processes and
   retain raw evidence privately according to the local capture's needs.
