# Worker Pool with Queue for Constrained Environments

## Overview

Add worker pool management to the Supervisor with configurable `maxWorkers` limit, request queuing, and idle worker preemption. Designed for resource-constrained environments (e.g., VM on Android phone) where only 1-2 concurrent Claude processes are practical.

## Phases

### Phase 1: Core Queue Implementation (Server)
- New `WorkerQueue` class
- Supervisor modifications for capacity checking and queue processing
- Unit tests

### Phase 2: API Endpoints
- Queue status endpoints
- Cancel endpoint
- Modified session endpoints to return 202 when queued

### Phase 3: SSE Events
- Queue position events via EventBus
- Client can track queue status in real-time

### Phase 4: Safe Restart Indicator
- Track if server has active work via SSE events
- UI shows "unsafe to restart" warning in reload banner
- Integrates with existing `useReloadNotifications` hook

---

## Phase 1: Core Queue Implementation

### New File: `packages/server/src/supervisor/WorkerQueue.ts`

```typescript
interface QueuedRequest {
  id: string;                    // UUID
  type: "new-session" | "resume-session";
  projectPath: string;
  projectId: UrlProjectId;
  sessionId?: string;            // For resume requests
  message: UserMessage;
  permissionMode?: PermissionMode;
  queuedAt: Date;
  resolve: (result: QueuedRequestResult) => void;
}

type QueuedRequestResult =
  | { status: "started"; process: Process }
  | { status: "cancelled"; reason: string };
```

**Methods:**
- `enqueue(params)` → `{ queueId, position, promise }`
- `dequeue()` → `QueuedRequest | undefined`
- `cancel(queueId)` → `boolean`
- `findBySessionId(sessionId)` → consolidate multiple resume requests
- `getQueueInfo()` → for API responses
- `getPosition(queueId)` → number | undefined

### Modify: `packages/server/src/supervisor/types.ts`

Add constants and types:
```typescript
export const IDLE_PREEMPT_THRESHOLD_MS = 10 * 1000; // 10 seconds

export interface QueuedRequestInfo {
  id: string;
  type: "new-session" | "resume-session";
  projectId: UrlProjectId;
  sessionId?: string;
  position: number;
  queuedAt: string;
}

export interface QueuedResponse {
  queued: true;
  queueId: string;
  position: number;
}
```

### Modify: `packages/server/src/supervisor/Supervisor.ts`

**New options:**
```typescript
interface SupervisorOptions {
  // ... existing ...
  maxWorkers?: number;              // 0 = unlimited (default)
  idlePreemptThresholdMs?: number;  // default 10s
}
```

**New private fields:**
- `maxWorkers: number`
- `idlePreemptThresholdMs: number`
- `workerQueue: WorkerQueue`

**New private methods:**
- `isAtCapacity()` → boolean
- `findPreemptableWorker()` → Process | undefined (idle > threshold, longest first)
- `preemptWorker(process, forQueueId)` → void
- `processQueue()` → called when worker becomes available

**Modified methods:**
- `startSession()` → returns `Process | QueuedResponse`
- `resumeSession()` → returns `Process | QueuedResponse`
- `unregisterProcess()` → calls `processQueue()` after cleanup

**New public methods:**
- `cancelQueuedRequest(queueId)` → boolean
- `getQueueInfo()` → QueuedRequestInfo[]
- `getQueuePosition(queueId)` → number | undefined

**Key logic:**
1. If not at capacity → start immediately
2. If at capacity, find preemptable worker (idle > 10s) → preempt and start
3. Otherwise → queue and return `{ queued: true, queueId, position }`

**Preemption rules:**
- Only preempt if `state.type === "idle"` (NOT `waiting-input`)
- Preempt longest-idle worker first
- Call `process.abort()` then `unregisterProcess()`

### Modify: `packages/server/src/config.ts`

```typescript
interface Config {
  // ... existing ...
  maxWorkers: number;                    // env: MAX_WORKERS, default 0
  idlePreemptThresholdSeconds: number;   // env: IDLE_PREEMPT_THRESHOLD, default 10
}
```

