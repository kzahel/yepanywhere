// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VersionInfo } from "../../api/client";
import type { TranslationFn } from "../../i18n";
import messages from "../../i18n/en.json";
import {
  REMOTE_COMPATIBILITY_REMINDER_SNOOZE_MS,
  restoreRemoteCompatibilityNoticeDismissals,
} from "../../hooks/useRemoteCompatibilityNoticeDismissals";
import {
  type RemoteCompatibilityNotice,
  getRemoteCompatibilityNotices,
} from "../../lib/remoteCompatibilityNotices";
import styles from "../RemoteCompatibilityNotices.module.css";
import bannerStyles from "../ui/Banner.module.css";
import {
  RemoteCompatibilityNoticeCard,
  RemoteCompatibilityNotices,
} from "../RemoteCompatibilityNotices";

const t: TranslationFn = (key, vars) =>
  Object.entries(vars ?? {}).reduce(
    (text, [name, value]) => text.replaceAll(`{${name}}`, String(value)),
    messages[key],
  );

function version(overrides: Partial<VersionInfo> = {}): VersionInfo {
  return {
    current: "0.8.0",
    latest: "0.8.0",
    updateAvailable: false,
    resumeProtocolVersion: 3,
    remoteCompatibilityLevel: 10,
    capabilities: [],
    ...overrides,
  };
}

function notice(
  overrides: Partial<RemoteCompatibilityNotice> = {},
): RemoteCompatibilityNotice {
  return {
    id: "test-notice",
    severity: "security",
    title: "Server update required soon",
    body: "Remote login still works during the compatibility window.",
    guidance: "Update the local server before the next hosted release.",
    versionSummary: "Server v0.5.0; recommended v0.5.1",
    dismissKey: "test-notice-key",
    priority: 10,
    dismissal: "dismiss",
    floatingPlacement: "over-header",
    ...overrides,
  };
}

function expectNoLegacyNoticeClasses(container: HTMLElement) {
  const classNames = Array.from(
    container.querySelectorAll<HTMLElement>("[class]"),
  ).flatMap((element) => Array.from(element.classList));

  expect(
    classNames.some(
      (className) =>
        className.startsWith("remote-compatibility-notice") ||
        className === "is-copied",
    ),
  ).toBe(false);
}

