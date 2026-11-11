import { ResumeError } from "../../lib/connection/resumeErrors";
// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { type ReactNode, useEffect, useLayoutEffect, useState } from "react";
import {
  MemoryRouter,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RelayConnectionGate } from "../RelayConnectionGate";

const testState = vi.hoisted(() => ({
  clearHostSession: vi.fn(),
  connectViaRelay: vi.fn(),
  disconnect: vi.fn(),
  host: {
    id: "host-1",
    mode: "relay",
    relayUrl: "wss://relay.example.test/ws",
    relayUsername: "macbook",
    session: { sessionId: "stored-session" },
    srpUsername: "macbook",
  },
  secondHost: {
    id: "host-2",
    mode: "relay",
    relayUrl: "wss://relay.example.test/ws",
    relayUsername: "laptop",
    session: { sessionId: "second-stored-session" },
    srpUsername: "laptop",
  },
  remote: {
    connection: {} as object | null,
    connectViaRelay: vi.fn(),
    currentHostId: "host-1" as string | null,
    currentRelayUsername: "macbook" as string | null,
    disconnect: vi.fn(),
    isAutoResuming: false,
    isIntentionalDisconnect: false,
    setCurrentHostId: vi.fn(),
  },
}));

vi.mock("../../contexts/RemoteConnectionContext", () => ({
  useRemoteConnection: () => testState.remote,
}));

vi.mock("../../lib/hostStorage", () => ({
  clearHostSession: testState.clearHostSession,
  getHostById: (hostId: string) =>
    [testState.host, testState.secondHost].find((host) => host.id === hostId),
  getHostByRelayUsername: (relayUsername: string) =>
    [testState.host, testState.secondHost].find(
      (host) => host.relayUsername === relayUsername,
    ),
}));

vi.mock("../../RemoteApp", () => ({
  ConnectedAppContent: ({ children }: { children: ReactNode }) => (
    <div data-testid="connected-content">{children}</div>
  ),
}));

vi.mock("../../i18n", () => ({
  useI18n: () => ({
    t: (key: string) => {
      const translations: Record<string, string> = {
        hostOfflineGoToLogin: "Go to Login",
        hostOfflineHintRelay: "Check the relay connection.",
        hostOfflineMessageRelayUnreachable: "Could not connect to the relay.",
        hostOfflineRetry: "Retry",
        hostOfflineTitleRelayUnreachable: "Relay Unreachable",
        modalClose: "Close",
        relayLoginCustomRelayUrl: "Custom Relay URL",
        relayLoginServerName: "Server name",
      };
      return translations[key] ?? key;
    },
  }),
}));

let documentMounts = 0;
let documentUnmounts = 0;
const committedDocumentPaths: string[] = [];

