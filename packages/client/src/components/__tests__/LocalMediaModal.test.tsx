import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { toUrlProjectId } from "@yep-anywhere/shared";
import { useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionMetadataProvider } from "../../contexts/SessionMetadataContext";
import { I18nProvider } from "../../i18n";
import {
  clearCurrentSessionViewer,
  presentSessionViewer,
  useSessionViewerController,
} from "../../lib/sessionViewerController";
import { ImageViewer } from "../ImageViewer";
import imageViewerStyles from "../ImageViewer.module.css";
import {
  LocalFileModal,
  LocalMediaModal,
  type LocalMediaSource,
  useLocalMediaInlinePreviews,
} from "../LocalMediaModal";
import localMediaStyles from "../LocalMediaModal.module.css";
import { SessionViewerProvider } from "../SessionManagedViewer";

const originalCreateObjectUrlDescriptor = Object.getOwnPropertyDescriptor(
  URL,
  "createObjectURL",
);
const originalRevokeObjectUrlDescriptor = Object.getOwnPropertyDescriptor(
  URL,
  "revokeObjectURL",
);
const originalImageDecodeDescriptor = Object.getOwnPropertyDescriptor(
  HTMLImageElement.prototype,
  "decode",
);

function hasClass(element: Element, className: string | undefined): boolean {
  return className !== undefined && element.classList.contains(className);
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

function restoreObjectProperty(
  target: object,
  name: PropertyKey,
  descriptor: PropertyDescriptor | undefined,
) {
  if (descriptor) {
    Object.defineProperty(target, name, descriptor);
  } else {
    Reflect.deleteProperty(target, name);
  }
}

function MediaViewerControllerProbe() {
  const viewer = useSessionViewerController();
  return viewer ? (
    <button type="button" onClick={viewer.restore}>
      Restore image viewer
    </button>
  ) : null;
}

function InlineMediaPreviewHarness({
  html,
  source,
}: {
  html: string;
  source: LocalMediaSource;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  useLocalMediaInlinePreviews(rootRef, "stable-file-version", source);
  return (
    <div
      ref={rootRef}
      // biome-ignore lint/security/noDangerouslySetInnerHtml: test fixture mirrors sanitized Markdown output
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

describe("LocalMediaModal loading transitions", () => {
  afterEach(() => {
    act(() => clearCurrentSessionViewer());
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    restoreObjectProperty(
      URL,
      "createObjectURL",
      originalCreateObjectUrlDescriptor,
    );
    restoreObjectProperty(
      URL,
      "revokeObjectURL",
      originalRevokeObjectUrlDescriptor,
    );
    restoreObjectProperty(
      HTMLImageElement.prototype,
      "decode",
      originalImageDecodeDescriptor,
    );
  });

  it("keeps its fullscreen modal identity while the first image loads", async () => {
    const imageBlob = deferred<Blob>();
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => "blob:first-image"),
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn(),
    });

    render(
      <I18nProvider>
        <LocalMediaModal
          path="/tmp/first.png"
          mediaType="image"
          mediaSource={{ fetchBlob: () => imageBlob.promise }}
          onClose={() => {}}
        />
      </I18nProvider>,
    );

    expect(document.querySelector(".modal-overlay--image-viewer")).toBeTruthy();
    expect(screen.getByRole("dialog").classList).toContain(
      "modal--image-viewer",
    );
    expect(
      screen
        .getByRole("dialog")
        .querySelector(`.${localMediaStyles.imagePlaceholder}`),
    ).toBeTruthy();

    imageBlob.resolve(new Blob(["png"], { type: "image/png" }));
    expect(await screen.findByRole("img", { name: "first.png" })).toBeTruthy();
  });

  it("reuses inline media when generated HTML is replaced", async () => {
    const createObjectUrl = vi.fn(() => "blob:shared-plot");
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: createObjectUrl,
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn(),
    });
    const fetchBlob = vi.fn(
      async () => new Blob(["png"], { type: "image/png" }),
    );
    const source = { fetchBlob };
    const previews = ["first", "second"]
      .map(
        (label) =>
          `<span data-label="${label}" class="local-media-inline-preview" data-media-path="/tmp/plot.png" data-media-type="image" data-expanded="true"></span>`,
      )
      .join("");
    const { container, rerender } = render(
      <InlineMediaPreviewHarness html={previews} source={source} />,
    );

    await waitFor(() =>
      expect(container.querySelectorAll("img")).toHaveLength(2),
    );
    expect(fetchBlob).toHaveBeenCalledOnce();
    expect(createObjectUrl).toHaveBeenCalledOnce();

    rerender(
      <InlineMediaPreviewHarness
        html={`<p>Annotated</p>${previews}`}
        source={source}
      />,
    );

    await waitFor(() =>
      expect(container.querySelectorAll("img")).toHaveLength(2),
    );
    expect(fetchBlob).toHaveBeenCalledOnce();
    expect(createObjectUrl).toHaveBeenCalledOnce();
    expect(
      Array.from(container.querySelectorAll("img"), (image) => image.src),
    ).toEqual(["blob:shared-plot", "blob:shared-plot"]);
  });

  it("keeps the decoded image visible until its replacement is ready", async () => {
    const nextImageDecoded = deferred<void>();
    const createObjectUrl = vi
      .fn()
      .mockReturnValueOnce("blob:first-image")
      .mockReturnValueOnce("blob:second-image");
    const revokeObjectUrl = vi.fn();
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: createObjectUrl,
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: revokeObjectUrl,
    });
    const decode = vi.fn(() => nextImageDecoded.promise);
    Object.defineProperty(HTMLImageElement.prototype, "decode", {
      configurable: true,
      value: decode,
    });
    const mediaSource = {
      fetchBlob: async (path: string) =>
        new Blob([path], { type: "image/png" }),
    };
    const renderModal = (path: string, current: number) => (
      <I18nProvider>
        <LocalMediaModal
          path={path}
          mediaType="image"
          mediaSource={mediaSource}
          imageNavigation={{
            count: 2,
            current,
            onNext: () => {},
            onPrevious: () => {},
          }}
          onClose={() => {}}
        />
      </I18nProvider>
    );
    const { rerender } = render(renderModal("/tmp/first.png", 1));

    const firstImage = await screen.findByRole("img", { name: "first.png" });
    expect(firstImage.getAttribute("src")).toBe("blob:first-image");
    rerender(renderModal("/tmp/second.png", 2));

    await waitFor(() => expect(decode).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("img", { name: "first.png" })).toBe(firstImage);
    expect(screen.getByRole("link", { name: "first.png" })).toBeTruthy();
    expect(screen.getByText("1 of 2")).toBeTruthy();
    expect(screen.getByRole("dialog").classList).toContain(
      "modal--image-viewer",
    );
    expect(revokeObjectUrl).not.toHaveBeenCalledWith("blob:first-image");

    nextImageDecoded.resolve();
    const secondImage = await screen.findByRole("img", {
      name: "second.png",
    });
    expect(secondImage.getAttribute("src")).toBe("blob:second-image");
    expect(screen.getByRole("link", { name: "second.png" })).toBeTruthy();
    expect(screen.getByText("2 of 2")).toBeTruthy();
    await waitFor(() =>
      expect(revokeObjectUrl).toHaveBeenCalledWith("blob:first-image"),
    );
  });

  it("keeps the displayed image when a replacement fails", async () => {
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => "blob:first-image"),
    });
    const revokeObjectUrl = vi.fn();
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: revokeObjectUrl,
    });
    const mediaSource = {
      fetchBlob: async (path: string) => {
        if (path.endsWith("second.png")) {
          throw new Error("Replacement failed");
        }
        return new Blob([path], { type: "image/png" });
      },
    };
    const renderModal = (path: string, current: number) => (
      <I18nProvider>
        <LocalMediaModal
          path={path}
          mediaType="image"
          mediaSource={mediaSource}
          imageNavigation={{
            count: 2,
            current,
            onNext: () => {},
            onPrevious: () => {},
          }}
          onClose={() => {}}
        />
      </I18nProvider>
    );
    const { rerender } = render(renderModal("/tmp/first.png", 1));
    const firstImage = await screen.findByRole("img", { name: "first.png" });

    rerender(renderModal("/tmp/second.png", 2));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Replacement failed",
    );
    expect(screen.getByRole("img", { name: "first.png" })).toBe(firstImage);
    expect(screen.getByText("1 of 2")).toBeTruthy();
    expect(revokeObjectUrl).not.toHaveBeenCalledWith("blob:first-image");
  });

  it("ignores a decoded replacement after newer navigation supersedes it", async () => {
    const decodedByUrl = new Map<string, ReturnType<typeof deferred<void>>>();
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi
        .fn()
        .mockReturnValueOnce("blob:first-image")
        .mockReturnValueOnce("blob:second-image")
        .mockReturnValueOnce("blob:third-image"),
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn(),
    });
    Object.defineProperty(HTMLImageElement.prototype, "decode", {
      configurable: true,
      value: vi.fn(function (this: HTMLImageElement) {
        const pendingDecode = deferred<void>();
        decodedByUrl.set(this.src, pendingDecode);
        return pendingDecode.promise;
      }),
    });
    const mediaSource = {
      fetchBlob: async (path: string) =>
        new Blob([path], { type: "image/png" }),
    };
    const renderModal = (path: string, current: number) => (
      <I18nProvider>
        <LocalMediaModal
          path={path}
          mediaType="image"
          mediaSource={mediaSource}
          imageNavigation={{
            count: 3,
            current,
            onNext: () => {},
            onPrevious: () => {},
          }}
          onClose={() => {}}
        />
      </I18nProvider>
    );
    const { rerender } = render(renderModal("/tmp/first.png", 1));
    await screen.findByRole("img", { name: "first.png" });

    rerender(renderModal("/tmp/second.png", 2));
    await waitFor(() =>
      expect(decodedByUrl.has("blob:second-image")).toBe(true),
    );
    rerender(renderModal("/tmp/third.png", 3));
    await waitFor(() =>
      expect(decodedByUrl.has("blob:third-image")).toBe(true),
    );

    decodedByUrl.get("blob:second-image")?.resolve();
    await act(async () => {});
    expect(screen.getByRole("img", { name: "first.png" })).toBeTruthy();

    decodedByUrl.get("blob:third-image")?.resolve();
    expect(await screen.findByRole("img", { name: "third.png" })).toBeTruthy();
    expect(screen.queryByRole("img", { name: "second.png" })).toBeNull();
    expect(screen.getByText("3 of 3")).toBeTruthy();
  });
});

