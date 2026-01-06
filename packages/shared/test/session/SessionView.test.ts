import { describe, expect, it } from "vitest";
import type {
  AppSessionStatus,
  AppSessionSummary,
} from "../../src/app-types.js";
import type { UrlProjectId } from "../../src/projectId.js";
import {
  SESSION_TITLE_MAX_LENGTH,
  SessionView,
  getSessionDisplayTitle,
} from "../../src/session/SessionView.js";

// Helper to create a minimal valid SessionView for testing
function createView(
  overrides: Partial<{
    id: string;
    projectId: UrlProjectId;
    autoTitle: string | null;
    fullTitle: string | null;
    customTitle: string | undefined;
    createdAt: string;
    updatedAt: string;
    messageCount: number;
    status: AppSessionStatus;
    isArchived: boolean;
    isStarred: boolean;
    pendingInputType: "tool-approval" | "user-question" | undefined;
    processState:
      | "running"
      | "idle"
      | "waiting-input"
      | "terminated"
      | undefined;
    lastSeenAt: string | undefined;
    hasUnread: boolean;
    contextUsage: { inputTokens: number; percentage: number } | undefined;
  }> = {},
): SessionView {
  return new SessionView(
    overrides.id ?? "session-123",
    overrides.projectId ?? ("project-123" as UrlProjectId),
    "autoTitle" in overrides ? (overrides.autoTitle as string) : "Auto title",
    "fullTitle" in overrides
      ? (overrides.fullTitle as string)
      : "Full auto title",
    overrides.customTitle,
    overrides.createdAt ?? "2024-01-01T00:00:00Z",
    overrides.updatedAt ?? "2024-01-02T00:00:00Z",
    overrides.messageCount ?? 10,
    overrides.status ?? { state: "idle" },
    overrides.isArchived ?? false,
    overrides.isStarred ?? false,
    overrides.pendingInputType,
    overrides.processState,
    overrides.lastSeenAt,
    overrides.hasUnread ?? false,
    overrides.contextUsage,
  );
}