### New Test File: `packages/server/test/workerQueue.test.ts`

Test scenarios:
1. Basic enqueue/dequeue FIFO
2. Cancel removes from queue and resolves with cancelled
3. findBySessionId returns existing entry
4. Position updates after dequeue
5. Empty queue returns undefined

### Modify: `packages/server/test/supervisor.test.ts`

Add tests:
1. `maxWorkers: 2` - third session gets queued
2. Preemption - idle worker > 10s gets preempted
3. No preemption if workers are `waiting-input`
4. Queue processes when worker completes
5. Cancel queued request
6. `maxWorkers: 0` - unlimited (backwards compat)

---

## Phase 2: API Endpoints

### Modify: `packages/server/src/routes/sessions.ts`

**POST /api/projects/:projectId/sessions**
- Return 202 with `{ queued, queueId, position }` when queued
- Return 200 with `{ sessionId, processId, ... }` when started

**POST /api/sessions/:sessionId/messages** (resume path)
- Same 202/200 pattern

### New routes in sessions.ts or new queue.ts:

```typescript
// GET /api/queue
// Returns: { queue: QueuedRequestInfo[] }

// GET /api/queue/:queueId
// Returns: { queueId, position } or 404

// DELETE /api/queue/:queueId
// Returns: { cancelled: true } or 404
```

---

## Phase 3: SSE Events

### Modify: `packages/server/src/watcher/EventBus.ts`

New event types:
```typescript
interface QueueRequestAddedEvent {
  type: "queue-request-added";
  queueId: string;
  sessionId?: string;
  projectId: UrlProjectId;
  position: number;
  timestamp: string;
}

interface QueuePositionChangedEvent {
  type: "queue-position-changed";
  queueId: string;
  sessionId?: string;
  position: number;
  timestamp: string;
}

interface QueueRequestRemovedEvent {
  type: "queue-request-removed";
  queueId: string;
  sessionId?: string;
  reason: "started" | "cancelled";
  timestamp: string;
}
```

Add to `BusEvent` union type.

### Modify: WorkerQueue

Emit events via EventBus when:
- Request added → `queue-request-added`
- Position changes (after dequeue) → `queue-position-changed` for all remaining
- Request removed → `queue-request-removed`

---

## Files to Modify

| File | Changes |
|------|---------|
| `packages/server/src/supervisor/WorkerQueue.ts` | **NEW** - Queue implementation |
| `packages/server/src/supervisor/types.ts` | Add queue types, constants |
| `packages/server/src/supervisor/Supervisor.ts` | Add worker pool logic |
| `packages/server/src/config.ts` | Add maxWorkers, preempt threshold |
| `packages/server/src/app.ts` | Pass new config to Supervisor |
| `packages/server/src/index.ts` | Pass new config |
| `packages/server/src/routes/sessions.ts` | Return 202 when queued, add queue endpoints |
| `packages/server/src/watcher/EventBus.ts` | Add queue event types |
| `packages/server/test/workerQueue.test.ts` | **NEW** - Queue unit tests |
| `packages/server/test/supervisor.test.ts` | Add worker pool tests |

---

## Edge Cases

1. **Process goes idle while queue has requests** - `processQueue()` called after state change to idle (need to add listener)

2. **Multiple messages to same session while queued** - `findBySessionId()` returns existing entry; messages accumulate in session's MessageQueue once started

3. **Server restart** - Queue is in-memory, lost on restart. This is acceptable per user requirement.

4. **Preemption during tool approval** - Never preempt `waiting-input` state

5. **Race between queue cancel and start** - Queue operations are synchronous, so cancel either succeeds before start or fails after

---

## Config Example

```bash
# For constrained environment (Android VM)
MAX_WORKERS=1
IDLE_PREEMPT_THRESHOLD=10
IDLE_TIMEOUT=60  # shorter timeout too
```

---

## Phase 4: Safe Restart Indicator

### Overview

Add a visual indicator that warns users when restarting the server would interrupt active work. This integrates with the existing reload notification system (`useReloadNotifications` hook) and displays a warning banner when the server has active workers.

