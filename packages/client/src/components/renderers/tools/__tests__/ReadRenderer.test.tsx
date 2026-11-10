import { recordFromLegacyArgs } from "../prepareDisplay";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { toUrlProjectId } from "@yep-anywhere/shared";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PublicShareProvider } from "../../../../contexts/PublicShareContext";
import { SessionMetadataProvider } from "../../../../contexts/SessionMetadataContext";
import { setInlineMediaExpandedPreference } from "../../../../hooks/useInlineMedia";
import { I18nProvider } from "../../../../i18n";
import { asClientSummarySourceKey } from "../../../../lib/clientSummaryStore";
import type { YaSourceRuntime } from "../../../../lib/sourceRuntime";
import { SourceRuntimeProvider } from "../../../../lib/sourceRuntimeReact";
import { FakeSourceTransport } from "../../../../lib/transport";
import { readRenderer } from "../ReadRenderer";
import type { ReadResult } from "../types";

function createRuntime(transport: FakeSourceTransport): YaSourceRuntime {
  return {
    sourceKey: asClientSummarySourceKey("test:read-renderer"),
    transport,
    api: {} as YaSourceRuntime["api"],
    summary: {} as YaSourceRuntime["summary"],
    sessionDetails: {} as YaSourceRuntime["sessionDetails"],
  };
}

const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

const imageResult = {
  type: "image" as const,
  file: {
    base64: PNG_BASE64,
    type: "image/png",
    originalSize: 158 * 1024,
    dimensions: {
      originalWidth: 1024,
      originalHeight: 952,
      displayWidth: 512,
      displayHeight: 476,
    },
  },
};

vi.mock("../../../../contexts/SchemaValidationContext", () => ({
  useSchemaValidationContext: () => ({
    enabled: false,
    reportValidationError: vi.fn(),
    isToolIgnored: vi.fn(() => false),
    ignoreToolErrors: vi.fn(),
    clearIgnoredTools: vi.fn(),
    ignoredTools: [],
  }),
}));

const renderContext = {
  isStreaming: false,
  theme: "dark" as const,
};

if (!readRenderer.operations.includes("renderInteractiveSummary")) {
  throw new Error("Read renderer must provide interactive summary");
}

const projectRoot = "/local/graehl/yepanywhere";
const projectId = toUrlProjectId(projectRoot);

function renderInSession(children: ReactNode) {
  return render(
    <I18nProvider>
      <SessionMetadataProvider
        projectId={projectId}
        projectPath={projectRoot}
        sessionId="session-1"
      >
        {children}
      </SessionMetadataProvider>
    </I18nProvider>,
  );
}

