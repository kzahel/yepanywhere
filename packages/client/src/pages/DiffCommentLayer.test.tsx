// @vitest-environment jsdom

import type {
  PatchHunk,
  ReviewCommentRevision,
  ReviewSourceProjection,
} from "@yep-anywhere/shared";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useState } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type SourceReviewDefaultSession,
  SourceReviewDefaultSessionContext,
} from "../contexts/SourceReviewDefaultSessionContext";
import { I18nProvider } from "../i18n";
import { UI_KEYS } from "../lib/storageKeys";

const navigateSpy = vi.fn();
vi.mock("react-router-dom", async (orig) => ({
  ...(await orig<typeof import("react-router-dom")>()),
  useNavigate: () => navigateSpy,
}));
vi.mock("../hooks/useRemoteBasePath", () => ({
  useRemoteBasePath: () => "",
}));

const listReviewComments = vi.fn();
const addReviewComment = vi.fn();
const submitReview = vi.fn();
const getGlobalSessions = vi.fn();
vi.mock("../api/client", () => ({
  api: {
    listReviewComments: (...args: unknown[]) => listReviewComments(...args),
    addReviewComment: (...args: unknown[]) => addReviewComment(...args),
    submitReview: (...args: unknown[]) => submitReview(...args),
    getGlobalSessions: (...args: unknown[]) => getGlobalSessions(...args),
  },
}));

import { DiffCommentController } from "./DiffCommentLayer";
import { UnifiedDiff } from "./UnifiedDiff";

// context " a" (old1/new1) · removed "-b" (old2) · added "+c" (new2)
const PATCH: PatchHunk[] = [
  {
    oldStart: 1,
    oldLines: 2,
    newStart: 1,
    newLines: 2,
    lines: [" a", "-b", "+c"],
  },
];

const DIFF_HTML =
  `<pre class="shiki"><code>` +
  `<span class="line line-context" data-diff-line="0"> a</span>\n` +
  `<span class="line line-deleted" data-diff-line="1">-b</span>\n` +
  `<span class="line line-inserted" data-diff-line="2">+c</span>` +
  `</code></pre>`;

const t = (key: string) => key;

function Harness({
  patch = PATCH,
  revisions,
  projections,
}: {
  patch?: PatchHunk[];
  revisions?: {
    old?: ReviewCommentRevision;
    new?: ReviewCommentRevision;
  };
  projections?: Partial<Record<"old" | "new", ReviewSourceProjection>>;
}) {
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  return (
    <div className="diff-modal-content" ref={setContainer}>
      {container ? (
        <DiffCommentController
          projectId="proj1"
          filePath="src/a.ts"
          structuredPatch={patch}
          revisions={revisions}
          projections={projections}
          container={container}
          renderSource={({ openComment, editor }) => (
            <UnifiedDiff
              diffHtml={DIFF_HTML}
              structuredPatch={patch}
              splitAfterLine={openComment?.flatIndex}
              editor={editor}
            />
          )}
          t={t}
        />
      ) : (
        <div
          className="highlighted-diff"
          // biome-ignore lint/security/noDangerouslySetInnerHtml: test fixture
          dangerouslySetInnerHTML={{ __html: DIFF_HTML }}
        />
      )}
    </div>
  );
}

function renderHarness(
  defaultSession: SourceReviewDefaultSession | null = null,
) {
  return render(
    <I18nProvider>
      <MemoryRouter>
        <SourceReviewDefaultSessionContext.Provider value={defaultSession}>
          <Harness />
        </SourceReviewDefaultSessionContext.Provider>
      </MemoryRouter>
    </I18nProvider>,
  );
}