describe("LocalFileModal project paths", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("shows project-relative metadata while fetching the raw local path", async () => {
    const projectRoot = "C:\\Users\\user\\Documents\\code\\playbox";
    const rawPath = `${projectRoot}\\docs\\note.md`;
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) => {
        return new Response("hello", {
          headers: { "Content-Type": "text/plain" },
        });
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <I18nProvider>
        <SessionMetadataProvider
          projectId={toUrlProjectId(projectRoot)}
          projectPath={projectRoot}
          sessionId="session-1"
        >
          <LocalFileModal
            resource={{
              kind: "local-file",
              path: rawPath,
              lineNumber: 12,
              columnNumber: 4,
            }}
            onClose={() => {}}
          />
        </SessionMetadataProvider>
      </I18nProvider>,
    );

    const metadata = screen.getByText("docs/note.md:12:4");
    expect(metadata.getAttribute("title")).toBe(`${rawPath}:12:4`);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      encodeURIComponent(rawPath),
    );
  });

  it("opens ordinary HTML in a confined preview by default", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          '<h1>Local preview</h1><script>parent.document.body.dataset.pwned="1"</script>',
          { headers: { "Content-Type": "text/html" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const resource = { kind: "local-file" as const, path: "/tmp/demo.html" };

    render(
      <I18nProvider>
        <LocalFileModal resource={resource} onClose={() => {}} />
      </I18nProvider>,
    );

    const frame = await waitFor(() => {
      const candidate = document.querySelector<HTMLIFrameElement>("iframe");
      expect(candidate).toBeTruthy();
      return candidate;
    });
    if (!frame) throw new Error("Expected HTML preview iframe");
    // Same-origin so the viewer's find can search it; never with scripts.
    expect(frame.getAttribute("sandbox")).toBe("allow-same-origin");
    expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(frame.srcdoc).toContain("default-src 'none'");
    expect(document.body.dataset.pwned).toBeUndefined();
  });

  it("loads project-relative HTML through the project raw-file route", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL) =>
        new Response("<h1>Project preview</h1>", {
          headers: { "Content-Type": "text/html" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <I18nProvider>
        <LocalFileModal
          resource={{
            kind: "project-file",
            path: "research/paper.html",
            projectId: "project-id",
          }}
          onClose={() => {}}
        />
      </I18nProvider>,
    );

    await waitFor(() => expect(document.querySelector("iframe")).toBeTruthy());
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      "/api/projects/project-id/files/raw?path=research%2Fpaper.html",
    );
  });

  it("requests Markdown source or rendered preview from the existing route", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      return new Response(
        url.includes("render=1") ? "<h1>Rendered note</h1>" : "# Note\n",
        {
          headers: {
            "Content-Type": url.includes("render=1")
              ? "text/html"
              : "text/markdown",
          },
        },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const resource = {
      kind: "local-file" as const,
      path: "/tmp/note.md",
      renderMarkdown: true,
    };

    const { rerender } = render(
      <I18nProvider>
        <LocalFileModal
          resource={resource}
          initialPresentation="source"
          onClose={() => {}}
        />
      </I18nProvider>,
    );

    expect(await screen.findByText("# Note")).toBeTruthy();
    expect(String(fetchMock.mock.calls[0]?.[0])).not.toContain("render=1");

    rerender(
      <I18nProvider>
        <LocalFileModal
          resource={resource}
          initialPresentation="preview"
          onClose={() => {}}
        />
      </I18nProvider>,
    );

    await waitFor(() => expect(document.querySelector("iframe")).toBeTruthy());
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).includes("render=1")),
    ).toBe(true);
  });
});

