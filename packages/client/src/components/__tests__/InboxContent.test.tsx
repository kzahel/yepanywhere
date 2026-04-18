import { describe, expect, it } from "vitest";
import { buildInboxProjectOptions } from "../InboxContent";
import type { Project } from "../../types";

describe("buildInboxProjectOptions", () => {
  it("only includes projects that actually appear in inbox tiers", () => {
    const projects: Project[] = [
      {
        id: "p1",
        name: "observer-sessions",
        path: "C:/Users/Administrator/.claude-mem/observer-sessions",
        sessionCount: 10,
        activeOwnedCount: 0,
        activeExternalCount: 0,
        lastActivity: null,
      },
      {
        id: "p2",
        name: "Temp",
        path: "C:/Users/Administrator/AppData/Local/Temp",
        sessionCount: 4,
        activeOwnedCount: 0,
        activeExternalCount: 0,
        lastActivity: null,
      },
    ];

    const options = buildInboxProjectOptions(
      projects,
      [
        {
          sessionId: "s1",
          projectId: "p1",
          projectName: "observer-sessions",
          sessionTitle: "Hello",
          updatedAt: "2026-04-18T00:00:00.000Z",
        },
      ],
      "inboxAllProjects",
    );

    expect(options.map((option) => option.value)).toEqual(["", "p1"]);
  });

  it("adds path descriptions when multiple inbox projects share the same name", () => {
    const projects: Project[] = [
      {
        id: "p1",
        name: "observer-sessions",
        path: "C:/Users/Administrator/.claude-mem/observer-sessions",
        sessionCount: 10,
        activeOwnedCount: 0,
        activeExternalCount: 0,
        lastActivity: null,
      },
      {
        id: "p2",
        name: "observer-sessions",
        path: "C:/Windows/System32/config/systemprofile/.claude-mem/observer-sessions",
        sessionCount: 3,
        activeOwnedCount: 0,
        activeExternalCount: 0,
        lastActivity: null,
      },
    ];

    const options = buildInboxProjectOptions(
      projects,
      [
        {
          sessionId: "s1",
          projectId: "p1",
          projectName: "observer-sessions",
          sessionTitle: "Hello",
          updatedAt: "2026-04-18T00:00:00.000Z",
        },
        {
          sessionId: "s2",
          projectId: "p2",
          projectName: "observer-sessions",
          sessionTitle: "World",
          updatedAt: "2026-04-18T00:00:00.000Z",
        },
      ],
      "inboxAllProjects",
    );

    expect(options[1]).toMatchObject({
      value: "p1",
      label: "observer-sessions",
      description: "C:/Users/Administrator/.claude-mem/observer-sessions",
    });
    expect(options[2]).toMatchObject({
      value: "p2",
      label: "observer-sessions",
      description:
        "C:/Windows/System32/config/systemprofile/.claude-mem/observer-sessions",
    });
  });
});
