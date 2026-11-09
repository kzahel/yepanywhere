// @vitest-environment jsdom

import type { GitStatusInfo } from "@yep-anywhere/shared";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SourceRowMenuTrigger,
  sourceRowMenuSurface,
} from "../../components/SourceContextMenu";
import { I18nProvider } from "../../i18n";
import menuStyles from "../../components/SourceContextMenu.module.css";
import { RepoStatusBar } from "../RepoStatusBar";
import repoStyles from "../RepoStatusBar.module.css";
import { SourceModeTabs, type SourceTab } from "../SourceModeTabs";
import tabStyles from "../SourceModeTabs.module.css";
import uiTabStyles from "../../components/ui/Tabs.module.css";

const apiMocks = vi.hoisted(() => ({
  getGitIncomingCommits: vi.fn(),
}));

vi.mock("../../api/client", () => ({
  api: apiMocks,
}));

const t = ((key: string) => key) as never;

const TABS: readonly SourceTab[] = ["changes", "files", "comments"];

function gitStatus(overrides: Partial<GitStatusInfo> = {}): GitStatusInfo {
  return {
    isGitRepo: true,
    branch: "main",
    upstream: "origin/main",
    ahead: 0,
    behind: 0,
    isClean: true,
    files: [],
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("RepoStatusBar", () => {
  it("takes caller placement through className without exposing its own classes", () => {
    render(
      <RepoStatusBar
        status={gitStatus()}
        className="source-header-repo-status"
        t={t}
      />,
    );

    const bar = screen.getByTestId("repo-status-bar");
    expect(bar.classList.contains("source-header-repo-status")).toBe(true);
    expect(bar.classList.contains(repoStyles.bar as string)).toBe(true);
    expect(bar.classList.contains(repoStyles.inline as string)).toBe(true);
    // The legacy global vocabulary is gone; callers cannot target it any more.
    expect(document.querySelector(".repo-status-bar")).toBeNull();
  });

  it("marks a dirty or out-of-sync repository with the warn variant", () => {
    const { rerender } = render(<RepoStatusBar status={gitStatus()} t={t} />);
    expect(
      screen
        .getByTestId("repo-status-bar")
        .classList.contains(repoStyles.warn as string),
    ).toBe(false);

    rerender(<RepoStatusBar status={gitStatus({ ahead: 2 })} t={t} />);
    expect(
      screen
        .getByTestId("repo-status-bar")
        .classList.contains(repoStyles.warn as string),
    ).toBe(true);
  });

  it("opens the branch tip as a real link that left-clicks in place", () => {
    const onOpenHeadCommit = vi.fn();
    render(
      <RepoStatusBar
        status={gitStatus({
          recentCommits: [
            {
              hash: "0123456789abcdef0123456789abcdef01234567",
              shortHash: "0123456",
              subject: "Latest",
              authorName: "graehl",
              authorDate: "2026-08-18T00:00:00Z",
            },
          ],
        })}
        headCommitHref="/git-status?projectId=p1&rev=0123456789abcdef0123456789abcdef01234567"
        onOpenHeadCommit={onOpenHeadCommit}
        t={t}
      />,
    );

    const link = screen.getByRole("link", { name: "main" });
    expect(link.getAttribute("href")).toContain(
      "rev=0123456789abcdef0123456789abcdef01234567",
    );

    fireEvent.click(link, { button: 0 });
    expect(onOpenHeadCommit).toHaveBeenCalledTimes(1);

    // A modifier click belongs to the browser: the app must not intercept it.
    // jsdom would then try the real navigation, so swallow only that default.
    const swallowNavigation = (event: Event) => event.preventDefault();
    document.addEventListener("click", swallowNavigation);
    fireEvent.click(link, { button: 0, ctrlKey: true });
    document.removeEventListener("click", swallowNavigation);
    expect(onOpenHeadCommit).toHaveBeenCalledTimes(1);
  });

  it("leaves the branch inert without a commit target, and copies a detached tip", () => {
    const { rerender } = render(<RepoStatusBar status={gitStatus()} t={t} />);
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText("main")).toBeDefined();

    rerender(
      <RepoStatusBar
        status={gitStatus({
          branch: null,
          recentCommits: [
            {
              hash: "fedcba9876543210fedcba9876543210fedcba98",
              shortHash: "fedcba9",
              subject: "Detached",
              authorName: "graehl",
              authorDate: "2026-08-18T00:00:00Z",
            },
          ],
        })}
        t={t}
      />,
    );
    expect(screen.getByText("gitStatusDetachedHead")).toBeDefined();
    expect(
      screen.getByRole("button", { name: "sourceCopyCommitHash" }),
    ).toBeDefined();
  });

  it("loads last-checked incoming commits only after opening the upstream preview", async () => {
    apiMocks.getGitIncomingCommits.mockResolvedValue({
      upstream: "origin/main",
      headSha: "1111111111111111111111111111111111111111",
      upstreamSha: "2222222222222222222222222222222222222222",
      commits: [
        {
          hash: "2222222222222222222222222222222222222222",
          shortHash: "2222222",
          subject: "Incoming change",
          authorName: "Contributor",
          authorDate: "2026-08-18T00:00:00Z",
        },
      ],
      truncated: false,
      limit: 100,
    });
    render(
      <I18nProvider>
        <RepoStatusBar status={gitStatus()} projectId="p1" t={t} />
      </I18nProvider>,
    );
    expect(apiMocks.getGitIncomingCommits).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "→ origin/main" }));

    await waitFor(() => {
      expect(screen.getByText("Incoming change")).toBeDefined();
    });
    expect(apiMocks.getGitIncomingCommits).toHaveBeenCalledOnce();
    expect(apiMocks.getGitIncomingCommits).toHaveBeenCalledWith("p1");
    expect(screen.getByText("sourceIncomingCommitsDescription")).toBeDefined();
    const expectedDate = new Date("2026-08-18T00:00:00Z").toLocaleString(
      undefined,
      {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      },
    );
    expect(screen.getByText(`Contributor · ${expectedDate}`)).toBeDefined();
    expect(screen.queryByText(/2026-08-18T00:00:00Z/)).toBeNull();
  });

  it("offers the dirty badge as a button only when it can open Changes", () => {
    const onSelectChanges = vi.fn();
    const dirty = gitStatus({ isClean: false });
    const { rerender } = render(
      <RepoStatusBar status={dirty} onSelectChanges={onSelectChanges} t={t} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "gitStatusDirty" }));
    expect(onSelectChanges).toHaveBeenCalledTimes(1);

    rerender(<RepoStatusBar status={dirty} t={t} />);
    expect(screen.queryByRole("button", { name: "gitStatusDirty" })).toBeNull();
    expect(screen.getByText("gitStatusDirty")).toBeDefined();
  });
});

