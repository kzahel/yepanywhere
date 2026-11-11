import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  FileViewer,
  type FileViewerSource,
} from "../../src/components/FileViewer";
import {
  type LocalMediaSource,
  LocalMediaModal,
  useLocalMediaInlinePreviews,
} from "../../src/components/LocalMediaModal";
import { I18nProvider } from "../../src/i18n";
import { LOCAL_CLIENT_SUMMARY_SOURCE_KEY } from "../../src/lib/clientSummaryStore";
import type { YaSourceRuntime } from "../../src/lib/sourceRuntime";
import { SourceRuntimeProvider } from "../../src/lib/sourceRuntimeReact";
import { FakeSourceTransport } from "../../src/lib/transport";
import "../../src/styles/purposeGlobals";

/**
 * Mounts one Blob-backed media surface at a time, as a relayed client sees
 * them, so a browser test can check that closing each surface releases the
 * Blobs it fetched.
 */

type BlobSurface =
  | "modal-image"
  | "modal-video"
  | "inline-images"
  | "viewer-image"
  | "viewer-video";

declare global {
  interface Window {
    blobRetention: {
      show(surface: BlobSurface, generation: number): void;
      hide(): void;
      fetchedBytes(): number;
    };
  }
}

const BLOB_BYTES = 1024 * 1024;
let fetchedBytes = 0;

// The fixture's Blobs are zero-filled placeholders that no browser can decode.
// A surface that hears the decode error replaces its media element with a
// fallback, which on a slow runner happens before the test counts the element
// (observed in CI: the file viewer showing "cannot be displayed inline"). Blob
// lifetime is the subject here, so the error stops at the window during
// capture, before any element listener sees it.
window.addEventListener(
  "error",
  (event) => {
    if (
      event.target instanceof HTMLMediaElement ||
      event.target instanceof HTMLImageElement
    ) {
      event.stopImmediatePropagation();
    }
  },
  true,
);

function fetchedBlob(type: string): Promise<Blob> {
  fetchedBytes += BLOB_BYTES;
  return Promise.resolve(new Blob([new Uint8Array(BLOB_BYTES)], { type }));
}

const mediaSource: LocalMediaSource = {
  buildApiPath: (path) => `/fixture-media?path=${encodeURIComponent(path)}`,
  fetchBlob: (path) =>
    fetchedBlob(path.endsWith(".mp4") ? "video/mp4" : "image/png"),
};

function viewerSource(path: string, mimeType: string): FileViewerSource {
  return {
    loadFile: async () => ({
      metadata: { path, size: BLOB_BYTES, mimeType, isText: false },
      rawUrl: `/fixture-raw?path=${encodeURIComponent(path)}`,
    }),
    fetchRawFileBlob: () => fetchedBlob(mimeType),
  };
}

const runtime: YaSourceRuntime = {
  sourceKey: LOCAL_CLIENT_SUMMARY_SOURCE_KEY,
  transport: new FakeSourceTransport({
    kind: "secure",
    capabilities: { sameOriginUrls: false },
  }),
  api: {} as YaSourceRuntime["api"],
  summary: {} as YaSourceRuntime["summary"],
  sessionDetails: {} as YaSourceRuntime["sessionDetails"],
};

function InlineImages({ generation }: { generation: number }) {
  const rootRef = useRef<HTMLDivElement>(null);
  useLocalMediaInlinePreviews(rootRef, `generation-${generation}`, mediaSource);
  const html = ["a", "b", "c"]
    .map(
      (name) =>
        `<span class="local-media-inline-preview" data-media-path="/tmp/${generation}-${name}.png" data-media-type="image" data-expanded="true"></span>`,
    )
    .join("");
  return (
    <div
      ref={rootRef}
      // biome-ignore lint/security/noDangerouslySetInnerHtml: fixture mirrors sanitized Markdown output
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

function Surface({
  surface,
  generation,
}: {
  surface: BlobSurface;
  generation: number;
}) {
  switch (surface) {
    case "modal-image":
    case "modal-video": {
      const extension = surface === "modal-image" ? "png" : "mp4";
      return (
        <LocalMediaModal
          path={`/tmp/${generation}.${extension}`}
          mediaType={surface === "modal-image" ? "image" : "video"}
          mediaSource={mediaSource}
          onClose={() => {}}
        />
      );
    }
    case "inline-images":
      return <InlineImages generation={generation} />;
    case "viewer-image":
    case "viewer-video": {
      const path =
        surface === "viewer-image"
          ? `shots/${generation}.png`
          : `clips/${generation}.mp4`;
      return (
        <FileViewer
          projectId="fixture-project"
          filePath={path}
          source={viewerSource(
            path,
            surface === "viewer-image" ? "image/png" : "video/mp4",
          )}
        />
      );
    }
  }
}

function Fixture() {
  const [shown, setShown] = useState<{
    surface: BlobSurface;
    generation: number;
  } | null>(null);
  window.blobRetention = {
    show: (surface, generation) => setShown({ surface, generation }),
    hide: () => setShown(null),
    fetchedBytes: () => fetchedBytes,
  };
  return (
    <SourceRuntimeProvider runtime={runtime}>
      <I18nProvider>
        {shown ? (
          <Surface
            key={`${shown.surface}-${shown.generation}`}
            surface={shown.surface}
            generation={shown.generation}
          />
        ) : null}
      </I18nProvider>
    </SourceRuntimeProvider>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing fixture root");
createRoot(root).render(<Fixture />);
