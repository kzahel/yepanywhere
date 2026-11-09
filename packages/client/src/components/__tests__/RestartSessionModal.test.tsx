// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ProviderInfo } from "@yep-anywhere/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RestartSessionModal } from "../RestartSessionModal";

/**
 * `NewSessionForm` is stubbed here on purpose. Its selection behavior has its
 * own suite; what this dialog owns is the draft it seeds, the launch options
 * it passes, and the restart it sends.
 */
const { mockRestartSession, mockGetRestartHandoff, formProps } = vi.hoisted(
  () => ({
    mockRestartSession: vi.fn(),
    mockGetRestartHandoff: vi.fn(),
    formProps: { current: null as Record<string, unknown> | null },
  }),
);

type LaunchStub = {
  initialMessage: string;
  composer?: "editable" | "muted";
  startLabel?: string;
  submit: (request: {
    message: string;
    options: Record<string, unknown>;
    clientTimestamp: number;
  }) => Promise<void>;
};

vi.mock("../NewSessionForm", () => ({
  NewSessionForm: (props: Record<string, unknown>) => {
    formProps.current = props;
    const launch = props.launch as LaunchStub;
    return (
      <div data-testid="new-session-form">
        <span data-testid="seeded-message">{launch.initialMessage}</span>
        <span data-testid="composer-mode">{String(launch.composer)}</span>
        <button
          type="button"
          onClick={() => {
            void launch
              .submit({
                // The real form sends the composer's current text; an unedited
                // handoff sends exactly what was seeded.
                message: launch.initialMessage,
                options: { provider: "codex", model: "gpt-5.5" },
                clientTimestamp: 1,
              })
              .catch(() => {});
          }}
        >
          {launch.startLabel}
        </button>
      </div>
    );
  },
}));

vi.mock("../../api/client", () => ({
  api: {
    restartSession: mockRestartSession,
    getRestartHandoff: mockGetRestartHandoff,
  },
}));

vi.mock("../../i18n", () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, string>) =>
      params ? `${key}:${Object.values(params).join(",")}` : key,
  }),
}));

const providerInfo = (
  provider: "claude" | "codex",
  models: ProviderInfo["models"],
  extra?: Partial<ProviderInfo>,
): ProviderInfo => ({
  name: provider,
  displayName: provider === "claude" ? "Claude" : "Codex",
  installed: true,
  authenticated: true,
  enabled: true,
  models,
  ...extra,
});

const forkableProviders = [
  providerInfo("claude", [{ id: "sonnet", name: "Sonnet" }], {
    supportsForkSession: true,
  }),
];

function renderModal(overrides?: Record<string, unknown>) {
  return render(
    <RestartSessionModal
      projectId="proj-1"
      sessionId="sess-1"
      provider="claude"
      providerDisplayName="Claude"
      providers={[providerInfo("claude", [{ id: "sonnet", name: "Sonnet" }])]}
      currentModel="sonnet"
      mode="default"
      thinking="off"
      onRestarted={vi.fn()}
      onClose={vi.fn()}
      {...overrides}
    />,
  );
}

