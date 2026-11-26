import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SourceTransport } from "../../lib/transport/types";
import { I18nProvider } from "../../i18n";
import { ManagedArtifactPreview } from "../ManagedArtifactPreview";
import { ArtifactPreview } from "../ArtifactPreview";

const state = vi.hoisted(() => ({
  fetch: vi.fn(),
  version: {} as Record<string, unknown> | null,
  share: null as object | null,
  shareStatus: null as { canCreate: boolean } | null,
  getPublicFileShares: vi.fn(),
  createPublicFileShare: vi.fn(),
}));
const statusListeners = new Set<() => void>();
let sourceSnapshot = { kind: "secure", state: "ready", channels: [] };
const capabilities: {
  sameOriginUrls: boolean;
  scopedPreviewFiles?: boolean;
  openHtmlPreview?: SourceTransport["capabilities"]["openHtmlPreview"];
  packagedArtifactViewerVersion?: 1;
} = { sameOriginUrls: true };
const runtime = {
  sourceKey: "localhost",
  transport: {
    fetch: state.fetch,
    capabilities,
    status: {
      getSnapshot: () => sourceSnapshot,
      subscribe: (listener: () => void) => {
        statusListeners.add(listener);
        return () => statusListeners.delete(listener);
      },
    },
  },
};
vi.mock("../../contexts/SourceRuntimeContext", () => ({
  useCurrentSourceRuntime: () => runtime,
}));
vi.mock("../../hooks/useVersion", () => ({
  useRetainedVersionInfo: () => state.version,
}));
vi.mock("../../contexts/PublicShareContext", () => ({
  usePublicShareContext: () => state.share,
}));
vi.mock("../../hooks/usePublicShareStatus", () => ({
  usePublicShareStatus: () => ({ status: state.shareStatus }),
}));
vi.mock("../../api/client", () => ({
  api: {
    getPublicFileShares: state.getPublicFileShares,
    createPublicFileShare: state.createPublicFileShare,
  },
}));

const PROJECT_ID = "cHJvamVjdA";
const SHARE_URL = `https://ya.example/remote/share/secret123/file?h=relayuser&projectId=${PROJECT_ID}&path=mockup%2Findex.html&standalone=1#v=2&target=file`;

beforeEach(() => {
  delete capabilities.packagedArtifactViewerVersion;
  delete capabilities.scopedPreviewFiles;
  delete capabilities.openHtmlPreview;
  sourceSnapshot = { kind: "secure", state: "ready", channels: [] };
  state.version = {
    current: "0.8.2",
    capabilities: ["artifact-viewer"],
    artifactViewer: {
      port: 4402,
      available: true,
      locked: false,
      localOrigin: "http://artifacts.localhost:3400",
      publicOrigin: "https://artifacts.example.org",
    },
  };
  state.share = null;
  state.shareStatus = { canCreate: true };
  state.fetch.mockReset();
  state.getPublicFileShares.mockReset();
  state.createPublicFileShare.mockReset();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function mount(projectId?: string) {
  return render(
    <I18nProvider>
      <ArtifactPreview
        html="<p>Static</p>"
        path={projectId ? "mockup/index.html" : "/mockup/index.html"}
        projectId={projectId}
        title="Mockup"
      />
    </I18nProvider>,
  );
}

async function runAndOpenMenu(projectId?: string) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ artifactViewer: 1 }),
    }),
  );
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
  const origin =
    window.location.hostname === "localhost"
      ? "http://artifacts.localhost:3400"
      : "https://artifacts.example.org";
  state.fetch.mockResolvedValue({
    id: "grant",
    url: `${origin}/a/token/index.html`,
    expiresAt: Date.now() + 1000,
  });
  mount(projectId);
  fireEvent.click(
    screen.getByRole("button", {
      name: "Run full HTML/CSS/JavaScript preview (current view is sanitized)",
    }),
  );
  const stop = await screen.findByRole("button", {
    name: "Stop interactive preview",
  });
  fireEvent.contextMenu(stop, { clientX: 20, clientY: 20 });
  return stop;
}

it("does not contact an artifact origin or request grants from an old server", () => {
  state.version = { current: "0.8.1" };
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  mount();
  expect(screen.queryByRole("button")).toBeNull();
  expect(screen.getByTitle("Mockup").getAttribute("sandbox")).toBe(
    "allow-same-origin",
  );
  expect(fetch).not.toHaveBeenCalled();
  expect(state.fetch).not.toHaveBeenCalled();
});