describe("ReadRenderer", () => {
  afterEach(() => {
    cleanup();
  });

  it("keeps normal text reads as native file links", () => {
    renderInSession(
      <div>
        {readRenderer
          .prepare(
            recordFromLegacyArgs(
              { file_path: "packages/client/src/hooks/useGlobalSessions.ts" },
              {
                type: "text",
                file: {
                  filePath: "packages/client/src/hooks/useGlobalSessions.ts",
                  content: 'import { useCallback } from "react";\n',
                  numLines: 1,
                  startLine: 1,
                  totalLines: 1,
                },
              },
              false,
            ),
          )
          .renderInteractiveSummary(renderContext)}
      </div>,
    );

    const link = screen.getByRole("link", {
      name: "packages/client/src/hooks/useGlobalSessions.ts",
    });
    expect(link.getAttribute("href")).toBe(
      `/projects/${projectId}/file?path=packages%2Fclient%2Fsrc%2Fhooks%2FuseGlobalSessions.ts`,
    );
    expect(screen.getByRole("link", { name: "1 lines" })).toBeDefined();
  });

  it("links partial read summaries and their line counts to the read range", () => {
    renderInSession(
      <div>
        {readRenderer
          .prepare(
            recordFromLegacyArgs(
              {
                file_path:
                  "packages/client/src/lib/connection/SecureConnection.ts",
              },
              {
                type: "text",
                file: {
                  filePath:
                    "packages/client/src/lib/connection/SecureConnection.ts",
                  content: "line\n".repeat(81),
                  numLines: 81,
                  startLine: 510,
                  totalLines: 900,
                },
              },
              false,
            ),
          )
          .renderInteractiveSummary(renderContext)}
      </div>,
    );

    const expectedHref = `/projects/${projectId}/file?path=packages%2Fclient%2Fsrc%2Flib%2Fconnection%2FSecureConnection.ts&line=510&lineEnd=590`;
    const expectedRangeHref = `${expectedHref}&view=range`;
    expect(
      screen
        .getByRole("link", { name: /SecureConnection\.ts\s*:510-590/i })
        .getAttribute("href"),
    ).toBe(expectedHref);
    expect(
      screen.getByRole("link", { name: "81 lines" }).getAttribute("href"),
    ).toBe(expectedRangeHref);
  });

  it("renders public share Read summaries as share file links", () => {
    render(
      <PublicShareProvider
        value={{
          projectId,
          relayUrl: "wss://relay.graehl.org/ws",
          relayUsername: "ygraehl",
          secret: "share-secret",
        }}
      >
        <SessionMetadataProvider
          projectId={projectId}
          projectPath={projectRoot}
          sessionId="session-1"
        >
          {readRenderer
            .prepare(
              recordFromLegacyArgs(
                { file_path: "ui-report/README.md" },
                {
                  type: "text",
                  file: {
                    filePath: "ui-report/README.md",
                    content: "# Report\n",
                    numLines: 1,
                    startLine: 1,
                    totalLines: 1,
                  },
                },
                false,
              ),
            )
            .renderInteractiveSummary(renderContext)}
        </SessionMetadataProvider>
      </PublicShareProvider>,
    );

    expect(
      screen
        .getByRole("link", { name: /ui-report\/README\.md/i })
        .getAttribute("href"),
    ).toBe(
      `/share/share-secret/file?path=ui-report%2FREADME.md&h=ygraehl&r=wss%3A%2F%2Frelay.graehl.org%2Fws&projectId=${projectId}`,
    );
  });

  it("renders expanded text reads with a native file link", () => {
    renderInSession(
      <div>
        {readRenderer
          .prepare(
            recordFromLegacyArgs(
              undefined,
              {
                type: "text",
                file: {
                  filePath: "packages/client/src/hooks/useGlobalSessions.ts",
                  content: 'import { useCallback } from "react";\n',
                  numLines: 1,
                  startLine: 1,
                  totalLines: 1,
                },
              },
              false,
              "complete",
            ),
          )
          .renderToolResult(renderContext)}
      </div>,
    );

    expect(
      screen.getByRole("link", { name: /useGlobalSessions\.ts/i }),
    ).toBeDefined();
  });

  it("does not markdown-render backticks in non-Markdown reads", () => {
    const { container } = renderInSession(
      <div>
        {readRenderer
          .prepare(
            recordFromLegacyArgs(
              undefined,
              {
                type: "text",
                file: {
                  filePath: "packages/client/src/components/Widget.tsx",
                  content: "const label = `dev`;\n",
                  numLines: 1,
                  startLine: 1,
                  totalLines: 1,
                },
              },
              false,
              "complete",
            ),
          )
          .renderToolResult(renderContext)}
      </div>,
    );

    expect(screen.getByText("const label = `dev`;")).toBeDefined();
    expect(
      container.querySelector("[data-fixed-font-rendered__content] code"),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "Show source" })).toBeNull();
  });

  it("renders zero-line PTY-backed reads without fake continuation text", () => {
    renderInSession(
      <div>
        {readRenderer
          .prepare(
            recordFromLegacyArgs(
              { file_path: "packages/client/src/hooks/useGlobalSessions.ts" },
              {
                type: "text",
                file: {
                  filePath: "packages/client/src/hooks/useGlobalSessions.ts",
                  content: "",
                  numLines: 0,
                  startLine: 1,
                  totalLines: 260,
                },
                session_id: 37863,
              } as never,
              false,
            ),
          )
          .renderInteractiveSummary(renderContext)}
      </div>,
    );

    expect(
      screen.queryByRole("button", { name: /useGlobalSessions\.ts/i }),
    ).toBeNull();
    const link = screen.getByRole("link", { name: /useGlobalSessions\.ts/i });
    expect(link).toBeDefined();
    expect(link.getAttribute("href")).not.toContain("line=1");
    expect(link.textContent).not.toContain(":1");
    expect(screen.getByText("0 lines")).toBeDefined();
    expect(screen.queryByText(/continues in Shell/)).toBeNull();
  });

  it("renders zero-line PTY-backed read results without a phantom first line", () => {
    renderInSession(
      <div>
        {readRenderer
          .prepare(
            recordFromLegacyArgs(
              undefined,
              {
                type: "text",
                file: {
                  filePath: "packages/client/src/hooks/useGlobalSessions.ts",
                  content: "",
                  numLines: 0,
                  startLine: 1,
                  totalLines: 260,
                },
                session_id: 37863,
              } as never,
              false,
              "complete",
            ),
          )
          .renderToolResult(renderContext)}
      </div>,
    );

    expect(
      screen.queryByRole("button", { name: /useGlobalSessions\.ts/i }),
    ).toBeNull();
    const link = screen.getByRole("link", { name: /useGlobalSessions\.ts/i });
    expect(link).toBeDefined();
    expect(link.getAttribute("href")).not.toContain("line=1");
    expect(link.textContent).not.toContain(":1");
    expect(screen.getByText("0 lines")).toBeDefined();
    expect(screen.getByText("No content read")).toBeDefined();
    expect(screen.queryByText(/continues in Shell/)).toBeNull();
  });

  it("revokes an opened PDF's object URL once the new tab has had time to load it", () => {
    vi.useFakeTimers();
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const { createObjectURL, revokeObjectURL } = URL;
    URL.createObjectURL = vi.fn(() => "blob:pdf-tab");
    const revoke = vi.fn();
    URL.revokeObjectURL = revoke;
    try {
      renderInSession(
        <div>
          {readRenderer
            .prepare(
              recordFromLegacyArgs(
                { file_path: "" },
                {
                  type: "pdf",
                  file: { base64: btoa("%PDF-1.4"), originalSize: 8 },
                },
                false,
                "complete",
              ),
            )
            .renderToolResult(renderContext)}
        </div>,
      );
      fireEvent.click(screen.getByRole("button", { name: /open pdf/i }));
      expect(open).toHaveBeenCalledWith("blob:pdf-tab", "_blank");
      expect(revoke).not.toHaveBeenCalled();
      vi.advanceTimersByTime(60_000);
      expect(revoke).toHaveBeenCalledWith("blob:pdf-tab");
    } finally {
      open.mockRestore();
      URL.createObjectURL = createObjectURL;
      URL.revokeObjectURL = revokeObjectURL;
      vi.useRealTimers();
    }
  });

  describe("image reads", () => {
    afterEach(() => {
      // Unmount first so resetting the store doesn't re-render a mounted tree
      // outside act(), then reset to the default (collapsed) for the next test.
      cleanup();
      setInlineMediaExpandedPreference(false);
    });

    it("keeps the image collapsed when Expand Inline Media is off", () => {
      setInlineMediaExpandedPreference(false);
      const { container } = renderInSession(
        <div>
          {readRenderer
            .prepare(
              recordFromLegacyArgs(
                {
                  file_path: "/tmp/screenshot.png",
                },
                imageResult,
                false,
                "complete",
              ),
            )
            .renderToolResult(renderContext)}
        </div>,
      );

      expect(container.querySelector("img[data-read-image]")).toBeNull();
      expect(
        screen.getByRole("button", { name: /expand image/i }),
      ).toBeDefined();
    });

    it("expands the image inline when the setting is on", () => {
      setInlineMediaExpandedPreference(true);
      const { container } = renderInSession(
        <div>
          {readRenderer
            .prepare(
              recordFromLegacyArgs(
                {
                  file_path: "/tmp/screenshot.png",
                },
                imageResult,
                false,
                "complete",
              ),
            )
            .renderToolResult(renderContext)}
        </div>,
      );

      expect(container.querySelector("img[data-read-image]")).not.toBeNull();
      expect(
        screen.getByRole("button", { name: /collapse image/i }),
      ).toBeDefined();
    });

    it("lets the user expand a collapsed image on demand", () => {
      setInlineMediaExpandedPreference(false);
      const { container } = renderInSession(
        <div>
          {readRenderer
            .prepare(
              recordFromLegacyArgs(
                {
                  file_path: "/tmp/screenshot.png",
                },
                imageResult,
                false,
                "complete",
              ),
            )
            .renderToolResult(renderContext)}
        </div>,
      );

      expect(container.querySelector("img[data-read-image]")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: /expand image/i }));
      expect(container.querySelector("img[data-read-image]")).not.toBeNull();
    });

    // Once YA materializes tool-result media, the stored result keeps its
    // metadata and drops the provider's bytes. The row must still show the
    // image rather than falling back to raw JSON.
    it("reads the file back when the result carries no inline bytes", async () => {
      setInlineMediaExpandedPreference(true);
      Object.defineProperty(URL, "createObjectURL", {
        configurable: true,
        value: vi.fn(() => "blob:read-image"),
      });
      Object.defineProperty(URL, "revokeObjectURL", {
        configurable: true,
        value: vi.fn(),
      });
      const fetchBlob = vi.fn(
        async () => new Blob(["png"], { type: "image/png" }),
      );
      const runtime = createRuntime(
        new FakeSourceTransport({
          kind: "secure",
          capabilities: { sameOriginUrls: false },
          fetchBlob,
        }),
      );
      const { file, ...rest } = imageResult;
      const { base64: _dropped, ...strippedFile } = file;

      const { container } = renderInSession(
        <SourceRuntimeProvider runtime={runtime}>
          {readRenderer
            .prepare(
              recordFromLegacyArgs(
                { file_path: "/tmp/screenshot.png" },
                { ...rest, file: strippedFile },
                false,
                "complete",
              ),
            )
            .renderToolResult(renderContext)}
        </SourceRuntimeProvider>,
      );

      expect(container.textContent).not.toContain("Rich preview unavailable");
      await waitFor(() => {
        expect(fetchBlob).toHaveBeenCalledWith(
          "/local-image?path=%2Ftmp%2Fscreenshot.png",
        );
      });
      const image = await waitFor(() => {
        const element = container.querySelector("img[data-read-image]");
        if (!element) throw new Error("image preview not rendered");
        return element;
      });
      expect(image.getAttribute("src")).toBe("blob:read-image");
    });
  });

  // Claude Code's read-dedup returns a non-error Read whose `file` has only
  // `filePath` — content/numLines are omitted because the file is unchanged
  // since the last Read. These results must not crash or print "undefined
  // lines"; they render a distinct "unchanged" state instead.
  describe("read-dedup (content-less file) results", () => {
    // Intentionally malformed vs. the ReadResult type: at runtime the validated
    // schema allows this (all TextFile fields are optional), which is the whole
    // point — the renderer must tolerate it.
    const dedupResult = {
      type: "text",
      file: { filePath: "CLAUDE.md" },
    } as unknown as ReadResult;

    it("renders the expanded result without crashing (markdown path)", () => {
      expect(() =>
        renderInSession(
          <div>
            {readRenderer
              .prepare(
                recordFromLegacyArgs(
                  {
                    file_path: "CLAUDE.md",
                  },
                  dedupResult,
                  false,
                  "complete",
                ),
              )
              .renderToolResult(renderContext)}
          </div>,
        ),
      ).not.toThrow();

      expect(document.body.textContent).not.toContain("undefined lines");
      expect(document.body.textContent).toContain("unchanged");
    });

    it("renders the interactive summary as unchanged, not 'undefined lines'", () => {
      renderInSession(
        <div>
          {readRenderer
            .prepare(
              recordFromLegacyArgs(
                { file_path: "CLAUDE.md" },
                dedupResult,
                false,
              ),
            )
            .renderInteractiveSummary(renderContext)}
        </div>,
      );

      expect(document.body.textContent).not.toContain("undefined lines");
      expect(document.body.textContent).toContain("unchanged");
    });

    it("summarizes the collapsed row as 'unchanged'", () => {
      expect(
        readRenderer
          .prepare(
            recordFromLegacyArgs(
              {
                file_path: "CLAUDE.md",
              },
              dedupResult,
              false,
              "complete",
            ),
          )
          .getResultSummary() ?? "",
      ).toBe("unchanged");
    });
  });
});