### Design Goals

1. **Non-blocking** - Indicator is informational only; users can still restart
2. **Real-time** - Updates via SSE as workers start/stop
3. **Integrated** - Reuses existing reload banner pattern
4. **Simple** - Minimal server changes, most logic client-side

### Server Changes

#### 1. New SSE Event: `worker-activity-changed`

**Modify: `packages/server/src/watcher/EventBus.ts`**

```typescript
/** Event emitted when worker activity changes (for safe restart indicator) */
export interface WorkerActivityEvent {
  type: "worker-activity-changed";
  activeWorkers: number;
  queueLength: number;
  /** True if any worker is running or waiting-input (unsafe to restart) */
  hasActiveWork: boolean;
  timestamp: string;
}

// Add to BusEvent union type
export type BusEvent =
  | ... existing ...
  | WorkerActivityEvent;
```

#### 2. Emit Events from Supervisor

**Modify: `packages/server/src/supervisor/Supervisor.ts`**

Add private method to emit worker activity:
```typescript
private emitWorkerActivity(): void {
  if (!this.eventBus) return;

  const hasActiveWork = Array.from(this.processes.values()).some(
    (p) => p.state.type === "running" || p.state.type === "waiting-input"
  );

  const event: WorkerActivityEvent = {
    type: "worker-activity-changed",
    activeWorkers: this.processes.size,
    queueLength: this.workerQueue.length,
    hasActiveWork,
    timestamp: new Date().toISOString(),
  };
  this.eventBus.emit(event);
}
```

Call `emitWorkerActivity()` in:
- `registerProcess()` - after adding process
- `unregisterProcess()` - after removing process
- Process state change subscription (in `registerProcess`) - when state changes

#### 3. New API Endpoint for Initial State

**Modify: `packages/server/src/routes/sessions.ts`** (or new `status.ts`)

```typescript
// GET /api/status/workers
// Returns: { activeWorkers, queueLength, hasActiveWork }
router.get("/api/status/workers", (req, res) => {
  const status = supervisor.getWorkerPoolStatus();
  const hasActiveWork = supervisor.getAllProcesses().some(
    (p) => p.state.type === "running" || p.state.type === "waiting-input"
  );
  res.json({
    ...status,
    hasActiveWork,
  });
});
```

### Client Changes

#### 1. Extend `useReloadNotifications` Hook

**Modify: `packages/client/src/hooks/useReloadNotifications.ts`**

Add state for worker activity:
```typescript
interface WorkerActivity {
  activeWorkers: number;
  queueLength: number;
  hasActiveWork: boolean;
}

// In hook:
const [workerActivity, setWorkerActivity] = useState<WorkerActivity>({
  activeWorkers: 0,
  queueLength: 0,
  hasActiveWork: false,
});
```

Fetch initial state on mount (after dev status check succeeds):
```typescript
// Fetch initial worker activity state
fetch(`${API_BASE}/status/workers`)
  .then((res) => res.ok ? res.json() : null)
  .then((data: WorkerActivity | null) => {
    if (data) setWorkerActivity(data);
  })
  .catch(() => {});
```

Add SSE event listener:
```typescript
const handleWorkerActivity = (event: MessageEvent) => {
  try {
    const data = JSON.parse(event.data) as WorkerActivity;
    setWorkerActivity(data);
  } catch {}
};

es.addEventListener("worker-activity-changed", handleWorkerActivity);
```

Return `workerActivity` and computed `unsafeToRestart`:
```typescript
return {
  // ... existing ...
  /** Current worker activity for safe restart indicator */
  workerActivity,
  /** True if restarting would interrupt active work */
  unsafeToRestart: workerActivity.hasActiveWork,
};
```

#### 2. Modify Reload Banner Display

**Modify: `packages/client/src/App.tsx`**