it("keeps a static preview when resolution fails and retries only on request", async () => {
  const fetch = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
  vi.stubGlobal("fetch", fetch);
  mount();
  fireEvent.click(
    screen.getByRole("button", {
      name: "Run full HTML/CSS/JavaScript preview (current view is sanitized)",
    }),
  );
  await screen.findByRole("status");
  expect(state.fetch).not.toHaveBeenCalled();
  expect(screen.getByTitle("Mockup").getAttribute("sandbox")).toBe(
    "allow-same-origin",
  );
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch).toHaveBeenCalledWith(
    expect.stringContaining("/health"),
    expect.objectContaining({
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
    }),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Retry interactive preview" }),
  );
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
});

it("admits only after a successful probe and keeps the grant reusable", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ artifactViewer: 1 }),
    }),
  );
  const origin =
    window.location.hostname === "localhost"
      ? "http://artifacts.localhost:3400"
      : "https://artifacts.example.org";
  state.fetch.mockResolvedValue({
    id: "grant",
    url: `${origin}/a/token/index.html`,
    expiresAt: Date.now() + 1000,
  });
  const { unmount } = mount();
  fireEvent.click(
    screen.getByRole("button", {
      name: "Run full HTML/CSS/JavaScript preview (current view is sanitized)",
    }),
  );
  await screen.findByRole("button", { name: "Stop interactive preview" });
  expect(screen.getByTitle("Mockup").getAttribute("sandbox")).toBe(
    "allow-scripts allow-same-origin allow-downloads",
  );
  expect(screen.getByTitle("Mockup").getAttribute("src")).toBe(
    `${origin}/a/token/index.html`,
  );
  unmount();
  expect(state.fetch).toHaveBeenCalledTimes(1);
});

it.each([
  { reused: false, revokes: 1 },
  { reused: true, revokes: 0 },
])(
  "revokes a grant that arrives after the preview closed only if it was minted for it: %j",
  async ({ reused, revokes }) => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ artifactViewer: 1 }),
      }),
    );
    const origin =
      window.location.hostname === "localhost"
        ? "http://artifacts.localhost:3400"
        : "https://artifacts.example.org";
    let admit!: (grant: object) => void;
    state.fetch.mockImplementation((_path: string, init?: RequestInit) =>
      init?.method === "DELETE"
        ? Promise.resolve({ success: true })
        : new Promise((resolve) => {
            admit = resolve;
          }),
    );
    const { unmount } = mount();
    fireEvent.click(
      screen.getByRole("button", {
        name: "Run full HTML/CSS/JavaScript preview (current view is sanitized)",
      }),
    );
    await waitFor(() => expect(state.fetch).toHaveBeenCalledTimes(1));
    unmount();
    admit({
      id: "grant",
      url: `${origin}/a/token/index.html`,
      expiresAt: Date.now() + 1000,
      reused,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      state.fetch.mock.calls.filter(
        ([, init]) => (init as RequestInit | undefined)?.method === "DELETE",
      ),
    ).toHaveLength(revokes);
  },
);

it("opens only its own frame's same-grant tab requests, without an opener", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ artifactViewer: 1 }),
    }),
  );
  const open = vi.fn();
  vi.stubGlobal("open", open);
  const origin =
    window.location.hostname === "localhost"
      ? "http://artifacts.localhost:3400"
      : "https://artifacts.example.org";
  state.fetch.mockResolvedValue({
    id: "grant",
    url: `${origin}/a/token/index.html`,
    expiresAt: Date.now() + 1000,
  });
  mount();
  fireEvent.click(
    screen.getByRole("button", {
      name: "Run full HTML/CSS/JavaScript preview (current view is sanitized)",
    }),
  );
  await screen.findByRole("button", { name: "Stop interactive preview" });
  const frame = screen.getByTitle("Mockup") as HTMLIFrameElement;
  const request = (url: string, source: Window | null) =>
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { protocol: "yep-artifact-tab/1", type: "open", url },
        source,
      }),
    );
  request(`${origin}/a/other/paper.pdf`, frame.contentWindow);
  request(`${origin}/a/token/paper.pdf?next=1`, frame.contentWindow);
  request(`${origin}/a/token/paper.pdf`, window);
  expect(open).not.toHaveBeenCalled();
  request(`${origin}/a/token/paper.pdf?download=true`, frame.contentWindow);
  expect(open).toHaveBeenCalledWith(
    `${origin}/a/token/paper.pdf?download=true`,
    "_blank",
    "noopener,noreferrer",
  );
});

