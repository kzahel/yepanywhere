// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import { ReloadBanner, ReloadBannerStack } from "../ReloadBanner";
import styles from "../ReloadBanner.module.css";
import bannerStyles from "../ui/Banner.module.css";

function rect(
  left: number,
  top: number,
  width: number,
  height: number,
): DOMRect {
  return {
    bottom: top + height,
    height,
    left,
    right: left + width,
    top,
    width,
    x: left,
    y: top,
    toJSON: () => ({}),
  };
}

function renderBanner(props: Partial<Parameters<typeof ReloadBanner>[0]> = {}) {
  return render(
    <I18nProvider>
      <ReloadBanner
        target="backend"
        onReload={vi.fn()}
        onDismiss={vi.fn()}
        {...props}
      />
    </I18nProvider>,
  );
}

describe("ReloadBanner", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reloads and consumes the notice in one action", () => {
    const onReload = vi.fn();
    const onDismiss = vi.fn();
    renderBanner({
      unsafeToRestart: true,
      interruptibleSessionCount: 1,
      onReload,
      onDismiss,
    });

    fireEvent.click(screen.getByRole("button", { name: "Reload Now" }));

    expect(onReload).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("schedules a safe reload and consumes the notice", () => {
    const onRestartWhenSafe = vi.fn();
    const onDismiss = vi.fn();
    renderBanner({
      unsafeToRestart: true,
      interruptibleSessionCount: 1,
      onRestartWhenSafe,
      onDismiss,
    });

    fireEvent.click(screen.getByRole("button", { name: "Reload When Safe" }));

    expect(onRestartWhenSafe).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("offers reload when safe for backend reloads", () => {
    const onRestartWhenSafe = vi.fn();
    const onDismiss = vi.fn();
    renderBanner({
      unsafeToRestart: true,
      interruptibleSessionCount: 2,
      onRestartWhenSafe,
      onDismiss,
    });

    fireEvent.click(screen.getByRole("button", { name: "Reload When Safe" }));

    expect(onRestartWhenSafe).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(screen.getByTitle(/2 active sessions/).textContent).toContain(
      "2 active",
    );
  });

  it("reloads immediately for safe backend reloads", () => {
    const onReload = vi.fn();
    const onDismiss = vi.fn();
    renderBanner({
      onRestartWhenSafe: vi.fn(),
      onReload,
      onDismiss,
    });

    fireEvent.click(screen.getByRole("button", { name: "Reload Server" }));

    expect(onReload).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByRole("button", { name: "Reload When Safe" }),
    ).toBeNull();
  });

  it("shows scheduled drain status and cancel action", () => {
    const onCancelSafeRestart = vi.fn();
    const onDismiss = vi.fn();
    renderBanner({
      onRestartWhenSafe: vi.fn(),
      onCancelSafeRestart,
      onDismiss,
      safeRestartState: {
        status: "scheduled",
        blockers: [
          { type: "active-sessions", count: 1 },
          { type: "session-queue", count: 2 },
        ],
        canRestartNow: false,
        scheduledAt: "2026-06-30T00:00:00.000Z",
        updatedAt: "2026-06-30T00:00:00.000Z",
      },
    });

    const status = screen.getByTitle(
      "Restart scheduled - waiting for 1 active session and 2 queued messages",
    );
    expect(status.textContent).toContain("1 active, 2 queued");
    expect(
      screen.getByText(
        "Restart scheduled - waiting for 1 active session and 2 queued messages",
      ),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Cancel Restart" }));

    expect(onCancelSafeRestart).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("shows preserved recovered queue status for scheduled restart", () => {
    renderBanner({
      onRestartWhenSafe: vi.fn(),
      safeRestartState: {
        status: "scheduled",
        blockers: [{ type: "active-sessions", count: 1 }],
        preserved: [{ type: "recovered-session-queue", count: 2 }],
        canRestartNow: false,
        scheduledAt: "2026-06-30T00:00:00.000Z",
        updatedAt: "2026-06-30T00:00:00.000Z",
      },
    });

    expect(
      screen.getByText(/2 recovered patient queued messages preserved/),
    ).toBeTruthy();
  });

  it("does not show reload when safe for frontend reloads", () => {
    renderBanner({
      target: "frontend",
      onRestartWhenSafe: vi.fn(),
    });

    expect(
      screen.queryByRole("button", { name: "Reload When Safe" }),
    ).toBeNull();
  });

  it("uses a compact message and a clear dismiss control", () => {
    const onDismiss = vi.fn();
    renderBanner({ onDismiss });

    expect(screen.getByText("Server changed")).toBeTruthy();
    // A safe reload is the plain warning.
    expect(
      screen.getByRole("status").className.includes(bannerStyles.warning!),
    ).toBe(true);
    const dismiss = screen.getByRole("button", { name: "Dismiss" });
    expect(dismiss.textContent).toBe("×");

    fireEvent.click(dismiss);

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("keeps the global selection and geometry hooks beside module classes", () => {
    render(
      <I18nProvider>
        <ReloadBannerStack>
          <ReloadBanner
            target="backend"
            onReload={vi.fn()}
            onDismiss={vi.fn()}
            onRestartWhenSafe={vi.fn()}
            unsafeToRestart
            interruptibleSessionCount={1}
          />
        </ReloadBannerStack>
      </I18nProvider>,
    );

    // `reload-banner` is named by the global transcript-selection rule and
    // the transcript artifact smoke script; `reload-banner-stack` is the
    // geometry hook the placement effect measures.
    const banner = screen.getByRole("status");
    expect(banner.classList.contains("reload-banner")).toBe(true);
    expect(banner.className).toContain(styles.banner);
    // An unsafe backend restart reads as an error, not the plain warning.
    expect(banner.className.includes(bannerStyles.error!)).toBe(true);
    expect(banner.className.includes(bannerStyles.warning!)).toBe(false);

    const stack = document.querySelector(".reload-banner-stack");
    expect(stack?.className).toContain(styles.stack);

    // The rest of the vocabulary now lives only in the module.
    for (const retired of [
      "reload-banner-warning",
      "reload-banner-content",
      "reload-banner-button",
    ]) {
      expect(document.getElementsByClassName(retired)).toHaveLength(0);
    }
  });

  it("skips empty-stack geometry and positions a later notice", async () => {
    vi.spyOn(window, "innerWidth", "get").mockReturnValue(1280);
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(1080);
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 1;
    });
    const geometry = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement) {
        if (this.classList.contains("reload-banner-stack"))
          return rect(814, 1014, 454, 54);
        if (this.hasAttribute("data-session-input"))
          return rect(278, 918, 1002, 162);
        if (this.tagName === "BUTTON") return rect(1080, 1032, 100, 36);
        return rect(0, 0, 0, 0);
      });
    const view = (notice: boolean) => (
      <>
        <footer data-session-input>
          <button type="button">Composer action</button>
        </footer>
        <ReloadBannerStack avoidSessionComposer>
          {notice && <div>Reload notice</div>}
        </ReloadBannerStack>
      </>
    );
    const { rerender, unmount } = render(view(false));
    document.querySelector<HTMLElement>("[data-session-input]")!.style.height =
      "162px";
    await Promise.resolve();
    fireEvent(window, new Event("resize"));
    expect(geometry).not.toHaveBeenCalled();

    rerender(view(true));
    fireEvent(window, new Event("resize"));
    expect(
      document
        .querySelector<HTMLElement>(".reload-banner-stack")
        ?.style.getPropertyValue("--reload-banner-stack-lift"),
    ).toBe("158px");
    unmount();
  });

  it("lifts above a session composer when the corner would cover a control", () => {
    vi.spyOn(window, "innerWidth", "get").mockReturnValue(1280);
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(1080);
    const geometry = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement) {
        if (this.classList.contains("reload-banner-stack")) {
          return rect(814, 1014, 454, 54);
        }
        if (this.hasAttribute("data-session-input")) {
          return rect(278, 918, 1002, 162);
        }
        if (this.tagName === "BUTTON") {
          return rect(1080, 1032, 100, 36);
        }
        return rect(0, 0, 0, 0);
      });

    const { unmount } = render(
      <>
        <footer data-session-input>
          <button type="button">Composer action</button>
        </footer>
        <ReloadBannerStack avoidSessionComposer>
          <div>Reload notice</div>
        </ReloadBannerStack>
      </>,
    );

    const stack = document.querySelector<HTMLElement>(".reload-banner-stack");
    expect(stack?.style.getPropertyValue("--reload-banner-stack-lift")).toBe(
      "158px",
    );

    unmount();
    geometry.mockRestore();
  });
});
