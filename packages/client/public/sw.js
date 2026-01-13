/**
 * Service Worker for Push Notifications
 *
 * Handles:
 * - push: Receives push events and shows notifications
 * - notificationclick: Handles user clicking on notifications
 * - message: Receives settings updates from main thread
 *
 * Payload types (from server):
 * - pending-input: Session needs approval or user question
 * - session-halted: Session stopped working
 * - dismiss: Close notification on other devices
 * - test: Test notification
 */

// Version constant for controlled updates
// Increment this when making intentional SW changes
// Browsers reinstall SW only when file content changes
const SW_VERSION = "1.0.0";

// Settings synced from main thread
const settings = {
  notifyInApp: false, // When true, notify even when app is focused (if session not viewed)
};

// ============ Debug Logging ============
// Logs are stored in IndexedDB for retrieval via main thread

const LOG_DB_NAME = "sw-logs";
const LOG_STORE_NAME = "logs";
const MAX_LOGS = 100;

async function openLogDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(LOG_DB_NAME, 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(LOG_STORE_NAME)) {
        db.createObjectStore(LOG_STORE_NAME, {
          keyPath: "id",
          autoIncrement: true,
        });
      }
    };
  });
}

async function swLog(level, message, data = {}) {
  const timestamp = new Date().toISOString();
  const logEntry = { timestamp, level, message, data };

  // Always log to console
  const consoleMethod =
    level === "error"
      ? console.error
      : level === "warn"
        ? console.warn
        : console.log;
  consoleMethod(`[SW ${level.toUpperCase()}]`, message, data);

  try {
    const db = await openLogDb();
    const tx = db.transaction(LOG_STORE_NAME, "readwrite");
    const store = tx.objectStore(LOG_STORE_NAME);

    // Add new log
    store.add(logEntry);

    // Prune old logs
    const countRequest = store.count();
    countRequest.onsuccess = () => {
      if (countRequest.result > MAX_LOGS) {
        const cursor = store.openCursor();
        let deleted = 0;
        const toDelete = countRequest.result - MAX_LOGS;
        cursor.onsuccess = (e) => {
          const c = e.target.result;
          if (c && deleted < toDelete) {
            c.delete();
            deleted++;
            c.continue();
          }
        };
      }
    };

    await tx.complete;
    db.close();
  } catch (e) {
    // Silently fail if IndexedDB not available
  }
}

// Expose logs retrieval via message
async function getSwLogs() {
  try {
    const db = await openLogDb();
    const tx = db.transaction(LOG_STORE_NAME, "readonly");
    const store = tx.objectStore(LOG_STORE_NAME);

    return new Promise((resolve) => {
      const request = store.getAll();
      request.onsuccess = () => {
        db.close();
        resolve(request.result || []);
      };
      request.onerror = () => {
        db.close();
        resolve([]);
      };
    });
  } catch {
    return [];
  }
}

async function clearSwLogs() {
  try {
    const db = await openLogDb();
    const tx = db.transaction(LOG_STORE_NAME, "readwrite");
    tx.objectStore(LOG_STORE_NAME).clear();
    await tx.complete;
    db.close();
  } catch {
    // Ignore
  }
}

/**
 * Service Worker Lifecycle: Install & Activate
 *
 * We use skipWaiting() to activate immediately, but are careful with clients.claim().
 *
 * Problem: Calling clients.claim() while pages are loading can disrupt in-flight
 * network requests (SSE connections, fetches), causing the page to appear to "reload".
 * This is especially noticeable in dev mode where the SW updates frequently, or on
 * mobile browsers with aggressive SW update checking.
 *
 * Solution: Only claim clients if there are no windows currently open. This means:
 * - First visit: SW installs but doesn't claim until next navigation
 * - SW update with tabs open: New SW waits, old SW continues serving
 * - SW update with no tabs: New SW claims immediately
 *
 * Potential drawbacks:
 * - Push notifications may be handled by old SW until user navigates/refreshes
 * - Settings synced via postMessage won't reach new SW until it claims
 * - In production this is rarely an issue; mainly affects dev mode with frequent updates
 *
 * Alternative: Remove skipWaiting() entirely for fully lazy updates, but this delays
 * all SW updates until all tabs close (could be days).
 */
self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    self.clients.matchAll({ type: "window" }).then((windowClients) => {
      // Only claim if no windows are open - avoids disrupting active pages
      if (windowClients.length === 0) {
        return self.clients.claim();
      }
      // Otherwise, let pages naturally pick up new SW on next navigation
      console.log(
        `[SW] Skipping claim - ${windowClients.length} window(s) open`,
      );
    }),
  );
});

