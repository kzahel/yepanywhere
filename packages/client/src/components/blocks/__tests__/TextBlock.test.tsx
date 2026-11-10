import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RenderModeProvider,
  useOptionalRenderModeContext,
} from "../../../contexts/RenderModeContext";
import { SessionMetadataProvider } from "../../../contexts/SessionMetadataContext";
import { setInlineMediaExpandedPreference } from "../../../hooks/useInlineMedia";
import { I18nProvider } from "../../../i18n";
import { asClientSummarySourceKey } from "../../../lib/clientSummaryStore";
import type { YaSourceRuntime } from "../../../lib/sourceRuntime";
import { SourceRuntimeProvider } from "../../../lib/sourceRuntimeReact";
import { FakeSourceTransport } from "../../../lib/transport";
import localMediaStyles from "../../LocalMediaModal.module.css";
import { SessionAppLinkContext } from "../../SessionAppLinks";
import { TextBlock } from "../TextBlock";

function GlobalRenderModeButton() {
  const renderMode = useOptionalRenderModeContext();
  return (
    <button type="button" onClick={renderMode?.toggleGlobalMode}>
      global render mode
    </button>
  );
}

const apiMocks = vi.hoisted(() => ({
  getFile: vi.fn(),
  getFileRawUrl: vi.fn(),
}));

vi.mock("../../../components/FileRevisionLink", () => ({
  FileRevisionLink: () => null,
}));
vi.mock("../../../api/client", () => ({
  api: apiMocks,
}));

function createRuntime(transport: FakeSourceTransport): YaSourceRuntime {
  return {
    sourceKey: asClientSummarySourceKey("test:text-block"),
    transport,
    api: {} as YaSourceRuntime["api"],
    summary: {} as YaSourceRuntime["summary"],
    sessionDetails: {} as YaSourceRuntime["sessionDetails"],
  };
}

