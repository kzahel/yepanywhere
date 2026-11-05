import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FileRevisionLink, formatRevisionAge } from "../FileRevisionLink";
import { I18nProvider } from "../../i18n";
import { PublicShareProvider } from "../../contexts/PublicShareContext";

const mocks = vi.hoisted(() => ({
  getGitFileRevision: vi.fn(),
  sourceKey: "local",
}));

vi.mock("../../api/client", () => ({
  api: { getGitFileRevision: mocks.getGitFileRevision },
}));
vi.mock("../../hooks/useRemoteBasePath", () => ({
  useRemoteBasePath: () => "",
}));

vi.mock("../../lib/clientSummaryStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/clientSummaryStore")>()),
  useClientSummarySourceKey: () => mocks.sourceKey,
}));
describe("FileRevisionLink", () => {
  beforeEach(() => {
    mocks.sourceKey = "local";
    mocks.getGitFileRevision.mockReset();
  });

  it("does not acquire private provenance in a public share", () => {
    render(
      <PublicShareProvider
        value={{
          projectId: "project-1",
          relayUrl: "wss://relay.test",
          relayUsername: "owner",
          secret: "public-share-fixture",
        }}
      >
        <FileRevisionLink
          projectId="project-1"
          path="src/file.ts"
          dirtyLabel="dirty"
          uncommittedLabel="uncommitted"
        />
      </PublicShareProvider>,
    );
    expect(mocks.getGitFileRevision).not.toHaveBeenCalled();
  });

  it("renders a regular commit diff link with age, dirtiness, and tooltip", async () => {
    mocks.getGitFileRevision.mockResolvedValue({
      path: "src/file.ts",
      isGitRepo: true,
      dirty: true,
      commit: {
        hash: "1234567890abcdef",
        shortHash: "1234567",
        authorName: "Ada Lovelace",
        authorDate: "2026-08-23T12:00:00.000Z",
        subject: "Explain revision",
        message: "Explain revision\n\nMore detail",
        messageTruncated: true,
      },
    });

    render(
      <I18nProvider>
        <FileRevisionLink
          projectId="project-1"
          path="src/file.ts"
          origPath="src/old.ts"
          showAuthor
          dirtyLabel="dirty"
          uncommittedLabel="uncommitted"
        />
      </I18nProvider>,
    );

    const link = await screen.findByRole("link", { name: "1234567" });
    expect(link.getAttribute("href")).toBe(
      "/git-status?projectId=project-1&rev=1234567890abcdef&commitFile=src%2Fold.ts",
    );
    expect(link.getAttribute("title")).toContain("Ada Lovelace");
    expect(screen.getByText("Ada Lovelace")).not.toBeNull();
    expect(link.getAttribute("title")).toContain("Explain revision");
    expect(link.getAttribute("title")).toMatch(/\n\.\.\.$/);
    expect(screen.getByText("dirty")).not.toBeNull();
    expect(mocks.getGitFileRevision).toHaveBeenCalledWith("project-1", {
      path: "src/file.ts",
      origPath: "src/old.ts",
      rev: undefined,
    });
    fireEvent.contextMenu(link);
    await waitFor(() =>
      expect(mocks.getGitFileRevision).toHaveBeenLastCalledWith("project-1", {
        path: "src/old.ts",
        origPath: undefined,
        rev: "1234567890abcdef",
      }),
    );
  });

  it("labels a file that has no reachable commit as uncommitted", async () => {
    mocks.getGitFileRevision.mockResolvedValue({
      path: "new.txt",
      isGitRepo: true,
      dirty: false,
      commit: null,
    });
    render(
      <FileRevisionLink
        projectId="project-1"
        path="new.txt"
        dirtyLabel="dirty"
        uncommittedLabel="uncommitted"
      />,
    );

    expect(await screen.findByText("uncommitted")).not.toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("reloads provenance when the source changes and ignores the old response", async () => {
    let resolveFirst: ((value: unknown) => void) | undefined;
    const first = new Promise((resolve) => {
      resolveFirst = resolve;
    });
    mocks.getGitFileRevision.mockReturnValueOnce(first).mockResolvedValueOnce({
      path: "same.txt",
      isGitRepo: true,
      dirty: false,
      commit: {
        hash: "bbbbbbbbbbbbbbbb",
        shortHash: "bbbbbbb",
        authorName: "Second source",
        authorDate: "2026-08-25T12:00:00.000Z",
        subject: "Second revision",
        message: "Second revision",
        messageTruncated: false,
      },
    });
    const props = {
      projectId: "shared-project",
      path: "same.txt",
      dirtyLabel: "dirty",
      uncommittedLabel: "uncommitted",
    };
    const { rerender } = render(<FileRevisionLink {...props} />);

    mocks.sourceKey = "remote:second";
    rerender(<FileRevisionLink {...props} />);
    expect(await screen.findByRole("link", { name: "bbbbbbb" })).not.toBeNull();

    resolveFirst?.({
      path: "same.txt",
      isGitRepo: true,
      dirty: false,
      commit: {
        hash: "aaaaaaaaaaaaaaaa",
        shortHash: "aaaaaaa",
        authorName: "First source",
        authorDate: "2026-08-24T12:00:00.000Z",
        subject: "First revision",
        message: "First revision",
        messageTruncated: false,
      },
    });
    await Promise.resolve();

    expect(screen.queryByRole("link", { name: "aaaaaaa" })).toBeNull();
    expect(mocks.getGitFileRevision).toHaveBeenCalledTimes(2);
  });
});

describe("formatRevisionAge", () => {
  const now = Date.parse("2026-08-25T12:00:00.000Z");

  it("uses compact elapsed units", () => {
    expect(formatRevisionAge("2026-08-25T11:58:00.000Z", now)).toBe("2m ago");
    expect(formatRevisionAge("2026-08-23T12:00:00.000Z", now)).toBe("2d ago");
  });
});