describe("DiffCommentLayer", () => {
  beforeEach(() => {
    getGlobalSessions.mockResolvedValue({ sessions: [], hasMore: false });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    localStorage.removeItem(UI_KEYS.sessionHoverCardShowDelayMs);
  });

  it("opens a comment window anchored to the clicked line", async () => {
    listReviewComments.mockResolvedValue({
      comments: [],
      batches: [],
      pendingCount: 0,
    });
    renderHarness();

    // Click the added line (flat index 2 → new line 2).
    fireEvent.click(document.querySelector('[data-diff-line="2"]')!);

    // Anchor label shows the current (new) line number.
    await screen.findByText("src/a.ts:2");
    expect(screen.getByRole("textbox")).toBeTruthy();
    expect(document.querySelector("[data-review-comment-split]")).toBeTruthy();
    expect(
      document
        .querySelector("[data-review-comment-before]")
        ?.querySelector('[data-diff-line="2"]'),
    ).toBeTruthy();
  });

  it("exposes one line-action menu through pointer and keyboard paths", async () => {
    listReviewComments.mockResolvedValue({
      comments: [],
      batches: [],
      pendingCount: 0,
    });
    renderHarness();

    const line = document.querySelector<HTMLElement>('[data-diff-line="2"]')!;
    await waitFor(() => expect(line.tabIndex).toBe(0));
    fireEvent.pointerMove(line, { pointerType: "mouse", clientX: 30 });
    expect(
      screen.getByRole("button", { name: "sourceMoreActions" }),
    ).toBeDefined();

    fireEvent.contextMenu(line, { clientX: 40, clientY: 50 });
    expect(await screen.findByRole("menu")).toBeDefined();
    expect(screen.getByText("sourceCommentOnLine")).toBeDefined();
    expect(screen.getByText("sourceCopyLine")).toBeDefined();
    expect(screen.getByText("sourceCopyPathLine")).toBeDefined();

    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(document.activeElement).toBe(line);

    fireEvent.keyDown(line, { key: "F10", shiftKey: true });
    expect(await screen.findByRole("menu")).toBeDefined();
  });

  it("Add to review posts a comment with the derived anchor", async () => {
    listReviewComments.mockResolvedValue({
      comments: [],
      batches: [],
      pendingCount: 0,
    });
    addReviewComment.mockResolvedValue({
      comment: { id: "c1", status: "pending", anchor: {}, text: "x" },
    });
    renderHarness();

    fireEvent.click(document.querySelector('[data-diff-line="2"]')!);
    await screen.findByText("src/a.ts:2");

    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "why added?" },
    });
    fireEvent.click(screen.getByText("sourceReviewAddToReview"));

    await waitFor(() => expect(addReviewComment).toHaveBeenCalledTimes(1));
    const [projectId, anchor, text] = addReviewComment.mock.calls[0] as [
      string,
      Record<string, unknown>,
      string,
    ];
    expect(projectId).toBe("proj1");
    expect(text).toBe("why added?");
    expect(anchor).toMatchObject({
      path: "src/a.ts",
      side: "new",
      oldLine: null,
      newLine: 2,
      revision: { kind: "uncommitted" },
    });
  });

  it("submits one comment to a new session and navigates to it", async () => {
    listReviewComments.mockResolvedValue({
      comments: [],
      batches: [],
      pendingCount: 0,
    });
    addReviewComment.mockResolvedValue({
      comment: { id: "c1", status: "pending", anchor: {}, text: "x" },
    });
    submitReview.mockResolvedValue({ sessionId: "sess-9", consumed: ["c1"] });
    renderHarness({
      projectId: "proj1",
      id: "sess-default",
      title: "Fix source review flow",
      newSession: {
        provider: "codex",
        model: "gpt-5.4",
        thinking: { type: "adaptive", display: "summarized" },
        effort: "high",
      },
    });

    fireEvent.click(document.querySelector('[data-diff-line="1"]')!);
    await screen.findByText("src/a.ts:2"); // removed line: falls back to old line 2

    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "removed why?" },
    });
    fireEvent.change(screen.getByLabelText("sourceReviewTargetLegend"), {
      target: { value: "new" },
    });
    fireEvent.click(screen.getByText("sourceReviewSubmitComment"));

    await waitFor(() =>
      expect(submitReview).toHaveBeenCalledWith("proj1", ["c1"], "new", {
        provider: "codex",
        model: "gpt-5.4",
        thinking: { type: "adaptive", display: "summarized" },
        effort: "high",
        // The server carries the opening session's router, sandbox and tier.
        sourceSessionId: "sess-default",
      }),
    );
    expect(navigateSpy).toHaveBeenCalledWith("/projects/proj1/sessions/sess-9");
  });

  it("submits one comment to the tab's default session", async () => {
    localStorage.setItem(UI_KEYS.sessionHoverCardShowDelayMs, "0");
    listReviewComments.mockResolvedValue({
      comments: [],
      batches: [],
      pendingCount: 0,
    });
    addReviewComment.mockResolvedValue({
      comment: { id: "c2", status: "pending", anchor: {}, text: "x" },
    });
    submitReview.mockResolvedValue({
      sessionId: "sess-default",
      consumed: ["c2"],
    });
    renderHarness({
      projectId: "proj1",
      id: "sess-default",
      title: "Fix source review flow",
      newSession: { provider: "codex", model: "gpt-5.4", effort: "high" },
    });

    fireEvent.click(document.querySelector('[data-diff-line="2"]')!);
    await screen.findByText("src/a.ts:2");
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "follow up here" },
    });
    const target = screen.getByLabelText(
      "sourceReviewTargetLegend",
    ) as HTMLSelectElement;
    expect(target.value).toBe("sess-default");
    const submitToDefault = await screen.findByText(
      "sourceReviewSubmitComment",
    );
    expect(submitToDefault.getAttribute("title")).toBeNull();
    const hoverTarget = submitToDefault.parentElement;
    expect(hoverTarget?.tagName).toBe("SPAN");
    fireEvent.pointerEnter(hoverTarget!, {
      pointerType: "mouse",
      clientX: 20,
    });
    await waitFor(() =>
      expect(screen.getByRole("tooltip").textContent).toContain(
        "Fix source review flow",
      ),
    );
    fireEvent.click(submitToDefault);

    await waitFor(() =>
      expect(submitReview).toHaveBeenCalledWith(
        "proj1",
        ["c2"],
        "sess-default",
      ),
    );
    expect(navigateSpy).toHaveBeenCalledWith(
      "/projects/proj1/sessions/sess-default",
    );
  });

  it("defaults immediate submit to the most recently active project session", async () => {
    listReviewComments.mockResolvedValue({
      comments: [],
      batches: [],
      pendingCount: 0,
    });
    getGlobalSessions.mockResolvedValue({
      sessions: [
        {
          id: "sess-recent",
          title: "Recent implementation",
          customTitle: null,
          provider: "codex",
          model: "gpt-5.4",
          projectId: "proj1",
        },
        {
          id: "sess-older",
          title: "Older implementation",
          customTitle: null,
          provider: "claude",
          model: "sonnet",
          projectId: "proj1",
        },
      ],
      hasMore: false,
    });
    addReviewComment.mockResolvedValue({
      comment: { id: "c3", status: "pending", anchor: {}, text: "x" },
    });
    submitReview.mockResolvedValue({
      sessionId: "sess-recent",
      consumed: ["c3"],
    });
    renderHarness();

    fireEvent.click(document.querySelector('[data-diff-line="2"]')!);
    await waitFor(() =>
      expect(
        (screen.getByLabelText("sourceReviewTargetLegend") as HTMLSelectElement)
          .value,
      ).toBe("sess-recent"),
    );
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "send to the recent session" },
    });
    fireEvent.click(screen.getByText("sourceReviewSubmitComment"));

    await waitFor(() =>
      expect(submitReview).toHaveBeenCalledWith("proj1", ["c3"], "sess-recent"),
    );
  });

  it("anchors a context click to the clicked column's side (side-by-side)", async () => {
    listReviewComments.mockResolvedValue({
      comments: [],
      batches: [],
      pendingCount: 0,
    });
    addReviewComment.mockResolvedValue({
      comment: { id: "c1", status: "pending", anchor: {}, text: "x" },
    });
    // Context line (flat index 0) inside an OLD (left) column.
    function ColHarness() {
      const [container, setContainer] = useState<HTMLDivElement | null>(null);
      return (
        <div ref={setContainer}>
          {container ? (
            <DiffCommentController
              projectId="proj1"
              filePath="src/a.ts"
              structuredPatch={PATCH}
              container={container}
              renderSource={({ editor }) => (
                <>
                  <div data-diff-col="old">
                    <span className="line line-context" data-diff-line="0">
                      {" a"}
                    </span>
                  </div>
                  {editor}
                </>
              )}
              t={t}
            />
          ) : (
            <div data-diff-col="old">
              <span className="line line-context" data-diff-line="0">
                {" a"}
              </span>
            </div>
          )}
        </div>
      );
    }
    render(
      <MemoryRouter>
        <ColHarness />
      </MemoryRouter>,
      { wrapper: I18nProvider },
    );

    fireEvent.click(document.querySelector('[data-diff-line="0"]')!);
    await screen.findByRole("textbox");
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "left side" },
    });
    fireEvent.click(screen.getByText("sourceReviewAddToReview"));

    await waitFor(() => expect(addReviewComment).toHaveBeenCalledTimes(1));
    const anchor = addReviewComment.mock.calls[0]?.[1] as {
      side: string;
      oldLine: number | null;
      newLine: number | null;
    };
    // A context line clicked in the left column anchors the old side.
    expect(anchor.side).toBe("old");
    expect(anchor.oldLine).toBe(1);
    expect(anchor.newLine).toBe(1);
  });

  it("anchors each comparison side to the revision that contains it", async () => {
    const baseSha = "a".repeat(40);
    const headSha = "b".repeat(40);
    listReviewComments.mockResolvedValue({
      comments: [],
      batches: [],
      pendingCount: 0,
    });
    addReviewComment.mockResolvedValue({
      comment: { id: "c1", status: "pending", anchor: {}, text: "x" },
    });
    render(
      <MemoryRouter>
        <Harness
          revisions={{
            old: { kind: "sha", sha: baseSha },
            new: { kind: "sha", sha: headSha },
          }}
        />
      </MemoryRouter>,
      { wrapper: I18nProvider },
    );

    fireEvent.click(document.querySelector('[data-diff-line="1"]')!);
    fireEvent.change(await screen.findByRole("textbox"), {
      target: { value: "old side" },
    });
    fireEvent.click(screen.getByText("sourceReviewAddToReview"));
    await waitFor(() => expect(addReviewComment).toHaveBeenCalledTimes(1));

    fireEvent.click(document.querySelector('[data-diff-line="2"]')!);
    fireEvent.change(await screen.findByRole("textbox"), {
      target: { value: "new side" },
    });
    fireEvent.click(screen.getByText("sourceReviewAddToReview"));
    await waitFor(() => expect(addReviewComment).toHaveBeenCalledTimes(2));

    expect(addReviewComment.mock.calls[0]?.[1]).toMatchObject({
      side: "old",
      revision: { kind: "sha", sha: baseSha },
    });
    expect(addReviewComment.mock.calls[1]?.[1]).toMatchObject({
      side: "new",
      revision: { kind: "sha", sha: headSha },
    });
  });

  it("keeps rendered capture identity distinct from anchor provenance", async () => {
    listReviewComments.mockResolvedValue({
      comments: [],
      batches: [],
      pendingCount: 0,
    });
    addReviewComment.mockResolvedValue({
      comment: { id: "c1", status: "pending", anchor: {}, text: "x" },
    });
    render(
      <MemoryRouter>
        <Harness
          revisions={{
            old: { kind: "sha", sha: "a".repeat(40) },
          }}
          projections={{
            old: {
              kind: "revision",
              revision: "b".repeat(40),
              path: "src/original.ts",
              side: "old",
            },
          }}
        />
      </MemoryRouter>,
      { wrapper: I18nProvider },
    );

    fireEvent.click(document.querySelector('[data-diff-line="1"]')!);
    fireEvent.change(await screen.findByRole("textbox"), {
      target: { value: "capture this exact side" },
    });
    fireEvent.click(screen.getByText("sourceReviewAddToReview"));
    await waitFor(() => expect(addReviewComment).toHaveBeenCalledTimes(1));

    expect(addReviewComment.mock.calls[0]?.[1]).toMatchObject({
      revision: { kind: "sha", sha: "a".repeat(40) },
      projection: {
        kind: "revision",
        revision: "b".repeat(40),
        path: "src/original.ts",
        side: "old",
      },
    });
  });

  it("tints a line that already has a pending comment", async () => {
    listReviewComments.mockResolvedValue({
      comments: [
        {
          id: "existing",
          status: "pending",
          text: "seen",
          createdAt: "2026-07-26T00:00:00Z",
          anchor: {
            path: "src/a.ts",
            revision: { kind: "uncommitted", savedAt: "2026-07-26T00:00:00Z" },
            side: "new",
            oldLine: null,
            newLine: 2,
            snippet: "c",
          },
        },
      ],
      batches: [],
      pendingCount: 1,
    });
    renderHarness();

    await waitFor(() =>
      expect(
        document
          .querySelector('[data-diff-line="2"]')
          ?.classList.contains("has-review-comment"),
      ).toBe(true),
    );
    // A line without a comment is not tinted.
    expect(
      document
        .querySelector('[data-diff-line="0"]')
        ?.classList.contains("has-review-comment"),
    ).toBe(false);
  });

  it("does not tint the same line coordinates from another endpoint", async () => {
    const baseSha = "a".repeat(40);
    const headSha = "b".repeat(40);
    listReviewComments.mockResolvedValue({
      comments: [
        {
          id: "old-side",
          status: "pending",
          text: "old",
          createdAt: "2026-07-26T00:00:00Z",
          anchor: {
            path: "src/a.ts",
            revision: { kind: "sha", sha: baseSha },
            side: "old",
            oldLine: 2,
            newLine: null,
            snippet: "b",
          },
        },
        {
          id: "other-projection",
          status: "pending",
          text: "other",
          createdAt: "2026-07-26T00:00:00Z",
          anchor: {
            path: "src/a.ts",
            revision: { kind: "sha", sha: baseSha },
            side: "new",
            oldLine: null,
            newLine: 2,
            snippet: "c",
          },
        },
      ],
      batches: [],
      pendingCount: 2,
    });
    render(
      <MemoryRouter>
        <Harness
          revisions={{
            old: { kind: "sha", sha: baseSha },
            new: { kind: "sha", sha: headSha },
          }}
        />
      </MemoryRouter>,
      { wrapper: I18nProvider },
    );

    await waitFor(() =>
      expect(
        document
          .querySelector('[data-diff-line="1"]')
          ?.classList.contains("has-review-comment"),
      ).toBe(true),
    );
    expect(
      document
        .querySelector('[data-diff-line="2"]')
        ?.classList.contains("has-review-comment"),
    ).toBe(false);
  });
});