it("copies the file's public share as a play link, never a public artifact grant", async () => {
  state.getPublicFileShares.mockResolvedValue({ items: [] });
  state.createPublicFileShare.mockResolvedValue({ url: SHARE_URL });
  const stop = await runAndOpenMenu(PROJECT_ID);
  fireEvent.click(screen.getByRole("menuitem", { name: "Copy public URL" }));
  await waitFor(() =>
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      `https://ya.example/remote/play.html?h=relayuser&projectId=${PROJECT_ID}&path=mockup%2Findex.html#share=secret123`,
    ),
  );
  expect(state.createPublicFileShare).toHaveBeenCalledWith({
    projectId: PROJECT_ID,
    path: "mockup/index.html",
  });
  // The only artifact grant is the local one that runs the preview.
  expect(state.fetch).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("menu")).toBeNull();
  fireEvent.contextMenu(stop, { clientX: 20, clientY: 20 });
  fireEvent.click(
    screen.getByRole("menuitem", { name: "Stop interactive preview" }),
  );
  await screen.findByRole("button", {
    name: "Run full HTML/CSS/JavaScript preview (current view is sanitized)",
  });
  expect(screen.getByTitle("Mockup").getAttribute("sandbox")).toBe(
    "allow-same-origin",
  );
});

it("reuses the file's existing public share for Copy public URL", async () => {
  state.getPublicFileShares.mockResolvedValue({
    items: [{ shareId: "s1", url: SHARE_URL }],
  });
  await runAndOpenMenu(PROJECT_ID);
  fireEvent.click(screen.getByRole("menuitem", { name: "Copy public URL" }));
  await waitFor(() =>
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      expect.stringContaining("/remote/play.html?"),
    ),
  );
  expect(state.getPublicFileShares).toHaveBeenCalledWith(
    PROJECT_ID,
    "mockup/index.html",
  );
  expect(state.createPublicFileShare).not.toHaveBeenCalled();
});

it("offers no Copy public URL without a project file or share creation", async () => {
  await runAndOpenMenu();
  expect(screen.getByRole("menuitem", { name: "Stop interactive preview" }));
  expect(
    screen.queryByRole("menuitem", { name: "Copy public URL" }),
  ).toBeNull();
  cleanup();
  state.shareStatus = { canCreate: false };
  await runAndOpenMenu(PROJECT_ID);
  expect(
    screen.queryByRole("menuitem", { name: "Copy public URL" }),
  ).toBeNull();
});

it("never offers private grants in a public share", () => {
  state.share = {};
  mount();
  expect(screen.queryByRole("button")).toBeNull();
  expect(state.fetch).not.toHaveBeenCalled();
});

it.each(["0.9.1", "0.9.2"])(
  "keeps hosted servers at %s on the old viewer without preview lease requests",
  (current) => {
    vi.stubGlobal("location", {
      origin: "https://latest.yepanywhere.com",
      hostname: "latest.yepanywhere.com",
      href: "https://latest.yepanywhere.com/",
    });
    vi.stubGlobal("navigator", {
      userAgent: "Mozilla/5.0 Chrome/148.0.0.0",
      language: "en-US",
    });
    state.version = {
      current,
      capabilities: [],
      artifactViewer: { available: false, port: 4402, locked: false },
    };
    const { container } = mount(PROJECT_ID);
    expect(container.querySelector("iframe")?.getAttribute("sandbox")).toBe(
      "allow-same-origin",
    );
    expect(state.fetch).not.toHaveBeenCalled();
  },
);

it("preserves an explicit custom artifact host when the managed capability exists", () => {
  vi.stubGlobal("location", {
    origin: "https://latest.yepanywhere.com",
    hostname: "latest.yepanywhere.com",
    href: "https://latest.yepanywhere.com/",
  });
  vi.stubGlobal("navigator", {
    userAgent: "Mozilla/5.0 Chrome/148.0.0.0",
    language: "en-US",
  });
  state.version = {
    ...state.version,
    current: "0.9.4",
    capabilities: ["artifact-viewer", "artifact-relay-preview"],
  };
  const { container } = mount(PROJECT_ID);
  expect(container.querySelector("iframe")?.getAttribute("sandbox")).toBe(
    "allow-same-origin",
  );
  expect(screen.getByRole("button", { name: /Run full HTML/ })).toBeTruthy();
  expect(state.fetch).not.toHaveBeenCalled();
});