describe("TextBlock", () => {
  afterEach(() => {
    cleanup();
    setInlineMediaExpandedPreference(false);
    apiMocks.getFile.mockReset();
    apiMocks.getFileRawUrl.mockReset();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("defers local math rendering until streaming text completes", () => {
    const { container, rerender } = render(
      <I18nProvider>
        <TextBlock text="Streaming $x^2$ now" isStreaming={true} />
      </I18nProvider>,
    );

    expect(container.querySelector(".text-block-toggle")).toBeNull();
    expect(container.querySelector(".text-block-local-rendered")).toBeNull();
    expect(screen.getByText("Streaming $x^2$ now")).toBeDefined();

    rerender(
      <I18nProvider>
        <TextBlock text="Streaming $x^2$ now" isStreaming={false} />
      </I18nProvider>,
    );

    expect(container.querySelector(".text-block-toggle")).toBeTruthy();
    expect(container.querySelector(".text-block-local-rendered")).toBeTruthy();
    expect(container.querySelector(".katex")).toBeTruthy();
  });

  it("marks text the provider cut off to take a steering message", () => {
    const { container } = render(
      <I18nProvider>
        <TextBlock text="I will add the flag, have it override the" />
      </I18nProvider>,
    );

    expect(
      container.querySelector(".text-block-aborted-mid-stream"),
    ).toBeNull();

    cleanup();
    const cut = render(
      <I18nProvider>
        <TextBlock
          text="I will add the flag, have it override the"
          abortedMidStream={true}
        />
      </I18nProvider>,
    );

    const marker = cut.container.querySelector(
      ".text-block-aborted-mid-stream",
    );
    expect(marker?.textContent).toContain("interrupted by your message");
    expect(marker?.getAttribute("title")).toContain(
      "read the message you sent",
    );
  });

  it("does not show render toggle for server HTML that matches plain text", () => {
    const { container } = render(
      <I18nProvider>
        <TextBlock text="Plain answer." augmentHtml="<p>Plain answer.</p>" />
      </I18nProvider>,
    );

    expect(container.querySelector(".text-block-toggle")).toBeNull();
    expect(screen.getByText("Plain answer.")).toBeDefined();
  });

  it("rewrites rendered anchor destinations without changing their labels", () => {
    const { container } = render(
      <I18nProvider>
        <SessionAppLinkContext.Provider
          value={{
            rewriteHref: (href) =>
              href === "http://plan.localhost/"
                ? "https://plan.example.org/?ya_access=token"
                : href,
          }}
        >
          <TextBlock
            text="plan.localhost"
            augmentHtml={
              '<p><a href="http://plan.localhost/">plan.localhost</a></p>'
            }
          />
        </SessionAppLinkContext.Provider>
      </I18nProvider>,
    );

    const link = container.querySelector("a");
    expect(link?.textContent).toBe("plan.localhost");
    expect(link?.getAttribute("href")).toBe(
      "https://plan.example.org/?ya_access=token",
    );
  });

  it("shows render toggle for completed server markdown", () => {
    const { container } = render(
      <I18nProvider>
        <TextBlock
          text="- **win**"
          augmentHtml="<ul><li><strong>win</strong></li></ul>"
        />
      </I18nProvider>,
    );

    expect(container.querySelector(".text-block-toggle")).toBeTruthy();
    expect(container.querySelector("strong")?.textContent).toBe("win");
  });

  it("keeps assistant markdown rendered when global render mode changes", () => {
    const { container } = render(
      <I18nProvider>
        <RenderModeProvider>
          <GlobalRenderModeButton />
          <TextBlock
            text="- **win**"
            augmentHtml="<ul><li><strong>win</strong></li></ul>"
          />
        </RenderModeProvider>
      </I18nProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "global render mode" }));

    expect(container.querySelector("strong")?.textContent).toBe("win");
    expect(container.querySelector(".text-block-source")).toBeNull();
  });

  it("mounts local media previews inline beside rendered markdown links", async () => {
    setInlineMediaExpandedPreference(true);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new Blob(["png"], { type: "image/png" }))),
    );
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn(() => "blob:preview"),
      revokeObjectURL: vi.fn(),
    });

    const { container } = render(
      <I18nProvider>
        <TextBlock
          text="[trajectory](/tmp/trajectory.png)"
          augmentHtml={
            '<span class="local-media-link-group"><button type="button" class="local-media-inline-toggle" data-media-path="/tmp/trajectory.png" data-media-type="image" data-expanded="true" aria-label="Collapse image" aria-expanded="true" title="Collapse inline preview">-</button><a href="/api/local-image?path=%2Ftmp%2Ftrajectory.png" class="local-media-link" data-media-type="image">trajectory<span class="local-media-type">(image)</span></a></span><span class="local-media-inline-preview" data-media-path="/tmp/trajectory.png" data-media-type="image" data-expanded="true"></span>'
          }
        />
      </I18nProvider>,
    );

    expect(container.querySelector(".local-media-link")).toBeTruthy();
    expect(await screen.findByAltText("trajectory.png")).toBeTruthy();
    expect(
      container.querySelector(`.${localMediaStyles.inlineImageButton}`),
    ).toBeTruthy();
  });

  it("keeps inline media stable when paragraph quote buttons are disabled", async () => {
    setInlineMediaExpandedPreference(true);
    const fetchMock = vi.fn(
      async () => new Response(new Blob(["png"], { type: "image/png" })),
    );
    const observe = vi.fn();
    class ResizeObserverMock {
      observe = observe;
      disconnect = vi.fn();
    }
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn(() => "blob:preview"),
      revokeObjectURL: vi.fn(),
    });

    render(
      <I18nProvider>
        <TextBlock
          text="[trajectory](/tmp/trajectory.png)"
          augmentHtml={
            '<span class="local-media-link-group"><button type="button" class="local-media-inline-toggle" data-media-path="/tmp/trajectory.png" data-media-type="image" data-expanded="true" aria-label="Collapse image" aria-expanded="true" title="Collapse inline preview">-</button><a href="/api/local-image?path=%2Ftmp%2Ftrajectory.png" class="local-media-link" data-media-type="image">trajectory<span class="local-media-type">(image)</span></a></span><span class="local-media-inline-preview" data-media-path="/tmp/trajectory.png" data-media-type="image" data-expanded="true"></span>'
          }
          onQuoteBlock={() => {}}
          paragraphQuoteCirclesEnabled={false}
        />
      </I18nProvider>,
    );

    expect(await screen.findByAltText("trajectory.png")).toBeTruthy();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(observe).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: /Quote this paragraph/ }),
    ).toBeTruthy();
  });

  it("keeps inline media stable across paragraph quote measurements", async () => {
    setInlineMediaExpandedPreference(true);
    const fetchMock = vi.fn(
      async () => new Response(new Blob(["png"], { type: "image/png" })),
    );
    let resizeCallback: ResizeObserverCallback | null = null;
    let notifyIntersection: IntersectionObserverCallback = () => {};
    class ResizeObserverMock {
      constructor(callback: ResizeObserverCallback) {
        resizeCallback = callback;
      }
      observe = vi.fn();
      disconnect = vi.fn();
    }
    class IntersectionObserverMock {
      constructor(callback: IntersectionObserverCallback) {
        notifyIntersection = callback;
      }
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
    }
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
    vi.stubGlobal("IntersectionObserver", IntersectionObserverMock);
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn(() => "blob:preview"),
      revokeObjectURL: vi.fn(),
    });

    const { container } = render(
      <I18nProvider>
        <TextBlock
          text="[trajectory](/tmp/trajectory.png)"
          augmentHtml={
            '<p><span class="local-media-link-group"><button type="button" class="local-media-inline-toggle" data-media-path="/tmp/trajectory.png" data-media-type="image" data-expanded="true" aria-label="Collapse image" aria-expanded="true" title="Collapse inline preview">-</button><a href="/api/local-image?path=%2Ftmp%2Ftrajectory.png" class="local-media-link" data-media-type="image">trajectory<span class="local-media-type">(image)</span></a></span><span class="local-media-inline-preview" data-media-path="/tmp/trajectory.png" data-media-type="image" data-expanded="true"></span></p>'
          }
          onQuoteBlock={() => {}}
        />
      </I18nProvider>,
    );

    expect(await screen.findByAltText("trajectory.png")).toBeTruthy();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const surface = container.querySelector(".text-block");
    const paragraph = container.querySelector("p");
    expect(surface).toBeTruthy();
    expect(paragraph).toBeTruthy();
    act(() => {
      notifyIntersection(
        [
          { target: surface, isIntersecting: true },
        ] as unknown as IntersectionObserverEntry[],
        {} as IntersectionObserver,
      );
      notifyIntersection(
        [
          { target: paragraph, isIntersecting: true },
        ] as unknown as IntersectionObserverEntry[],
        {} as IntersectionObserver,
      );
    });
    await waitFor(() =>
      expect(
        container.querySelector(".text-block-quote-paragraph"),
      ).toBeTruthy(),
    );
    const preview = container.querySelector(".local-media-inline-preview");

    await act(async () => {
      resizeCallback?.([], {} as ResizeObserver);
      await new Promise((resolve) => setTimeout(resolve, 150));
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(container.querySelector(".local-media-inline-preview")).toBe(
      preview,
    );
  });

  it("keeps local media previews collapsed by default until expanded", async () => {
    setInlineMediaExpandedPreference(false);
    const fetchMock = vi.fn(
      async () => new Response(new Blob(["png"], { type: "image/png" })),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn(() => "blob:preview"),
      revokeObjectURL: vi.fn(),
    });

    const { container } = render(
      <I18nProvider>
        <TextBlock
          text="[trajectory](/tmp/trajectory.png)"
          augmentHtml={
            '<span class="local-media-link-group"><button type="button" class="local-media-inline-toggle" data-media-path="/tmp/trajectory.png" data-media-type="image" data-expanded="true" aria-label="Collapse image" aria-expanded="true" title="Collapse inline preview">-</button><a href="/api/local-image?path=%2Ftmp%2Ftrajectory.png" class="local-media-link" data-ya-resource="local-media" data-ya-path="/tmp/trajectory.png" data-ya-media-type="image" data-media-type="image">trajectory<span class="local-media-type">(image)</span></a></span><span class="local-media-inline-preview" data-media-path="/tmp/trajectory.png" data-media-type="image" data-expanded="true"></span>'
          }
        />
      </I18nProvider>,
    );

    const toggle = container.querySelector(
      ".local-media-inline-toggle",
    ) as HTMLButtonElement | null;
    const preview = container.querySelector(
      ".local-media-inline-preview",
    ) as HTMLElement | null;

    expect(toggle?.hidden).toBe(false);
    expect(toggle?.textContent).toBe("+");
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    expect(preview?.hidden).toBe(false);
    expect(preview?.getAttribute("data-expanded")).toBe("false");
    expect(
      container.querySelector(`.${localMediaStyles.inlineImageButton}`),
    ).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.click(toggle as HTMLButtonElement);

    expect(toggle?.textContent).toBe("-");
    expect(toggle?.getAttribute("aria-expanded")).toBe("true");
    expect(await screen.findByAltText("trajectory.png")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const clickAllowed = fireEvent.click(
      screen.getByRole("link", { name: /trajectory/i }),
    );

    expect(clickAllowed).toBe(false);
    expect(screen.getByRole("dialog").textContent).toContain("trajectory.png");
    expect(
      await screen.findByRole("img", { name: "trajectory.png" }),
    ).toBeTruthy();
  });

  it("keeps inline videos collapsed by default until expanded", async () => {
    setInlineMediaExpandedPreference(false);
    const fetchMock = vi.fn(
      async () => new Response(new Blob(["mp4"], { type: "video/mp4" })),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn(() => "blob:video-preview"),
      revokeObjectURL: vi.fn(),
    });

    const { container } = render(
      <I18nProvider>
        <TextBlock
          text="[demo](/tmp/demo.mp4)"
          augmentHtml={
            '<span class="local-media-link-group"><button type="button" class="local-media-inline-toggle" data-media-path="/tmp/demo.mp4" data-media-type="video" data-expanded="true" aria-label="Collapse video" aria-expanded="true" title="Collapse inline preview">-</button><a href="/api/local-image?path=%2Ftmp%2Fdemo.mp4" class="local-media-link" data-ya-resource="local-media" data-ya-path="/tmp/demo.mp4" data-ya-media-type="video" data-media-type="video">demo<span class="local-media-type">(video)</span></a></span><span class="local-media-inline-preview" data-media-path="/tmp/demo.mp4" data-media-type="video" data-expanded="true"></span>'
          }
        />
      </I18nProvider>,
    );

    const toggle = container.querySelector(
      ".local-media-inline-toggle",
    ) as HTMLButtonElement | null;
    const preview = container.querySelector(
      ".local-media-inline-preview",
    ) as HTMLElement | null;

    expect(toggle?.textContent).toBe("+");
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    expect(preview?.getAttribute("data-expanded")).toBe("false");
    expect(
      container.querySelector(`.${localMediaStyles.inlinePlayer}`),
    ).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.click(toggle as HTMLButtonElement);

    expect(toggle?.textContent).toBe("-");
    expect(toggle?.getAttribute("aria-expanded")).toBe("true");
    await waitFor(() => {
      expect(
        container.querySelector(`.${localMediaStyles.inlinePlayer}`),
      ).toBeTruthy();
    });
    // A direct transport hands the player the server URL to stream, instead
    // of fetching the whole video into a blob first.
    const videoUrl = "/api/local-image?path=%2Ftmp%2Fdemo.mp4";
    const inlinePlayer = container.querySelector<HTMLVideoElement>(
      `.${localMediaStyles.inlinePlayer}`,
    );
    expect(inlinePlayer?.getAttribute("src")).toBe(videoUrl);
    expect(inlinePlayer?.preload).toBe("metadata");
    expect(fetchMock).not.toHaveBeenCalled();

    const clickAllowed = fireEvent.click(
      screen.getByRole("link", { name: /demo/i }),
    );

    expect(clickAllowed).toBe(false);
    expect(screen.getByRole("dialog").textContent).toContain("demo.mp4");
    await waitFor(() => {
      expect(
        screen
          .getByRole("dialog")
          .querySelector(`.${localMediaStyles.player}`)
          ?.getAttribute("src"),
      ).toBe(videoUrl);
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("plays local audio links inline and in the modal", async () => {
    setInlineMediaExpandedPreference(false);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { container } = render(
      <I18nProvider>
        <TextBlock
          text="[clip](/tmp/clip.wav)"
          augmentHtml={
            '<span class="local-media-link-group"><button type="button" class="local-media-inline-toggle" data-media-path="/tmp/clip.wav" data-media-type="audio" data-expanded="false" aria-label="Expand audio" aria-expanded="false" title="Expand inline preview">+</button><a href="/api/local-image?path=%2Ftmp%2Fclip.wav" class="local-media-link" data-ya-resource="local-media" data-ya-path="/tmp/clip.wav" data-ya-media-type="audio" data-media-type="audio">clip<span class="local-media-type">(audio)</span></a></span><span class="local-media-inline-preview" data-media-path="/tmp/clip.wav" data-media-type="audio" data-expanded="false"></span>'
          }
        />
      </I18nProvider>,
    );

    fireEvent.click(
      container.querySelector(".local-media-inline-toggle") as HTMLElement,
    );
    const audioUrl = "/api/local-image?path=%2Ftmp%2Fclip.wav";
    await waitFor(() => {
      expect(
        container
          .querySelector(".local-media-inline-preview audio")
          ?.getAttribute("src"),
      ).toBe(audioUrl);
    });

    fireEvent.click(screen.getByRole("link", { name: /clip/i }));
    await waitFor(() => {
      expect(
        screen.getByRole("dialog").querySelector("audio")?.getAttribute("src"),
      ).toBe(audioUrl);
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("opens semantic local media links through the existing modal", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new Blob(["png"], { type: "image/png" }))),
    );
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn(() => "blob:preview"),
      revokeObjectURL: vi.fn(),
    });

    render(
      <I18nProvider>
        <TextBlock
          text="![trajectory](C:/tmp/trajectory.png)"
          augmentHtml={
            '<p><a href="/api/local-image?path=C%3A%2Ftmp%2Ftrajectory.png" data-ya-resource="local-media" data-ya-path="C:/tmp/trajectory.png" data-ya-media-type="image">trajectory</a></p>'
          }
        />
      </I18nProvider>,
    );

    const clickAllowed = fireEvent.click(
      screen.getByRole("link", { name: "trajectory" }),
    );

    expect(clickAllowed).toBe(false);
    expect(screen.getByRole("dialog").textContent).toContain("trajectory.png");
    expect(
      await screen.findByRole("img", { name: "trajectory.png" }),
    ).toBeTruthy();
  });

  it("opens hydrated image pixels and exposes their image actions", async () => {
    setInlineMediaExpandedPreference(true);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new Blob(["png"], { type: "image/png" }))),
    );
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn(() => "blob:preview"),
      revokeObjectURL: vi.fn(),
    });

    render(
      <I18nProvider>
        <TextBlock
          text="![trajectory](/tmp/trajectory.png)"
          augmentHtml={
            '<span class="local-media-link-group"><button type="button" class="local-media-inline-toggle" data-media-path="/tmp/trajectory.png" data-media-type="image" data-expanded="true" aria-label="Collapse image" aria-expanded="true">-</button><a href="/api/local-image?path=%2Ftmp%2Ftrajectory.png" class="local-media-link" data-ya-resource="local-media" data-ya-path="/tmp/trajectory.png" data-ya-media-type="image" data-media-type="image">trajectory<span class="local-media-type">(image)</span></a></span><span class="local-media-inline-preview" data-media-path="/tmp/trajectory.png" data-media-type="image" data-expanded="true"></span>'
          }
        />
      </I18nProvider>,
    );

    const preview = await screen.findByRole("button", {
      name: "Open trajectory.png",
    });
    fireEvent.contextMenu(preview);
    expect(
      screen.getAllByRole("menuitem").map((item) => item.textContent),
    ).toEqual(["Open", "Download", "Copy image", "Copy absolute file path"]);

    fireEvent.click(screen.getByRole("menuitem", { name: "Open" }));
    expect(screen.getByRole("dialog").textContent).toContain("trajectory.png");
    expect(
      await screen.findByRole("img", { name: "trajectory.png" }),
    ).toBeTruthy();
  });

  it("opens direct local-file links in a modal", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response('{"ok": true}\n', {
          headers: { "Content-Type": "application/json; charset=utf-8" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <I18nProvider>
        <TextBlock
          text="[probe json](/tmp/probe.json)"
          augmentHtml={
            '<p><a href="/api/local-file?path=%2Ftmp%2Fprobe.json">probe json</a></p>'
          }
        />
      </I18nProvider>,
    );

    const clickAllowed = fireEvent.click(
      screen.getByRole("link", { name: "probe json" }),
    );

    expect(clickAllowed).toBe(false);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/local-file?path=%2Ftmp%2Fprobe.json",
      {
        cache: "no-cache",
        credentials: "include",
        headers: expect.any(Headers),
        // Every API request carries the shared deadline, so a server that
        // accepts the connection and then stops answering still ends this
        // request. See api/requestDeadline.ts.
        signal: expect.any(AbortSignal),
      },
    );
    expect(screen.getByRole("dialog").textContent).toContain("probe.json");
    expect(await screen.findByText(/"ok": true/)).toBeTruthy();
  });

  it("labels a direct rendered file path and omits its raw API URL", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    render(
      <I18nProvider>
        <TextBlock
          text="[research-practice.md](/home/graehl/agents/user/research-practice.md:1)"
          augmentHtml={
            '<p><a href="/api/local-file?path=%2Fhome%2Fgraehl%2Fagents%2Fuser%2Fresearch-practice.md&amp;render=1&amp;line=1" data-ya-resource="local-file" data-ya-path="/home/graehl/agents/user/research-practice.md" data-ya-render-markdown="true" data-ya-line="1">research-practice.md</a></p>'
          }
        />
      </I18nProvider>,
    );

    fireEvent.contextMenu(
      screen.getByRole("link", { name: "research-practice.md" }),
    );

    expect(
      screen.queryByRole("menuitem", { name: "Copy viewer link" }),
    ).toBeNull();
    fireEvent.click(
      screen.getByRole("menuitem", { name: "Copy absolute file path" }),
    );

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(
        "/home/graehl/agents/user/research-practice.md",
      );
    });
  });

  it("opens a rendered local HTML link in the selected presentation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("<h1>Rendered local preview</h1>", {
            headers: { "Content-Type": "text/html" },
          }),
      ),
    );

    render(
      <I18nProvider>
        <TextBlock
          text="[demo.html](/tmp/demo.html)"
          augmentHtml={
            '<p><a href="/api/local-file?path=%2Ftmp%2Fdemo.html" data-ya-resource="local-file" data-ya-path="/tmp/demo.html">demo.html</a></p>'
          }
        />
      </I18nProvider>,
    );

    fireEvent.contextMenu(screen.getByRole("link", { name: "demo.html" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Open" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Preview" }));

    const frame = await waitFor(() => {
      const candidate = document.querySelector<HTMLIFrameElement>("iframe");
      expect(candidate).toBeTruthy();
      return candidate;
    });
    expect(frame?.getAttribute("sandbox")).toBe("allow-same-origin");
    expect(frame?.srcdoc).toContain("Rendered local preview");
  });

  it("opens absolute local-file links under the active project in FileViewer", async () => {
    apiMocks.getFile.mockResolvedValueOnce({
      content: "# Project doc\n\nRendered through FileViewer.",
      metadata: {
        isText: true,
        mimeType: "text/markdown",
        path: "docs/status.md",
        size: 36,
      },
      rawUrl: "/api/projects/project-1/files/raw?path=docs%2Fstatus.md",
      renderedMarkdownHtml: "<h1>Project doc</h1>",
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { container } = render(
      <I18nProvider>
        <SessionMetadataProvider
          projectId="project-1"
          projectPath="/Users/kgraehl/code/yepanywhere"
          sessionId="session-1"
        >
          <TextBlock
            text="[status](/Users/kgraehl/code/yepanywhere/docs/status.md)"
            augmentHtml={
              '<p><a href="/api/local-file?path=%2FUsers%2Fkgraehl%2Fcode%2Fyepanywhere%2Fdocs%2Fstatus.md" data-ya-resource="local-file" data-ya-path="/Users/kgraehl/code/yepanywhere/docs/status.md" data-ya-render-markdown="true">status</a></p>'
            }
          />
        </SessionMetadataProvider>
      </I18nProvider>,
    );

    const clickAllowed = fireEvent.click(
      screen.getByRole("link", { name: "status" }),
    );

    expect(clickAllowed).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(apiMocks.getFile).toHaveBeenCalledWith(
      "project-1",
      "docs/status.md",
      true,
      undefined,
      undefined,
      "full",
    );
    expect(await screen.findByText(/Project doc/)).toBeTruthy();
    const overlay = document.body.querySelector("[data-modal-overlay]");
    expect(overlay).toBeTruthy();
    expect(overlay?.parentElement).toBe(document.body);
    expect(container.contains(overlay)).toBe(false);
  });

  it("opens allowed external files in the session project FileViewer", async () => {
    apiMocks.getFile.mockResolvedValueOnce({
      content: "# External doc\n\nUses session glossary context.",
      metadata: {
        isText: true,
        mimeType: "text/markdown",
        path: "/tmp/external.md",
        size: 47,
      },
      rawUrl: "/api/projects/project-1/files/raw?path=%2Ftmp%2Fexternal.md",
      renderedMarkdownHtml: "<h1>External doc</h1>",
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    render(
      <I18nProvider>
        <SessionMetadataProvider
          projectId="project-1"
          projectPath="/workspace/project"
          sessionId="session-1"
        >
          <TextBlock
            text="[external](/tmp/external.md)"
            augmentHtml={
              '<p><a href="/api/local-file?path=%2Ftmp%2Fexternal.md" data-ya-resource="local-file" data-ya-path="/tmp/external.md" data-ya-render-markdown="true">external</a></p>'
            }
          />
        </SessionMetadataProvider>
      </I18nProvider>,
    );

    fireEvent.click(screen.getByRole("link", { name: "external" }));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(apiMocks.getFile).toHaveBeenCalledWith(
      "project-1",
      "/tmp/external.md",
      true,
      undefined,
      undefined,
      "full",
    );
    expect(await screen.findByText(/External doc/)).toBeTruthy();
  });

  it("opens generated project-file links in FileViewer", async () => {
    apiMocks.getFile.mockResolvedValueOnce({
      content: "# Project doc\n\nRendered through FileViewer.",
      metadata: {
        isText: true,
        mimeType: "text/markdown",
        path: "docs/status.md",
        size: 36,
      },
      rawUrl: "/api/projects/project-1/files/raw?path=docs%2Fstatus.md",
      renderedMarkdownHtml: "<h1>Project doc</h1>",
    });

    render(
      <I18nProvider>
        <TextBlock
          text="See docs/status.md"
          augmentHtml={
            '<p>See <a class="fixed-font-file-link" href="/projects/project-1/file?path=docs%2Fstatus.md&amp;line=8" data-ya-resource="project-file" data-ya-project-id="project-1" data-ya-path="docs/status.md" data-ya-line="8" data-ya-private-project-file-link="true">docs/status.md</a></p>'
          }
        />
      </I18nProvider>,
    );

    const clickAllowed = fireEvent.click(
      screen.getByRole("link", { name: "docs/status.md" }),
    );

    expect(clickAllowed).toBe(false);
    expect(apiMocks.getFile).toHaveBeenCalledWith(
      "project-1",
      "docs/status.md",
      true,
      8,
      undefined,
      "full",
    );
    expect(await screen.findByText(/Project doc/)).toBeTruthy();
  });

  it("opens explicit project file viewer URLs in FileViewer", async () => {
    apiMocks.getFile.mockResolvedValueOnce({
      content: "# Explicit URL\n\nRendered through FileViewer.",
      metadata: {
        isText: true,
        mimeType: "text/markdown",
        path: "topics/route.md",
        size: 41,
      },
      rawUrl: "/api/projects/project-1/files/raw?path=topics%2Froute.md",
      renderedMarkdownHtml: "<h1>Explicit URL</h1>",
    });

    render(
      <I18nProvider>
        <TextBlock
          text="See /projects/project-1/file?path=topics%2Froute.md"
          augmentHtml={
            '<p>See <a href="/projects/project-1/file?path=topics%2Froute.md&amp;line=12&amp;lineEnd=15">/projects/project-1/file?path=topics%2Froute.md</a></p>'
          }
        />
      </I18nProvider>,
    );

    const clickAllowed = fireEvent.click(
      screen.getByRole("link", {
        name: "/projects/project-1/file?path=topics%2Froute.md",
      }),
    );

    expect(clickAllowed).toBe(false);
    expect(apiMocks.getFile).toHaveBeenCalledWith(
      "project-1",
      "topics/route.md",
      true,
      12,
      15,
      "full",
    );
    expect(await screen.findByText(/Explicit URL/)).toBeTruthy();
  });

  it("normalizes browser-style Windows drive local-file links under the active project", async () => {
    apiMocks.getFile.mockResolvedValueOnce({
      content: "# Queue doc\n\nRendered through FileViewer.",
      metadata: {
        isText: true,
        mimeType: "text/markdown",
        path: "topics/message-control-steer-queue-btw-later-interrupt.md",
        size: 39,
      },
      rawUrl:
        "/api/projects/project-1/files/raw?path=topics%2Fmessage-control-steer-queue-btw-later-interrupt.md",
      renderedMarkdownHtml: "<h1>Queue doc</h1>",
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    render(
      <I18nProvider>
        <SessionMetadataProvider
          projectId="project-1"
          projectPath="C:/Users/user/Documents/code/yepanywhere"
          sessionId="session-1"
        >
          <TextBlock
            text="[queue doc](/C:/Users/user/Documents/code/yepanywhere/topics/message-control-steer-queue-btw-later-interrupt.md)"
            augmentHtml={
              '<p><a href="/api/local-file?path=%2FC%3A%2FUsers%2Fuser%2FDocuments%2Fcode%2Fyepanywhere%2Ftopics%2Fmessage-control-steer-queue-btw-later-interrupt.md&amp;render=1&amp;line=38" data-ya-resource="local-file" data-ya-path="/C:/Users/user/Documents/code/yepanywhere/topics/message-control-steer-queue-btw-later-interrupt.md" data-ya-render-markdown="true" data-ya-line="38">queue doc</a></p>'
            }
          />
        </SessionMetadataProvider>
      </I18nProvider>,
    );

    const clickAllowed = fireEvent.click(
      screen.getByRole("link", { name: "queue doc" }),
    );

    expect(clickAllowed).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(apiMocks.getFile).toHaveBeenCalledWith(
      "project-1",
      "topics/message-control-steer-queue-btw-later-interrupt.md",
      true,
      38,
      undefined,
      "full",
    );
    expect(await screen.findByText(/Queue doc/)).toBeTruthy();
  });

  it("preserves direct browser gestures for local-file links", () => {
    render(
      <I18nProvider>
        <TextBlock
          text="[probe json](/tmp/probe.json)"
          augmentHtml={
            '<p><a href="/api/local-file?path=%2Ftmp%2Fprobe.json">probe json</a></p>'
          }
        />
      </I18nProvider>,
    );

    let defaultPreventedBeforeDocument = true;
    document.addEventListener(
      "click",
      (event) => {
        defaultPreventedBeforeDocument = event.defaultPrevented;
        event.preventDefault();
      },
      { once: true },
    );

    fireEvent.click(screen.getByRole("link", { name: "probe json" }), {
      metaKey: true,
    });

    expect(defaultPreventedBeforeDocument).toBe(false);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens remote local-file links through the active connection", async () => {
    const fetchBlob = vi.fn(
      async () => new Blob(["remote file"], { type: "text/plain" }),
    );
    const runtime = createRuntime(
      new FakeSourceTransport({
        kind: "secure",
        capabilities: { sameOriginUrls: false },
        fetchBlob,
      }),
    );

    render(
      <I18nProvider>
        <SourceRuntimeProvider runtime={runtime}>
          <TextBlock
            text="[probe json](C:/tmp/probe.json)"
            augmentHtml={
              '<p><a href="/api/local-file?path=C%3A%2Ftmp%2Fprobe.json">probe json</a></p>'
            }
          />
        </SourceRuntimeProvider>
      </I18nProvider>,
    );

    const clickAllowed = fireEvent.click(
      screen.getByRole("link", { name: "probe json" }),
    );

    expect(clickAllowed).toBe(false);
    expect(fetchBlob).toHaveBeenCalledWith(
      "/local-file?path=C%3A%2Ftmp%2Fprobe.json",
    );
    expect(await screen.findByText("remote file")).toBeTruthy();
  });

  it("shows remote local-file server rejections inside the modal", async () => {
    const fetchBlob = vi.fn(async () => {
      throw new Error("API error: 403: Path not in allowed directories");
    });
    const runtime = createRuntime(
      new FakeSourceTransport({
        kind: "secure",
        capabilities: { sameOriginUrls: false },
        fetchBlob,
      }),
    );

    render(
      <I18nProvider>
        <SourceRuntimeProvider runtime={runtime}>
          <TextBlock
            text="[probe json](C:/tmp/probe.json)"
            augmentHtml={
              '<p><a href="/api/local-file?path=C%3A%2Ftmp%2Fprobe.json">probe json</a></p>'
            }
          />
        </SourceRuntimeProvider>
      </I18nProvider>,
    );

    const clickAllowed = fireEvent.click(
      screen.getByRole("link", { name: "probe json" }),
    );

    expect(clickAllowed).toBe(false);
    expect(
      await screen.findByText(/Path not in allowed directories/),
    ).toBeTruthy();
  });
});
