import { describe, expect, it } from "vitest";
import {
  PUSH_ERROR_INSECURE_CONTEXT,
  PUSH_ERROR_PUSH_API_UNAVAILABLE,
  getPushSupportError,
} from "../pushSupport";

describe("getPushSupportError", () => {
  it("reports insecure HTTP origins before checking browser APIs", () => {
    expect(
      getPushSupportError({
        hasWindow: true,
        isSecureContext: false,
        hasServiceWorker: true,
        hasPushManager: true,
        hasNotification: true,
      }),
    ).toBe(PUSH_ERROR_INSECURE_CONTEXT);
  });

  it("reports missing Push API on secure origins", () => {
    expect(
      getPushSupportError({
        hasWindow: true,
        isSecureContext: true,
        hasServiceWorker: true,
        hasPushManager: false,
        hasNotification: true,
      }),
    ).toBe(PUSH_ERROR_PUSH_API_UNAVAILABLE);
  });

  it("returns null when the browser exposes all required APIs", () => {
    expect(
      getPushSupportError({
        hasWindow: true,
        isSecureContext: true,
        hasServiceWorker: true,
        hasPushManager: true,
        hasNotification: true,
      }),
    ).toBeNull();
  });
});
