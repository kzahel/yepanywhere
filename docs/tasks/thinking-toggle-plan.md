# Plan: Add Thinking Mode Dirty Flag to Process

## Problem

When a user toggles thinking mode in the UI, the setting is read at message-send time. However, if a process already exists for the session, the message is queued to the existing process which was created with the **old** thinking settings. The new thinking preference is ignored until the process is terminated and restarted.

## Solution

Add a "config dirty" flag to the Process class. When resuming a session, compare the requested `maxThinkingTokens` with what the process was created with. If they differ, mark the process as dirty. When the process becomes idle (waiting for input), check the dirty flag and terminate it so the next message spawns a fresh process with the correct settings.

## Implementation Steps

### 1. Store thinking config on Process (`packages/server/src/supervisor/Process.ts`)

Add a field to track the `maxThinkingTokens` the process was created with:

```typescript
/** The maxThinkingTokens this process was created with (undefined = thinking disabled) */
private _maxThinkingTokens: number | undefined;

/** Whether the process config is stale and should be terminated when idle */
private _configDirty = false;
```

Add to constructor options and store in constructor.

Add getters:
- `get maxThinkingTokens(): number | undefined`
- `get configDirty(): boolean`

Add method to mark dirty:
- `markConfigDirty(): void` - sets `_configDirty = true`

### 2. Update ProcessOptions type (`packages/server/src/supervisor/types.ts`)

Add `maxThinkingTokens?: number` to `ProcessOptions` interface.

### 3. Pass maxThinkingTokens when creating Process (`packages/server/src/supervisor/Supervisor.ts`)

In `startProviderSession`, `startRealSession`, etc., pass `maxThinkingTokens` in the ProcessOptions.

### 4. Check and mark dirty on resume (`packages/server/src/supervisor/Supervisor.ts`)

In `resumeSession`, when reusing an existing process (lines ~589-605):

```typescript
// Check if thinking settings changed
const requestedThinking = modelSettings?.maxThinkingTokens;
if (existingProcess.maxThinkingTokens !== requestedThinking) {
  existingProcess.markConfigDirty();
}
```

### 5. Terminate dirty process when idle (`packages/server/src/supervisor/Process.ts`)

In the idle state transition (when process finishes a turn and waits for input):

```typescript
if (this._configDirty) {
  // Config changed - terminate so next message gets fresh process
  this.terminate("config_changed");
  return;
}
```

This should happen in `setState` or wherever the process transitions to waiting/idle state.

### 6. Handle termination reason in Supervisor

The Supervisor's `unregisterProcess` or the process event handlers should recognize `config_changed` as a clean termination (not an error).

## Files to Modify

1. `packages/server/src/supervisor/types.ts` - Add `maxThinkingTokens` to ProcessOptions
2. `packages/server/src/supervisor/Process.ts` - Add field, getter, dirty flag, termination on idle
3. `packages/server/src/supervisor/Supervisor.ts` - Pass maxThinkingTokens to Process, check on resume

## Testing Considerations

- Unit test: Process with thinking enabled, mark dirty, verify terminates on idle
- Integration test: Send message with thinking=on, toggle to off, send another message, verify process restarted
- Edge case: Process mid-turn when marked dirty should complete turn before terminating

## Alternative Considered

Could terminate immediately when marked dirty if process is already idle. This is slightly more complex to detect reliably, so deferring termination to the idle transition is simpler.
