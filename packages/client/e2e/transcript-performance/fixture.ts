import { toUrlProjectId } from "@yep-anywhere/shared";
import type { Message, SessionMetadata } from "../../src/types";

export const projectId = toUrlProjectId("/synthetic/frontend");
export const sessionId = "frontend-performance";
export { LOCAL_CLIENT_SUMMARY_SOURCE_KEY as sourceKey } from "../../src/lib/clientSummaryStore";
import { LOCAL_CLIENT_SUMMARY_SOURCE_KEY as sourceKey } from "../../src/lib/clientSummaryStore";
export const entryKey = {
  sourceKey,
  projectId,
  sessionId,
  initialHistoryCompactions: null,
};
export const project = {
  id: projectId,
  path: "/synthetic/frontend",
  name: "Frontend fixture",
  sessionCount: 201,
  activeOwnedCount: 0,
  activeExternalCount: 0,
  lastActivity: "2026-01-02T10:00:00.000Z",
};
export function metadata(count: number): SessionMetadata {
  return {
    id: sessionId,
    projectId,
    projectName: project.name,
    title: "Controlled frontend workload",
    fullTitle: "Controlled frontend workload",
    provider: "claude",
    model: "claude-sonnet-4-5",
    createdAt: "2026-01-02T10:00:00.000Z",
    updatedAt: new Date().toISOString(),
    messageCount: count,
    ownership: { owner: "none" },
  };
}
export function turn(index: number, marker: string): Message[] {
  if (!/^[a-z0-9-]+$/.test(marker)) throw new Error("Invalid fixture marker");
  const timestamp = new Date(Date.UTC(2026, 0, 2, 10, 0, index)).toISOString();
  return [
    {
      type: "user",
      uuid: `user-${index}`,
      timestamp,
      content: `Inspect task ${index}`,
    },
    {
      type: "assistant",
      uuid: `call-${index}`,
      timestamp,
      content: [
        {
          type: "tool_use",
          id: `read-${index}`,
          name: "Read",
          input: { file_path: `src/file-${index}.ts` },
        },
      ],
    },
    {
      type: "user",
      uuid: `result-${index}`,
      timestamp,
      content: [
        {
          type: "tool_result",
          tool_use_id: `read-${index}`,
          content: "export const ready = true;\n".repeat(16),
        },
      ],
    },
    {
      type: "assistant",
      uuid: `reply-${index}`,
      timestamp,
      content: [
        {
          type: "text",
          text: `Task **${index}** is complete. ${marker}`,
          _html: `<p>Task <strong>${index}</strong> is complete. ${marker}</p>`,
        },
      ],
    },
  ];
}
export function history(turns: number): Message[] {
  return Array.from({ length: turns }, (_, i) =>
    turn(i, `history-${i}`),
  ).flat();
}
