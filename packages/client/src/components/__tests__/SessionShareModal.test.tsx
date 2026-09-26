// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../api/client";
import { I18nProvider } from "../../i18n";
import {
  asClientSummarySourceKey,
  resetClientSummaryStoreForTests,
  setCurrentClientSummarySourceKey,
} from "../../lib/clientSummaryStore";
import { SessionShareModal } from "../SessionShareModal";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function managedItem(
  shareId: string,
  title: string,
  mode: "frozen" | "live" = "frozen",
) {
  return {
    shareId,
    url: `https://ya.graehl.org/share/${shareId}?h=test-host`,
    mode,
    title,
    projectName: "project",
    sessionId: "session-1",
    provider: "codex" as const,
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt: "2026-05-01T00:01:00.000Z",
    capturedAt: "2026-05-01T00:01:00.000Z",
    snapshotBytes: 2048,
    activeViewerCount: 0,
    hasViewerSnapshots: false,
  };
}

describe("SessionShareModal", () => {
  const writeText = vi.fn();

  beforeEach(() => {
    resetClientSummaryStoreForTests();
    vi.spyOn(api, "getPublicSessionShareStatus").mockResolvedValue({
      activeCount: 0,
      frozenCount: 0,
      liveCount: 0,
      activeViewerCount: 0,
      viewers: [],
    });
    vi.spyOn(api, "createPublicSessionShare").mockResolvedValue({
      url: "https://ya.graehl.org/share/secret?h=test-host",
      shareId: "share-1",
      mode: "frozen",
      createdAt: "2026-05-01T00:00:00.000Z",
      secretBits: 512,
    });
    vi.spyOn(api, "revokePublicSessionShares").mockResolvedValue({
      activeCount: 0,
      frozenCount: 0,
      liveCount: 0,
      activeViewerCount: 0,
      viewers: [],
      revokedCount: 2,
    });
    vi.spyOn(api, "freezePublicSessionLiveShares").mockResolvedValue({
      activeCount: 1,
      frozenCount: 1,
      liveCount: 0,
      activeViewerCount: 0,
      viewers: [],
      convertedCount: 1,
    });
    vi.spyOn(api, "freezePublicSessionViewerToken").mockResolvedValue({
      activeCount: 1,
      frozenCount: 0,
      liveCount: 1,
      activeViewerCount: 0,
      viewers: [
        {
          viewerId: "viewer-token-1",
          shortId: "viewer-t",
          firstSeenAt: "2026-05-01T00:00:00.000Z",
          lastSeenAt: "2026-05-01T00:01:00.000Z",
          accessCount: 2,
          active: false,
          disconnected: false,
          frozen: true,
        },
      ],
      viewerId: "viewer-token-1",
      convertedCount: 1,
    });
    vi.spyOn(api, "disconnectPublicSessionViewerToken").mockResolvedValue({
      activeCount: 1,
      frozenCount: 0,
      liveCount: 1,
      activeViewerCount: 0,
      viewers: [],
      viewerId: "viewer-token-1",
    });
    vi.spyOn(api, "getPublicShares").mockResolvedValue({
      items: [
        {
          shareId: "share-1",
          url: "https://ya.graehl.org/share/secret?h=test-host",
          mode: "frozen",
          title: "Build logs",
          projectName: "project",
          sessionId: "session-1",
          provider: "codex",
          createdAt: "2026-05-01T00:00:00.000Z",
          updatedAt: "2026-05-01T00:01:00.000Z",
          capturedAt: "2026-05-01T00:01:00.000Z",
          linkedFileMode: "live",
          snapshotBytes: 2048,
          activeViewerCount: 0,
          hasViewerSnapshots: false,
        },
      ],
      nextCursor: null,
      totalCount: 1,
    });
    vi.spyOn(api, "revokePublicShare").mockResolvedValue({ revoked: true });
    vi.spyOn(api, "freezePublicShares").mockResolvedValue({
      convertedCount: 1,
    });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    // vi.restoreAllMocks() only restores spies, so reset this shared mock.
    writeText.mockReset();
    writeText.mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
    resetClientSummaryStoreForTests();
    vi.restoreAllMocks();
    delete (globalThis as { ClipboardItem?: unknown }).ClipboardItem;
  });

  it("writes to the clipboard before the slow share request resolves", async () => {
    // Defer the create so we can observe that the clipboard write is initiated
    // from the click's user-activation rather than after the round-trip.
    let resolveCreate: (value: {
      url: string;
      mode: "frozen";
      createdAt: string;
      secretBits: number;
    }) => void = () => {};
    vi.mocked(api.createPublicSessionShare).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCreate = resolve;
        }),
    );
    const write = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { write, writeText },
    });
    class FakeClipboardItem {
      constructor(public items: Record<string, Promise<Blob>>) {}
    }
    Object.defineProperty(globalThis, "ClipboardItem", {
      configurable: true,
      value: FakeClipboardItem,
    });

    render(
      <I18nProvider>
        <SessionShareModal
          projectId="cHJvamVjdA"
          sessionId="session-1"
          title="Build logs"
          onClose={vi.fn()}
        />
      </I18nProvider>,
    );

    fireEvent.click(
      screen.getByRole("button", { name: /Copy Frozen Snapshot Link/ }),
    );

    // The promise-valued write is dispatched before the share URL exists, so the
    // activation is captured even when the create is slow.
    await waitFor(() => expect(write).toHaveBeenCalledTimes(1));
    expect(writeText).not.toHaveBeenCalled();

    resolveCreate({
      url: "https://ya.graehl.org/share/secret?h=test-host",
      mode: "frozen",
      createdAt: "2026-05-01T00:00:00.000Z",
      secretBits: 512,
    });

    await waitFor(() => {
      expect(
        screen.getByText("Public share link copied to clipboard."),
      ).toBeTruthy();
    });
  });

  it("creates and copies a frozen public share in one click", async () => {
    render(
      <I18nProvider>
        <SessionShareModal
          projectId="cHJvamVjdA"
          sessionId="session-1"
          initialPrompt="first prompt"
          title="Build logs"
          onClose={vi.fn()}
        />
      </I18nProvider>,
    );

    fireEvent.click(
      screen.getByRole("button", { name: /Copy Frozen Snapshot Link/ }),
    );

    await waitFor(() => {
      expect(api.createPublicSessionShare).toHaveBeenCalledWith({
        projectId: "cHJvamVjdA",
        sessionId: "session-1",
        mode: "frozen",
        initialPrompt: "first prompt",
        title: "Build logs",
      });
    });
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(
        "https://ya.graehl.org/share/secret?h=test-host",
      );
      expect(
        screen.getByDisplayValue(
          "https://ya.graehl.org/share/secret?h=test-host",
        ),
      ).toBeTruthy();
      expect(
        screen.getByText("Public share link copied to clipboard."),
      ).toBeTruthy();
    });
  });

  it("creates and copies a live public share in one click", async () => {
    const onStatusChange = vi.fn();
    render(
      <I18nProvider>
        <SessionShareModal
          projectId="cHJvamVjdA"
          sessionId="session-1"
          title="Build logs"
          onStatusChange={onStatusChange}
          onClose={vi.fn()}
        />
      </I18nProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: /Copy Live Link/ }));

    await waitFor(() => {
      expect(api.createPublicSessionShare).toHaveBeenCalledWith(
        expect.objectContaining({ mode: "live" }),
      );
    });
    await waitFor(() => {
      expect(onStatusChange).toHaveBeenCalledWith(
        expect.objectContaining({
          activeCount: 1,
          liveCount: 1,
        }),
      );
    });
  });

  it("shows manual copy guidance without legacy copy fallbacks", async () => {
    writeText.mockRejectedValueOnce(new Error("Document is not focused"));
    const execCommand = vi.fn();
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: execCommand,
    });

    render(
      <I18nProvider>
        <SessionShareModal
          projectId="cHJvamVjdA"
          sessionId="session-1"
          title="Build logs"
          onClose={vi.fn()}
        />
      </I18nProvider>,
    );

    fireEvent.click(
      screen.getByRole("button", { name: /Copy Frozen Snapshot Link/ }),
    );

    await waitFor(() => {
      expect(
        screen.getByText(
          "Public share link created. Clipboard access was blocked; select the link above to copy it manually.",
        ),
      ).toBeTruthy();
    });
    expect(execCommand).not.toHaveBeenCalled();
    expect(screen.queryByText("Document is not focused")).toBeNull();
    expect(
      screen.getByDisplayValue(
        "https://ya.graehl.org/share/secret?h=test-host",
      ),
    ).toBeTruthy();
  });

  it("tries async clipboard even when document focus is unreliable", async () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: vi.fn(() => true),
    });

    render(
      <I18nProvider>
        <SessionShareModal
          projectId="cHJvamVjdA"
          sessionId="session-1"
          title="Build logs"
          onClose={vi.fn()}
        />
      </I18nProvider>,
    );

    fireEvent.click(
      screen.getByRole("button", { name: /Copy Frozen Snapshot Link/ }),
    );

    await waitFor(() => {
      expect(
        screen.getByText("Public share link copied to clipboard."),
      ).toBeTruthy();
    });
    expect(writeText).toHaveBeenCalledWith(
      "https://ya.graehl.org/share/secret?h=test-host",
    );
  });

  it("shows revoke all only when the session already has active shares", async () => {
    vi.mocked(api.getPublicSessionShareStatus).mockResolvedValue({
      activeCount: 2,
      frozenCount: 1,
      liveCount: 1,
      activeViewerCount: 3,
      viewers: [],
    });

    render(
      <I18nProvider>
        <SessionShareModal
          projectId="cHJvamVjdA"
          sessionId="session-1"
          title="Build logs"
          onClose={vi.fn()}
        />
      </I18nProvider>,
    );

    const revoke = await screen.findByRole("button", {
      name: "Revoke All Shared Links",
    });
    expect(
      screen.getByLabelText(
        "3 active viewer(s), 0 token(s), 1 live link(s), 1 snapshot link(s)",
      ),
    ).toBeTruthy();
    fireEvent.click(revoke);

    await waitFor(() => {
      expect(api.revokePublicSessionShares).toHaveBeenCalledWith(
        "cHJvamVjdA",
        "session-1",
      );
    });
    expect(screen.getByText("Revoked 2 shared link(s).")).toBeTruthy();
  });

  it("freezes all live public links", async () => {
    vi.mocked(api.getPublicSessionShareStatus).mockResolvedValue({
      activeCount: 1,
      frozenCount: 0,
      liveCount: 1,
      activeViewerCount: 0,
      viewers: [],
    });

    render(
      <I18nProvider>
        <SessionShareModal
          projectId="cHJvamVjdA"
          sessionId="session-1"
          title="Build logs"
          onClose={vi.fn()}
        />
      </I18nProvider>,
    );

    fireEvent.click(
      await screen.findByRole("button", {
        name: "Stop live updates",
      }),
    );

    await waitFor(() => {
      expect(api.freezePublicSessionLiveShares).toHaveBeenCalledWith(
        "cHJvamVjdA",
        "session-1",
      );
    });
    expect(
      screen.getByText(
        "Live updates stopped for 1 link(s); they now open as frozen snapshots.",
      ),
    ).toBeTruthy();
  });

  it("shows viewer tokens with freeze and disconnect controls", async () => {
    vi.mocked(api.getPublicSessionShareStatus).mockResolvedValue({
      activeCount: 1,
      frozenCount: 0,
      liveCount: 1,
      activeViewerCount: 1,
      viewers: [
        {
          viewerId: "viewer-token-1",
          shortId: "viewer-t",
          firstSeenAt: "2026-05-01T00:00:00.000Z",
          lastSeenAt: "2026-05-01T00:01:00.000Z",
          accessCount: 2,
          active: true,
          disconnected: false,
          frozen: false,
        },
      ],
    });

    render(
      <I18nProvider>
        <SessionShareModal
          projectId="cHJvamVjdA"
          sessionId="session-1"
          title="Build logs"
          onClose={vi.fn()}
        />
      </I18nProvider>,
    );

    expect(await screen.findByText("viewer-t")).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", {
        name: "Snapshot this token viewer-t",
      }),
    );
    await waitFor(() => {
      expect(api.freezePublicSessionViewerToken).toHaveBeenCalledWith(
        "cHJvamVjdA",
        "session-1",
        "viewer-token-1",
      );
    });
    expect(
      await screen.findByText(
        "Token viewer-t will see a snapshot from now on.",
      ),
    ).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", {
        name: "Disconnect this token viewer-t",
      }),
    );
    await waitFor(() => {
      expect(api.disconnectPublicSessionViewerToken).toHaveBeenCalledWith(
        "cHJvamVjdA",
        "session-1",
        "viewer-token-1",
      );
    });
  });

  it("opens compact session management without creating a link", async () => {
    render(
      <I18nProvider>
        <SessionShareModal
          projectId="cHJvamVjdA"
          sessionId="session-1"
          title="Build logs"
          managementAvailable
          onClose={vi.fn()}
        />
      </I18nProvider>,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Manage This Session’s Shares" }),
    );

    expect(await screen.findByText("Build logs")).toBeTruthy();
    expect(api.getPublicShares).toHaveBeenCalledWith({
      projectId: "cHJvamVjdA",
      sessionId: "session-1",
      mode: undefined,
    });
    const scope = screen.getByRole("group", { name: "Show" });
    expect(
      scope.querySelector('button[aria-pressed="true"]')?.textContent,
    ).toBe("This session");
    expect(
      screen.queryByRole("button", { name: "Share This Session" }),
    ).toBeNull();
    const shareType = screen.getByRole("group", { name: "Share type" });
    expect(
      shareType.querySelectorAll('button[aria-pressed="true"]'),
    ).toHaveLength(2);
    expect(screen.getByText(/0 active public viewer/)).toBeTruthy();
    expect(screen.getByRole("img", { name: "Frozen" })).toBeTruthy();
    expect(api.createPublicSessionShare).not.toHaveBeenCalled();
    expect(screen.getByText(/could not snapshot linked files/i)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "All projects" }));
    await waitFor(() => {
      expect(api.getPublicShares).toHaveBeenLastCalledWith({
        projectId: undefined,
        sessionId: undefined,
        mode: undefined,
      });
    });
    expect(
      screen.getByRole("button", {
        name: "Review all Frozen share links in All projects for revocation",
      }),
    ).toBeTruthy();
  });

  it("replaces manager ownership when the backend source changes", async () => {
    const sourceAInventory =
      deferred<Awaited<ReturnType<typeof api.getPublicShares>>>();
    vi.mocked(api.getPublicShares)
      .mockReturnValueOnce(sourceAInventory.promise)
      .mockResolvedValue({
        items: [managedItem("source-b", "Source B inventory")],
        nextCursor: null,
        totalCount: 1,
      });
    setCurrentClientSummarySourceKey(asClientSummarySourceKey("host:source-a"));

    render(
      <I18nProvider>
        <SessionShareModal
          initialView="manage"
          managementAvailable
          onClose={vi.fn()}
        />
      </I18nProvider>,
    );
    await waitFor(() => expect(api.getPublicShares).toHaveBeenCalledTimes(1));

    act(() => {
      setCurrentClientSummarySourceKey(
        asClientSummarySourceKey("host:source-b"),
      );
    });
    expect(await screen.findByText("Source B inventory")).toBeTruthy();

    sourceAInventory.resolve({
      items: [managedItem("source-a", "Stale source A inventory")],
      nextCursor: null,
      totalCount: 1,
    });
    await waitFor(() => {
      expect(screen.queryByText("Stale source A inventory")).toBeNull();
      expect(screen.getByText("Source B inventory")).toBeTruthy();
    });
    expect(api.getPublicShares).toHaveBeenCalledTimes(2);
  });

  it("creates, copies, and highlights a managed link from the type rail", async () => {
    render(
      <I18nProvider>
        <SessionShareModal
          projectId="cHJvamVjdA"
          sessionId="session-1"
          title="Build logs"
          initialView="manage"
          managementAvailable
          onClose={vi.fn()}
        />
      </I18nProvider>,
    );

    await screen.findByText("Build logs");
    fireEvent.click(
      screen.getByRole("button", {
        name: "Create and copy Frozen link",
      }),
    );

    await waitFor(() => {
      expect(api.createPublicSessionShare).toHaveBeenCalledWith(
        expect.objectContaining({ mode: "frozen" }),
      );
      expect(writeText).toHaveBeenCalledWith(
        "https://ya.graehl.org/share/secret?h=test-host",
      );
    });
    expect((await screen.findByRole("listitem")).className).toContain(
      "rowHighlighted",
    );
  });

  it("does not let a pending create reopen category preparation", async () => {
    const create =
      deferred<Awaited<ReturnType<typeof api.createPublicSessionShare>>>();
    vi.mocked(api.createPublicSessionShare).mockReturnValue(create.promise);

    render(
      <I18nProvider>
        <SessionShareModal
          projectId="cHJvamVjdA"
          sessionId="session-1"
          initialView="manage"
          managementAvailable
          onClose={vi.fn()}
        />
      </I18nProvider>,
    );

    await screen.findByText("Build logs");
    vi.mocked(api.getPublicShares).mockClear();
    const createButton = screen.getByRole("button", {
      name: "Create and copy Frozen link",
    });
    const scopeFilter = screen.getByRole("button", {
      name: /^All projects$/,
    });
    const copy = screen.getByRole("button", { name: "Copy public link" });
    const prepare = screen.getByRole("button", {
      name: "Review all Frozen share links in This session for revocation",
    });

    fireEvent.click(createButton);
    expect(scopeFilter).toHaveProperty("disabled", true);
    expect(copy).toHaveProperty("disabled", true);
    expect(prepare).toHaveProperty("disabled", true);
    fireEvent.click(scopeFilter);
    fireEvent.click(copy);
    fireEvent.click(prepare);
    expect(api.getPublicShares).not.toHaveBeenCalled();
    expect(writeText).not.toHaveBeenCalled();

    create.resolve({
      url: "https://ya.graehl.org/share/created?h=test-host",
      shareId: "created",
      mode: "frozen",
      createdAt: "2026-05-01T00:00:00.000Z",
      secretBits: 512,
    });
    await waitFor(() => expect(createButton).toHaveProperty("disabled", false));
  });

  it("offers scoped type revokes before inventory resolves", () => {
    vi.mocked(api.getPublicShares).mockImplementation(
      () => new Promise(() => {}),
    );
    render(
      <I18nProvider>
        <SessionShareModal
          projectId="cHJvamVjdA"
          sessionId="session-1"
          initialView="manage"
          managementAvailable
          onClose={vi.fn()}
        />
      </I18nProvider>,
    );

    expect(
      screen.getByRole("button", {
        name: "Review all Frozen share links in This session for revocation",
      }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", {
        name: "Review all Live share links in This session for revocation",
      }),
    ).toBeTruthy();
  });

  it("copies a retained managed link", async () => {
    render(
      <I18nProvider>
        <SessionShareModal
          initialView="manage"
          managementAvailable
          onClose={vi.fn()}
        />
      </I18nProvider>,
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "Copy public link" }),
    );
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(
        "https://ya.graehl.org/share/secret?h=test-host",
      );
    });
  });

  it("does not let stale copy overwrite a newer create notice", async () => {
    const staleCopy = deferred<void>();
    writeText.mockImplementationOnce(() => staleCopy.promise);
    vi.mocked(api.createPublicSessionShare).mockResolvedValueOnce({
      url: "https://ya.graehl.org/share/created?h=test-host",
      shareId: "created",
      mode: "frozen",
      createdAt: "2026-05-01T00:00:00.000Z",
      secretBits: 512,
    });

    render(
      <I18nProvider>
        <SessionShareModal
          projectId="cHJvamVjdA"
          sessionId="session-1"
          initialView="manage"
          managementAvailable
          onClose={vi.fn()}
        />
      </I18nProvider>,
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "Copy public link" }),
    );
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    fireEvent.click(
      screen.getByRole("button", {
        name: "Create and copy Frozen link",
      }),
    );
    expect(
      await screen.findByText("Public share link copied to clipboard."),
    ).toBeTruthy();
    expect(writeText).toHaveBeenCalledTimes(2);

    staleCopy.resolve(undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(
      screen.getByText("Public share link copied to clipboard."),
    ).toBeTruthy();
    expect(screen.queryByText("Public link copied to clipboard.")).toBeNull();
    expect((await screen.findByRole("listitem")).className).not.toContain(
      "rowHighlighted",
    );
  });

  it("revokes one opaque managed link", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    // Once revoked, the inventory refresh must not return the link again;
    // otherwise the empty state shows only until that refresh lands.
    vi.mocked(api.revokePublicShare).mockImplementation(async () => {
      vi.mocked(api.getPublicShares).mockResolvedValue({
        items: [],
        nextCursor: null,
        totalCount: 0,
      });
      return { revoked: true };
    });
    render(
      <I18nProvider>
        <SessionShareModal
          initialView="manage"
          managementAvailable
          onClose={vi.fn()}
        />
      </I18nProvider>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Revoke" }));
    await waitFor(() => {
      expect(api.revokePublicShare).toHaveBeenCalledWith("share-1");
    });
    expect(await screen.findByText("No matching public links.")).toBeTruthy();
  });

  it("hides selective freeze controls without the indexed capability", async () => {
    vi.mocked(api.getPublicShares).mockResolvedValue({
      items: [managedItem("live-link", "Live link", "live")],
      nextCursor: null,
      totalCount: 1,
    });
    render(
      <I18nProvider>
        <SessionShareModal
          initialView="manage"
          managementAvailable
          managementFreezeAvailable={false}
          onClose={vi.fn()}
        />
      </I18nProvider>,
    );

    await screen.findByText("Live link");
    expect(
      screen.queryByRole("button", { name: "Freeze at current state" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", {
        name: "Review all Live share links in All projects for freezing",
      }),
    ).toBeNull();
  });

  it("confirms a live link freeze without offering it on frozen rows", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    vi.mocked(api.getPublicShares).mockResolvedValue({
      items: [
        managedItem("live-link", "Live link", "live"),
        managedItem("frozen-link", "Frozen link"),
      ],
      nextCursor: null,
      totalCount: 2,
    });
    render(
      <I18nProvider>
        <SessionShareModal
          initialView="manage"
          managementAvailable
          managementFreezeAvailable
          onClose={vi.fn()}
        />
      </I18nProvider>,
    );

    await screen.findByText("Live link");
    const freezeButtons = screen.getAllByRole("button", {
      name: "Freeze at current state",
    });
    expect(freezeButtons).toHaveLength(1);
    fireEvent.click(freezeButtons[0]!);

    expect(window.confirm).toHaveBeenCalledWith(
      "Freeze this live public link now? It will stop receiving updates, but anyone with the link will retain access to the current snapshot.",
    );
    await waitFor(() => {
      expect(api.freezePublicShares).toHaveBeenCalledWith(["live-link"]);
    });
  });

  it("reviews and freezes the exact live links in the selected scope", async () => {
    vi.mocked(api.getPublicShares).mockImplementation((options = {}) =>
      Promise.resolve(
        options.mode === "live"
          ? {
              items: [
                managedItem("live-a", "Live A", "live"),
                managedItem("frozen-race", "Already frozen"),
                managedItem("live-b", "Live B", "live"),
              ],
              nextCursor: null,
              totalCount: 3,
            }
          : {
              items: [managedItem("initial", "Initial inventory", "live")],
              nextCursor: null,
              totalCount: 1,
            },
      ),
    );
    vi.mocked(api.freezePublicShares).mockResolvedValue({ convertedCount: 2 });
    render(
      <I18nProvider>
        <SessionShareModal
          projectId="cHJvamVjdA"
          sessionId="session-1"
          initialView="manage"
          managementAvailable
          managementFreezeAvailable
          onClose={vi.fn()}
        />
      </I18nProvider>,
    );

    await screen.findByText("Initial inventory");
    fireEvent.click(
      screen.getByRole("button", {
        name: "Review all Live share links in This session for freezing",
      }),
    );

    const confirm = await screen.findByRole("button", {
      name: "Confirm: freeze 2 Live share link(s) in This session (0 active client(s))",
    });
    expect(api.freezePublicShares).not.toHaveBeenCalled();
    expect(
      screen.getByText(
        "Click again to freeze 2 Live share link(s) in This session (0 active client(s)). The links will retain the current snapshot but stop receiving updates.",
      ),
    ).toBeTruthy();
    fireEvent.click(confirm);

    await waitFor(() => {
      expect(api.freezePublicShares).toHaveBeenCalledWith(["live-a", "live-b"]);
    });
  });

  it("confirms exact type, scope, link, and viewer counts", async () => {
    render(
      <I18nProvider>
        <SessionShareModal
          projectId="cHJvamVjdA"
          sessionId="session-1"
          initialView="manage"
          managementAvailable
          onClose={vi.fn()}
        />
      </I18nProvider>,
    );

    await screen.findByText("Build logs");
    fireEvent.click(
      screen.getByRole("button", {
        name: "Review all Frozen share links in This session for revocation",
      }),
    );

    await waitFor(() => {
      expect(api.getPublicShares).toHaveBeenCalledWith({
        projectId: "cHJvamVjdA",
        sessionId: "session-1",
        mode: "frozen",
        cursor: undefined,
      });
      expect(
        screen.getByRole("button", {
          name: "Confirm: revoke 1 Frozen share link(s) in This session (0 active client(s))",
        }),
      ).toBeTruthy();
    });
    expect(
      screen.getByText(
        "Click again to revoke 1 Frozen share link(s) in This session (0 active client(s)). Anyone using one will immediately lose access.",
      ),
    ).toBeTruthy();
    expect(
      screen
        .getByText(
          "Click again to revoke 1 Frozen share link(s) in This session (0 active client(s)). Anyone using one will immediately lose access.",
        )
        .closest("button"),
    ).toBeNull();
    expect(
      screen
        .getByRole("button", { name: "Frozen" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      screen.getByRole("button", { name: "Live" }).getAttribute("aria-pressed"),
    ).toBe("false");
    expect(api.revokePublicShare).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByRole("button", {
        name: "Confirm: revoke 1 Frozen share link(s) in This session (0 active client(s))",
      }),
    );
    await waitFor(() => {
      expect(api.revokePublicShare).toHaveBeenCalledWith("share-1");
    });
  });

  it("does not let filter or copy truncate multi-link revocation", async () => {
    const firstRevoke =
      deferred<Awaited<ReturnType<typeof api.revokePublicShare>>>();
    vi.mocked(api.getPublicShares).mockImplementation((options = {}) =>
      Promise.resolve(
        options.mode === "frozen"
          ? {
              items: [
                managedItem("revoke-a", "Revoke A"),
                managedItem("revoke-b", "Revoke B"),
              ],
              nextCursor: null,
              totalCount: 2,
            }
          : {
              items: [managedItem("initial", "Initial inventory")],
              nextCursor: null,
              totalCount: 1,
            },
      ),
    );
    vi.mocked(api.revokePublicShare)
      .mockReturnValueOnce(firstRevoke.promise)
      .mockResolvedValue({ revoked: true });

    render(
      <I18nProvider>
        <SessionShareModal
          projectId="cHJvamVjdA"
          sessionId="session-1"
          initialView="manage"
          managementAvailable
          onClose={vi.fn()}
        />
      </I18nProvider>,
    );

    await screen.findByText("Initial inventory");
    fireEvent.click(
      screen.getByRole("button", {
        name: "Review all Frozen share links in This session for revocation",
      }),
    );
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Confirm: revoke 2 Frozen share link(s) in This session (0 active client(s))",
      }),
    );

    const scopeFilter = screen.getByRole("button", {
      name: /^All projects$/,
    });
    const copy = screen.getAllByRole("button", {
      name: "Copy public link",
    })[0];
    if (!copy) throw new Error("Expected a managed-link copy control");
    expect(scopeFilter).toHaveProperty("disabled", true);
    expect(copy).toHaveProperty("disabled", true);
    fireEvent.click(scopeFilter);
    fireEvent.click(copy);
    expect(writeText).not.toHaveBeenCalled();

    firstRevoke.resolve({ revoked: true });
    await waitFor(() => {
      expect(api.revokePublicShare).toHaveBeenCalledTimes(2);
      expect(api.revokePublicShare).toHaveBeenNthCalledWith(1, "revoke-a");
      expect(api.revokePublicShare).toHaveBeenNthCalledWith(2, "revoke-b");
    });
  });

  it("shares the category preparation first page with visible inventory", async () => {
    render(
      <I18nProvider>
        <SessionShareModal
          projectId="cHJvamVjdA"
          sessionId="session-1"
          initialView="manage"
          managementAvailable
          onClose={vi.fn()}
        />
      </I18nProvider>,
    );

    await screen.findByText("Build logs");
    vi.mocked(api.getPublicShares).mockClear();
    fireEvent.click(
      screen.getByRole("button", {
        name: "Review all Frozen share links in This session for revocation",
      }),
    );

    await screen.findByRole("button", {
      name: "Confirm: revoke 1 Frozen share link(s) in This session (0 active client(s))",
    });
    expect(api.getPublicShares).toHaveBeenCalledTimes(1);
    expect(api.getPublicShares).toHaveBeenCalledWith({
      projectId: "cHJvamVjdA",
      sessionId: "session-1",
      mode: "frozen",
      cursor: undefined,
    });
  });

  it("announces a shared category first-page rejection once", async () => {
    render(
      <I18nProvider>
        <SessionShareModal
          projectId="cHJvamVjdA"
          sessionId="session-1"
          initialView="manage"
          managementAvailable
          onClose={vi.fn()}
        />
      </I18nProvider>,
    );

    await screen.findByText("Build logs");
    vi.mocked(api.getPublicShares).mockRejectedValueOnce(
      new Error("Category inventory unavailable"),
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "Review all Frozen share links in This session for revocation",
      }),
    );

    await waitFor(() => expect(screen.getAllByRole("alert")).toHaveLength(1));
    expect(screen.getByRole("alert").textContent).toContain(
      "Category inventory unavailable",
    );
    expect(screen.queryByText("No matching public links.")).toBeNull();
  });

  it("does not reload the first page for semantic-equivalent identity", async () => {
    const renderModal = (title: string) => (
      <I18nProvider>
        <SessionShareModal
          projectId="cHJvamVjdA"
          sessionId="session-1"
          title={title}
          initialView="manage"
          managementAvailable
          onClose={vi.fn()}
        />
      </I18nProvider>
    );
    const rendered = render(renderModal("First title"));

    await screen.findByText("Build logs");
    expect(api.getPublicShares).toHaveBeenCalledTimes(1);
    rendered.rerender(renderModal("Updated title"));
    expect(api.getPublicShares).toHaveBeenCalledTimes(1);
  });

  it("cancels an armed category revoke when another control is used", async () => {
    render(
      <I18nProvider>
        <SessionShareModal
          projectId="cHJvamVjdA"
          sessionId="session-1"
          initialView="manage"
          managementAvailable
          onClose={vi.fn()}
        />
      </I18nProvider>,
    );

    await screen.findByText("Build logs");
    fireEvent.click(
      screen.getByRole("button", {
        name: "Review all Frozen share links in This session for revocation",
      }),
    );
    await screen.findByRole("button", {
      name: "Confirm: revoke 1 Frozen share link(s) in This session (0 active client(s))",
    });

    fireEvent.click(screen.getByRole("button", { name: /^All projects$/ }));
    await waitFor(() => {
      expect(api.getPublicShares).toHaveBeenLastCalledWith({
        projectId: undefined,
        sessionId: undefined,
        mode: "frozen",
      });
      expect(
        screen.queryByText(/Click again to revoke 1 Frozen share link/),
      ).toBeNull();
    });
    expect(api.revokePublicShare).not.toHaveBeenCalled();
  });

  it("omits create controls from the global manager", async () => {
    render(
      <I18nProvider>
        <SessionShareModal
          initialView="manage"
          managementAvailable
          onClose={vi.fn()}
        />
      </I18nProvider>,
    );

    await screen.findByText("Build logs");
    expect(
      screen.queryByRole("button", { name: /Create and copy/ }),
    ).toBeNull();
  });

  it("renders inventory failure without ready-empty inventory copy", async () => {
    vi.mocked(api.getPublicShares).mockRejectedValue(
      new Error("Inventory unavailable"),
    );

    render(
      <I18nProvider>
        <SessionShareModal
          initialView="manage"
          managementAvailable
          onClose={vi.fn()}
        />
      </I18nProvider>,
    );

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Inventory unavailable",
    );
    expect(screen.queryByText("No matching public links.")).toBeNull();
    expect(screen.queryByText(/matching public link/)).toBeNull();
  });

  it("ignores a deferred Load More result after the filter changes", async () => {
    const stalePage =
      deferred<Awaited<ReturnType<typeof api.getPublicShares>>>();
    vi.mocked(api.getPublicShares).mockImplementation((options = {}) => {
      if (options.cursor === "next") return stalePage.promise;
      if (options.mode === "frozen") {
        return Promise.resolve({
          items: [managedItem("filtered", "Filtered inventory")],
          nextCursor: null,
          totalCount: 1,
        });
      }
      return Promise.resolve({
        items: [managedItem("first", "First page")],
        nextCursor: "next",
        totalCount: 2,
      });
    });

    render(
      <I18nProvider>
        <SessionShareModal
          projectId="cHJvamVjdA"
          sessionId="session-1"
          initialView="manage"
          managementAvailable
          onClose={vi.fn()}
        />
      </I18nProvider>,
    );

    await screen.findByText("First page");
    fireEvent.click(screen.getByRole("button", { name: "Load More" }));
    fireEvent.click(screen.getByRole("button", { name: "Live" }));
    expect(await screen.findByText("Filtered inventory")).toBeTruthy();

    stalePage.resolve({
      items: [managedItem("stale", "Stale next page")],
      nextCursor: null,
      totalCount: 2,
    });

    await waitFor(() => {
      expect(screen.queryByText("Stale next page")).toBeNull();
      expect(screen.getByText("Filtered inventory")).toBeTruthy();
    });
  });

  it("keeps category confirmation armed when its inert banner is clicked", async () => {
    render(
      <I18nProvider>
        <SessionShareModal
          projectId="cHJvamVjdA"
          sessionId="session-1"
          initialView="manage"
          managementAvailable
          onClose={vi.fn()}
        />
      </I18nProvider>,
    );

    await screen.findByText("Build logs");
    fireEvent.click(
      screen.getByRole("button", {
        name: "Review all Frozen share links in This session for revocation",
      }),
    );
    const confirmation = await screen.findByRole("button", {
      name: "Confirm: revoke 1 Frozen share link(s) in This session (0 active client(s))",
    });
    fireEvent.click(
      screen.getByText(
        "Click again to revoke 1 Frozen share link(s) in This session (0 active client(s)). Anyone using one will immediately lose access.",
      ),
    );

    expect(confirmation).toBeTruthy();
    expect(
      screen.getByRole("button", {
        name: "Confirm: revoke 1 Frozen share link(s) in This session (0 active client(s))",
      }),
    ).toBeTruthy();
  });

  it("disables create mutations during category preparation and deletion", async () => {
    const preparation =
      deferred<Awaited<ReturnType<typeof api.getPublicShares>>>();
    const deletion =
      deferred<Awaited<ReturnType<typeof api.revokePublicShare>>>();
    let frozenCalls = 0;
    vi.mocked(api.getPublicShares).mockImplementation((options = {}) => {
      if (options.mode === "frozen") {
        frozenCalls += 1;
        if (frozenCalls === 1) return preparation.promise;
      }
      return Promise.resolve({
        items: [managedItem("share-1", "Build logs")],
        nextCursor: null,
        totalCount: 1,
      });
    });
    vi.mocked(api.revokePublicShare).mockReturnValue(deletion.promise);

    render(
      <I18nProvider>
        <SessionShareModal
          projectId="cHJvamVjdA"
          sessionId="session-1"
          initialView="manage"
          managementAvailable
          onClose={vi.fn()}
        />
      </I18nProvider>,
    );

    await screen.findByText("Build logs");
    const create = screen.getByRole("button", {
      name: "Create and copy Frozen link",
    });
    fireEvent.click(
      screen.getByRole("button", {
        name: "Review all Frozen share links in This session for revocation",
      }),
    );
    expect(create).toHaveProperty("disabled", true);

    preparation.resolve({
      items: [managedItem("share-1", "Build logs")],
      nextCursor: null,
      totalCount: 1,
    });
    const confirm = await screen.findByRole("button", {
      name: "Confirm: revoke 1 Frozen share link(s) in This session (0 active client(s))",
    });
    expect(create).toHaveProperty("disabled", false);

    fireEvent.click(confirm);
    expect(create).toHaveProperty("disabled", true);
    deletion.resolve({ revoked: true });
    await waitFor(() => expect(create).toHaveProperty("disabled", false));
  });

  it("does not let stale category preparation re-arm confirmation", async () => {
    const preparation =
      deferred<Awaited<ReturnType<typeof api.getPublicShares>>>();
    let frozenCalls = 0;
    vi.mocked(api.getPublicShares).mockImplementation((options = {}) => {
      if (options.mode === "frozen") {
        frozenCalls += 1;
        if (frozenCalls === 1) return preparation.promise;
      }
      return Promise.resolve({
        items: [managedItem("share-1", "Build logs")],
        nextCursor: null,
        totalCount: 1,
      });
    });

    render(
      <I18nProvider>
        <SessionShareModal
          projectId="cHJvamVjdA"
          sessionId="session-1"
          initialView="manage"
          managementAvailable
          onClose={vi.fn()}
        />
      </I18nProvider>,
    );

    await screen.findByText("Build logs");
    fireEvent.click(
      screen.getByRole("button", {
        name: "Review all Frozen share links in This session for revocation",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "All projects" }));
    preparation.resolve({
      items: [managedItem("share-1", "Build logs")],
      nextCursor: null,
      totalCount: 1,
    });

    await waitFor(() => {
      expect(screen.queryByText(/Click again to revoke/)).toBeNull();
      expect(
        screen.queryByRole("button", { name: /Confirm: revoke/ }),
      ).toBeNull();
    });
  });

  it("revokes the immutable prepared IDs when inventory changes", async () => {
    const preparedInventory = {
      items: [
        managedItem("prepared-a", "Prepared A"),
        managedItem("prepared-b", "Prepared B"),
      ],
      nextCursor: null,
      totalCount: 2,
    };
    vi.mocked(api.getPublicShares).mockImplementation((options = {}) => {
      if (options.mode === "frozen") {
        return Promise.resolve(preparedInventory);
      }
      return Promise.resolve({
        items: [managedItem("initial", "Initial inventory")],
        nextCursor: null,
        totalCount: 1,
      });
    });
    const modal = () => (
      <I18nProvider>
        <SessionShareModal
          projectId="cHJvamVjdA"
          sessionId="session-1"
          initialView="manage"
          managementAvailable
          onClose={vi.fn()}
        />
      </I18nProvider>
    );
    const rendered = render(modal());

    await screen.findByText("Initial inventory");
    fireEvent.click(
      screen.getByRole("button", {
        name: "Review all Frozen share links in This session for revocation",
      }),
    );
    const confirm = await screen.findByRole("button", {
      name: "Confirm: revoke 2 Frozen share link(s) in This session (0 active client(s))",
    });

    preparedInventory.items.splice(
      0,
      preparedInventory.items.length,
      managedItem("replacement", "Replacement inventory"),
    );
    preparedInventory.totalCount = 1;
    rendered.rerender(modal());
    expect(screen.getByText("Replacement inventory")).toBeTruthy();
    vi.mocked(api.revokePublicShare).mockClear();
    fireEvent.click(confirm);

    await waitFor(() => {
      expect(api.revokePublicShare).toHaveBeenCalledTimes(2);
      expect(api.revokePublicShare).toHaveBeenNthCalledWith(1, "prepared-a");
      expect(api.revokePublicShare).toHaveBeenNthCalledWith(2, "prepared-b");
      expect(api.revokePublicShare).not.toHaveBeenCalledWith("replacement");
    });
  });

  it("makes a location category the exact shown confirmation set", async () => {
    render(
      <I18nProvider>
        <SessionShareModal
          projectId="cHJvamVjdA"
          sessionId="session-1"
          initialView="manage"
          managementAvailable
          onClose={vi.fn()}
        />
      </I18nProvider>,
    );

    await screen.findByText("Build logs");
    fireEvent.click(
      screen.getByRole("button", {
        name: "Review all share links in This project for revocation",
      }),
    );

    await waitFor(() => {
      expect(api.getPublicShares).toHaveBeenCalledWith({
        projectId: "cHJvamVjdA",
        sessionId: undefined,
        mode: undefined,
        cursor: undefined,
      });
      expect(
        screen.getByRole("button", {
          name: "Confirm: revoke 1 share link(s) in This project (0 active client(s))",
        }),
      ).toBeTruthy();
    });
    expect(
      screen
        .getByRole("button", { name: /^This project$/ })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      screen
        .getByRole("button", { name: "Frozen" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      screen.getByRole("button", { name: "Live" }).getAttribute("aria-pressed"),
    ).toBe("true");
  });
});
