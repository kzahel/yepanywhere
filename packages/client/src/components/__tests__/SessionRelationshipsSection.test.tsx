import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import { SessionRelationshipsSection } from "../SessionRelationshipsSection";

const mocks = vi.hoisted(() => ({
  source: "host:a",
  read: vi.fn(),
  refresh: vi.fn(),
  navigate: vi.fn(),
}));
vi.mock("../../hooks/useSessionRelationships", () => ({
  useSessionRelationships: (...args: unknown[]) => mocks.read(...args),
}));
vi.mock("../../contexts/SourceRuntimeContext", () => ({
  useCurrentSourceRuntime: () => ({ sourceKey: mocks.source }),
}));
vi.mock("../../hooks/useRemoteBasePath", () => ({
  useRemoteBasePath: () => "/-/relay/owned",
}));
vi.mock("../../lib/clientSummaryStore", () => ({
  useSessionCollectionRecord: (id: string) =>
    id === "launcher" ? { title: "Launcher session" } : undefined,
}));
const session = (sessionId: string) => ({
  kind: "session",
  serverId: "local",
  sessionId,
  projectId: "project",
  provider: "claude",
});
const child = {
  kind: "provider-child",
  serverId: "local",
  parentSessionId: "current",
  childId: "child id",
  projectId: "project",
  provider: "claude",
};
const proof = { trust: "command-observed", observedAt: "2026-11-06T00:00:00Z" };
const row = (type: string, source: unknown, target: unknown) => ({
  type,
  source,
  target,
  evidence: [proof],
});
const wrap = () => (
  <MemoryRouter>
    <I18nProvider>
      <SessionRelationshipsSection
        projectId="project"
        sessionId="current"
        onNavigate={mocks.navigate}
      />
    </I18nProvider>
  </MemoryRouter>
);
beforeEach(() => {
  mocks.source = "host:a";
  mocks.read.mockReset();
  mocks.refresh.mockReset();
  mocks.navigate.mockReset();
});
afterEach(cleanup);

it("links back to an independent launcher and preserves parent-scoped native-child navigation without assigning future predicates child semantics", () => {
  mocks.read.mockReturnValue({
    loading: false,
    error: null,
    refetch: mocks.refresh,
    page: {
      nextCursor: null,
      relationships: [
        row("launched_harness", session("launcher"), session("current")),
        row("provider_child", session("current"), child),
        row("future_predicate", session("current"), {
          ...child,
          childId: "future child",
        }),
      ],
    },
  });
  render(wrap());
  expect(screen.getByText("Launched by")).not.toBeNull();
  expect(
    screen.getByRole("link", { name: "Launcher session" }).getAttribute("href"),
  ).toBe("/-/relay/owned/projects/project/sessions/launcher");
  expect(
    screen.getByRole("link", { name: "child id" }).getAttribute("href"),
  ).toBe("/-/relay/owned/projects/project/sessions/current/agents/child%20id");
  expect(screen.getByText("future child").closest("a")).toBeNull();
  expect(screen.getAllByRole("link")).toHaveLength(2);
  fireEvent.click(screen.getByRole("link", { name: "Launcher session" }));
  expect(mocks.navigate).toHaveBeenCalledTimes(1);
});

it("omits unfamiliar trust labels and shows a neutral, non-navigable future reference", () => {
  mocks.read.mockReturnValue({
    loading: false,
    error: null,
    refetch: mocks.refresh,
    page: {
      nextCursor: null,
      relationships: [
        {
          ...row("future_relation", session("current"), {
            kind: "future-reference",
            provider: "opencode",
          }),
          evidence: [{ ...proof, trust: "future-trust" }],
        },
      ],
    },
  });
  const view = render(wrap());
  expect(screen.getByText("Unrecognized session reference")).not.toBeNull();
  expect(screen.queryAllByRole("link")).toHaveLength(0);
  expect(view.container.textContent).not.toContain("undefined");
  expect(view.container.textContent).toContain("OpenCode");
});

it("uses only server-issued cursors, refreshes from page one and resets cursor state across sources", () => {
  mocks.read.mockImplementation((_project, _session, cursor) => ({
    loading: false,
    error: null,
    refetch: mocks.refresh,
    page: { nextCursor: cursor ? null : "owned-cursor", relationships: [] },
  }));
  const view = render(wrap());
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  expect(mocks.read).toHaveBeenLastCalledWith(
    "project",
    "current",
    "owned-cursor",
  );
  expect(screen.getByText("Page 2")).not.toBeNull();
  mocks.source = "host:b";
  view.rerender(wrap());
  expect(mocks.read).toHaveBeenLastCalledWith("project", "current", undefined);
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  fireEvent.click(screen.getByRole("button", { name: "Refresh from start" }));
  expect(mocks.read).toHaveBeenLastCalledWith("project", "current", undefined);
  fireEvent.click(screen.getByRole("button", { name: "Refresh from start" }));
  expect(mocks.refresh).toHaveBeenCalledTimes(1);
});

it("keeps loading and failure local instead of manufacturing an empty relationship page", () => {
  mocks.read.mockReturnValue({
    loading: true,
    error: null,
    page: null,
    refetch: mocks.refresh,
  });
  const view = render(wrap());
  expect(screen.getByRole("status").textContent).toContain(
    "Loading related sessions",
  );
  expect(
    screen.queryByText("No matching links have been recorded."),
  ).toBeNull();
  mocks.read.mockReturnValue({
    loading: false,
    error: new Error("private provider path"),
    page: null,
    refetch: mocks.refresh,
  });
  view.rerender(wrap());
  expect(screen.getByRole("status").textContent).toContain(
    "Relationships are unavailable",
  );
  expect(screen.queryByText("private provider path")).toBeNull();
});
