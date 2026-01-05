# Web Push Notifications Implementation

## Overview

Add web push notifications to claude-anywhere so users get notified on their phone/other devices when:
1. **High priority**: A session needs approval (tool-approval or user-question)
2. **Lower priority**: A session that was working has halted (went from running → idle)

The key insight: only send push when the user isn't actively engaged with the app. If they have a tab open and are interacting, SSE already handles it.

## Background Context

### Existing Infrastructure

**Server-side:**
- `EventBus` (`packages/server/src/watcher/EventBus.ts`) - Central pub/sub for all events
- `ProcessStateEvent` - Emitted when session state changes (running, waiting-input)
- `NotificationService` (`packages/server/src/notifications/NotificationService.ts`) - Tracks last-seen timestamps per session
- `SessionSeenEvent` - Broadcast when any client marks a session as seen
- Data stored in `~/.claude-anywhere/` directory

**Client-side:**
- `useEngagementTracking` hook - Tracks if user is actively engaged (focused + recent interaction within 30s)
- `useFileActivity` hook - Subscribes to SSE activity stream
- `useSSE` hook - Generic SSE connection management
- No service worker exists yet

**Key Events:**
```typescript
// From EventBus.ts
ProcessStateEvent: {
  type: "process-state-changed";
  sessionId: string;
  projectId: UrlProjectId;
  processState: "running" | "waiting-input";
  timestamp: string;
}

SessionSeenEvent: {
  type: "session-seen";
  sessionId: string;
  timestamp: string;
  messageId?: string;
}
```

### Web Push Architecture (VAPID)

Web Push uses VAPID (Voluntary Application Server Identification) keys:
- **Public key**: Shared with browser, used to encrypt push messages
- **Private key**: Server-only, used to sign push requests
- Keys are generated once and reused forever
- No external accounts needed (Google/Mozilla/Apple push services just relay encrypted payloads)

Flow:
1. Server generates VAPID key pair (one-time setup)
2. Client registers service worker
3. Client calls `pushManager.subscribe()` with VAPID public key
4. Client sends subscription endpoint to server
5. Server uses `web-push` library to send notifications
6. Service worker receives push, shows notification

### Notification Decision Logic

```
Session enters waiting-input state
          │
          ▼
    ┌─────────────────┐
    │ Any SSE client  │──── Yes ──► Check engagement
    │ connected?      │              │
    └─────────────────┘              ▼
          │                   ┌──────────────────┐
          │                   │ Client engaged?  │
          No                  │ (focus + recent  │
          │                   │  interaction)    │
          ▼                   └──────────────────┘
    Send push                        │
    notification              ┌──────┴──────┐
                              │             │
                             Yes           No
                              │             │
                              ▼             ▼
                         SSE handles   Send push
                         it (no push)  notification
```

---

## Phase 1: VAPID Key Setup Script

### Goal
Create `pnpm setup-vapid` command that generates and stores VAPID keys.

### Implementation

**Files to create:**
- `scripts/setup-vapid.ts` - Key generation script

**Files to modify:**
- `package.json` - Add setup-vapid script
- `packages/server/package.json` - Add `web-push` dependency

**Key storage location:** `~/.claude-anywhere/vapid.json`
```json
{
  "publicKey": "BNxR...",
  "privateKey": "Ux3...",
  "subject": "mailto:claude-anywhere@localhost"
}
```

### Verification
```bash
# Run the script
pnpm setup-vapid

# Verify keys were created
cat ~/.claude-anywhere/vapid.json | jq .

# Verify keys are valid format (base64url, correct lengths)
# Public key should be 65 bytes when decoded (uncompressed P-256 point)
# Private key should be 32 bytes when decoded

# Run again - should detect existing keys and not overwrite
pnpm setup-vapid
# Should output: "VAPID keys already exist at ~/.claude-anywhere/vapid.json"
```

