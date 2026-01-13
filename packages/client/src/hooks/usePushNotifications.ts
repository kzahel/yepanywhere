import { useCallback, useEffect, useState } from "react";
import { api } from "../api/client";
import {
  LEGACY_KEYS,
  getServerScoped,
  setServerScoped,
} from "../lib/storageKeys";
const SW_PATH = "/sw.js";

// Service worker is disabled in dev mode by default to avoid page reload issues
// (skipWaiting + clients.claim can disrupt SSE connections on mobile screen unlock)
// Enable with VITE_ENABLE_SW=true in .env or environment
const SW_ENABLED =
  !import.meta.env.DEV || import.meta.env.VITE_ENABLE_SW === "true";

interface PushState {
  isSupported: boolean;
  isSubscribed: boolean;
  isLoading: boolean;
  error: string | null;
  permission: NotificationPermission;
  browserProfileId: string | null;
}

/**
 * Hook for managing push notification subscriptions.
 *
 * Handles:
 * - Service worker registration
 * - Push subscription management
 * - Browser profile ID generation/persistence
 * - Server sync
 */
export function usePushNotifications() {
  const [state, setState] = useState<PushState>({
    isSupported: false,
    isSubscribed: false,
    isLoading: true,
    error: null,
    permission: "default",
    browserProfileId: null,
  });

  const [registration, setRegistration] =
    useState<ServiceWorkerRegistration | null>(null);

  // Check browser support (and whether SW is enabled in this environment)
  const isSupported =
    SW_ENABLED &&
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window;

  // Get or create browser profile ID
  const getBrowserProfileId = useCallback((): string => {
    let browserProfileId = getServerScoped(
      "browserProfileId",
      LEGACY_KEYS.browserProfileId,
    );
    if (!browserProfileId) {
      browserProfileId = crypto.randomUUID();
      setServerScoped(
        "browserProfileId",
        browserProfileId,
        LEGACY_KEYS.browserProfileId,
      );
    }
    return browserProfileId;
  }, []);

  // Initialize: register service worker and check subscription status
  useEffect(() => {
    if (!isSupported) {
      const reason = !SW_ENABLED
        ? "Service worker disabled in dev mode (set VITE_ENABLE_SW=true to enable)"
        : "Push notifications not supported in this browser";
      // Still populate browserProfileId so we can identify this browser profile in the subscribed list
      const browserProfileId = getServerScoped(
        "browserProfileId",
        LEGACY_KEYS.browserProfileId,
      );
      setState((s) => ({
        ...s,
        isSupported: false,
        isLoading: false,
        error: reason,
        browserProfileId,
      }));
      return;
    }

    const init = async () => {
      try {
        // Register service worker
        const reg = await navigator.serviceWorker.register(SW_PATH);
        setRegistration(reg);

        // Wait for service worker to be ready
        await navigator.serviceWorker.ready;

        // Check current subscription status
        const subscription = await reg.pushManager.getSubscription();
        const browserProfileId = getBrowserProfileId();

        setState({
          isSupported: true,
          isSubscribed: !!subscription,
          isLoading: false,
          error: null,
          permission: Notification.permission,
          browserProfileId,
        });
      } catch (err) {
        console.error("[usePushNotifications] Init error:", err);
        setState((s) => ({
          ...s,
          isSupported: true,
          isLoading: false,
          error: err instanceof Error ? err.message : "Failed to initialize",
        }));
      }
    };

    init();
  }, [isSupported, getBrowserProfileId]);

  // Subscribe to push notifications
  const subscribe = useCallback(async () => {
    if (!registration) {
      setState((s) => ({ ...s, error: "Service worker not ready" }));
      return;
    }

    setState((s) => ({ ...s, isLoading: true, error: null }));

    try {
      // Request notification permission
      const permission = await Notification.requestPermission();
      setState((s) => ({ ...s, permission }));

      if (permission !== "granted") {
        setState((s) => ({
          ...s,
          isLoading: false,
          error: "Notification permission denied",
        }));
        return;
      }

      // Get VAPID public key from server
      const { publicKey } = await api.getPushPublicKey();

      // Convert base64url to Uint8Array for applicationServerKey
      const applicationServerKey = urlBase64ToUint8Array(publicKey);

      // Subscribe to push
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: applicationServerKey.buffer as ArrayBuffer,
      });

      // Send subscription to server
      const browserProfileId = getBrowserProfileId();
      const subscriptionJson = subscription.toJSON();

      await api.subscribePush(
        browserProfileId,
        subscriptionJson as PushSubscriptionJSON,
        getDeviceName(),
      );

      setState((s) => ({
        ...s,
        isSubscribed: true,
        isLoading: false,
        error: null,
        browserProfileId,
      }));
    } catch (err) {
      console.error("[usePushNotifications] Subscribe error:", err);
      setState((s) => ({
        ...s,
        isLoading: false,
        error: err instanceof Error ? err.message : "Failed to subscribe",
      }));
    }
  }, [registration, getBrowserProfileId]);

  // Unsubscribe from push notifications
  const unsubscribe = useCallback(async () => {
    if (!registration) {
      setState((s) => ({ ...s, error: "Service worker not ready" }));
      return;
    }

    setState((s) => ({ ...s, isLoading: true, error: null }));

    try {
      // Get current subscription
      const subscription = await registration.pushManager.getSubscription();

      if (subscription) {
        // Unsubscribe locally
        await subscription.unsubscribe();
      }

      // Notify server
      const browserProfileId = getBrowserProfileId();
      await api.unsubscribePush(browserProfileId);

      setState((s) => ({
        ...s,
        isSubscribed: false,
        isLoading: false,
        error: null,
      }));
    } catch (err) {
      console.error("[usePushNotifications] Unsubscribe error:", err);
      setState((s) => ({
        ...s,
        isLoading: false,
        error: err instanceof Error ? err.message : "Failed to unsubscribe",
      }));
    }
  }, [registration, getBrowserProfileId]);

  // Send a test notification
  const sendTest = useCallback(async () => {
    const browserProfileId = getBrowserProfileId();
    setState((s) => ({ ...s, isLoading: true, error: null }));

    try {
      await api.testPush(browserProfileId);
      setState((s) => ({ ...s, isLoading: false }));
    } catch (err) {
      console.error("[usePushNotifications] Test push error:", err);
      setState((s) => ({
        ...s,
        isLoading: false,
        error: err instanceof Error ? err.message : "Failed to send test",
      }));
    }
  }, [getBrowserProfileId]);

  // Get service worker logs (for debugging)
  const getSwLogs = useCallback(async (): Promise<SwLogEntry[]> => {
    const sw = navigator.serviceWorker?.controller;
    if (!sw) {
      console.warn("[usePushNotifications] No active service worker");
      return [];
    }

    return new Promise((resolve) => {
      const channel = new MessageChannel();
      channel.port1.onmessage = (event) => {
        resolve(event.data?.logs || []);
      };
      sw.postMessage({ type: "get-sw-logs" }, [channel.port2]);

      // Timeout after 2 seconds
      setTimeout(() => resolve([]), 2000);
    });
  }, []);

  // Clear service worker logs
  const clearSwLogs = useCallback(async (): Promise<void> => {
    const sw = navigator.serviceWorker?.controller;
    if (!sw) return;

    return new Promise((resolve) => {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => resolve();
      sw.postMessage({ type: "clear-sw-logs" }, [channel.port2]);
      setTimeout(resolve, 1000);
    });
  }, []);

  return {
    ...state,
    subscribe,
    unsubscribe,
    sendTest,
    getSwLogs,
    clearSwLogs,
  };
}

export interface SwLogEntry {
  id?: number;
  timestamp: string;
  level: "info" | "warn" | "error";
  message: string;
  data: Record<string, unknown>;
}

/**
 * Convert a base64url-encoded string to a Uint8Array.
 * Used for the applicationServerKey in pushManager.subscribe().
 */
function urlBase64ToUint8Array(base64String: string): Uint8Array {
  // Add padding if needed
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");

  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);

  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }

  return outputArray;
}

/**
 * Generate a friendly device name based on user agent.
 */
function getDeviceName(): string {
  const ua = navigator.userAgent;

  // Try to extract a meaningful name
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Android/.test(ua)) return "Android";
  if (/Mac/.test(ua)) return "Mac";
  if (/Windows/.test(ua)) return "Windows";
  if (/Linux/.test(ua)) return "Linux";

  return "Browser";
}
