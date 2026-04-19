import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PUSH_ERROR_DEV_MODE_DISABLED,
  PUSH_ERROR_INSECURE_CONTEXT,
} from "../../hooks/pushSupport";
import { useNotifyInApp } from "../../hooks/useNotifyInApp";
import { usePushNotifications } from "../../hooks/usePushNotifications";
import { I18nProvider } from "../../i18n";
import { PushNotificationToggle } from "../PushNotificationToggle";

vi.mock("../../hooks/usePushNotifications", () => ({
  usePushNotifications: vi.fn(),
}));

vi.mock("../../hooks/useNotifyInApp", () => ({
  useNotifyInApp: vi.fn(),
}));

const usePushNotificationsMock = vi.mocked(usePushNotifications);
const useNotifyInAppMock = vi.mocked(useNotifyInApp);

describe("PushNotificationToggle", () => {
  beforeEach(() => {
    useNotifyInAppMock.mockReturnValue({
      notifyInApp: false,
      setNotifyInApp: vi.fn(),
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("shows HTTPS guidance for insecure origins", () => {
    usePushNotificationsMock.mockReturnValue({
      isSupported: false,
      isSubscribed: false,
      isLoading: false,
      error: PUSH_ERROR_INSECURE_CONTEXT,
      permission: "default",
      browserProfileId: null,
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
      sendTest: vi.fn(),
      getSwLogs: vi.fn(),
      clearSwLogs: vi.fn(),
    });

    render(
      <I18nProvider>
        <PushNotificationToggle />
      </I18nProvider>,
    );

    expect(
      screen.getByText(
        "Push notifications require HTTPS or localhost. Open this site over HTTPS to enable them.",
      ),
    ).toBeDefined();
    expect(
      screen.getByText(
        "Push notifications require a secure context. Open Yep Anywhere from https, localhost, or a trusted local-network origin.",
      ),
    ).toBeDefined();
    expect(
      screen.getByText(
        "If you're using a raw IP or an untrusted host, switch to localhost, Tailscale, or HTTPS before trying again.",
      ),
    ).toBeDefined();
  });

  it("shows the dev-mode hint when service workers are disabled by settings", () => {
    usePushNotificationsMock.mockReturnValue({
      isSupported: false,
      isSubscribed: false,
      isLoading: false,
      error: PUSH_ERROR_DEV_MODE_DISABLED,
      permission: "default",
      browserProfileId: null,
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
      sendTest: vi.fn(),
      getSwLogs: vi.fn(),
      clearSwLogs: vi.fn(),
    });

    render(
      <I18nProvider>
        <PushNotificationToggle />
      </I18nProvider>,
    );

    expect(
      screen.getByText(
        "This only affects this device. Other subscribed devices will still receive notifications from the server.",
      ),
    ).toBeDefined();
    expect(
      screen.getByText(
        "To enable push on this device in dev mode, restart with VITE_ENABLE_SW=true.",
      ),
    ).toBeDefined();
  });
});
