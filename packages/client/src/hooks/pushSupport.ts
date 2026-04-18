export const PUSH_ERROR_NOT_SUPPORTED =
  "Push notifications not supported in this browser";
export const PUSH_ERROR_INSECURE_CONTEXT =
  "Push notifications require HTTPS or localhost. Open this site over HTTPS to enable them.";
export const PUSH_ERROR_SERVICE_WORKER_UNAVAILABLE =
  "Service workers are unavailable in this browser context.";
export const PUSH_ERROR_PUSH_API_UNAVAILABLE =
  "Push API is unavailable in this browser.";
export const PUSH_ERROR_NOTIFICATION_UNAVAILABLE =
  "Notifications API is unavailable in this browser.";
export const PUSH_ERROR_DEV_MODE_DISABLED =
  "Service worker disabled (enable in Settings > Development)";

export interface PushSupportEnvironment {
  hasWindow: boolean;
  isSecureContext: boolean;
  hasServiceWorker: boolean;
  hasPushManager: boolean;
  hasNotification: boolean;
}

export function getPushSupportError(
  environment: PushSupportEnvironment,
): string | null {
  if (!environment.hasWindow) {
    return PUSH_ERROR_NOT_SUPPORTED;
  }

  if (!environment.isSecureContext) {
    return PUSH_ERROR_INSECURE_CONTEXT;
  }

  if (!environment.hasServiceWorker) {
    return PUSH_ERROR_SERVICE_WORKER_UNAVAILABLE;
  }

  if (!environment.hasPushManager) {
    return PUSH_ERROR_PUSH_API_UNAVAILABLE;
  }

  if (!environment.hasNotification) {
    return PUSH_ERROR_NOTIFICATION_UNAVAILABLE;
  }

  return null;
}