**Automated test:** Create `scripts/setup-vapid.test.ts`
- Test key generation in temp directory
- Test idempotency (doesn't overwrite existing)
- Test key format validation

---

## Phase 2: Push Subscription Service (Server)

### Goal
Server-side service to store push subscriptions and send notifications.

### Implementation

**Files to create:**
- `packages/server/src/push/PushService.ts` - Core push notification service
- `packages/server/src/push/types.ts` - TypeScript types
- `packages/server/src/routes/push.ts` - API endpoints
- `packages/server/test/push/PushService.test.ts` - Unit tests

**API Endpoints:**
```
GET  /api/push/vapid-public-key  → { publicKey: string }
POST /api/push/subscribe         ← { subscription: PushSubscription, deviceId: string }
POST /api/push/unsubscribe       ← { deviceId: string }
GET  /api/push/subscriptions     → { subscriptions: SubscriptionInfo[] }
```

**Subscription storage:** `~/.claude-anywhere/push-subscriptions.json`
```json
{
  "version": 1,
  "subscriptions": {
    "device-abc123": {
      "endpoint": "https://fcm.googleapis.com/...",
      "keys": { "p256dh": "...", "auth": "..." },
      "createdAt": "2025-01-01T00:00:00Z",
      "userAgent": "Mozilla/5.0..."
    }
  }
}
```

### Verification
```bash
# Unit tests
pnpm -F server test -- --run test/push/PushService.test.ts

# Integration: Start server, hit endpoints
curl http://localhost:3400/api/push/vapid-public-key
# Should return { publicKey: "..." }

# Subscribe with mock subscription
curl -X POST http://localhost:3400/api/push/subscribe \
  -H "Content-Type: application/json" \
  -d '{"deviceId":"test-device","subscription":{"endpoint":"https://example.com","keys":{"p256dh":"test","auth":"test"}}}'

# Verify stored
cat ~/.claude-anywhere/push-subscriptions.json | jq .
```

**Automated tests:**
- Test subscription CRUD operations
- Test VAPID key loading (fails gracefully if not setup)
- Test subscription persistence across service restarts

---

## Phase 3: Service Worker + Client Subscription

### Goal
Client-side service worker that receives push events and manages subscription lifecycle.

### Implementation

**Files to create:**
- `packages/client/public/sw.js` - Service worker (must be plain JS, not TypeScript)
- `packages/client/src/hooks/usePushNotifications.ts` - React hook for push management
- `packages/client/src/components/PushNotificationToggle.tsx` - UI toggle component

**Files to modify:**
- `packages/client/src/pages/SettingsPage.tsx` - Add push notification settings
- `packages/client/src/api/client.ts` - Add push API methods

**Service Worker Events:**
```javascript
// sw.js
self.addEventListener('push', (event) => {
  const data = event.data.json();
  // Show notification (unless app is focused)
});

self.addEventListener('notificationclick', (event) => {
  // Handle approve/deny actions
  // Open app to session if clicked
});
```

**Device ID Generation:**
- Generate random UUID on first subscription
- Store in localStorage: `claude-anywhere-device-id`
- Reuse for all subscriptions from this browser

### Verification
```bash
# Build client and verify sw.js is in output
pnpm -F client build
ls packages/client/dist/sw.js

# E2E test: Register service worker
pnpm test:e2e -- --grep "service worker"
```

**Automated tests:**
- E2E test: Service worker registers successfully
- E2E test: Push permission prompt appears on toggle
- Unit test: `usePushNotifications` hook state management
- Unit test: Device ID generation and persistence

---

## Phase 4: Push on Pending Input

### Goal
Send push notification when a session enters `waiting-input` state and user isn't engaged.

### Implementation

**Files to modify:**
- `packages/server/src/supervisor/Supervisor.ts` - Hook into state change emission
- `packages/server/src/push/PushService.ts` - Add notification sending logic

**Files to create:**
- `packages/server/src/push/PushNotifier.ts` - Orchestrates when to send pushes

**Engagement Detection:**
The server needs to know if any client is engaged. Options:

1. **Heartbeat approach**: Clients send periodic "I'm engaged" pings
2. **Assume not engaged**: If no SSE client connected, definitely send push
3. **Client reports engagement**: On push receive, service worker checks if app is focused

Recommended: Option 3 (simplest, matches vision doc):
- Server always sends push when `waiting-input` occurs
- Service worker skips showing notification if app window is focused

**Push Payload:**
```typescript
interface PushPayload {
  type: "pending-input";
  sessionId: string;
  projectId: string;
  projectName: string;
  inputType: "tool-approval" | "user-question";
  summary: string; // e.g., "Run: npm install lodash"
  timestamp: string;
}
```

### Verification
```bash
# Unit test the notifier logic
pnpm -F server test -- --run test/push/PushNotifier.test.ts

# E2E test with mock push subscription
# 1. Subscribe a mock endpoint
# 2. Trigger waiting-input state
# 3. Verify push was sent to mock endpoint
```

**Automated tests:**
- Unit test: PushNotifier sends when state is waiting-input
- Unit test: Push payload format is correct
- E2E test: Full flow from state change to push send (use mock endpoint)
- E2E test: Service worker shows notification (Playwright with service worker)

---

## Phase 5: Notification Actions + Dismissal Sync

### Goal
- Approve/Deny directly from notification
- When user interacts on one device, dismiss notification on others

### Implementation

**Notification Actions:**
```javascript
// In sw.js
self.registration.showNotification(title, {
  body: "Claude wants to run: npm install",
  actions: [
    { action: "approve", title: "Approve" },
    { action: "deny", title: "Deny" }
  ],
  tag: `session-${sessionId}`, // For dismissal sync
  data: { sessionId, projectId }
});
```

**Action Handling:**
```javascript
self.addEventListener('notificationclick', (event) => {
  const { action } = event;
  const { sessionId } = event.notification.data;

  if (action === 'approve') {
    fetch(`/api/sessions/${sessionId}/approve`, { method: 'POST' });
  } else if (action === 'deny') {
    fetch(`/api/sessions/${sessionId}/deny`, { method: 'POST' });
  } else {
    // Clicked notification body - open the app
    clients.openWindow(`/session/${sessionId}`);
  }
  event.notification.close();
});
```

**Dismissal Sync:**
When session is no longer waiting-input (approved, denied, or user opened it):
1. Server sends a "dismiss" push to all subscriptions
2. Service worker closes notification with matching tag

```typescript
// New push type
interface DismissPushPayload {
  type: "dismiss";
  sessionId: string;
}
```

### Verification
```bash
# E2E tests for notification actions
pnpm test:e2e -- --grep "notification actions"
```

**Automated tests:**
- E2E test: Click approve action → session approved
- E2E test: Click deny action → session denied
- E2E test: Click notification body → app opens to session
- E2E test: Dismissal sync - mark seen on one device, notification closes on other

---

## Phase 6: Session Halted Notification (Lower Priority)

### Goal
Notify when a session that was working for a while goes idle (completed or errored).

### Implementation

**Detection Logic:**
```typescript
// Track sessions that have been running
const runningSessionTimestamps = new Map<string, number>();

eventBus.subscribe((event) => {
  if (event.type === "process-state-changed") {
    if (event.processState === "running") {
      runningSessionTimestamps.set(event.sessionId, Date.now());
    } else {
      const startedAt = runningSessionTimestamps.get(event.sessionId);
      runningSessionTimestamps.delete(event.sessionId);

      // Only notify if it was running for > 30 seconds
      if (startedAt && Date.now() - startedAt > 30_000) {
        // Send "session halted" notification
      }
    }
  }
});
```

**Push Payload:**
```typescript
interface SessionHaltedPayload {
  type: "session-halted";
  sessionId: string;
  projectName: string;
  reason: "completed" | "error" | "idle";
  duration: number; // How long it was running
}
```

### Verification
```bash
pnpm -F server test -- --run test/push/SessionHaltedNotifier.test.ts
```

**Automated tests:**
- Unit test: Only notifies if session ran > 30s
- Unit test: Doesn't notify for quick tasks
- Unit test: Correct reason (completed vs error)

---

## Testing Strategy Summary

| Phase | Unit Tests | Integration Tests | E2E Tests |
|-------|------------|-------------------|-----------|
| 1 | Key format validation | Script idempotency | - |
| 2 | CRUD, persistence | API endpoints | - |
| 3 | Hook state | SW registration | Permission flow |
| 4 | Notifier logic | State→Push flow | Full notification |
| 5 | - | Action endpoints | Click actions |
| 6 | Duration tracking | - | - |

## File Structure After Implementation

```
scripts/
  setup-vapid.ts
  setup-vapid.test.ts

packages/server/src/
  push/
    PushService.ts        # Subscription management, sending
    PushNotifier.ts       # When-to-send logic
    types.ts
  routes/
    push.ts               # API endpoints

packages/server/test/
  push/
    PushService.test.ts
    PushNotifier.test.ts

packages/client/
  public/
    sw.js                 # Service worker
  src/
    hooks/
      usePushNotifications.ts
    components/
      PushNotificationToggle.tsx
    api/
      client.ts           # (modified)
    pages/
      SettingsPage.tsx    # (modified)
```

## Dependencies to Add

```bash
# Server
pnpm -F server add web-push
pnpm -F server add -D @types/web-push
```

## Notes

- VAPID keys are per-installation, stored in `~/.claude-anywhere/`
- Push subscriptions are per-device/browser, also stored locally
- No external accounts or services required
- Service worker must be plain JS (not TypeScript) for browser compatibility
- Vite will serve `public/sw.js` at the root path
