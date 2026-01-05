# External Session Live Updates

## Current State

External sessions (detected via `ExternalSessionTracker`) show the warning banner and status badge correctly, but **message content does not update live**.

### What works:
- **Status changes** (idle → external → idle) stream via `session-status-changed` SSE events
- **Session list** auto-refreshes when files change (`useSessions.ts` handles this)
- **Owned sessions** get live message updates via `/api/sessions/{id}/stream`

### What's missing:
- **External session content** (messages) don't live-update in the detail view

## Proposed Fix

In `useSession.ts`, add file change handling similar to `useSessions.ts`:

1. Subscribe to `onFileChange` events from `useFileActivity`
2. When a file change matches the current sessionId and `status.state !== "owned"`:
   - Debounce (500ms)
   - Refetch session via `api.getSession()`
3. Update messages state with new data

### Key code changes:

```typescript
// In useSession.ts

const handleFileChange = useCallback((event: FileChangeEvent) => {
  // Only care about session files
  if (event.fileType !== "session") return;

  // Check if file matches current session
  if (!event.relativePath.includes(sessionId)) return;

  // Skip if we own the session (we get updates via SSE stream)
  if (status.state === "owned") return;

  // Debounced refetch
  debouncedFetch();
}, [sessionId, status.state]);

useFileActivity({
  onSessionStatusChange: handleSessionStatusChange,
  onFileChange: handleFileChange,  // Add this
});
```

## Considerations

- **Performance**: Refetching reads the entire session from disk. Fine for now, could optimize later with incremental reads.
- **Debouncing**: 500ms debounce prevents hammering the API during rapid writes.
- **Race condition**: If user sends message while external session is active, the refetch will include their message too (desired behavior).
