// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PendingDraft } from "../../lib/draftSyncStorage";
import type { InputRequest } from "../../types";
import styles from "../ToolApprovalPanel.module.css";
import { ToolApprovalPanel } from "../ToolApprovalPanel";

const draftState = vi.hoisted(() => ({ pending: [] as PendingDraft[] }));
vi.mock("../../lib/draftSyncStorage", async (original) => ({
  ...(await original<typeof import("../../lib/draftSyncStorage")>()),
  draftSyncPending: () => draftState.pending,
}));

const translations: Record<string, string> = {
  draftSyncNotice: "Draft needs attention",
  draftSyncReview: "Review draft changes",
  draftSyncClose: "Close review",
  toolApprovalCollapse: "Collapse approval",
  toolApprovalExpand: "Expand approval",
  toolApprovalNo: "No",
  toolApprovalSend: "Send",
  toolApprovalTellInstead: "Tell Claude instead",
  toolApprovalFeedbackPlaceholder: "What should change?",
  toolApprovalYes: "Yes",
};

vi.mock("../../i18n", () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      if (key === "toolApprovalAllow") {
        return `Allow ${String(params?.tool ?? "")} ${String(params?.summary ?? "")}?`;
      }
      return translations[key] ?? key;
    },
  }),
}));

vi.mock("../../hooks/useDrafts", () => ({
  useToolApprovalFeedbackDraft: () => ["", vi.fn(), vi.fn()],
}));

vi.mock("../renderers/tools", () => ({
  toolRegistry: {
    renderToolUse: vi.fn(),
  },
}));

vi.mock("../tools/summaries", () => ({
  getToolSummary: () => "wget --spider https://example.org",
}));

const request: InputRequest = {
  id: "request-1",
  sessionId: "session-1",
  type: "tool-approval",
  prompt: "Allow the command?",
  toolName: "Bash",
  toolInput: { command: "wget --spider https://example.org?" },
  timestamp: "2026-08-01T00:00:00.000Z",
};

function renderPanel(
  props: Partial<ComponentProps<typeof ToolApprovalPanel>> = {},
) {
  return render(
    <ToolApprovalPanel
      request={request}
      sessionId="session-1"
      onApprove={vi.fn(async () => {})}
      onDeny={vi.fn(async () => {})}
      {...props}
    />,
  );
}

describe("ToolApprovalPanel", () => {
  beforeEach(() => {
    draftState.pending = [];
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("renders the approval surface with module-owned classes", () => {
    const { container } = renderPanel();
    const root = container.firstElementChild;

    expect(root).toBeTruthy();
    expect(root?.classList.contains(styles.root!)).toBe(true);
    expect(root?.querySelector(`.${styles.toggle}`)).toBeTruthy();
    expect(root?.querySelector(`.${styles.panel}`)).toBeTruthy();
    expect(root?.querySelector(`.${styles.question}`)?.textContent).toBe(
      "Allow Bash wget --spider https://example.org?",
    );
    expect(root?.querySelector(`.${styles.option}`)).toBeTruthy();
  });

  it("keeps collapse and keyboard approval actions wired to the panel", async () => {
    const onApprove = vi.fn(async () => {});
    const onDeny = vi.fn(async () => {});
    const onCollapsedChange = vi.fn();
    const { container, rerender } = render(
      <ToolApprovalPanel
        request={request}
        sessionId="session-1"
        onApprove={onApprove}
        onDeny={onDeny}
        onCollapsedChange={onCollapsedChange}
      />,
    );

    await act(async () => {
      vi.advanceTimersByTime(150);
    });

    // Keystrokes outside the panel (the composer, or the page body after the
    // composer unmounts under a typing user) must never answer the prompt.
    await act(async () => {
      fireEvent.keyDown(window, { key: "Enter" });
      fireEvent.keyDown(document.body, { key: "2" });
      await Promise.resolve();
    });
    expect(onApprove).not.toHaveBeenCalled();
    expect(onDeny).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.keyDown(screen.getByRole("button", { name: /Yes/ }), {
        key: "Enter",
      });
      await Promise.resolve();
    });
    expect(onApprove).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Collapse approval" }));
    expect(onCollapsedChange).toHaveBeenCalledWith(true);

    rerender(
      <ToolApprovalPanel
        request={request}
        sessionId="session-1"
        onApprove={onApprove}
        onDeny={onDeny}
        collapsed
        onCollapsedChange={onCollapsedChange}
      />,
    );

    const root = container.firstElementChild;
    const toggle = screen.getByRole("button", { name: "Expand approval" });
    expect(root?.querySelector(`.${styles.panel}`)).toBeNull();
    expect(
      toggle.querySelector("svg")?.classList.contains(styles.chevronUp!),
    ).toBe(true);
    fireEvent.click(toggle);
    expect(onCollapsedChange).toHaveBeenLastCalledWith(false);
  });
  it("keeps recovery review reachable when approval replaces the composer, without approving on Enter", async () => {
    draftState.pending = [
      {
        key: "draft-tool-approval-feedback:local:session-1",
        slot: { kind: "approval", sessionId: "session-1" },
        recovery: true,
        local: {
          fields: { text: "Retained approval feedback" },
          attachments: [],
        },
      },
    ];
    const onApprove = vi.fn(async () => {}),
      onDeny = vi.fn(async () => {});
    renderPanel({ onApprove, onDeny, collapsed: true });
    await act(async () => {
      vi.advanceTimersByTime(150);
    });
    const review = screen.getByRole("button", { name: "Review draft changes" });
    fireEvent.keyDown(review, { key: "Enter" });
    expect(onApprove).not.toHaveBeenCalled();
    fireEvent.click(review);
    expect(screen.getByText("Retained approval feedback")).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("button", { name: "Close review" }), {
      key: "Escape",
    });
    expect(onDeny).not.toHaveBeenCalled();
  });
});