describe("LocalMediaModal", () => {
  afterEach(() => {
    act(() => clearCurrentSessionViewer());
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    restoreObjectProperty(
      URL,
      "createObjectURL",
      originalCreateObjectUrlDescriptor,
    );
    restoreObjectProperty(
      URL,
      "revokeObjectURL",
      originalRevokeObjectUrlDescriptor,
    );
    restoreObjectProperty(
      HTMLImageElement.prototype,
      "decode",
      originalImageDecodeDescriptor,
    );
  });

  it("opens one fullscreen viewer with explicit zoom and download", async () => {
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => "blob:local-media-image"),
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn(),
    });
    const fetchBlob = vi.fn(
      async () => new Blob(["png"], { type: "image/png" }),
    );
    render(
      <I18nProvider>
        <LocalMediaModal
          path="/tmp/plot.png"
          mediaType="image"
          mediaSource={{ fetchBlob }}
          onClose={() => {}}
        />
      </I18nProvider>,
    );

    const imageLink = await screen.findByRole("link", { name: "plot.png" });
    expect(imageLink.getAttribute("href")).toBe("blob:local-media-image");
    expect(imageLink.getAttribute("target")).toBe("_blank");
    expect(imageLink.getAttribute("rel")).toBe("noopener noreferrer");

    const downloadLink = screen.getByRole("link", {
      name: "Download plot.png",
    });
    expect(downloadLink.getAttribute("href")).toBe("blob:local-media-image");
    expect(downloadLink.getAttribute("download")).toBe("plot.png");
    expect(
      screen
        .getByRole("toolbar", { name: "Image view controls" })
        .closest(".modal-header"),
    ).not.toBeNull();
    expect(
      screen.queryByRole("button", { name: "Close image viewer" }),
    ).toBeNull();

    expect(
      screen.getByRole("dialog").querySelector(`.${imageViewerStyles.viewer}`),
    ).toBeTruthy();
    const imageSurface = screen
      .getByRole("dialog")
      .querySelector<HTMLElement>(`.${imageViewerStyles.stage}`);
    expect(imageSurface).toBeTruthy();
    if (!imageSurface) return;
    fireEvent.click(screen.getByRole("radio", { name: "100%" }));
    expect(hasClass(imageSurface, imageViewerStyles.zoom)).toBe(true);
    fireEvent.click(screen.getByRole("radio", { name: "Fit" }));
    expect(hasClass(imageSurface, imageViewerStyles.fit)).toBe(true);

    const image = screen.getByRole("img", { name: "plot.png" });
    fireEvent.contextMenu(image);
    expect(
      screen.getAllByRole("menuitem").map((item) => item.textContent),
    ).toEqual(["Open", "Download", "Copy image", "Copy absolute file path"]);
    // Escape closes the menu, not the Modal under it.
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.getByRole("dialog")).toBeTruthy();
    Object.defineProperties(image, {
      naturalHeight: { configurable: true, value: 1080 },
      naturalWidth: { configurable: true, value: 1920 },
    });
    fireEvent.load(image);
    const stage = screen
      .getByRole("dialog")
      .querySelector<HTMLElement>(`.${imageViewerStyles.stage}`);
    expect(stage).toBeTruthy();
    if (!stage) return;
    Object.defineProperties(stage, {
      clientHeight: { configurable: true, value: 700 },
      clientWidth: { configurable: true, value: 1000 },
      setPointerCapture: { configurable: true, value: vi.fn() },
    });
    stage.getBoundingClientRect = vi.fn(() => ({
      bottom: 700,
      height: 700,
      left: 0,
      right: 1000,
      toJSON: () => ({}),
      top: 0,
      width: 1000,
      x: 0,
      y: 0,
    }));
    const dispatchTouchPointer = (
      type: "pointerdown" | "pointermove" | "pointerup",
      pointerId: number,
      clientX: number,
    ) => {
      const event = new MouseEvent(type, {
        bubbles: true,
        clientX,
        clientY: 300,
      });
      Object.defineProperties(event, {
        pointerId: { value: pointerId },
        pointerType: { value: "touch" },
      });
      fireEvent(stage, event);
    };
    dispatchTouchPointer("pointerdown", 1, 300);
    dispatchTouchPointer("pointerdown", 2, 500);
    dispatchTouchPointer("pointermove", 2, 700);
    expect(hasClass(imageSurface, imageViewerStyles.zoom)).toBe(true);
    expect(
      screen
        .getByRole("dialog")
        .querySelector(`.${imageViewerStyles.zoomLevel}`)?.textContent,
    ).toBe("101%");

    dispatchTouchPointer("pointerup", 1, 300);
    dispatchTouchPointer("pointerup", 2, 700);
    fireEvent.click(screen.getByRole("radio", { name: "100%" }));
    await act(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => resolve());
        }),
    );
    stage.scrollLeft = 500;
    dispatchTouchPointer("pointerdown", 1, 300);
    dispatchTouchPointer("pointerdown", 2, 500);
    dispatchTouchPointer("pointermove", 1, 400);
    dispatchTouchPointer("pointermove", 2, 600);
    await waitFor(() => expect(stage.scrollLeft).toBe(400));
    expect(
      screen
        .getByRole("dialog")
        .querySelector(`.${imageViewerStyles.zoomLevel}`)?.textContent,
    ).toBe("100%");

    expect(fetchBlob).toHaveBeenCalledWith(
      "/tmp/plot.png",
      "/api/local-image?path=%2Ftmp%2Fplot.png",
      "modal",
    );
  });

  it("exposes gallery navigation through buttons and arrow keys", async () => {
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => "blob:local-media-image"),
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn(),
    });
    const onNext = vi.fn();
    const onPrevious = vi.fn();
    const mediaSource = {
      fetchBlob: async () => new Blob(["png"], { type: "image/png" }),
    };

    const renderModal = (next: () => void, previous: () => void) => (
      <I18nProvider>
        <LocalMediaModal
          path="/tmp/plot.png"
          mediaType="image"
          mediaSource={mediaSource}
          imageNavigation={{
            count: 4,
            current: 2,
            onNext: next,
            onPrevious: previous,
          }}
          onClose={() => {}}
        />
      </I18nProvider>
    );
    const { rerender } = render(renderModal(onNext, onPrevious));

    expect(await screen.findByText("2 of 4")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Previous image" }));
    fireEvent.click(screen.getByRole("button", { name: "Next image" }));
    expect(onPrevious).toHaveBeenCalledTimes(1);
    expect(onNext).toHaveBeenCalledTimes(1);

    const updatedOnNext = vi.fn();
    const updatedOnPrevious = vi.fn();
    rerender(renderModal(updatedOnNext, updatedOnPrevious));
    fireEvent.keyDown(document, { key: "ArrowLeft" });
    expect(
      hasClass(
        screen.getByRole("group", { name: "Gallery image navigation" }),
        imageViewerStyles.hidden,
      ),
    ).toBe(true);
    expect(
      hasClass(screen.getByText("2 of 4"), imageViewerStyles.visible),
    ).toBe(true);
    fireEvent.keyDown(document, { key: "ArrowRight" });
    fireEvent.keyDown(document, { key: "ArrowRight", repeat: true });
    fireEvent.keyDown(document, { ctrlKey: true, key: "ArrowRight" });

    expect(onPrevious).toHaveBeenCalledTimes(1);
    expect(onNext).toHaveBeenCalledTimes(1);
    expect(updatedOnPrevious).toHaveBeenCalledTimes(1);
    expect(updatedOnNext).toHaveBeenCalledTimes(2);
  });

  it("reveals transient gallery chrome without covering the image", () => {
    vi.useFakeTimers();
    const onNext = vi.fn();
    const onPrevious = vi.fn();
    const navigationModel = {
      count: 4,
      current: 2,
      onNext,
      onPrevious,
    };

    const { rerender } = render(
      <I18nProvider>
        <ImageViewer
          fileName="plot.png"
          navigation={navigationModel}
          url="blob:local-media-image"
        />
      </I18nProvider>,
    );

    const viewer = document.querySelector<HTMLElement>(
      `.${imageViewerStyles.viewer}`,
    );
    const stageShell = document.querySelector<HTMLElement>(
      `.${imageViewerStyles.stageShell}`,
    );
    const stage = document.querySelector<HTMLElement>(
      `.${imageViewerStyles.stage}`,
    );
    const navigation = screen.getByRole("group", {
      name: "Gallery image navigation",
    });
    const position = screen.getByText("2 of 4");
    expect(viewer).toBeTruthy();
    expect(stageShell).toBeTruthy();
    expect(stage).toBeTruthy();
    if (!viewer || !stageShell || !stage) return;

    expect(hasClass(navigation, imageViewerStyles.visible)).toBe(true);
    expect(hasClass(position, imageViewerStyles.visible)).toBe(true);
    expect(stageShell.contains(position)).toBe(false);
    expect(position.parentElement).toBe(viewer);
    expect(
      screen
        .getByRole("button", { name: "Previous image" })
        .querySelector("path")
        ?.getAttribute("d"),
    ).toBe("m15 18-6-6 6-6");

    act(() => vi.advanceTimersByTime(2_000));
    expect(hasClass(navigation, imageViewerStyles.hidden)).toBe(true);
    expect(hasClass(position, imageViewerStyles.hidden)).toBe(true);

    const mouseMove = new MouseEvent("pointermove", { bubbles: true });
    Object.defineProperty(mouseMove, "pointerType", { value: "mouse" });
    fireEvent(stage, mouseMove);
    expect(hasClass(navigation, imageViewerStyles.visible)).toBe(true);
    expect(hasClass(position, imageViewerStyles.visible)).toBe(true);

    rerender(
      <I18nProvider>
        <ImageViewer
          fileName="plot.png"
          initialNavigationChrome="position"
          keyboardNavigationSequence={1}
          navigation={navigationModel}
          url="blob:local-media-image"
        />
      </I18nProvider>,
    );
    expect(hasClass(navigation, imageViewerStyles.hidden)).toBe(true);
    expect(hasClass(position, imageViewerStyles.visible)).toBe(true);

    Object.defineProperty(stage, "setPointerCapture", {
      configurable: true,
      value: vi.fn(),
    });
    for (const type of ["pointerdown", "pointerup"]) {
      const touchEvent = new MouseEvent(type, { bubbles: true });
      Object.defineProperties(touchEvent, {
        pointerId: { value: 1 },
        pointerType: { value: "touch" },
      });
      fireEvent(stage, touchEvent);
    }
    expect(hasClass(navigation, imageViewerStyles.visible)).toBe(true);
    expect(hasClass(position, imageViewerStyles.visible)).toBe(true);
  });

  it("dismisses through the shared Back, Backspace, Escape, and close paths", async () => {
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => "blob:local-media-image"),
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn(),
    });
    const onClose = vi.fn();

    render(
      <I18nProvider>
        <LocalMediaModal
          path="/tmp/plot.png"
          mediaType="image"
          mediaSource={{
            fetchBlob: async () => new Blob(["png"], { type: "image/png" }),
          }}
          onClose={onClose}
        />
      </I18nProvider>,
    );

    await screen.findByRole("img", { name: "plot.png" });
    const stage = screen
      .getByRole("dialog")
      .querySelector<HTMLElement>(`.${imageViewerStyles.stage}`);
    expect(stage).toBeTruthy();
    if (!stage) return;
    expect(stage.getAttribute("role")).toBeNull();
    expect(stage.tabIndex).toBe(-1);

    fireEvent.click(stage);
    fireEvent.click(screen.getByRole("img", { name: "plot.png" }));
    fireEvent.keyDown(stage, { key: "Enter" });
    expect(onClose).not.toHaveBeenCalled();

    window.history.replaceState({}, "");
    window.dispatchEvent(new PopStateEvent("popstate", { state: {} }));
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(document, { key: "Backspace" });
    expect(onClose).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(3);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(4);
  });

  it("parks a path-backed image in the session viewer controller", async () => {
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => "blob:local-media-image"),
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn(),
    });
    const onClose = vi.fn();

    render(
      <I18nProvider>
        <SessionViewerProvider sessionId="session-1">
          <LocalMediaModal
            path="/tmp/plot.png"
            mediaType="image"
            mediaSource={{
              fetchBlob: async () => new Blob(["png"], { type: "image/png" }),
            }}
            onClose={onClose}
          />
          <MediaViewerControllerProbe />
        </SessionViewerProvider>
      </I18nProvider>,
    );

    await screen.findByRole("img", { name: "plot.png" });
    fireEvent.click(screen.getByRole("radio", { name: "100%" }));
    const stage = screen
      .getByRole("dialog")
      .querySelector<HTMLElement>(`.${imageViewerStyles.stage}`);
    expect(stage && hasClass(stage, imageViewerStyles.zoom)).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Minimize" }));
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "Restore image viewer" }),
    );
    expect(screen.getByRole("img", { name: "plot.png" })).toBeTruthy();
    expect(stage && hasClass(stage, imageViewerStyles.zoom)).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByRole("button", { name: "Restore image viewer" }),
    ).toBeNull();
  });

  it("parks a nested image with its existing parent viewer", async () => {
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => "blob:local-media-image"),
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn(),
    });
    const onClose = vi.fn();
    const parentOnClose = vi.fn();
    act(() => {
      presentSessionViewer({
        id: "parent-viewer",
        kind: "file",
        sessionId: "session-1",
        label: "docs/guide.md",
        filePath: "docs/guide.md",
        lineSuffix: "",
        onClose: parentOnClose,
      });
    });

    render(
      <I18nProvider>
        <SessionViewerProvider sessionId="session-1">
          <LocalMediaModal
            path="/tmp/plot.png"
            parentViewerId="parent-viewer"
            mediaType="image"
            mediaSource={{
              fetchBlob: async () => new Blob(["png"], { type: "image/png" }),
            }}
            onClose={onClose}
          />
          <MediaViewerControllerProbe />
        </SessionViewerProvider>
      </I18nProvider>,
    );

    await screen.findByRole("img", { name: "plot.png" });
    fireEvent.click(screen.getByRole("button", { name: "Minimize" }));
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "Restore image viewer" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(parentOnClose).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "Restore image viewer" }),
    ).toBeTruthy();
  });

  it("fits vector sources to the stage instead of stopping at their declared size", () => {
    const fitZoomLabel = (vector: boolean) => {
      cleanup();
      render(
        <I18nProvider>
          <ImageViewer
            fileName={vector ? "figure.svg" : "plot.png"}
            url="blob:local-media-image"
            vector={vector}
          />
        </I18nProvider>,
      );
      const stage = document.querySelector<HTMLElement>(
        `.${imageViewerStyles.stage}`,
      );
      const image = screen.getByRole("img", {
        name: vector ? "figure.svg" : "plot.png",
      });
      if (!stage) throw new Error("missing stage");
      // A 1000x600 usable stage after the viewer's 32px padding.
      Object.defineProperty(stage, "clientWidth", {
        configurable: true,
        value: 1032,
      });
      Object.defineProperty(stage, "clientHeight", {
        configurable: true,
        value: 632,
      });
      Object.defineProperty(image, "naturalWidth", {
        configurable: true,
        value: 200,
      });
      Object.defineProperty(image, "naturalHeight", {
        configurable: true,
        value: 120,
      });
      fireEvent.load(image);
      return {
        image,
        zoom: screen.getByRole("status").textContent,
      };
    };

    const raster = fitZoomLabel(false);
    expect(raster.zoom).toBe("100%");
    expect(hasClass(raster.image, imageViewerStyles.vector)).toBe(false);

    const vector = fitZoomLabel(true);
    expect(vector.zoom).toBe("500%");
    expect(hasClass(vector.image, imageViewerStyles.vector)).toBe(true);
  });
});
