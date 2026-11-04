import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import { ProjectAppViewer } from "../ProjectAppViewer";

const mock = vi.hoisted(() => ({
  version: "0.9.4",
  denyLivePreview: false,
  fetch: vi.fn(),
}));
vi.mock("../../hooks/useVersion", () => ({
  useVersion: () => ({
    version: {
      current: mock.version,
      deniedCapabilityBits: mock.denyLivePreview ? [[3, 64]] : [],
    },
  }),
}));
vi.mock("../../api/sourceApiFetch", () => ({ fetchJSON: mock.fetch }));
// Process-state events, the agent activity a static app's watch follows.
const activity = vi.hoisted(() => {
  const listeners = new Set<(event: unknown) => void>();
  return {
    listeners,
    emit: (event: object) => {
      for (const listener of listeners)
        listener({ type: "process-state-changed", ...event });
    },
  };
});
vi.mock("../../lib/activityBus", () => ({
  activityBus: {
    on: (_type: string, listener: (event: unknown) => void) => {
      activity.listeners.add(listener);
      return () => activity.listeners.delete(listener);
    },
  },
}));
beforeEach(() => {
  mock.version = "0.9.4";
  mock.denyLivePreview = false;
  mock.fetch.mockReset().mockImplementation(async (path: string) =>
    path.endsWith("/open")
      ? {
          id: "static:test",
          kind: "static",
          label: "Canvas",
          url: "https://artifacts.example/a/token/index.html",
          transferable: true,
        }
      : path.endsWith("/address")
        ? { enabled: false, reservations: [] }
        : {
            projectId: "test",
            declaration: { where: { kind: "static" } },
            state: "ready",
            latestArtifact: null,
            canExecute: true,
            canShare: true,
            removedFrom: [],
          },
  );
});
afterEach(cleanup);
it.each([false, true])(
  "gates live preview start requests when denied=%s",
  async (denied) => {
    mock.denyLivePreview = denied;
    const original = mock.fetch.getMockImplementation()!;
    mock.fetch.mockImplementation(async (...args) => {
      const value = await original(...args);
      if (String(args[0]).endsWith("/app"))
        return { ...value, livePreview: { where: { kind: "process" } } };
      return value;
    });
    render(
      <I18nProvider>
        <ProjectAppViewer projectId="test" presentation="settings" />
      </I18nProvider>,
    );
    await screen.findByText("App: ready");
    if (denied) {
      expect(screen.queryByRole("button", { name: "Live preview" })).toBeNull();
      expect(
        mock.fetch.mock.calls.some(([path]) => path.endsWith("/start")),
      ).toBe(false);
    } else {
      fireEvent.click(screen.getByRole("button", { name: "Live preview" }));
      await waitFor(() =>
        expect(mock.fetch).toHaveBeenCalledWith("/projects/test/app/start", {
          method: "POST",
          body: JSON.stringify({ mode: "live-preview" }),
        }),
      );
    }
  },
);
it("renders address controls inline and saves visibility without stopping serving", async () => {
  const row = {
    name: "canvas",
    namespace: "apps.example",
    owner: "superuser",
    serving: true,
    public: false,
    privateOnly: false,
    url: "https://canvas.apps.example/?ya_access=private",
  };
  mock.fetch.mockImplementation(
    async (path: string, options?: { body: string }) => {
      if (path.endsWith("/serve")) {
        Object.assign(row, JSON.parse(options!.body));
        return row;
      }
      if (path.endsWith("/address"))
        return {
          enabled: true,
          namespace: "apps.example",
          canPublish: true,
          reservations: [{ ...row }],
        };
      return { state: "ready", declaration: null, removedFrom: [] };
    },
  );
  const { container } = render(
    <I18nProvider>
      <ProjectAppViewer projectId="test" presentation="settings" />
    </I18nProvider>,
  );
  fireEvent.click(
    await screen.findByRole("checkbox", { name: "Public — no link required" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Save access" }));
  await waitFor(() => expect(row.public).toBe(true));
  expect(row.serving).toBe(true);
  expect(container.querySelector("iframe")).toBeNull();
  expect(mock.fetch.mock.calls.some(([path]) => path.endsWith("/open"))).toBe(
    false,
  );
  expect(
    screen
      .getByRole("button", { name: "Copy viewer link" })
      .getAttribute("href"),
  ).toBe(row.url);
});
it("copies the served address from the bar instead of the launch link", async () => {
  const served = "https://canvas.apps.example/?ya_access=private";
  const original = mock.fetch.getMockImplementation()!;
  mock.fetch.mockImplementation(async (...args) =>
    String(args[0]).endsWith("/address")
      ? {
          enabled: true,
          namespace: "apps.example",
          canPublish: false,
          reservations: [
            {
              name: "canvas",
              namespace: "apps.example",
              owner: "superuser",
              serving: true,
              public: false,
              privateOnly: false,
              url: served,
            },
          ],
        }
      : original(...args),
  );
  const writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  const { container } = render(
    <I18nProvider>
      <ProjectAppViewer projectId="test" />
    </I18nProvider>,
  );
  await waitFor(() => expect(container.querySelector("iframe")).toBeTruthy());
  const link = screen.getByRole("button", { name: "Copy viewer link" });
  await waitFor(() =>
    expect(link.getAttribute("title")).toBe("Serving: canvas.apps.example"),
  );
  fireEvent.click(link);
  await waitFor(() => expect(writeText).toHaveBeenCalledWith(served));
});
it("tells a user without publishing permission who can make the app public", async () => {
  mock.fetch.mockImplementation(async (path: string) => {
    if (path.endsWith("/address"))
      return {
        enabled: true,
        namespace: "apps.example",
        canPublish: false,
        reservations: [
          {
            name: "archer-canvas",
            namespace: "apps.example",
            owner: "archer",
            serving: true,
            public: false,
            privateOnly: true,
          },
        ],
      };
    return { state: "ready", declaration: null, removedFrom: [] };
  });
  render(
    <I18nProvider>
      <ProjectAppViewer projectId="test" presentation="settings" />
    </I18nProvider>,
  );
  expect(
    await screen.findByText(
      /Public access \(no link required\) needs the administrator/,
    ),
  ).toBeTruthy();
  expect(
    screen.queryByRole("checkbox", { name: "Public — no link required" }),
  ).toBeNull();
});
it("sends no App requests to an older server", () => {
  mock.version = "0.9.2";
  render(
    <I18nProvider>
      <ProjectAppViewer projectId="test" onBack={() => {}} />
    </I18nProvider>,
  );
  expect(screen.getByText("Project App requires a newer server.")).toBeTruthy();
  expect(mock.fetch).not.toHaveBeenCalled();
});
it("offers a view-only user Start for a stopped app and never Stop", async () => {
  const process = {
    version: 1,
    where: { kind: "process", cwd: ".", entry: "/" },
    start: { argv: ["npm", "start"], portEnv: "PORT" },
  };
  let running = false;
  mock.fetch.mockImplementation(async (path: string) =>
    path.endsWith("/address")
      ? { enabled: false, reservations: [] }
      : path.endsWith("/app")
        ? {
            projectId: "test",
            declaration: process,
            ...(running ? { activeDeclaration: process } : {}),
            state: running ? "running" : "stopped",
            latestArtifact: null,
            canExecute: false,
            canStart: true,
            canShare: false,
            removedFrom: [],
          }
        : new Promise(() => {}),
  );
  render(
    <I18nProvider>
      <ProjectAppViewer projectId="test" onBack={() => {}} />
    </I18nProvider>,
  );
  expect(await screen.findByRole("button", { name: "Start app" })).toBeTruthy();
  running = true;
  cleanup();
  render(
    <I18nProvider>
      <ProjectAppViewer projectId="test" onBack={() => {}} />
    </I18nProvider>,
  );
  await screen.findByText(/running/);
  expect(screen.queryByRole("button", { name: "Stop app" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Start app" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Restart app" })).toBeNull();
});
it("starts a stopped process app before serving its address, and warns while it is served but stopped", async () => {
  const process = {
    version: 1,
    where: { kind: "process", cwd: ".", entry: "/" },
    start: { argv: ["npm", "start"], portEnv: "PORT" },
  };
  const row = {
    name: "canvas",
    namespace: "apps.example",
    owner: "superuser",
    serving: false,
    public: false,
    privateOnly: false,
  };
  let running = false;
  mock.fetch.mockImplementation(
    async (path: string, options?: { body: string }) => {
      if (path.endsWith("/start")) {
        running = true;
        return {};
      }
      if (path.endsWith("/serve")) {
        Object.assign(row, JSON.parse(options!.body));
        return row;
      }
      if (path.endsWith("/address"))
        return {
          enabled: true,
          namespace: "apps.example",
          canPublish: true,
          reservations: [{ ...row }],
        };
      return {
        projectId: "test",
        declaration: process,
        ...(running ? { activeDeclaration: process } : {}),
        state: running ? "running" : "stopped",
        latestArtifact: null,
        canExecute: true,
        canShare: false,
        removedFrom: [],
      };
    },
  );
  render(
    <I18nProvider>
      <ProjectAppViewer projectId="test" presentation="settings" />
    </I18nProvider>,
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Start app and serve here" }),
  );
  await waitFor(() =>
    expect(
      mock.fetch.mock.calls
        .map(([path]) => path)
        .filter((path) => /\/(start|serve)$/.test(path)),
    ).toEqual(["/projects/test/app/start", "/projects/test/app/address/serve"]),
  );
  expect(
    await screen.findByRole("button", { name: "Stop serving at this address" }),
  ).toBeTruthy();
  expect(screen.queryByText(/visitors to canvas\.apps\.example/)).toBeNull();

  running = false;
  cleanup();
  render(
    <I18nProvider>
      <ProjectAppViewer projectId="test" presentation="settings" />
    </I18nProvider>,
  );
  expect(
    await screen.findByText(/visitors to canvas\.apps\.example see/),
  ).toBeTruthy();
});
it("restarts a running app as stop, then start in its running mode", async () => {
  const process = {
    version: 1,
    where: { kind: "process", cwd: ".", entry: "/" },
    start: { argv: ["npm", "start"], portEnv: "PORT" },
  };
  mock.fetch.mockImplementation(async (path: string) =>
    path.endsWith("/address")
      ? { enabled: false, reservations: [] }
      : path.endsWith("/app")
        ? {
            projectId: "test",
            declaration: process,
            livePreview: process,
            activeDeclaration: process,
            mode: "live-preview",
            state: "running",
            latestArtifact: null,
            canExecute: true,
            canShare: false,
            removedFrom: [],
          }
        : path.endsWith("/stop") || path.endsWith("/start")
          ? {}
          : new Promise(() => {}),
  );
  render(
    <I18nProvider>
      <ProjectAppViewer projectId="test" presentation="settings" />
    </I18nProvider>,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Restart app" }));
  await waitFor(() =>
    expect(
      mock.fetch.mock.calls
        .map(([path, init]) => [path, init?.body])
        .filter(([path]) => /\/(stop|start)$/.test(path)),
    ).toEqual([
      ["/projects/test/app/stop", "{}"],
      ["/projects/test/app/start", JSON.stringify({ mode: "live-preview" })],
    ]),
  );
});
it("returns Back from the latest artifact to the project app before closing", async () => {
  mock.fetch.mockImplementation(async (path: string, init?: RequestInit) =>
    path.endsWith("/open")
      ? JSON.parse(String(init?.body)).target === "artifact"
        ? {
            id: "artifact:a1",
            kind: "artifact",
            label: "example.html",
            url: "https://artifacts.example/a/token/example.html",
            transferable: true,
          }
        : {
            id: "static:test",
            kind: "static",
            label: "Canvas",
            url: "https://artifacts.example/a/token/index.html",
            transferable: true,
          }
      : path.endsWith("/address")
        ? { enabled: false, reservations: [] }
        : {
            projectId: "test",
            declaration: { where: { kind: "static" } },
            state: "ready",
            latestArtifact: { id: "a1", label: "example.html" },
            canExecute: true,
            canShare: true,
            removedFrom: [],
          },
  );
  const onBack = vi.fn();
  const { container } = render(
    <I18nProvider>
      <ProjectAppViewer
        projectId="test"
        initialTarget={{ target: "artifact", artifactId: "a1" }}
        onBack={onBack}
      />
    </I18nProvider>,
  );
  await waitFor(() =>
    expect(container.querySelector("iframe")?.title).toBe("example.html"),
  );
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  await waitFor(() =>
    expect(container.querySelector("iframe")?.title).toBe("Canvas"),
  );
  expect(onBack).not.toHaveBeenCalled();
  // The toolbar toggle stays usable after the app's view has loaded.
  const latest = screen.getByRole("button", {
    name: "Latest artifact: example.html",
  });
  fireEvent.click(latest);
  await waitFor(() =>
    expect(container.querySelector("iframe")?.title).toBe("example.html"),
  );
  expect(latest.getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(latest);
  await waitFor(() =>
    expect(container.querySelector("iframe")?.title).toBe("Canvas"),
  );
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  expect(onBack).toHaveBeenCalledTimes(1);
  // The project name is Home: from an artifact it shows the app, and from
  // the app it reopens the entry route.
  cleanup();
  const titled = render(
    <I18nProvider>
      <ProjectAppViewer
        projectId="test"
        projectName="garden"
        initialTarget={{ target: "artifact", artifactId: "a1" }}
      />
    </I18nProvider>,
  );
  await waitFor(() =>
    expect(titled.container.querySelector("iframe")?.title).toBe(
      "example.html",
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "garden" }));
  await waitFor(() =>
    expect(titled.container.querySelector("iframe")?.title).toBe("Canvas"),
  );
  const opens = () =>
    mock.fetch.mock.calls.filter(([path]) => path.endsWith("/open")).length;
  const before = opens();
  fireEvent.click(screen.getByRole("button", { name: "garden" }));
  await waitFor(() => expect(opens()).toBe(before + 1));
  // A host offering its own artifact button suppresses the toolbar's.
  cleanup();
  const hosted = render(
    <I18nProvider>
      <ProjectAppViewer projectId="test" offerLatestArtifact={false} />
    </I18nProvider>,
  );
  await waitFor(() =>
    expect(hosted.container.querySelector("iframe")?.title).toBe("Canvas"),
  );
  expect(
    screen.queryByRole("button", { name: "Latest artifact: example.html" }),
  ).toBeNull();
});
it("shows a view-only user settings status without controls it cannot use", async () => {
  const original = mock.fetch.getMockImplementation()!;
  mock.fetch.mockImplementation(async (...args) => {
    const value = await original(...args);
    return String(args[0]).endsWith("/app")
      ? { ...value, canExecute: false, canShare: false, canCopyLink: false }
      : value;
  });
  const { container } = render(
    <I18nProvider>
      <ProjectAppViewer projectId="test" onSession={() => {}} />
    </I18nProvider>,
  );
  await waitFor(() => expect(container.querySelector("iframe")).toBeTruthy());
  expect(
    screen.queryByRole("button", { name: "New session in this project" }),
  ).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "App settings" }));
  await screen.findByText("App: ready");
  expect(
    screen.queryByRole("button", { name: "Create share link" }),
  ).toBeNull();
  expect(
    screen.queryByText(/Public app delivery is not configured/),
  ).toBeNull();
});
it("marks a copied launch link live until a confirmed restart revokes it", async () => {
  const process = {
    version: 1,
    where: { kind: "process", cwd: ".", entry: "/" },
    start: { argv: ["npm", "start"], portEnv: "PORT" },
  };
  let launch = 1;
  mock.fetch.mockImplementation(async (path: string) => {
    if (path.endsWith("/stop") || path.endsWith("/start")) {
      if (path.endsWith("/start")) launch += 1;
      return {};
    }
    if (path.endsWith("/open"))
      return {
        id: `service:test:${launch}`,
        kind: "service",
        label: "Project app",
        url: `http://app-${launch}.localhost/?ya_access=t${launch}`,
        transferable: true,
      };
    if (path.endsWith("/address")) return { enabled: false, reservations: [] };
    return {
      projectId: "test",
      declaration: process,
      activeDeclaration: process,
      state: "running",
      latestArtifact: null,
      canExecute: true,
      canShare: false,
      removedFrom: [],
    };
  });
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn(async () => {}) },
  });
  const confirm = vi.spyOn(window, "confirm");
  const { container } = render(
    <I18nProvider>
      <ProjectAppViewer projectId="test" />
    </I18nProvider>,
  );
  await waitFor(() => expect(container.querySelector("iframe")).toBeTruthy());
  const link = () => screen.getByRole("button", { name: "Copy viewer link" });
  expect(link().className).toMatch(/linkInactive/);
  fireEvent.click(link());
  await waitFor(() => expect(link().className).toMatch(/linkActive/));
  // Declining leaves the app and its link alone.
  confirm.mockReturnValueOnce(false);
  fireEvent.click(screen.getByRole("button", { name: "Restart app" }));
  expect(
    mock.fetch.mock.calls.some(([path]) => String(path).endsWith("/stop")),
  ).toBe(false);
  confirm.mockReturnValueOnce(true);
  fireEvent.click(screen.getByRole("button", { name: "Restart app" }));
  await waitFor(() =>
    expect(container.querySelector("iframe")?.getAttribute("src")).toContain(
      "app-2",
    ),
  );
  expect(link().className).toMatch(/linkInactive/);
  // A right-click (or held press) restarts without asking.
  confirm.mockClear();
  fireEvent.contextMenu(screen.getByRole("button", { name: "Restart app" }));
  await waitFor(() =>
    expect(container.querySelector("iframe")?.getAttribute("src")).toContain(
      "app-3",
    ),
  );
  expect(confirm).not.toHaveBeenCalled();
  confirm.mockRestore();
});
it("lights reload for newer static files, arms a one-shot reload, and holds to auto-reload", async () => {
  localStorage.clear();
  let stamp = "2026-10-18T00:00:01.000Z";
  mock.fetch.mockImplementation(async (path: string) =>
    path.endsWith("/open")
      ? {
          id: "static:test",
          kind: "static",
          label: "Canvas",
          url: "https://artifacts.example/a/token/index.html",
          transferable: true,
        }
      : path.endsWith("/address")
        ? { enabled: false, reservations: [] }
        : {
            projectId: "test",
            declaration: { where: { kind: "static" } },
            state: "ready",
            updatedAt: stamp,
            latestArtifact: null,
            canExecute: true,
            canShare: false,
            removedFrom: [],
          },
  );
  const opens = () =>
    mock.fetch.mock.calls.filter(([path]) => String(path).endsWith("/open"))
      .length;
  const { container } = render(
    <I18nProvider>
      <ProjectAppViewer projectId="test" />
    </I18nProvider>,
  );
  await waitFor(() => expect(container.querySelector("iframe")).toBeTruthy());
  const reload = () => screen.getByRole("button", { name: "Reload from disk" });
  const infoReads = () =>
    mock.fetch.mock.calls.filter(([path]) => String(path).endsWith("/app"))
      .length;
  // Returning to the page is one trigger for a reading.
  const poll = async () => {
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
  };
  expect(reload().className).toBe("");
  // With no activity the viewer reads nothing, even as the files change.
  stamp = "2026-10-18T00:00:02.000Z";
  const quiet = infoReads();
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(infoReads()).toBe(quiet);
  // A project agent going idle reads at once and lights the button; another
  // project's agent does not.
  act(() => {
    activity.emit({ projectId: "other", sessionId: "x", activity: "idle" });
  });
  expect(infoReads()).toBe(quiet);
  act(() => {
    activity.emit({ projectId: "test", sessionId: "s1", activity: "idle" });
  });
  await waitFor(() => expect(reload().className).toMatch(/reloadStale/));
  // Newer files light the button; clicking loads them and clears it.
  await act(async () => {
    fireEvent.click(reload());
  });
  await waitFor(() => expect(container.querySelector("iframe")).toBeTruthy());
  await waitFor(() => expect(reload().className).toBe(""));
  // A click with nothing new arms one reload for the next change.
  // Await the open and its focus-listener effect before returning to the page.
  await act(async () => {
    fireEvent.click(reload());
  });
  await waitFor(() => expect(reload().className).toMatch(/reloadArmed/));
  const armedOpens = opens();
  stamp = "2026-10-18T00:00:03.000Z";
  await poll();
  await waitFor(() => expect(opens()).toBe(armedOpens + 1));
  await waitFor(() => expect(reload().className).toBe(""));
  // Holding (right-click here) reloads on every change, and is remembered.
  fireEvent.contextMenu(reload());
  expect(reload().className).toMatch(/reloadAuto/);
  expect(
    localStorage.getItem("yep-anywhere-project-app-auto-reload:test"),
  ).toBe("1");
  const autoOpens = opens();
  stamp = "2026-10-18T00:00:04.000Z";
  await poll();
  await waitFor(() => expect(opens()).toBe(autoOpens + 1));
  await waitFor(() => expect(reload().className).toMatch(/reloadAuto/));
});
it("keeps the live iframe across settings and sharing and delegates mic synchronously to its composer", async () => {
  const toggle = vi.fn();
  const onVoice = vi.fn();
  const { container } = render(
    <I18nProvider>
      <ProjectAppViewer
        projectId="test"
        onBack={() => {}}
        onVoice={onVoice}
        voice={{
          toggle,
          isListening: false,
          isAvailable: true,
          stopAndFinalize: () => "",
          cancelProcessing: vi.fn(),
          prewarm: vi.fn(),
          beginInsertionBoundary: vi.fn(),
          continueAfterSpeechSend: vi.fn(),
        }}
      />
    </I18nProvider>,
  );
  await waitFor(() => expect(container.querySelector("iframe")).toBeTruthy());
  const frame = container.querySelector("iframe");
  fireEvent.click(screen.getByRole("button", { name: "Start microphone" }));
  expect(onVoice).toHaveBeenCalledTimes(1);
  expect(toggle).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "App settings" }));
  await waitFor(() =>
    expect(mock.fetch).toHaveBeenCalledWith("/projects/test/app/address"),
  );
  expect(container.querySelector("iframe")).toBe(frame);
  expect(screen.queryByRole("group", { name: "App address" })).toBeNull();
  // Sharing lives in settings; there is no separate Share button.
  expect(screen.queryByRole("button", { name: "Share app" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Create share link" }));
  await screen.findByText("Valid while this app launch is running.");
  expect(container.querySelector("iframe")).toBe(frame);
});
it("shows the page its frame reports and opens a crumb under the view's link", async () => {
  const original = mock.fetch.getMockImplementation()!;
  mock.fetch.mockImplementation(async (...args) =>
    String(args[0]).endsWith("/open")
      ? {
          id: "service:test",
          kind: "service",
          label: "App",
          url: "https://app-x.example/?ya_access=view-token",
        }
      : original(...args),
  );
  const { container } = render(
    <I18nProvider>
      <ProjectAppViewer projectId="test" projectName="draft" />
    </I18nProvider>,
  );
  await waitFor(() => expect(container.querySelector("iframe")).not.toBeNull());
  const frame = container.querySelector("iframe")!;
  // The frame is committed before the effect that listens for its reports
  // runs; flush effects so a report is not posted into that gap.
  await act(async () => {});
  const report = (href: string, source: MessageEventSource | null) =>
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { type: "yep-anywhere:app-location", href },
          origin: new URL(href).origin,
          source,
        }),
      );
    });
  const paper = "/research/papers/p/_build/index.html";
  // Neither another window nor another origin names the frame's page.
  report(`https://app-x.example${paper}`, window);
  report(`https://elsewhere.example${paper}`, frame.contentWindow);
  expect(
    screen.queryByRole("navigation", { name: "Page shown in the app" }),
  ).toBeNull();
  const answers = vi
    .spyOn(frame.contentWindow!, "postMessage")
    .mockImplementation(() => {});
  report(`https://app-x.example${paper}?ya_access=leak`, frame.contentWindow);
  const trail = await screen.findByRole("navigation", {
    name: "Page shown in the app",
  });
  expect(trail.textContent).toBe("/research/papers/p/_build/index.html");
  expect(trail.textContent).not.toContain("leak");
  // The page learns whether the bar shows its whole path: jsdom lays out
  // nothing, so not yet; a trail that fits answers that it does.
  const shown = (value: boolean) =>
    expect(answers).toHaveBeenLastCalledWith(
      { type: "yep-anywhere:app-location-shown", shown: value },
      "https://app-x.example",
    );
  await waitFor(() => shown(false));
  Object.defineProperty(trail, "clientWidth", { value: 300 });
  Object.defineProperty(trail, "scrollWidth", { value: 300 });
  report(`https://app-x.example${paper}`, frame.contentWindow);
  await waitFor(() => shown(true));
  fireEvent.click(screen.getByRole("button", { name: "papers" }));
  expect(frame.src).toBe(
    "https://app-x.example/research/papers/?ya_access=view-token",
  );
  // Opening in a new tab and reloading keep the last reported page, under
  // the view's own link rather than any token the page carried.
  const page = `https://app-x.example${paper}?ya_access=view-token`;
  expect(
    screen
      .getByRole("link", { name: "Move viewer to new tab" })
      .getAttribute("href"),
  ).toBe(page);
  fireEvent.click(screen.getByRole("button", { name: "Reload from disk" }));
  await waitFor(() =>
    expect(container.querySelector("iframe")).not.toBe(frame),
  );
  expect(container.querySelector("iframe")!.src).toBe(page);
});
it("inserts app path comments only from the displayed frame and origin", async () => {
  const original = mock.fetch.getMockImplementation()!;
  mock.fetch.mockImplementation(async (...args) =>
    String(args[0]).endsWith("/open")
      ? {
          id: "service:test",
          kind: "service",
          label: "App",
          url: "https://app-x.example/?ya_access=view-token",
        }
      : original(...args),
  );
  const insert = vi.fn();
  const { container, rerender } = render(
    <I18nProvider>
      <ProjectAppViewer projectId="test" onComment={insert} />
    </I18nProvider>,
  );
  await waitFor(() => expect(container.querySelector("iframe")).not.toBeNull());
  await act(async () => {});
  const frame = container.querySelector("iframe")!;
  const post = (
    data: object,
    origin = "https://app-x.example",
    source: MessageEventSource | null = frame.contentWindow,
  ) =>
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", { data, origin, source }),
      );
    });
  const data = { type: "yep-anywhere:app-comment", path: "docs/a file.md" };
  post(data, "https://unrelated.example");
  post(data, "https://app-x.example", window);
  for (const path of [
    "../secret",
    "/absolute",
    "docs/../secret",
    "x\nforged",
    "C:\\secret",
  ])
    post({ ...data, path });
  expect(insert).not.toHaveBeenCalled();
  post({
    type: "yep-anywhere:app-location",
    href: "https://app-x.example/docs/a%20file.md",
    projectRoot: "https://app-x.example/",
    projectPath: "docs/a file.md",
  });
  fireEvent.click(await screen.findByRole("button", { name: "Path actions" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Comment on path" }));
  expect(insert).toHaveBeenLastCalledWith("docs/a file.md\n\n");
  post({ ...data, quote: "first line\nsecond line" });
  expect(insert).toHaveBeenLastCalledWith(
    "docs/a file.md\n\n> first line\n> second line\n\n",
  );
  // Updating the draft callback must not erase the frame's reported path.
  rerender(
    <I18nProvider>
      <ProjectAppViewer projectId="test" onComment={(text) => insert(text)} />
    </I18nProvider>,
  );
  expect(screen.getByRole("button", { name: "Path actions" })).toBeTruthy();
});
it.each([true, false])(
  "copies the public link to the shown page from a local view when canShare=%s",
  async (canShare) => {
    const original = mock.fetch.getMockImplementation()!;
    mock.fetch.mockImplementation(
      async (path: string, options?: { body: string }) => {
        if (path.endsWith("/open")) {
          const { audience } = JSON.parse(options!.body);
          return {
            id: "service:test",
            kind: "service",
            label: "App",
            url:
              audience === "public"
                ? "https://app-x.apps.example/?ya_access=public-token"
                : "http://app-x.localhost:3400/?ya_access=local-token",
          };
        }
        const value = await original(path, options);
        return path.endsWith("/app") ? { ...value, canShare } : value;
      },
    );
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const { container } = render(
      <I18nProvider>
        <ProjectAppViewer projectId="test" />
      </I18nProvider>,
    );
    await waitFor(() =>
      expect(container.querySelector("iframe")?.src).toContain("localhost"),
    );
    const frame = container.querySelector("iframe")!;
    // Flush the effect that listens for the frame's reports (see above).
    await act(async () => {});
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: {
            type: "yep-anywhere:app-location",
            href: "http://app-x.localhost:3400/docs/a.html?q=1#s",
          },
          source: frame.contentWindow,
          origin: "http://app-x.localhost:3400",
        }),
      );
    });
    await screen.findByRole("navigation", { name: "Page shown in the app" });
    fireEvent.click(screen.getByRole("button", { name: "Copy viewer link" }));
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(
        canShare
          ? "https://app-x.apps.example/docs/a.html?q=1&ya_access=public-token#s"
          : "http://app-x.localhost:3400/docs/a.html?q=1&ya_access=local-token#s",
      ),
    );
    // Open in new tab keeps the local link.
    expect(
      screen
        .getByRole("link", { name: "Move viewer to new tab" })
        .getAttribute("href"),
    ).toContain("app-x.localhost");
  },
);
