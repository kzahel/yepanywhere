import { useCallback, useEffect, useState } from "react";
import { api } from "../api/client";

const DEVICE_ID_KEY = "claude-anywhere-device-id";
const SW_PATH = "/sw.js";

interface PushState {
  isSupported: boolean;
  isSubscribed: boolean;
  isLoading: boolean;
  error: string | null;
  permission: NotificationPermission;
  deviceId: string | null;
}

/**
 * Hook for managing push notification subscriptions.
 *
 * Handles:
 * - Service worker registration
 * - Push subscription management
 * - Device ID generation/persistence
 * - Server sync
 */
export function usePushNotifications() {
  const [state, setState] = useState<PushState>({
    isSupported: false,
    isSubscribed: false,
    isLoading: true,
    error: null,
    permission: "default",
    deviceId: null,
  });

  const [registration, setRegistration] =
    useState<ServiceWorkerRegistration | null>(null);

  // Check browser support
  const isSupported =
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window;

  // Get or create device ID
  const getDeviceId = useCallback((): string => {
    let deviceId = localStorage.getItem(DEVICE_ID_KEY);
    if (!deviceId) {
      deviceId = crypto.randomUUID();
      localStorage.setItem(DEVICE_ID_KEY, deviceId);
    }
    return deviceId;
  }, []);

  // Initialize: register service worker and check subscription status
  useEffect(() => {
    if (!isSupported) {
      setState((s) => ({
        ...s,
        isSupported: false,
        isLoading: false,
        error: "Push notifications not supported in this browser",
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
        const deviceId = getDeviceId();

        setState({
          isSupported: true,
          isSubscribed: !!subscription,
          isLoading: false,
          error: null,
          permission: Notification.permission,
          deviceId,
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
  }, [isSupported, getDeviceId]);

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
      const deviceId = getDeviceId();
      const subscriptionJson = subscription.toJSON();

      await api.subscribePush(
        deviceId,
        subscriptionJson as PushSubscriptionJSON,
        getDeviceName(),
      );

      setState((s) => ({
        ...s,
        isSubscribed: true,
        isLoading: false,
        error: null,
        deviceId,
      }));
    } catch (err) {
      console.error("[usePushNotifications] Subscribe error:", err);
      setState((s) => ({
        ...s,
        isLoading: false,
        error: err instanceof Error ? err.message : "Failed to subscribe",
      }));
    }
  }, [registration, getDeviceId]);

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
      const deviceId = getDeviceId();
      await api.unsubscribePush(deviceId);

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
  }, [registration, getDeviceId]);

  // Send a test notification
  const sendTest = useCallback(async () => {
    const deviceId = getDeviceId();
    setState((s) => ({ ...s, isLoading: true, error: null }));

    try {
      await api.testPush(deviceId);
      setState((s) => ({ ...s, isLoading: false }));
    } catch (err) {
      console.error("[usePushNotifications] Test push error:", err);
      setState((s) => ({
        ...s,
        isLoading: false,
        error: err instanceof Error ? err.message : "Failed to send test",
      }));
    }
  }, [getDeviceId]);

  return {
    ...state,
    subscribe,
    unsubscribe,
    sendTest,
  };
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
