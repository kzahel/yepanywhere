# Integrate OpenCode Permission Model with YepAnywhere Mode Selector

## Overview

This task describes the integration of OpenCode's granular permission system with YepAnywhere's existing mode selector UI, providing users with fine-grained control over tool permissions while maintaining the familiar mode interface.

## Current State Analysis

### YepAnywhere Mode System
- **4 permission modes** in `packages/client/src/components/ModeSelector.tsx`:
  - `default`: Ask before edits - Auto-approves read-only tools, asks for mutating tools
  - `acceptEdits`: Edit automatically - Auto-approves file editing tools, asks for others  
  - `plan`: Plan mode - Auto-approves read-only tools, asks for others (planning/analysis mode)
  - `bypassPermissions`: Bypass permissions - Auto-approves all tools (full autonomous mode)

### OpenCode Permission System
- **Granular tool-level permissions** (`"allow"`, `"ask"`, `"deny"`)
- Per-tool configuration via `opencode.json` permission object
- Supports wildcard patterns and object-based granular rules

## Implementation Plan

### Phase 1: Core Permission Mapping

#### 1.1 Add Translation Layer to OpenCodeProvider

**File:** `packages/server/src/sdk/providers/opencode.ts`

Add method to translate YepAnywhere modes to OpenCode permissions:

```typescript
private translatePermissionMode(mode: PermissionMode): Record<string, string> {
  switch (mode) {
    case "default":
      return {
        "read": "allow",
        "edit": "ask", 
        "bash": "ask",
        "glob": "allow",
        "grep": "allow",
        "*": "ask"
      };
    case "acceptEdits":
      return {
        "read": "allow",
        "edit": "allow",
        "bash": "ask", 
        "webfetch": "allow",
        "*": "ask"
      };
    case "plan":
      return {
        "read": "allow",
        "edit": "deny",
        "bash": "deny",
        "glob": "allow",
        "grep": "allow",
        "websearch": "allow",
        "*": "ask"
      };
    case "bypassPermissions":
      return {
        "*": "allow"
      };
  }
}
```

#### 1.2 Extend Session Creation

Modify `startSession()` method to inject permissions during OpenCode server initialization:

```typescript
const permissions = this.translatePermissionMode(options.permissionMode || "default");
const opencodeConfig = {
  permission: permissions,
  // ... existing config
};
```

### Phase 2: Runtime Mode Switching

#### 2.1 Extend Agent Provider Interface

**File:** `packages/server/src/sdk/providers/types.ts`

Add runtime permission mode support to `AgentSession`:

```typescript
interface AgentSession {
  // ... existing methods
  updatePermissionMode?(mode: PermissionMode): Promise<void>;
}
```

#### 2.2 Implement Runtime Updates

Add to `OpenCodeProvider` class:

```typescript
async updatePermissionMode(sessionId: string, mode: PermissionMode): Promise<void> {
  const permissions = this.translatePermissionMode(mode);
  // Send config update to running opencode serve process
  await fetch(`${this.getBaseUrl(sessionId)}/config`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ permission: permissions })
  });
}
```

#### 2.3 Wire Up to API

**File:** `packages/server/src/app.ts`

Add endpoint to handle permission mode updates:

```typescript
app.put('/sessions/:sessionId/mode', async (req, res) => {
  const { mode } = req.body;
  const session = getSession(req.params.sessionId);
  if (session?.provider?.updatePermissionMode) {
    await session.provider.updatePermissionMode(req.params.sessionId, mode);
  }
  res.json({ success: true });
});
```

### Phase 3: UI Enhancements

#### 3.1 Update Process Information

**File:** `packages/client/src/components/ProcessInfoModal.tsx`

Add OpenCode permission state display:

```typescript
// Add section for permission details when provider is "opencode"
{provider === "opencode" && (
  <Section title="OpenCode Permissions">
    <InfoRow label="Current Mode" value={getCurrentModeDisplay()} />
    <InfoRow label="Permission State" value={getPermissionStateDisplay()} />
  </Section>
)}
```

#### 3.2 Enhance Mode Selector

**File:** `packages/client/src/components/ModeSelector.tsx`

Add provider-specific descriptions for OpenCode modes:

```typescript
const getModeDescription = (mode: PermissionMode, provider?: string) => {
  if (provider === "opencode") {
    switch (mode) {
      case "default": return "Read-only auto, edits require approval";
      case "acceptEdits": return "File edits auto, commands require approval";
      case "plan": return "Read-only and analysis mode";
      case "bypassPermissions": return "Full autonomous access";
    }
  }
  // ... existing descriptions
};
```

### Phase 4: Advanced Features

#### 4.1 Custom Permission Profiles

Add support for custom permission profiles beyond the 4 standard modes:

```typescript
interface PermissionProfile {
  name: string;
  description: string;
  permissions: Record<string, string>;
}

const customProfiles: PermissionProfile[] = [
  {
    name: "read-only-plus",
    description: "Read + safe commands only",
    permissions: {
      "read": "allow",
      "bash": { "git *": "allow", "*": "deny" },
      "*": "deny"
    }
  }
];
```

#### 4.2 Permission Debug View

Create a debug component to show current OpenCode permission state:

**File:** `packages/client/src/components/PermissionDebugPanel.tsx`

Features:
- Real-time permission state display
- Tool-by-tool permission matrix
- Permission override suggestions
- Permission change history

## Testing Strategy

### Unit Tests
- Test permission translation mapping
- Test runtime permission updates
- Test API endpoint integration

### Integration Tests  
- Test full mode switching workflow
- Test permission enforcement with different modes
- Test concurrent session mode changes

### E2E Tests
- Test UI mode switching with OpenCode provider
- Test permission approval flows
- Test mode persistence across sessions

## Benefits

1. **Preserves Existing UX** - Users continue using familiar YepAnywhere modes
2. **Leverages OpenCode Granularity** - More precise tool-level control
3. **Provider-Agnostic** - Other providers can implement their own permission logic
4. **Runtime Flexibility** - Modes can be changed during active sessions
5. **Future-Proof** - Easy to extend with new modes or OpenCode features
6. **Enhanced Security** - Fine-grained control reduces risk exposure

## Migration Plan

1. **Phase 1** (Core mapping) - Implement basic permission translation
2. **Phase 2** (Runtime switching) - Add live mode updates
3. **Phase 3** (UI enhancements) - Improve user experience
4. **Phase 4** (Advanced features) - Add custom profiles and debugging

## Dependencies

- OpenCode permission API support (verify `/config` endpoint availability)
- OpenCode SSE event updates for permission changes
- Testing infrastructure for permission enforcement

## Success Criteria

- [ ] All 4 YepAnywhere modes map correctly to OpenCode permissions
- [ ] Runtime mode switching works for active sessions
- [ ] UI correctly reflects current permission state
- [ ] Permission enforcement matches expected behavior
- [ ] No regressions in existing mode functionality
- [ ] Comprehensive test coverage for new functionality

## Notes

- OpenCode's permission model is more granular than YepAnywhere's modes - this integration leverages that power while maintaining UI simplicity
- Consider adding permission "profiles" in the future for even more granular control
- Permission state should be synchronized across multiple clients via SSE events
- This integration serves as a template for other providers with permission systems