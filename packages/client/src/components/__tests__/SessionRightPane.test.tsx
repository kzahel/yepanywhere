import { fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import { SessionRightPane } from "../SessionRightPane";

type Pane = ComponentProps<typeof SessionRightPane>["pane"];

function artifactPane(artifactToken?: string): Pane {
  return {
    selected: {
      url: "https://artifact.example.org/review.html",
      sourceUrl: "https://artifact.example.org/review.html",
      label: "review.html",
      announcementId: "play:review",
      artifactToken,
    },
    paneViewer: undefined,
    copyUrl: "https://artifact.example.org/review.html",
    onFrameLoad: vi.fn(),
    frameKey: "vhost:key:review",
    appStatus: undefined,
    expanded: true,
    canKill: true,
    killing: false,
    hide: vi.fn(),
    close: vi.fn(),
    kill: vi.fn(),
  } as unknown as Pane;
}

describe("session right pane", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it("reloads an artifact by remounting its frame", () => {
    const { container } = render(
      <I18nProvider>
        <SessionRightPane pane={artifactPane("token")} wide />
      </I18nProvider>,
    );
    const before = container.querySelector("iframe");
    expect(before).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reload from disk" }));
    const after = container.querySelector("iframe");
    expect(after).toBeTruthy();
    expect(after).not.toBe(before);
    expect(after?.getAttribute("src")).toBe(
      "https://artifact.example.org/review.html",
    );
  });

  it("names the reload for a live app rather than a file", () => {
    render(
      <I18nProvider>
        <SessionRightPane pane={artifactPane()} wide />
      </I18nProvider>,
    );
    expect(screen.getByRole("button", { name: "Reload app" })).toBeTruthy();
  });

  it("loads the project app only once revealed, then keeps it", () => {
    const pane = { ...artifactPane(), selected: undefined } as Pane;
    const projectApp = <iframe title="project app" src="about:blank" />;
    const view = (projectAppOpen: boolean) => (
      <I18nProvider>
        <SessionRightPane
          pane={pane}
          wide
          projectApp={projectApp}
          projectAppOpen={projectAppOpen}
        />
      </I18nProvider>
    );
    const { rerender } = render(view(false));
    // A hidden frame still loads, raising the app's own login prompt.
    expect(screen.queryByTitle("project app")).toBeNull();
    rerender(view(true));
    const frame = screen.getByTitle("project app");
    rerender(view(false));
    expect(screen.getByTitle("project app")).toBe(frame);
  });
});