describe("RemoteCompatibilityNotices", () => {
  const writeText = vi.fn();

  beforeEach(() => {
    window.localStorage.clear();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    writeText.mockReset();
    writeText.mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.useRealTimers();
    window.localStorage.clear();
  });

  it.each([
    ["floating", "security", "alert", styles.floating!, "error"],
    ["floating", "blocking", "alert", styles.floating!, "error"],
    ["floating", "recommended", "status", styles.floating!, "warning"],
    ["floating", "info", "status", styles.floating!, "info"],
    ["inline", "security", "alert", styles.inline!, "error"],
    ["inline", "blocking", "alert", styles.inline!, "error"],
    ["inline", "recommended", "status", styles.inline!, "warning"],
    ["inline", "info", "status", styles.inline!, "info"],
  ] as const)(
    "places %s %s notices with the %s role",
    (placement, severity, role, placementClass, tone) => {
      const { container } = render(
        <RemoteCompatibilityNoticeCard
          notice={notice({ severity })}
          placement={placement}
        />,
      );

      const root = screen.getByTestId("remote-compatibility-notice");
      expect(root.getAttribute("role")).toBe(role);
      expect(root.classList.contains(placementClass)).toBe(true);
      // Severity maps to the Banner tone, and only that one.
      const toneClasses = {
        info: bannerStyles.info!,
        warning: bannerStyles.warning!,
        error: bannerStyles.error!,
      };
      for (const [each, className] of Object.entries(toneClasses)) {
        expect(root.classList.contains(className)).toBe(each === tone);
      }
      expectNoLegacyNoticeClasses(container);
    },
  );

  it("preserves the multiline command, copied state, structure, and callbacks", async () => {
    const onDismiss = vi.fn();
    const onSnooze = vi.fn();
    const command = "git fetch origin\ngit merge origin/main";
    const { container } = render(
      <RemoteCompatibilityNoticeCard
        notice={notice({
          action: { label: "Copy source steps", command },
        })}
        noticeCount={2}
        placement="floating"
        onDismiss={onDismiss}
        onSnooze={onSnooze}
      />,
    );

    const root = screen.getByTestId("remote-compatibility-notice");
    const textarea = screen.getByLabelText(
      "Copy source steps text",
    ) as HTMLTextAreaElement;
    const copyButton = screen.getByRole("button", {
      name: "Copy source steps",
    });

    expect(root.querySelector(`.${styles.headline!}`)).toBeTruthy();
    expect(root.querySelector(`.${styles.meta!}`)).toBeTruthy();
    expect(screen.getByText("2 notices")).toBeTruthy();
    expect(root.querySelector(`.${styles.commandField!}`)).toBeTruthy();
    expect(textarea.classList.contains(styles.commandInput!)).toBe(true);
    expect(textarea.value).toBe(command);
    expect(copyButton.classList.contains(styles.copyButton!)).toBe(true);
    expect(copyButton.classList.contains(styles.copied!)).toBe(false);

    fireEvent.click(copyButton);

    expect(await screen.findByRole("button", { name: "Copied" })).toBe(
      copyButton,
    );
    expect(writeText).toHaveBeenCalledWith(command);
    expect(copyButton.classList.contains(styles.copied!)).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    fireEvent.click(screen.getByRole("button", { name: "Remind me later" }));
    expect(onDismiss).toHaveBeenCalledOnce();
    expect(onSnooze).toHaveBeenCalledOnce();
    expectNoLegacyNoticeClasses(container);
  });

  it("offers a reminder but no Dismiss for a snooze-only notice", () => {
    const onDismiss = vi.fn();
    const onSnooze = vi.fn();
    render(
      <RemoteCompatibilityNoticeCard
        notice={notice({ id: "unrelated-notice", dismissal: "snooze-only" })}
        placement="floating"
        onDismiss={onDismiss}
        onSnooze={onSnooze}
      />,
    );

    expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Remind me later" }));
    expect(onSnooze).toHaveBeenCalledOnce();
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("floats below the header when the notice asks, whatever its id", () => {
    const { unmount } = render(
      <RemoteCompatibilityNoticeCard
        notice={notice({
          id: "unrelated-notice",
          floatingPlacement: "below-header",
        })}
        placement="floating"
      />,
    );

    expect(
      screen
        .getByTestId("remote-compatibility-notice")
        .classList.contains(styles.belowHeader!),
    ).toBe(true);
    unmount();

    render(
      <RemoteCompatibilityNoticeCard
        notice={notice({ id: "server-runtime-node22" })}
        placement="floating"
      />,
    );

    expect(
      screen
        .getByTestId("remote-compatibility-notice")
        .classList.contains(styles.belowHeader!),
    ).toBe(false);
  });

  it("keeps inline info links and restore actions in the same structure", () => {
    const onRestore = vi.fn();
    const { container } = render(
      <RemoteCompatibilityNoticeCard
        notice={notice({
          severity: "info",
          title: "Remote compatibility ready",
          action: {
            label: "Read release notes",
            href: "https://example.invalid/release-notes",
          },
        })}
        placement="inline"
        onRestore={onRestore}
      />,
    );

    const link = screen.getByRole("link", { name: "Read release notes" });
    const restoreButton = screen.getByRole("button", {
      name: "Show reminder",
    });

    expect(link.getAttribute("href")).toBe(
      "https://example.invalid/release-notes",
    );
    expect(
      screen.queryByRole("button", { name: "Remind me later" }),
    ).toBeNull();

    fireEvent.click(restoreButton);
    expect(onRestore).toHaveBeenCalledOnce();
    expectNoLegacyNoticeClasses(container);
  });

  it("renders and dismisses the protocol 2 relay resume warning for this page view", () => {
    render(
      <RemoteCompatibilityNotices
        relayUsername="dev-box"
        versionInfo={version({
          current: "0.8.0",
          latest: "0.8.1",
          resumeProtocolVersion: 2,
        })}
      />,
    );

    expect(screen.getByRole("alert").textContent).toContain(
      "Server update required soon",
    );
    expect(screen.getByText(/compatibility window/i)).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Remind me later" }),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));

    expect(screen.queryByTestId("remote-compatibility-notice")).toBeNull();
    expect(window.localStorage.length).toBe(0);
  });

  it("renders the pre-v2 relay resume cutoff notice", () => {
    render(
      <RemoteCompatibilityNotices
        relayUsername="dev-box"
        versionInfo={version({ resumeProtocolVersion: 1 })}
      />,
    );

    expect(screen.getByRole("alert").textContent).toContain(
      "Server update required",
    );
    expect(screen.getByText(/use localhost, a tunnel, or a VPN/i)).toBeTruthy();
  });

  it("copies the update command for stable release installs", async () => {
    render(
      <RemoteCompatibilityNotices
        relayUsername="dev-box"
        versionInfo={version({
          current: "0.4.28",
          latest: "0.4.29",
          updateAvailable: true,
          installSource: "npm-global",
        })}
      />,
    );

    expect(
      screen.getByText("Server v0.4.28; recommended v0.8.0+"),
    ).toBeTruthy();
    expect(
      (screen.getByLabelText("Copy npm command text") as HTMLInputElement)
        .value,
    ).toBe("npm update -g yepanywhere");

    fireEvent.click(screen.getByRole("button", { name: "Copy npm command" }));

    expect(await screen.findByRole("button", { name: "Copied" })).toBeTruthy();
    expect(writeText).toHaveBeenCalledWith("npm update -g yepanywhere");
  });

  it("exposes source checkout steps for git-describe versions", async () => {
    render(
      <RemoteCompatibilityNotices
        relayUsername="dev-box"
        versionInfo={version({
          current: "0.4.28-3-gabcdef",
          latest: "0.4.29",
          updateAvailable: true,
        })}
      />,
    );

    expect(screen.getByText("Update recommended")).toBeTruthy();
    expect(screen.getByText(/Source checkout detected/i)).toBeTruthy();
    expect(
      (screen.getByLabelText("Copy source steps text") as HTMLTextAreaElement)
        .value,
    ).toBe("git fetch origin\ngit merge origin/main\npnpm install\npnpm build");

    fireEvent.click(screen.getByRole("button", { name: "Copy source steps" }));

    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(
        "git fetch origin\ngit merge origin/main\npnpm install\npnpm build",
      ),
    );
  });

  it("stays hidden after remount while the same notice is snoozed", () => {
    const props = {
      relayUsername: "dev-box",
      versionInfo: version({
        current: "0.4.28",
        latest: "0.4.29",
        updateAvailable: true,
      }),
    };
    const view = render(<RemoteCompatibilityNotices {...props} />);

    fireEvent.click(screen.getByRole("button", { name: "Remind me later" }));
    expect(screen.queryByTestId("remote-compatibility-notice")).toBeNull();

    view.unmount();
    render(<RemoteCompatibilityNotices {...props} />);

    expect(screen.queryByTestId("remote-compatibility-notice")).toBeNull();
  });

  it("shows dismissed notices again after remount", () => {
    const props = {
      relayUsername: "dev-box",
      versionInfo: version({
        current: "0.4.28",
        latest: "0.4.29",
        updateAvailable: true,
      }),
    };
    const view = render(<RemoteCompatibilityNotices {...props} />);

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByTestId("remote-compatibility-notice")).toBeNull();

    view.unmount();
    render(<RemoteCompatibilityNotices {...props} />);

    expect(screen.getByTestId("remote-compatibility-notice")).toBeTruthy();
  });

  it("shows snoozed notices again after the reminder delay", () => {
    vi.useFakeTimers();
    const now = new Date("2026-06-04T12:00:00Z");
    vi.setSystemTime(now);
    const props = {
      relayUsername: "dev-box",
      versionInfo: version({
        current: "0.4.28",
        latest: "0.4.29",
        updateAvailable: true,
      }),
    };
    const view = render(<RemoteCompatibilityNotices {...props} />);

    fireEvent.click(screen.getByRole("button", { name: "Remind me later" }));
    expect(screen.queryByTestId("remote-compatibility-notice")).toBeNull();

    view.unmount();
    vi.setSystemTime(
      new Date(now.getTime() + REMOTE_COMPATIBILITY_REMINDER_SNOOZE_MS + 1),
    );
    render(<RemoteCompatibilityNotices {...props} />);

    expect(screen.getByTestId("remote-compatibility-notice")).toBeTruthy();
  });

  it("reappears when another surface restores the dismissed notice", async () => {
    const props = {
      relayUsername: "dev-box",
      versionInfo: version({
        current: "0.4.28",
        latest: "0.4.29",
        updateAvailable: true,
      }),
    };
    render(<RemoteCompatibilityNotices {...props} />);

    fireEvent.click(screen.getByRole("button", { name: "Remind me later" }));
    expect(screen.queryByTestId("remote-compatibility-notice")).toBeNull();

    act(() => {
      restoreRemoteCompatibilityNoticeDismissals(
        getRemoteCompatibilityNotices({
          currentVersion: props.versionInfo.current,
          latestVersion: props.versionInfo.latest,
          updateAvailable: props.versionInfo.updateAvailable,
          resumeProtocolVersion: props.versionInfo.resumeProtocolVersion,
          remoteCompatibilityLevel: props.versionInfo.remoteCompatibilityLevel,
          capabilities: props.versionInfo.capabilities,
          relayUsername: props.relayUsername,
        }),
      );
    });

    await waitFor(() =>
      expect(screen.getByTestId("remote-compatibility-notice")).toBeTruthy(),
    );
  });

  it("keeps the runtime advisory snoozeable but never dismissable", () => {
    render(
      <RemoteCompatibilityNotices
        relayUsername={null}
        versionInfo={version()}
        runtimeNotice={{
          runtime: { kind: "node", version: "20.20.0" },
          sourceKey: "direct:one",
          t,
        }}
      />,
    );

    expect(screen.getByText("Upgrade Node.js before updating YA")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
    expect(
      screen.getByRole("button", { name: "Remind me later" }),
    ).toBeTruthy();
  });

  it("stays hidden while server version data is still loading", () => {
    render(
      <RemoteCompatibilityNotices relayUsername="dev-box" versionInfo={null} />,
    );

    expect(screen.queryByTestId("remote-compatibility-notice")).toBeNull();
  });

  it("renders the remote compatibility level warning for older servers", () => {
    render(
      <RemoteCompatibilityNotices
        relayUsername="dev-box"
        versionInfo={version({
          current: "0.5.2",
          latest: "0.5.2",
          remoteCompatibilityLevel: undefined,
        })}
      />,
    );

    expect(screen.getByRole("status").textContent).toContain(
      "Update local server soon",
    );
    expect(
      screen.getByText("Compatibility level 0; recommended 10"),
    ).toBeTruthy();
    expect(screen.getByText(/newer than your local YA server/i)).toBeTruthy();
  });
});
