import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { toUrlProjectId } from "@yep-anywhere/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import { invalidateLocalStorageValues } from "../../lib/localStorageValue";
import {
  clearCurrentSessionViewer,
  useSessionViewerController,
} from "../../lib/sessionViewerController";
import { presentProjectFileViewer } from "../FilePathLink";
import { LastSessionFile } from "../LastSessionFile";

function ControllerProbe() {
  const viewer = useSessionViewerController();
  if (!viewer) return null;
  return (
    <>
      <span>{viewer.label}</span>
      <button type="button" onClick={viewer.close}>
        Close
      </button>
      <button type="button" onClick={viewer.minimize}>
        Minimize
      </button>
    </>
  );
}

describe("last session file", () => {
  let root: HTMLDivElement;
  let target: HTMLDivElement;
  let margin: number;
  let measure: () => void;
  const projectId = toUrlProjectId("/project");

  function mount(sessionId = "session-1", inactive = false) {
    return render(
      <I18nProvider>
        <LastSessionFile
          sessionId={sessionId}
          target={target}
          inactive={inactive}
        />
        <ControllerProbe />
      </I18nProvider>,
    );
  }
  function open() {
    act(() =>
      presentProjectFileViewer({
        id: "file-1",
        sessionId: "session-1",
        projectId,
        filePath: "/project/docs/guide.md",
        lineNumber: 12,
        lineEnd: 16,
        viewMode: "range",
      }),
    );
  }

  beforeEach(() => {
    margin = 80;
    root = document.createElement("div");
    const transcript = document.createElement("div");
    transcript.setAttribute("data-message-list", "");
    target = document.createElement("div");
    root.append(transcript, target);
    document.body.append(root);
    vi.spyOn(target, "getBoundingClientRect").mockImplementation(
      () => ({ right: 1000 }) as DOMRect,
    );
    vi.spyOn(transcript, "getBoundingClientRect").mockImplementation(
      () => ({ right: 1000 - margin }) as DOMRect,
    );
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: () => void) {
          measure = callback;
        }
        observe() {}
        disconnect() {}
      },
    );
  });
  afterEach(() => {
    cleanup();
    clearCurrentSessionViewer();
    root.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("retains the route through Close and a fresh mount, isolated by session ID", () => {
    const mounted = mount();
    expect(
      screen.queryByRole("button", { name: /Restore file viewer/ }),
    ).toBeNull();
    open();
    expect(
      localStorage.getItem("yep-anywhere-session-last-file:session-1"),
    ).toBe(
      `/projects/${projectId}/file?path=%2Fproject%2Fdocs%2Fguide.md&line=12&lineEnd=16&view=range`,
    );
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    mounted.unmount();
    // Read from browser storage again rather than retaining the store snapshot.
    invalidateLocalStorageValues();
    const other = mount("session-2");
    expect(
      screen.queryByRole("button", { name: /Restore file viewer/ }),
    ).toBeNull();
    other.unmount();
    mount();
    const reopen = screen.getByRole("button", {
      name: "Restore file viewer: docs/guide.md",
    });
    expect(reopen.getAttribute("data-tooltip")).toBe("docs/guide.md");
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
    fireEvent.click(reopen);
    expect(screen.getByText("docs/guide.md:12-16")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /Restore file viewer/ }),
    ).toBeNull();
  });

  it("yields to the minimized controller and hides when the margin no longer fits", () => {
    mount();
    open();
    fireEvent.click(screen.getByRole("button", { name: "Minimize" }));
    expect(
      screen.queryByRole("button", { name: /Restore file viewer/ }),
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(
      screen.getByRole("button", { name: /Restore file viewer/ }),
    ).toBeTruthy();
    act(() => {
      margin = 40;
      measure();
    });
    expect(
      screen.queryByRole("button", { name: /Restore file viewer/ }),
    ).toBeNull();
    act(() => {
      margin = 80;
      measure();
    });
    expect(
      screen.getByRole("button", { name: /Restore file viewer/ }),
    ).toBeTruthy();
  });

  it("finds the reading column when reload hydration mounts it later", async () => {
    open();
    clearCurrentSessionViewer();
    const transcript = root.querySelector<HTMLElement>("[data-message-list]");
    if (!transcript) throw new Error("Missing fixture transcript");
    transcript.remove();
    mount();
    expect(
      screen.queryByRole("button", { name: /Restore file viewer/ }),
    ).toBeNull();
    root.prepend(transcript);
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /Restore file viewer/ }),
      ).toBeTruthy(),
    );
  });
});