function CachedDocument() {
  const location = useLocation();
  useLayoutEffect(() => {
    committedDocumentPaths.push(location.pathname);
  }, [location.pathname]);
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

function RouteSwitchControl() {
  const navigate = useNavigate();
  return (
    <>
      <button
        type="button"
        onClick={() => navigate("/-/relay/laptop/document")}
      >
        Open laptop
      </button>
      <button
        type="button"
        onClick={() => navigate("/-/relay/unknown/document")}
      >
        Open unknown
      </button>
    </>
  );
}

function RelayLoginProbe() {
  const location = useLocation();
  const state = location.state as { signInRequired?: string } | null;
  return (
    <>
      <div>Relay login</div>
      <div data-testid="relay-login-query">{location.search}</div>
      <div data-testid="relay-login-reason">{state?.signInRequired ?? ""}</div>
    </>
  );
}

function TestRoutes() {
  return (
    <MemoryRouter initialEntries={["/-/relay/macbook/document"]}>
      <RouteSwitchControl />
      <Routes>
        <Route path="/login" element={<div>Host picker</div>} />
        <Route path="/login/relay" element={<RelayLoginProbe />} />
        <Route path="/-/relay/:relayUsername" element={<RelayConnectionGate />}>
          <Route path="document" element={<CachedDocument />} />
        </Route>
      </Routes>
    </MemoryRouter>
  );
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
}

describe("RelayConnectionGate", () => {
  beforeEach(() => {
    documentMounts = 0;
    documentUnmounts = 0;
    committedDocumentPaths.length = 0;
    testState.connectViaRelay.mockReset();
    testState.clearHostSession.mockReset();
    testState.disconnect.mockReset();
    testState.remote = {
      connection: {},
      connectViaRelay: testState.connectViaRelay,
      currentHostId: "host-1",
      currentRelayUsername: "macbook",
      disconnect: testState.disconnect,
      isAutoResuming: false,
      isIntentionalDisconnect: false,
      setCurrentHostId: vi.fn(),
    };
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("keeps an unsaved active relay host connected", async () => {
    testState.remote = {
      ...testState.remote,
      currentHostId: null,
      currentRelayUsername: "macbook",
    };

    render(<TestRoutes />);

    expect(
      await screen.findByRole("button", { name: "Loaded document" }),
    ).toBeTruthy();
    expect(testState.disconnect).not.toHaveBeenCalled();
  });

  it("never commits the destination document under the previous host's connected state", async () => {
    render(<TestRoutes />);
    await screen.findByRole("button", { name: "Loaded document" });
    fireEvent.click(screen.getByRole("button", { name: "Open laptop" }));
    expect(testState.disconnect).toHaveBeenCalled();
    expect(committedDocumentPaths).toEqual(["/-/relay/macbook/document"]);
    expect(screen.queryByTestId("connected-content")).toBeNull();
  });

  it("ignores a superseded host attempt that rejects after the current route connects", async () => {
    const firstAttempt = deferred<void>();
    const secondAttempt = deferred<void>();
    testState.remote = {
      ...testState.remote,
      connection: null,
      currentHostId: null,
      currentRelayUsername: null,
    };
    testState.connectViaRelay
      .mockReturnValueOnce(firstAttempt.promise)
      .mockReturnValueOnce(secondAttempt.promise);

    render(<TestRoutes />);
    await waitFor(() =>
      expect(testState.connectViaRelay).toHaveBeenCalledTimes(1),
    );
    fireEvent.click(screen.getByRole("button", { name: "Open laptop" }));
    await waitFor(() =>
      expect(testState.connectViaRelay).toHaveBeenCalledTimes(2),
    );

    secondAttempt.resolve(undefined);
    expect(
      await screen.findByRole("button", { name: "Loaded document" }),
    ).toBeTruthy();

    firstAttempt.reject(new Error("Failed to connect to relay server"));
    await waitFor(() => {
      expect(screen.queryByText("Relay Unreachable")).toBeNull();
    });
    expect(
      screen.getByRole("button", { name: "Loaded document" }),
    ).toBeTruthy();
  });

  it("cancels a pending provider attempt when the replacement route has no host", async () => {
    const pendingAttempt = deferred<void>();
    testState.remote = {
      ...testState.remote,
      connection: null,
      currentHostId: null,
      currentRelayUsername: null,
    };
    testState.connectViaRelay.mockReturnValueOnce(pendingAttempt.promise);

    render(<TestRoutes />);
    await waitFor(() =>
      expect(testState.connectViaRelay).toHaveBeenCalledOnce(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Open unknown" }));

    expect(await screen.findByText("Relay login")).toBeTruthy();
    expect(testState.disconnect).toHaveBeenCalledWith(false);
    pendingAttempt.resolve(undefined);
    await Promise.resolve();
    expect(screen.queryByTestId("connected-content")).toBeNull();
  });

  it("dismisses a post-connect relay error without unmounting cached content", async () => {
    const view = render(<TestRoutes />);
    const loadedDocument = await screen.findByRole("button", {
      name: "Loaded document",
    });
    fireEvent.click(loadedDocument);
    expect(
      screen.getByRole("button", { name: "Edited local view" }),
    ).toBeTruthy();
    expect(documentMounts).toBe(1);

    const reconnect = deferred<void>();
    testState.connectViaRelay.mockReturnValueOnce(reconnect.promise);
    testState.remote = { ...testState.remote, connection: null };
    view.rerender(<TestRoutes />);

    await waitFor(() =>
      expect(testState.connectViaRelay).toHaveBeenCalledOnce(),
    );
    expect(
      screen.getByRole("button", { name: "Edited local view" }),
    ).toBeTruthy();
    expect(documentUnmounts).toBe(0);

    reconnect.reject(new Error("Failed to connect to relay server"));
    expect(await screen.findByText("Relay Unreachable")).toBeTruthy();
    expect(documentUnmounts).toBe(0);

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => {
      expect(screen.queryByText("Relay Unreachable")).toBeNull();
    });
    expect(
      screen.getByRole("button", { name: "Edited local view" }),
    ).toBeTruthy();
    expect(documentMounts).toBe(1);
    expect(documentUnmounts).toBe(0);
    expect(screen.queryByText("Relay login")).toBeNull();
  });

  it("keeps cached content mounted while an explicit retry succeeds", async () => {
    const view = render(<TestRoutes />);
    await screen.findByRole("button", { name: "Loaded document" });

    testState.connectViaRelay.mockRejectedValueOnce(
      new Error("Failed to connect to relay server"),
    );
    testState.remote = { ...testState.remote, connection: null };
    view.rerender(<TestRoutes />);

    expect(await screen.findByText("Relay Unreachable")).toBeTruthy();
    testState.connectViaRelay.mockResolvedValueOnce(undefined);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() =>
      expect(testState.connectViaRelay).toHaveBeenCalledTimes(2),
    );
    await waitFor(() => {
      expect(screen.queryByText("Relay Unreachable")).toBeNull();
    });
    expect(
      screen.getByRole("button", { name: "Loaded document" }),
    ).toBeTruthy();
    expect(documentMounts).toBe(1);
    expect(documentUnmounts).toBe(0);
  });

  it("opens the host picker after an intentional Switch Host disconnect", () => {
    testState.remote = {
      ...testState.remote,
      connection: null,
      isIntentionalDisconnect: true,
    };

    render(<TestRoutes />);

    expect(screen.getByText("Host picker")).toBeTruthy();
    expect(testState.connectViaRelay).not.toHaveBeenCalled();
  });

  it("explains explicit rejection before the user chooses login", async () => {
    const view = render(<TestRoutes />);
    await screen.findByRole("button", { name: "Loaded document" });

    testState.connectViaRelay.mockRejectedValueOnce(
      new ResumeError("rejected", "Server rejected session resume: expired"),
    );
    testState.remote = { ...testState.remote, connection: null };
    view.rerender(<TestRoutes />);

    expect(
      await screen.findByText("Server rejected session resume: expired"),
    ).toBeTruthy();
    // Credential retirement belongs to the attempted handshake, not mutable UI host state.
    expect(testState.clearHostSession).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(documentUnmounts).toBe(0);
    fireEvent.click(screen.getByRole("button", { name: "Go to Login" }));
    expect(await screen.findByText("Relay login")).toBeTruthy();
  });

  it("opens the prefilled login form when the first resume is rejected", async () => {
    testState.remote = {
      ...testState.remote,
      connection: null,
      currentHostId: null,
      currentRelayUsername: null,
    };
    testState.connectViaRelay.mockRejectedValueOnce(
      new ResumeError("rejected", "Server rejected session resume: expired"),
    );

    render(<TestRoutes />);

    expect(await screen.findByText("Relay login")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Go to Login" })).toBeNull();
    // Credential retirement belongs to the attempted handshake, not mutable UI host state.
    expect(testState.clearHostSession).not.toHaveBeenCalled();
    expect(screen.getByTestId("relay-login-reason").textContent).toBe(
      "auth_failed",
    );
    const query = new URLSearchParams(
      screen.getByTestId("relay-login-query").textContent ?? "",
    );
    expect(query.get("u")).toBe("macbook");
    expect(query.get("r")).toBe("wss://relay.example.test/ws");
  });
});
