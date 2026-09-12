import { describe, expect, it } from "vitest";
import type { PreviewSession, PreviewSource } from "./previewController";
import { previewGroups } from "./previewGroups";

const session = (id: string, updatedAt: string): PreviewSession => ({
  id,
  title: id,
  projectId: "project",
  projectName: "Project",
  updatedAt,
  issues: [],
});
const source = (id: string, sessions: PreviewSession[]): PreviewSource => ({
  host: {
    id,
    displayName: id,
    mode: "direct",
    wsUrl: "ws://test/api/ws",
    srpUsername: "test",
    createdAt: "",
  },
  status: "ready",
  sessions,
  hasMore: false,
  updatedAt: 0,
  issueCoverage: "disabled",
});

describe("ungrouped preview sessions", () => {
  it("sorts activity across machines, keeps equal dates stable and unknown dates last without mutating catalogs", () => {
    const sources = [
      source("a", [
        session("invalid", "invalid"),
        session("older", "2026-01-01T00:00:00Z"),
        session("tie-a", "2026-01-02T00:00:00Z"),
      ]),
      source("b", [
        session("tie-b", "2026-01-02T01:00:00+01:00"),
        session("newest", "2026-01-03T00:00:00Z"),
        session("missing", ""),
      ]),
      {
        ...source("excluded", [session("hidden", "2026-01-04T00:00:00Z")]),
        status: "excluded" as const,
      },
    ];
    const before = structuredClone(sources);
    expect(
      previewGroups(sources, "none")[0]?.rows.map(({ session }) => session.id),
    ).toEqual(["newest", "tie-a", "tie-b", "older", "invalid", "missing"]);
    expect(sources).toEqual(before);
  });

  it("keeps the empty state when included machines have no sessions", () => {
    expect(previewGroups([], "none")).toEqual([]);
    expect(previewGroups([source("empty", [])], "none")).toEqual([]);
  });
});
