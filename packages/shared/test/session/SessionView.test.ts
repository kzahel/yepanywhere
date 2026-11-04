import { describe, expect, it } from "vitest";
import type {
  AgentActivity,
  AppSessionSummary,
  SessionOwnership,
} from "../../src/app-types.js";
import type { UrlProjectId } from "../../src/projectId.js";
import {
  SESSION_TITLE_MAX_LENGTH,
  SessionView,
  getSessionDisplayTitle,
  sanitizeSessionTitle,
  truncateSessionTitle,
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
    ownership: SessionOwnership;
    isArchived: boolean;
    isStarred: boolean;
    pendingInputType: "tool-approval" | "user-question" | undefined;
    activity: AgentActivity | undefined;
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
    overrides.ownership ?? { owner: "none" },
    overrides.isArchived ?? false,
    overrides.isStarred ?? false,
    overrides.pendingInputType,
    overrides.activity,
    overrides.lastSeenAt,
    overrides.hasUnread ?? false,
    overrides.contextUsage,
    "claude",
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

  describe("ownership getters", () => {
    it("isOwned returns true when owner is self", () => {
      const view = createView({
        ownership: { owner: "self", processId: "proc-1" },
      });
      expect(view.isOwned).toBe(true);
      expect(view.isUnowned).toBe(false);
      expect(view.isExternal).toBe(false);
    });

    it("isUnowned returns true when owner is none", () => {
      const view = createView({ ownership: { owner: "none" } });
      expect(view.isUnowned).toBe(true);
      expect(view.isOwned).toBe(false);
      expect(view.isExternal).toBe(false);
    });

    it("isExternal returns true when owner is external", () => {
      const view = createView({ ownership: { owner: "external" } });
      expect(view.isExternal).toBe(true);
      expect(view.isOwned).toBe(false);
      expect(view.isUnowned).toBe(false);
    });
  });

  describe("activity getters", () => {
    it("isInTurn returns true when activity is in-turn", () => {
      const view = createView({ activity: "in-turn" });
      expect(view.isInTurn).toBe(true);
    });

    it("isWaitingForInput returns true when activity is waiting-input", () => {
      const view = createView({ activity: "waiting-input" });
      expect(view.isWaitingForInput).toBe(true);
    });

    it("returns false for undefined activity", () => {
      const view = createView({ activity: undefined });
      expect(view.isInTurn).toBe(false);
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
        ownership: { owner: "self", processId: "proc-1" },
        isArchived: true,
        isStarred: true,
        pendingInputType: "tool-approval",
        activity: "waiting-input",
        lastSeenAt: "2024-01-01T12:00:00Z",
        hasUnread: true,
        contextUsage: { inputTokens: 5000, percentage: 25 },
        provider: "claude",
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
      expect(view.isOwned).toBe(true);
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
        ownership: { owner: "none" },
        provider: "claude",
      };

      const view = SessionView.from(summary);

      expect(view.customTitle).toBeUndefined();
      expect(view.displayTitle).toBe("Auto title");
      expect(view.isArchived).toBe(false);
      expect(view.isStarred).toBe(false);
      expect(view.hasUnread).toBe(false);
      expect(view.pendingInputType).toBeUndefined();
      expect(view.activity).toBeUndefined();
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
      expect(view.isUnowned).toBe(true);
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

describe("session title sanitization", () => {
  it("strips invisible controls and bidi formatting", () => {
    expect(sanitizeSessionTitle("  safe\u202Ename\u200B\nnext  ")).toBe(
      "safe name next",
    );
  });

  it("normalizes and truncates sanitized titles", () => {
    const title = `${"x".repeat(130)}\u202E`;
    expect(truncateSessionTitle(title)).toHaveLength(SESSION_TITLE_MAX_LENGTH);
    expect(truncateSessionTitle(title)).toBe(`${"x".repeat(117)}...`);
  });

  it("truncates long titles exactly as sanitizing the whole title would", () => {
    const wholeTitle = (title: string) => {
      const sanitized = sanitizeSessionTitle(title);
      return sanitized.length <= SESSION_TITLE_MAX_LENGTH
        ? sanitized
        : `${sanitized.slice(0, SESSION_TITLE_MAX_LENGTH - 3).trimEnd()}...`;
    };
    const pieces = ["word", " ", "\n\t  ", "​", "‮", "é", "é"];
    let seed = 7;
    const next = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed;
    };
    for (let i = 0; i < 400; i += 1) {
      const length = 50 + (next() % 3000);
      let title = "";
      while (title.length < length) title += pieces[next() % pieces.length];
      if (i % 5 === 0) title = `${" ".repeat(next() % 600)}${title}`;
      expect(truncateSessionTitle(title)).toBe(wholeTitle(title));
    }
  });
});