it("renders the static fallback while a first-party server version is unknown", () => {
  vi.stubGlobal("location", {
    origin: "https://latest.yepanywhere.com",
    hostname: "latest.yepanywhere.com",
    href: "https://latest.yepanywhere.com/",
  });
  vi.stubGlobal("navigator", {
    userAgent: "Mozilla/5.0 Chrome/155.0.0.0",
    language: "en-US",
  });
  state.version = null;
  const { container } = mount();
  expect(container.querySelector("iframe")?.getAttribute("sandbox")).toBe(
    "allow-same-origin",
  );
  expect(state.fetch).not.toHaveBeenCalled();
});

it("releases a managed lease admitted after its viewer closes", async () => {
  let admit!: (lease: object) => void;
  state.fetch.mockImplementation((_path: string, init?: RequestInit) =>
    init?.method === "DELETE"
      ? Promise.resolve({ success: true })
      : new Promise((resolve) => {
          admit = resolve;
        }),
  );
  const { unmount } = render(
    <I18nProvider>
      <ManagedArtifactPreview
        html="<p>Static</p>"
        path="/bundle/index.html"
        title="Managed"
      />
    </I18nProvider>,
  );
  await waitFor(() => expect(state.fetch).toHaveBeenCalledOnce());
  expect(state.fetch.mock.calls[0]?.[1]?.signal).toBeUndefined();
  unmount();
  await act(async () =>
    admit({ id: "late", entry: "index.html", expiresAt: Date.now() + 1000 }),
  );
  expect(state.fetch).toHaveBeenLastCalledWith("/artifact-previews/late", {
    method: "DELETE",
    signal: expect.any(AbortSignal),
  });
});

it("selects the packaged viewer after native hello even when version data was already cached", async () => {
  vi.stubGlobal("location", {
    origin: "https://appassets.androidplatform.net",
    hostname: "appassets.androidplatform.net",
    href: "https://appassets.androidplatform.net/",
  });
  vi.stubGlobal("navigator", {
    userAgent: "Mozilla/5.0 Chrome/124.0.0.0",
    language: "en-US",
  });
  state.version = {
    current: "0.9.4",
    capabilities: ["artifact-relay-preview"],
    artifactViewer: { available: false },
  };
  state.fetch.mockImplementation(() => new Promise(() => {}));
  sourceSnapshot = { ...sourceSnapshot, state: "connecting" };
  mount();
  expect(state.fetch).not.toHaveBeenCalled();
  await act(async () => {
    capabilities.packagedArtifactViewerVersion = 1;
    sourceSnapshot = { ...sourceSnapshot, state: "ready" };
    for (const listener of statusListeners) listener();
  });
  expect(state.fetch).toHaveBeenCalledWith(
    "/artifact-previews",
    expect.objectContaining({ method: "POST" }),
  );
});

it("keeps the native preview file grant until the isolated sheet closes", async () => {
  let dismiss!: () => void;
  const open = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        dismiss = resolve;
      }),
  );
  capabilities.openHtmlPreview = open;
  capabilities.scopedPreviewFiles = true;
  state.version = { capabilities: ["artifact-relay-preview"] };
  state.fetch.mockResolvedValue({
    id: "native-grant",
    entry: "index.html",
    expiresAt: Date.now() + 60_000,
  });
  mount(PROJECT_ID);
  expect(state.fetch).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: /run/i }));
  await waitFor(() =>
    expect(open).toHaveBeenCalledWith(
      "<p>Static</p>",
      "Mockup",
      true,
      { id: "native-grant", sessionId: undefined },
      expect.any(AbortSignal),
    ),
  );
  expect(state.fetch).toHaveBeenCalledTimes(1);
  expect(state.fetch).toHaveBeenCalledWith(
    "/artifact-previews",
    expect.objectContaining({
      method: "POST",
      body: JSON.stringify({
        path: "mockup/index.html",
        projectId: PROJECT_ID,
      }),
    }),
  );
  await act(async () => dismiss());
  expect(state.fetch).toHaveBeenLastCalledWith(
    "/artifact-previews/native-grant",
    {
      method: "DELETE",
      signal: expect.any(AbortSignal),
    },
  );
});
