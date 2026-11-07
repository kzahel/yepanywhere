// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useEffect, useState } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectionGate } from "../../RemoteApp";

const testState = vi.hoisted(() => ({
  clearAutoResumeError: vi.fn(),
  remote: {
    autoResumeError: null as {
      message: string;
      mode: "direct";
      reason: "direct_unreachable";
      serverUrl: string;
    } | null,
    clearAutoResumeError: vi.fn(),
    connection: {} as object | null,
    currentRelayUsername: null,
    isAutoResuming: false,
    retryAutoResume: vi.fn(),
  },
  retryAutoResume: vi.fn(),
}));

vi.mock("../../contexts/RemoteConnectionContext", () => ({
  RemoteConnectionProvider: ({ children }: { children: React.ReactNode }) =>
    children,
  useOptionalRemoteConnection: () => testState.remote,
  useRemoteConnection: () => testState.remote,
}));

vi.mock("../../hooks/useRemoteActivityBusConnection", () => ({
  useRemoteActivityBusConnection: () => {},
}));

vi.mock("../../hooks/useVersion", () => ({
  useVersion: () => ({ version: null }),
}));

vi.mock("../../hooks/useServerSettings", () => ({
  useServerSettings: () => ({ settings: null }),
}));

vi.mock("../../hooks/useReloadNotifications", () => ({
  getVisibleReloadBanners: () => ({ backend: false, frontend: false }),
  useReloadNotifications: () => ({
    backendReloadSafetyKnown: true,
    isManualReloadMode: false,
    pendingReloads: { backend: false, frontend: false },
  }),
}));

vi.mock("../../components/BottomOverscrollReload", () => ({
  BottomOverscrollReload: () => null,
}));

vi.mock("../../components/RemoteCompatibilityNotices", () => ({
  RemoteCompatibilityNotices: () => null,
}));

vi.mock("../../i18n", () => ({
  useI18n: () => ({
    t: (key: string) => {
      const translations: Record<string, string> = {
        hostOfflineGoToLogin: "Go to Login",
        hostOfflineHintDirect: "Check the server connection.",
        hostOfflineMessageDirectUnreachableDirect:
          "Could not connect to the server.",
        hostOfflineRetry: "Retry",
        hostOfflineTitleDirectUnreachable: "Host Unreachable",
        modalClose: "Close",
        relayLoginCustomRelayUrl: "Server URL",
      };
      return translations[key] ?? key;
    },
  }),
}));

let documentMounts = 0;
let documentUnmounts = 0;

function CachedDocument() {
  const [text, setText] = useState("Loaded document");

  useEffect(() => {
    documentMounts += 1;
    return () => {
      documentUnmounts += 1;
    };
  }, []);

  return (
    <button type="button" onClick={() => setText("Edited local view")}>
      {text}
    </button>
  );
}

function TestRoutes() {
  return (
    <MemoryRouter initialEntries={["/document"]}>
      <Routes>
        <Route path="/login" element={<div>Direct login</div>} />
        <Route element={<ConnectionGate />}>
          <Route path="/document" element={<CachedDocument />} />
        </Route>
      </Routes>
    </MemoryRouter>
  );
}

describe("ConnectionGate", () => {
  beforeEach(() => {
    documentMounts = 0;
    documentUnmounts = 0;
    testState.clearAutoResumeError.mockReset();
    testState.retryAutoResume.mockReset();
    testState.remote = {
      autoResumeError: null,
      clearAutoResumeError: testState.clearAutoResumeError,
      connection: {},
      currentRelayUsername: null,
      isAutoResuming: false,
      retryAutoResume: testState.retryAutoResume,
    };
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("dismisses a post-connect direct error without unmounting cached content", async () => {
    const view = render(<TestRoutes />);
    const loadedDocument = await screen.findByRole("button", {
      name: "Loaded document",
    });
    fireEvent.click(loadedDocument);

    testState.remote = {
      ...testState.remote,
      autoResumeError: {
        message: "Failed to connect",
        mode: "direct",
        reason: "direct_unreachable",
        serverUrl: "wss://host.example.test/api/ws",
      },
      connection: null,
    };
    view.rerender(<TestRoutes />);

    expect(await screen.findByText("Host Unreachable")).toBeTruthy();
    expect(documentUnmounts).toBe(0);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    await waitFor(() =>
      expect(screen.queryByText("Host Unreachable")).toBeNull(),
    );
    expect(
      screen.getByRole("button", { name: "Edited local view" }),
    ).toBeTruthy();
    expect(documentMounts).toBe(1);
    expect(documentUnmounts).toBe(0);
  });

  it("still sends terminal failures without a network error to login", async () => {
    const view = render(<TestRoutes />);
    await screen.findByRole("button", { name: "Loaded document" });

    testState.remote = {
      ...testState.remote,
      autoResumeError: null,
      connection: null,
    };
    view.rerender(<TestRoutes />);

    expect(await screen.findByText("Direct login")).toBeTruthy();
    expect(documentUnmounts).toBe(1);
  });
});