describe("RestartSessionModal", () => {
  beforeEach(() => {
    formProps.current = null;
    mockGetRestartHandoff.mockResolvedValue({
      handoff: "# Handoff\n\nwhat the successor needs",
      handoffTitle: "Handoff: something",
      compactStatus: "completed",
    });
    mockRestartSession.mockResolvedValue({
      sessionId: "sess-new",
      processId: "proc-new",
      permissionMode: "default",
      modeVersion: 0,
      oldProcessAborted: false,
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("offers the computed handoff as an editable draft", async () => {
    renderModal();

    await waitFor(() => {
      expect(screen.getByTestId("seeded-message").textContent).toBe(
        "# Handoff\n\nwhat the successor needs",
      );
    });
    expect(screen.getByTestId("composer-mode").textContent).toBe("editable");
    expect(mockGetRestartHandoff).toHaveBeenCalledWith("proj-1", "sess-1", {
      sourceUrl: expect.any(String),
    });
  });

  it("sends the draft as the handoff text", async () => {
    renderModal();
    // The draft arrives asynchronously; starting before it lands would send an
    // empty handoff.
    await waitFor(() =>
      expect(screen.getByTestId("seeded-message").textContent).toBeTruthy(),
    );

    fireEvent.click(
      screen.getByRole("button", { name: "sessionRestartStart" }),
    );

    await waitFor(() => {
      expect(mockRestartSession).toHaveBeenCalledWith(
        "proj-1",
        "sess-1",
        expect.objectContaining({
          handoffText: "# Handoff\n\nwhat the successor needs",
          restartMode: undefined,
          reason: "Manual restart from Yep Anywhere",
        }),
      );
    });
  });

  it("carries the source session's settings into the form", async () => {
    renderModal({
      thinking: "on:xhigh",
      mode: "plan",
      currentModel: "opus",
    });

    await waitFor(() => expect(formProps.current).not.toBeNull());
    expect(formProps.current).toMatchObject({
      preferredProvider: "claude",
      preferredModel: "opus",
      preferredThinking: "on:xhigh",
      preferredPermissionMode: "plan",
    });
    const launch = formProps.current?.launch as LaunchStub & {
      fixedProject?: boolean;
      allowAttachments?: boolean;
    };
    expect(launch.fixedProject).toBe(true);
    expect(launch.allowAttachments).toBe(false);
  });

  it("mutes the composer for fork and sends no handoff text", async () => {
    renderModal({ providers: forkableProviders });
    await screen.findByTestId("new-session-form");

    fireEvent.click(
      screen.getByRole("radio", { name: "sessionRestartModeFork" }),
    );

    await waitFor(() => {
      // The draft stays readable but reads as inert: a fork copies the real
      // transcript rather than sending it.
      expect(screen.getByTestId("composer-mode").textContent).toBe("muted");
    });
    fireEvent.click(
      screen.getByRole("button", { name: "sessionRestartStartFork" }),
    );

    await waitFor(() => {
      expect(mockRestartSession).toHaveBeenCalledWith(
        "proj-1",
        "sess-1",
        expect.objectContaining({
          // A fork copies the real transcript, so it pins to the source
          // provider and sends no message of its own.
          provider: "claude",
          restartMode: "fork",
          handoffText: undefined,
          reason: undefined,
          sourceUrl: undefined,
        }),
      );
    });
  });

  it("offers fork only when the source provider supports it", async () => {
    renderModal();
    await screen.findByTestId("new-session-form");

    expect(
      screen.queryByRole("radio", { name: "sessionRestartModeFork" }),
    ).toBeNull();
  });

  it("withholds fork while the source session is over its usage limit", async () => {
    renderModal({
      providers: forkableProviders,
      providerRuntimeStatus: {
        kind: "retrying",
        provider: "claude",
        reason: "rate_limit",
        startedAt: "2026-08-01T00:00:00.000Z",
        lastSeenAt: "2026-08-01T00:00:00.000Z",
        retryAt: "2026-08-01T03:00:00.000Z",
        eventCount: 1,
        source: "test",
      },
    });
    await screen.findByTestId("new-session-form");

    // Forking replays the whole transcript into the same limit, so the option
    // is withheld rather than offered and failed.
    expect(
      screen.queryByRole("radio", { name: "sessionRestartModeFork" }),
    ).toBeNull();
    expect(screen.getByText(/sessionRestartForkRateLimitedUntil/)).toBeTruthy();
    // Handoff remains available: its bounded summary is the way out.
    expect(screen.getByTestId("composer-mode").textContent).toBe("editable");
  });

  it("surfaces a draft that could not be loaded", async () => {
    mockGetRestartHandoff.mockRejectedValue(new Error("no transcript"));
    renderModal();

    expect(await screen.findByText("no transcript")).toBeTruthy();
  });

  it("reports a failed restart without closing", async () => {
    mockRestartSession.mockRejectedValue(new Error("supervisor is busy"));
    const onRestarted = vi.fn();
    renderModal({ onRestarted });
    await screen.findByText("sessionRestartStart");

    fireEvent.click(
      screen.getByRole("button", { name: "sessionRestartStart" }),
    );

    expect(await screen.findByText("supervisor is busy")).toBeTruthy();
    expect(onRestarted).not.toHaveBeenCalled();
  });
});