/**
 * Handle messages from main thread
 */
self.addEventListener("message", async (event) => {
  if (event.data?.type === "setting-update") {
    const { key, value } = event.data;
    if (key in settings) {
      settings[key] = value;
      await swLog("info", `Setting updated: ${key} = ${value}`);
    }
  }

  // Log retrieval for debugging
  if (event.data?.type === "get-sw-logs") {
    const logs = await getSwLogs();
    event.ports[0]?.postMessage({ logs });
  }

  // Clear logs
  if (event.data?.type === "clear-sw-logs") {
    await clearSwLogs();
    event.ports[0]?.postMessage({ cleared: true });
  }
});

/**
 * Handle incoming push notifications
 */
self.addEventListener("push", (event) => {
  if (!event.data) {
    event.waitUntil(swLog("warn", "Push event with no data"));
    return;
  }

  let data;
  try {
    data = event.data.json();
  } catch (e) {
    event.waitUntil(
      swLog("error", "Failed to parse push data", { error: e.message }),
    );
    return;
  }

  event.waitUntil(
    swLog("info", "Push received", {
      type: data.type,
      sessionId: data.sessionId,
    }).then(() => handlePush(data)),
  );
});

async function handlePush(data) {
  // Check app window state for notification suppression
  const clients = await self.clients.matchAll({
    type: "window",
    includeUncontrolled: true,
  });

  const focusedClients = clients.filter((client) => client.focused);
  const hasFocusedClient = focusedClients.length > 0;

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

  // Test notifications always show (user explicitly requested them)
  if (data.type === "test") {
    // Urgency controls notification behavior:
    // - normal: auto-dismiss (requireInteraction: false)
    // - persistent: stays visible until dismissed (requireInteraction: true)
    // - silent: no sound (silent: true)
    const urgency = data.urgency || "normal";
    const options = {
      body: data.message || "Test notification",
      tag: "test",
      icon: "/icon-192.png",
      badge: "/badge-96.png",
      requireInteraction: urgency === "persistent",
      silent: urgency === "silent",
    };
    return self.registration.showNotification("Yep Anywhere", options);
  }

  // Determine if we should suppress notification
  if (hasFocusedClient) {
    if (settings.notifyInApp) {
      // Check if any focused client is viewing THIS session
      const sessionId = data.sessionId;
      const isSessionOpen =
        sessionId &&
        focusedClients.some((client) => {
          return client.url?.includes(`/sessions/${sessionId}`);
        });

      if (isSessionOpen) {
        console.log(
          "[SW] Session is open in focused window, skipping notification",
        );
        return;
      }
      // Session not open - continue to show notification
    } else {
      // notifyInApp disabled - skip if any window focused
      console.log("[SW] App is focused, skipping notification");
      return;
    }
  }

  // Handle different notification types
  if (data.type === "pending-input") {
    return showPendingInputNotification(data);
  }

  if (data.type === "session-halted") {
    return showSessionHaltedNotification(data);
  }

  console.warn("[SW] Unknown push type:", data.type);
}

async function showPendingInputNotification(data) {
  const title = data.projectName || "Yep Anywhere";
  const options = {
    body: data.summary || "Waiting for input",
    tag: `session-${data.sessionId}`,
    icon: "/icon-192.png",
    badge: "/badge-96.png",
    data: {
      sessionId: data.sessionId,
      projectId: data.projectId,
    },
    requireInteraction: true,
  };

  await swLog("info", "Showing pending-input notification", {
    sessionId: data.sessionId,
    inputType: data.inputType,
  });

  return self.registration.showNotification(title, options);
}

function showSessionHaltedNotification(data) {
  const title = data.projectName || "Yep Anywhere";
  const reasonText = {
    completed: "Task completed",
    error: "Task encountered an error",
    idle: "Task stopped",
  };
  const body = reasonText[data.reason] || "Session stopped";

  const options = {
    body,
    tag: `session-halted-${data.sessionId}`,
    icon: "/icon-192.png",
    badge: "/badge-96.png",
    data: {
      sessionId: data.sessionId,
      projectId: data.projectId,
    },
  };

  return self.registration.showNotification(title, options);
}

/**
 * Handle notification clicks - always open the session
 */
self.addEventListener("notificationclick", (event) => {
  const notification = event.notification;
  const data = notification.data || {};

  notification.close();

  event.waitUntil(handleNotificationClick(data));
});

async function handleNotificationClick(data) {
  const { sessionId, projectId } = data;

  await swLog("info", "Notification clicked", { sessionId, projectId });

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
