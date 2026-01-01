/**
 * Service Worker for Push Notifications
 *
 * Handles:
 * - push: Receives push events and shows notifications
 * - notificationclick: Handles user clicking on notifications
 *
 * Payload types (from server):
 * - pending-input: Session needs approval or user question
 * - session-halted: Session stopped working
 * - dismiss: Close notification on other devices
 * - test: Test notification
 */

// Skip waiting and claim clients immediately on install/activate
self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

/**
 * Handle incoming push notifications
 */
self.addEventListener("push", (event) => {
  if (!event.data) {
    console.warn("[SW] Push event with no data");
    return;
  }

  let data;
  try {
    data = event.data.json();
  } catch (e) {
    console.error("[SW] Failed to parse push data:", e);
    return;
  }

  event.waitUntil(handlePush(data));
});

async function handlePush(data) {
  // Check if any app window is focused - skip notification if so
  const clients = await self.clients.matchAll({
    type: "window",
    includeUncontrolled: true,
  });

  const hasFocusedClient = clients.some((client) => client.focused);

  // Handle dismiss payload - close matching notification
  if (data.type === "dismiss") {
    const notifications = await self.registration.getNotifications({
      tag: `session-${data.sessionId}`,
    });
    for (const notification of notifications) {
      notification.close();
    }
    return;
  }

  // Skip showing notification if app is in foreground
  if (hasFocusedClient) {
    console.log("[SW] App is focused, skipping notification");
    return;
  }

  // Handle different notification types
  if (data.type === "pending-input") {
    return showPendingInputNotification(data);
  }

  if (data.type === "session-halted") {
    return showSessionHaltedNotification(data);
  }

  if (data.type === "test") {
    return self.registration.showNotification("Claude Anywhere", {
      body: data.message || "Test notification",
      tag: "test",
      icon: "/favicon.ico",
    });
  }

  console.warn("[SW] Unknown push type:", data.type);
}

function showPendingInputNotification(data) {
  const title = data.projectName || "Claude Anywhere";
  const options = {
    body: data.summary || "Waiting for input",
    tag: `session-${data.sessionId}`,
    icon: "/favicon.ico",
    badge: "/favicon.ico",
    data: {
      sessionId: data.sessionId,
      projectId: data.projectId,
      inputType: data.inputType,
      requestId: data.requestId,
    },
    requireInteraction: true,
    actions: [
      { action: "approve", title: "Approve" },
      { action: "deny", title: "Deny" },
    ],
  };

  return self.registration.showNotification(title, options);
}

function showSessionHaltedNotification(data) {
  const title = data.projectName || "Claude Anywhere";
  const reasonText = {
    completed: "Task completed",
    error: "Task encountered an error",
    idle: "Task stopped",
  };
  const body = reasonText[data.reason] || "Session stopped";

  const options = {
    body,
    tag: `session-halted-${data.sessionId}`,
    icon: "/favicon.ico",
    data: {
      sessionId: data.sessionId,
      projectId: data.projectId,
    },
  };

  return self.registration.showNotification(title, options);
}

/**
 * Handle notification clicks
 */
self.addEventListener("notificationclick", (event) => {
  const notification = event.notification;
  const action = event.action;
  const data = notification.data || {};

  notification.close();

  event.waitUntil(handleNotificationClick(action, data));
});

async function handleNotificationClick(action, data) {
  const { sessionId, projectId, requestId } = data;

  // Handle approve/deny actions via API
  if ((action === "approve" || action === "deny") && requestId) {
    try {
      const response = await fetch(`/api/sessions/${sessionId}/input`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requestId,
          response: action,
        }),
      });

      if (response.ok) {
        // Success - notification will be dismissed via dismiss push
        console.log(
          `[SW] Successfully sent '${action}' for session ${sessionId}`,
        );
        return;
      }

      // API call failed - fall through to open the session
      console.warn(
        `[SW] API call failed for '${action}', opening session instead`,
      );
    } catch (e) {
      console.error("[SW] Failed to send action:", e);
      // Fall through to open the session
    }
  }

  // Open the session (default action or fallback on error)
  return openSession(sessionId, projectId);
}

/**
 * Open the session in the app window
 */
async function openSession(sessionId, projectId) {
  // Build the URL to open
  let url = "/";
  if (sessionId && projectId) {
    url = `/projects/${encodeURIComponent(projectId)}/sessions/${sessionId}`;
  }

  // Try to focus an existing window with this session, or open a new one
  const clients = await self.clients.matchAll({ type: "window" });

  // Look for an existing window we can focus
  for (const client of clients) {
    // If already on this session, just focus
    if (sessionId && client.url.includes(sessionId)) {
      return client.focus();
    }
  }

  // Try to navigate an existing window
  for (const client of clients) {
    if ("navigate" in client) {
      await client.navigate(url);
      return client.focus();
    }
  }

  // Open a new window as fallback
  if (self.clients.openWindow) {
    return self.clients.openWindow(url);
  }
}