describe("SessionView", () => {
  describe("constructor", () => {
    it("creates instance with all properties", () => {
      const view = createView({
        id: "session-abc",
        autoTitle: "My title",
        fullTitle: "My full title",
        customTitle: "Custom name",
        isArchived: true,
        isStarred: true,
        hasUnread: true,
      });

      expect(view.id).toBe("session-abc");
      expect(view.autoTitle).toBe("My title");
      expect(view.fullTitle).toBe("My full title");
      expect(view.customTitle).toBe("Custom name");
      expect(view.isArchived).toBe(true);
      expect(view.isStarred).toBe(true);
      expect(view.hasUnread).toBe(true);
    });

    it("allows null titles", () => {
      const view = createView({
        autoTitle: null,
        fullTitle: null,
        customTitle: undefined,
      });

      expect(view.autoTitle).toBeNull();
      expect(view.fullTitle).toBeNull();
      expect(view.customTitle).toBeUndefined();
    });
  });

  describe("displayTitle", () => {
    it("returns customTitle when set", () => {
      const view = createView({ customTitle: "Custom title" });
      expect(view.displayTitle).toBe("Custom title");
    });

    it("returns autoTitle when no customTitle", () => {
      const view = createView({ autoTitle: "Auto title" });
      expect(view.displayTitle).toBe("Auto title");
    });

    it("returns 'Untitled' when no titles", () => {
      const view = createView({ autoTitle: null, fullTitle: null });
      expect(view.displayTitle).toBe("Untitled");
    });

    it("prefers customTitle over autoTitle", () => {
      const view = createView({
        autoTitle: "Auto",
        customTitle: "Custom",
      });
      expect(view.displayTitle).toBe("Custom");
    });
  });

  describe("hasCustomTitle", () => {
    it("returns true when customTitle is set", () => {
      const view = createView({ customTitle: "Custom" });
      expect(view.hasCustomTitle).toBe(true);
    });

    it("returns false when customTitle is undefined", () => {
      const view = createView();
      expect(view.hasCustomTitle).toBe(false);
    });

    it("returns false when customTitle is empty string", () => {
      const view = createView({ customTitle: "" });
      expect(view.hasCustomTitle).toBe(false);
    });
  });

  describe("tooltipTitle", () => {
    it("returns fullTitle when available", () => {
      const view = createView({
        autoTitle: "Short",
        fullTitle: "Full long title",
      });
      expect(view.tooltipTitle).toBe("Full long title");
    });

    it("falls back to autoTitle when fullTitle is null", () => {
      const view = createView({ autoTitle: "Auto", fullTitle: null });
      expect(view.tooltipTitle).toBe("Auto");
    });

    it("returns null when both are null", () => {
      const view = createView({ autoTitle: null, fullTitle: null });
      expect(view.tooltipTitle).toBeNull();
    });
  });

  describe("isTruncated", () => {
    it("returns true when autoTitle differs from fullTitle", () => {
      const view = createView({
        autoTitle: "Short...",
        fullTitle: "Short title that was truncated",
      });
      expect(view.isTruncated).toBe(true);
    });

    it("returns false when autoTitle equals fullTitle", () => {
      const view = createView({
        autoTitle: "Same",
        fullTitle: "Same",
      });
      expect(view.isTruncated).toBe(false);
    });

    it("returns false when autoTitle is null", () => {
      const view = createView({ autoTitle: null, fullTitle: "Full" });
      expect(view.isTruncated).toBe(false);
    });

    it("returns false when fullTitle is null", () => {
      const view = createView({ autoTitle: "Auto", fullTitle: null });
      expect(view.isTruncated).toBe(false);
    });
  });

  describe("status getters", () => {
    it("isActive returns true when status is owned", () => {
      const view = createView({
        status: { state: "owned", processId: "proc-1" },
      });
      expect(view.isActive).toBe(true);
      expect(view.isIdle).toBe(false);
      expect(view.isExternal).toBe(false);
    });

    it("isIdle returns true when status is idle", () => {
      const view = createView({ status: { state: "idle" } });
      expect(view.isIdle).toBe(true);
      expect(view.isActive).toBe(false);
      expect(view.isExternal).toBe(false);
    });

    it("isExternal returns true when status is external", () => {
      const view = createView({ status: { state: "external" } });
      expect(view.isExternal).toBe(true);
      expect(view.isActive).toBe(false);
      expect(view.isIdle).toBe(false);
    });
  });

  describe("process state getters", () => {
    it("isRunning returns true when processState is running", () => {
      const view = createView({ processState: "running" });
      expect(view.isRunning).toBe(true);
    });

    it("isWaitingForInput returns true when processState is waiting-input", () => {
      const view = createView({ processState: "waiting-input" });
      expect(view.isWaitingForInput).toBe(true);
    });

    it("returns false for undefined processState", () => {
      const view = createView({ processState: undefined });
      expect(view.isRunning).toBe(false);
      expect(view.isWaitingForInput).toBe(false);
    });
  });

  describe("needsAttention", () => {
    it("returns true when hasUnread is true", () => {
      const view = createView({ hasUnread: true });
      expect(view.needsAttention).toBe(true);
    });

    it("returns true when pendingInputType is set", () => {
      const view = createView({ pendingInputType: "tool-approval" });
      expect(view.needsAttention).toBe(true);
    });

    it("returns true when both unread and pending", () => {
      const view = createView({
        hasUnread: true,
        pendingInputType: "user-question",
      });
      expect(view.needsAttention).toBe(true);
    });

    it("returns false when no unread and no pending", () => {
      const view = createView({ hasUnread: false });
      expect(view.needsAttention).toBe(false);
    });
  });

  describe("from", () => {
    it("creates SessionView from AppSessionSummary", () => {
      const summary: AppSessionSummary = {
        id: "session-456",
        projectId: "project-123" as UrlProjectId,
        title: "Auto title",
        fullTitle: "Full auto title",
        customTitle: "Custom name",
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-02T00:00:00Z",
        messageCount: 10,
        status: { state: "owned", processId: "proc-1" },
        isArchived: true,
        isStarred: true,
        pendingInputType: "tool-approval",
        processState: "waiting-input",
        lastSeenAt: "2024-01-01T12:00:00Z",
        hasUnread: true,
        contextUsage: { inputTokens: 5000, percentage: 25 },
      };

      const view = SessionView.from(summary);

      expect(view.id).toBe("session-456");
      expect(view.projectId).toBe("project-123");
      expect(view.autoTitle).toBe("Auto title");
      expect(view.fullTitle).toBe("Full auto title");
      expect(view.customTitle).toBe("Custom name");
      expect(view.displayTitle).toBe("Custom name");
      expect(view.isArchived).toBe(true);
      expect(view.isStarred).toBe(true);
      expect(view.isActive).toBe(true);
      expect(view.isWaitingForInput).toBe(true);
      expect(view.hasUnread).toBe(true);
      expect(view.needsAttention).toBe(true);
      expect(view.contextUsage).toEqual({ inputTokens: 5000, percentage: 25 });
    });

    it("handles summary without optional fields", () => {
      const summary: AppSessionSummary = {
        id: "session-789",
        projectId: "project-123" as UrlProjectId,
        title: "Auto title",
        fullTitle: "Full title",
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-02T00:00:00Z",
        messageCount: 5,
        status: { state: "idle" },
      };

      const view = SessionView.from(summary);

      expect(view.customTitle).toBeUndefined();
      expect(view.displayTitle).toBe("Auto title");
      expect(view.isArchived).toBe(false);
      expect(view.isStarred).toBe(false);
      expect(view.hasUnread).toBe(false);
      expect(view.pendingInputType).toBeUndefined();
      expect(view.processState).toBeUndefined();
    });
  });

  describe("fromPartial", () => {
    it("creates SessionView from partial data", () => {
      const view = SessionView.fromPartial({
        id: "session-123",
        title: "Auto",
        customTitle: "Custom",
        isStarred: true,
      });

      expect(view.id).toBe("session-123");
      expect(view.autoTitle).toBe("Auto");
      expect(view.customTitle).toBe("Custom");
      expect(view.displayTitle).toBe("Custom");
      expect(view.isStarred).toBe(true);
      expect(view.isArchived).toBe(false);
    });

    it("handles minimal data with defaults", () => {
      const view = SessionView.fromPartial({ id: "session-123" });

      expect(view.id).toBe("session-123");
      expect(view.autoTitle).toBeNull();
      expect(view.fullTitle).toBeNull();
      expect(view.customTitle).toBeUndefined();
      expect(view.displayTitle).toBe("Untitled");
      expect(view.messageCount).toBe(0);
      expect(view.isIdle).toBe(true);
      expect(view.isArchived).toBe(false);
      expect(view.isStarred).toBe(false);
    });
  });
});

describe("getSessionDisplayTitle", () => {
  it("returns customTitle when set", () => {
    expect(
      getSessionDisplayTitle({ customTitle: "Custom", title: "Auto" }),
    ).toBe("Custom");
  });

  it("returns title when no customTitle", () => {
    expect(getSessionDisplayTitle({ title: "Auto" })).toBe("Auto");
  });

  it("returns 'Untitled' when no titles", () => {
    expect(getSessionDisplayTitle({})).toBe("Untitled");
  });

  it("returns 'Untitled' for null session", () => {
    expect(getSessionDisplayTitle(null)).toBe("Untitled");
  });

  it("returns 'Untitled' for undefined session", () => {
    expect(getSessionDisplayTitle(undefined)).toBe("Untitled");
  });

  it("handles null title", () => {
    expect(getSessionDisplayTitle({ title: null })).toBe("Untitled");
  });
});

describe("SESSION_TITLE_MAX_LENGTH", () => {
  it("is 120 characters", () => {
    expect(SESSION_TITLE_MAX_LENGTH).toBe(120);
  });
});
