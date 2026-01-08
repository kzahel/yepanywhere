# OpenCode Permission API Research

Research findings on how OpenCode handles tool approvals and dynamic permission mode switching.

## Summary

OpenCode has a full permission system with SSE events for approval requests and HTTP endpoints for responding. This enables Yep Anywhere to intercept and proxy tool approvals through our unified UI.

## Permission Configuration

Permissions are set via `opencode.json` in the project directory:

```json
{
  "permission": {
    "*": "ask",
    "read": "ask",
    "edit": "ask",
    "bash": "ask",
    "glob": "ask",
    "grep": "ask"
  }
}
```

### Permission Actions
- `"allow"` - Auto-approve, no user prompt
- `"ask"` - Emit `permission.asked` event and wait for response
- `"deny"` - Block the operation entirely

### Important: OpenCode Defaults

OpenCode has built-in defaults that must be explicitly overridden:
- `read: allow` (default)
- `glob: allow` (default)
- `grep: allow` (default)

To require approval for all tools, you must explicitly set each one to `"ask"`.

## SSE Events

### `permission.asked`

Emitted when a tool needs approval:

```json
{
  "type": "permission.asked",
  "properties": {
    "id": "per_b9ec973f7001...",
    "sessionID": "ses_46136cf80ffe...",
    "permission": "read",
    "patterns": ["/path/to/file.txt"],
    "metadata": {},
    "always": ["*"],
    "tool": {
      "messageID": "msg_b9ec956c2001...",
      "callID": "call_4ee15a1bea91..."
    }
  }
}
```

Key fields:
- `id` - Unique permission request ID for replying
- `permission` - Tool type (read, edit, bash, glob, grep, etc.)
- `patterns` - File paths or command patterns
- `always` - Suggested patterns for "always approve" option
- `tool.callID` - Links to the tool_use block

## HTTP Endpoints

### `GET /permission`

List all pending permission requests across sessions:

```bash
curl http://127.0.0.1:14200/permission
```

Response:
```json
[
  {
    "id": "per_...",
    "sessionID": "ses_...",
    "permission": "read",
    "patterns": ["/path/to/file"],
    "metadata": {},
    "always": ["*"],
    "tool": { "messageID": "...", "callID": "..." }
  }
]
```

### `POST /permission/:id/reply`

Respond to a permission request:

```bash
curl -X POST http://127.0.0.1:14200/permission/per_xxx/reply \
  -H "Content-Type: application/json" \
  -d '{"reply": "once"}'
```

Request body:
```json
{ "reply": "once" | "always" | "reject" }
```

Reply options:
- `"once"` - Approve this specific request only
- `"always"` - Approve and cache pattern for future matching requests in this session
- `"reject"` - Deny the request

Response: `200 OK` with `true` on success.

### `PATCH /config`

Update configuration at runtime (including permissions):

```bash
curl -X PATCH http://127.0.0.1:14200/config \
  -H "Content-Type: application/json" \
  -d '{"permission": {"read": "allow", "edit": "ask"}}'
```

This allows dynamic permission mode switching without restarting the session.

## Mapping Yep Anywhere Modes to OpenCode Permissions

| Yep Anywhere Mode | OpenCode Permission Config |
|-------------------|---------------------------|
| `default` | `read: allow, glob: allow, grep: allow, edit: ask, bash: ask, *: ask` |
| `acceptEdits` | `read: allow, edit: allow, glob: allow, grep: allow, bash: ask, *: ask` |
| `plan` | `read: allow, glob: allow, grep: allow, edit: deny, bash: deny, *: ask` |
| `bypassPermissions` | `*: allow` |

## Implementation Notes

### Runtime Mode Switching

To switch permission modes mid-session:
1. Call `PATCH /config` with new permission settings
2. New settings take effect for subsequent tool calls
3. Pending approval requests continue with their original settings

### Approval Flow Integration

To proxy OpenCode approvals through Yep Anywhere:
1. Watch SSE stream for `permission.asked` events
2. Convert to our `ToolApprovalRequest` format
3. Present to user via our UI
4. Call `POST /permission/:id/reply` with user's choice

### Key Differences from Claude SDK

| Aspect | Claude SDK | OpenCode |
|--------|-----------|----------|
| Permission callback | `canUseTool` function | SSE events + HTTP reply |
| Mode granularity | 4 preset modes | Per-tool configuration |
| "Always" approval | N/A | Session-scoped pattern caching |
| Runtime switching | Via callback state | Via `PATCH /config` |

## Test File

See `packages/server/test/e2e/opencode-permissions.e2e.test.ts` for working E2E test demonstrating:
- Starting OpenCode with `"*": "ask"` config
- Receiving `permission.asked` SSE events
- Approving via `POST /permission/:id/reply`

Run with: `OPENCODE_PERMISSION_TESTS=true FOREGROUND=1 pnpm test:e2e`

## References

- [OpenCode Permissions Docs](https://opencode.ai/docs/permissions/)
- [OpenCode GitHub - Permission System](https://github.com/sst/opencode/blob/dev/packages/opencode/src/permission/index.ts)
- Task doc: `docs/tasks/2026-01-08-opencode-permission-integration.md`