Show warning when backend reload is pending AND work is active:
```tsx
const { pendingReloads, unsafeToRestart, workerActivity, ... } = useReloadNotifications();

// In render:
{pendingReloads.backend && (
  <ReloadBanner
    target="backend"
    onReload={reloadBackend}
    onDismiss={() => dismiss("backend")}
    unsafeToRestart={unsafeToRestart}
    activeWorkers={workerActivity.activeWorkers}
  />
)}
```

#### 3. Update ReloadBanner Component

**Modify: `packages/client/src/components/ReloadBanner.tsx`**

```tsx
interface Props {
  target: "backend" | "frontend";
  onReload: () => void;
  onDismiss: () => void;
  unsafeToRestart?: boolean;
  activeWorkers?: number;
}

export function ReloadBanner({
  target,
  onReload,
  onDismiss,
  unsafeToRestart,
  activeWorkers
}: Props) {
  const label = target === "backend" ? "Server" : "Frontend";

  return (
    <div className={`reload-banner ${unsafeToRestart ? "reload-banner-warning" : ""}`}>
      <span className="reload-banner-message">
        {label} code changed - reload to see changes
      </span>
      {unsafeToRestart && target === "backend" && (
        <span className="reload-banner-warning-text">
          ⚠️ {activeWorkers} active session{activeWorkers !== 1 ? "s" : ""} will be interrupted
        </span>
      )}
      <button
        type="button"
        className={`reload-banner-button reload-banner-button-primary ${
          unsafeToRestart ? "reload-banner-button-danger" : ""
        }`}
        onClick={onReload}
      >
        {unsafeToRestart ? "Reload Anyway" : `Reload ${label}`}
      </button>
      <button
        type="button"
        className="reload-banner-button"
        onClick={onDismiss}
      >
        Dismiss
      </button>
      <span className="reload-banner-shortcut">Ctrl+Shift+R</span>
    </div>
  );
}
```

#### 4. Add CSS Styles

**Modify: `packages/client/src/styles/index.css`**

```css
.reload-banner-warning {
  background: var(--error-bg, #fef2f2);
  border-color: var(--error-border, #fecaca);
}

.reload-banner-warning-text {
  color: var(--error-color, #dc2626);
  font-weight: 500;
  margin-left: 0.5rem;
}

.reload-banner-button-danger {
  background: var(--error-color, #dc2626);
  border-color: var(--error-color, #dc2626);
}

.reload-banner-button-danger:hover {
  background: var(--error-hover, #b91c1c);
}
```

### Files to Modify

| File | Changes |
|------|---------|
| `packages/server/src/watcher/EventBus.ts` | Add `WorkerActivityEvent` type |
| `packages/server/src/supervisor/Supervisor.ts` | Add `emitWorkerActivity()`, call on state changes |
| `packages/server/src/routes/sessions.ts` | Add `GET /api/status/workers` endpoint |
| `packages/client/src/hooks/useReloadNotifications.ts` | Track worker activity, add SSE listener |
| `packages/client/src/App.tsx` | Pass `unsafeToRestart` to `ReloadBanner` |
| `packages/client/src/components/ReloadBanner.tsx` | Show warning state, change button text |
| `packages/client/src/styles/index.css` | Add warning/danger styles |

### Testing

1. **Manual testing:**
   - Start server in dev mode with manual reload enabled
   - Start a session that takes time (e.g., complex task)
   - Modify server code → banner appears
   - Verify banner shows "⚠️ 1 active session will be interrupted"
   - Verify button says "Reload Anyway"
   - Wait for session to complete → warning disappears
   - Verify button returns to "Reload Server"

2. **Unit tests (optional):**
   - Test `emitWorkerActivity()` emits correct counts
   - Test event emission on register/unregister

### Edge Cases

1. **Multiple active workers** - Show count in warning message
2. **SSE disconnected** - Fall back to last known state (safe default)
3. **Dev mode not active** - Hook returns `unsafeToRestart: false` (no API calls made)
4. **Queued requests** - Include queue length in activity info for future use

### Future Enhancements (Out of Scope)

- Add confirmation dialog before reload when unsafe
- Show list of affected sessions in tooltip
- Track which specific sessions are affected
- Add "Force Stop All" button for emergencies
