# Phase 3: Service Worker + Client Subscription - Implementation Plan

## Overview

This phase adds client-side push notification support:
1. Service worker to receive push events
2. React hook for managing subscriptions
3. UI toggle in Settings page
4. API client methods for push endpoints

## Files to Create

### 1. `packages/client/public/sw.js` - Service Worker

Plain JavaScript service worker (not TypeScript) that:
- Listens for `push` events and shows notifications
- Listens for `notificationclick` to handle user actions
- Checks if app window is focused to avoid duplicate notifications
- Handles `dismiss` payload type to close notifications

```javascript
// Key event handlers:
self.addEventListener('push', (event) => { ... });
self.addEventListener('notificationclick', (event) => { ... });
```

**Notes:**
- Must be plain JS for browser compatibility
- Vite serves `public/` at root, so it'll be at `/sw.js`
- Skip showing notification if any app window is focused

### 2. `packages/client/src/hooks/usePushNotifications.ts` - React Hook

Hook that manages the push notification lifecycle:

```typescript
interface UsePushNotificationsReturn {
  // State
  isSupported: boolean;        // Browser supports push
  isSubscribed: boolean;       // Currently subscribed
  isLoading: boolean;          // Subscription in progress
  error: string | null;        // Last error
  permission: NotificationPermission;  // 'default' | 'granted' | 'denied'

  // Actions
  subscribe: () => Promise<void>;
  unsubscribe: () => Promise<void>;

  // Test
  sendTest: () => Promise<void>;
}
```

**Implementation details:**
- Generate/retrieve device ID from localStorage (`claude-anywhere-device-id`)
- Register service worker on mount
- Fetch VAPID public key from `/api/push/vapid-public-key`
- Handle permission request flow
- Sync subscription state with server

### 3. `packages/client/src/components/PushNotificationToggle.tsx` - UI Component

Toggle component for Settings page:

```tsx
<PushNotificationToggle />
```

**Features:**
- Shows toggle switch (disabled if not supported)
- Shows permission status
- Shows "Test Notification" button when subscribed
- Shows error messages
- Shows device list (other subscribed devices)

## Files to Modify

### 4. `packages/client/src/api/client.ts` - Add Push API Methods

Add to `api` object:

```typescript
// Push notification API
getPushPublicKey: () =>
  fetchJSON<{ publicKey: string }>('/push/vapid-public-key'),

subscribePush: (deviceId: string, subscription: PushSubscriptionJSON, deviceName?: string) =>
  fetchJSON<{ success: boolean }>('/push/subscribe', {
    method: 'POST',
    body: JSON.stringify({ deviceId, subscription, deviceName }),
  }),

unsubscribePush: (deviceId: string) =>
  fetchJSON<{ success: boolean }>('/push/unsubscribe', {
    method: 'POST',
    body: JSON.stringify({ deviceId }),
  }),

getPushSubscriptions: () =>
  fetchJSON<{ count: number; subscriptions: SubscriptionInfo[] }>('/push/subscriptions'),

testPush: (deviceId: string) =>
  fetchJSON<{ success: boolean }>('/push/test', {
    method: 'POST',
    body: JSON.stringify({ deviceId }),
  }),
```

### 5. `packages/client/src/pages/SettingsPage.tsx` - Add Notifications Section

Add new section after "Appearance":

```tsx
<section className="settings-section">
  <h2>Notifications</h2>
  <div className="settings-group">
    <PushNotificationToggle />
  </div>
</section>
```

## Implementation Order

1. **API client methods** (`client.ts`)
   - Add the 5 new API methods
   - Simple, no dependencies

2. **Service worker** (`public/sw.js`)
   - Create `public/` directory
   - Implement push and notificationclick handlers
   - Handle all payload types from `types.ts`

3. **React hook** (`usePushNotifications.ts`)
   - Device ID generation/persistence
   - Service worker registration
   - Subscription management
   - Server sync

4. **UI component** (`PushNotificationToggle.tsx`)
   - Toggle switch
   - Permission handling
   - Test button
   - Error display

5. **Settings integration** (`SettingsPage.tsx`)
   - Import and add component
   - Style as needed

## Service Worker Details

### Push Event Handling

```javascript
self.addEventListener('push', (event) => {
  const data = event.data.json();

  // Skip if app is focused
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then(clients => {
        const focused = clients.some(c => c.focused);
        if (focused) return; // Don't show, app is in foreground

        if (data.type === 'dismiss') {
          // Close notification with matching tag
          return self.registration.getNotifications({ tag: `session-${data.sessionId}` })
            .then(notifications => notifications.forEach(n => n.close()));
        }

        if (data.type === 'pending-input') {
          return self.registration.showNotification(data.projectName, {
            body: data.summary,
            tag: `session-${data.sessionId}`,
            data: { sessionId: data.sessionId, projectId: data.projectId },
            requireInteraction: true,
            actions: [
              { action: 'approve', title: 'Approve' },
              { action: 'deny', title: 'Deny' }
            ]
          });
        }

        if (data.type === 'test') {
          return self.registration.showNotification('Claude Anywhere', {
            body: data.message,
            tag: 'test'
          });
        }
      })
  );
});
```

### Notification Click Handling

```javascript
self.addEventListener('notificationclick', (event) => {
  const { action } = event;
  const { sessionId, projectId } = event.notification.data || {};

  event.notification.close();

  event.waitUntil(
    (async () => {
      if (action === 'approve' && sessionId) {
        // TODO: Phase 5 will implement approve/deny actions
        // For now, just open the session
      }

      // Open or focus the session page
      const url = sessionId ? `/projects/${projectId}/sessions/${sessionId}` : '/';
      const clients = await self.clients.matchAll({ type: 'window' });

      for (const client of clients) {
        if (client.url.includes(sessionId) && 'focus' in client) {
          return client.focus();
        }
      }

      if (self.clients.openWindow) {
        return self.clients.openWindow(url);
      }
    })()
  );
});
```

## Verification

After implementation:

```bash
# Build and verify sw.js in output
pnpm -F client build
ls packages/client/dist/sw.js

# Type check
pnpm typecheck

# Lint
pnpm lint

# Unit tests (if added)
pnpm -F client test
```

**Manual testing:**
1. Open Settings page
2. Enable push notifications (browser will prompt for permission)
3. Click "Test Notification"
4. Notification should appear (unless app is focused)
5. Click notification to open app

## Notes

- Service worker URL must be at root (`/sw.js`) for correct scope
- Device ID persists across sessions for same browser
- VAPID public key is fetched from server, not hardcoded
- Error handling for unsupported browsers (Safari iOS limitations)