describe("SourceModeTabs", () => {
  it("exposes tablist semantics and the selected tab", () => {
    const onSelect = vi.fn();
    render(
      <SourceModeTabs tab="files" tabs={TABS} onSelect={onSelect} t={t} />,
    );

    expect(
      screen.getByRole("tablist", { name: "gitStatusTitle" }),
    ).toBeTruthy();
    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(3);
    expect(tabs.map((tab) => tab.getAttribute("aria-selected"))).toEqual([
      "false",
      "true",
      "false",
    ]);

    fireEvent.click(tabs[0] as HTMLElement);
    expect(onSelect).toHaveBeenCalledWith("changes");
  });

  it("moves focus with arrows but switches modes only on activation", () => {
    const onSelect = vi.fn();
    render(
      <SourceModeTabs tab="files" tabs={TABS} onSelect={onSelect} t={t} />,
    );
    const [, files, comments] = screen.getAllByRole("tab") as HTMLElement[];

    fireEvent.keyDown(files as HTMLElement, { key: "ArrowRight" });
    expect(document.activeElement).toBe(comments);
    expect(onSelect).not.toHaveBeenCalled();

    fireEvent.click(comments as HTMLElement);
    expect(onSelect).toHaveBeenCalledWith("comments");
  });

  it("renders a count chip only for a positive count", () => {
    render(
      <SourceModeTabs
        tab="changes"
        tabs={TABS}
        counts={{ changes: 3, comments: 0 }}
        onSelect={vi.fn()}
        t={t}
      />,
    );

    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "sourceTabChanges3",
      "sourceTabFiles",
      "sourceTabComments",
    ]);
  });

  it("supports a fourth Reviews mode without changing the tab contract", () => {
    const onSelect = vi.fn();
    render(
      <SourceModeTabs
        tab="reviews"
        tabs={[...TABS, "reviews"]}
        onSelect={onSelect}
        t={t}
      />,
    );

    const reviews = screen.getByRole("tab", { name: "sourceTabReviews" });
    expect(reviews.getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByRole("tab", { name: "sourceTabComments" }));
    expect(onSelect).toHaveBeenCalledWith("comments");
  });

  it("selects the stacked phone layout by variant rather than by caller CSS", () => {
    const { rerender } = render(
      <SourceModeTabs tab="changes" tabs={TABS} onSelect={vi.fn()} t={t} />,
    );

    const header = screen.getByRole("tablist");
    expect(header.classList.contains(tabStyles.stacked as string)).toBe(false);
    expect(header.classList.contains(uiTabStyles.fillPhone as string)).toBe(
      false,
    );

    rerender(
      <SourceModeTabs
        tab="changes"
        tabs={TABS}
        variant="stacked"
        onSelect={vi.fn()}
        t={t}
      />,
    );
    const stacked = screen.getByRole("tablist").classList;
    expect(stacked.contains(tabStyles.stacked as string)).toBe(true);
    // Equal columns on phones only; desktop keeps content-sized tabs.
    expect(stacked.contains(uiTabStyles.fillPhone as string)).toBe(true);
    expect(stacked.contains(uiTabStyles.fill as string)).toBe(false);
  });
});

describe("SourceRowMenuTrigger", () => {
  it("reveals through a surface class the row opts into, not a row-owned rule", () => {
    expect(sourceRowMenuSurface).toBe(menuStyles.rowSurface);
    expect(sourceRowMenuSurface).not.toBe("");

    const onOpen = vi.fn();
    render(
      <li className={`commit-file-row ${sourceRowMenuSurface}`}>
        <SourceRowMenuTrigger
          actions={[]}
          label="sourceRowActions"
          onOpen={onOpen}
        />
      </li>,
    );

    const row = document.querySelector("li") as HTMLElement;
    expect(row.classList.contains(sourceRowMenuSurface)).toBe(true);

    const trigger = screen.getByRole("button", { name: "sourceRowActions" });
    expect(trigger.classList.contains(menuStyles.trigger as string)).toBe(true);
    expect(trigger.classList.contains("source-row-menu-trigger")).toBe(false);

    fireEvent.click(trigger);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});
