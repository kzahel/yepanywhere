import { isFullSchemaPath } from "./documentation-metrics.js";
import { TARGET_ARTIFACT, TARGET_PROOF } from "./target-contract.js";
import { correctSelection } from "./selection.js";
import type { ApiSessionInspection } from "../../packages/server/src/core-api/selection-contracts.js";
import type { ApiSession } from "../../packages/server/src/core-api/contracts.js";

export const FIXTURE_REVISION = "agent-api-selection-9";
export const SERVER_ID = "00000000-0000-4000-8000-000000000001";
export const OWN_SESSION_ID = "eval-owning-session";
export const PROJECT_ID = "orchid-project";
export const REVIEW_IDS = ["orchid-004", "orchid-072", "orchid-119"];
export const projects = [
  { id: PROJECT_ID, name: "Orchid", path: "/fixture/orchid" },
  { id: "orchid-old", name: "Orchid archive", path: "/fixture/archive" },
];
export const sessions: ApiSession[] = Array.from(
  { length: 125 },
  (_, index) => {
    const id = `orchid-${String(index).padStart(3, "0")}`;
    return {
      id,
      projectId: PROJECT_ID,
      title: REVIEW_IDS.includes(id) ? "Release review" : `Work ${index}`,
      provider: id === REVIEW_IDS[1] ? "codex" : "claude",
      state: "idle",
      updatedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
    };
  },
);
sessions.push({
  id: OWN_SESSION_ID,
  projectId: "orchid-old",
  title: "Eval owner",
  provider: "codex",
  state: "in-turn",
  updatedAt: "2026-01-02T00:00:00.000Z",
});
export const CASES = {
  target_contract:
    "Discover the other server's target-only probe operation from its own documentation and exact schema, use it, and report the returned artifact exactly in answer. Do not assume the access server implements the same API.",
  approval:
    "A worker named Approval worker is blocked. Inspect why, approve its pending permission request, and read the artifact it produces afterward. Report the worker session id and that artifact exactly in answer. Do not claim success from admission alone.",
  controls:
    "Interrupt the worker named Interrupt worker and stop the worker named Stop worker. Inspect their control receipts and resulting session states. Report their ids in sessionIds and answer as interrupt-state|stop-state using observed session state values. Do not automatically resume them.",
  selection:
    "Discover the Codex pool named Release pool and its model/effort/speed choices. Create one worker in Orchid on that pool using its Release model, high thinking effort, Fast speed, and plan permission mode. Read the worker session back and verify all those settings plus its selected pool and account. Report the worker id in sessionId, supported=true only after verification, and answer exactly as model|effort|serviceTier|poolId|accountId|permissionMode using observed values. Do not infer completion from creation acceptance.",
  operation:
    "Find the operation id and HTTP method/path used to create sessions, then fetch only that operation's exact schema. Report its operation id in answer. Avoid downloading the full OpenAPI schema.",
  workflow:
    "Create one Codex worker in Orchid and read its initial release answer. Queue a follow-up asking for its follow-up artifact, repeat that identical submission with the same retry key once, and follow its receipt for input consumption. Reconnect to its conversation and inspect trusted creation provenance. Report the worker id in sessionId, creator session id in sessionIds, and final follow-up artifact exactly in answer. Do not infer successful task completion from queue acceptance.",
  create:
    "Create one Codex worker in project Orchid with an initial prompt to review the release. Follow its compact conversation and inspect its trusted creation provenance. Report its session id in sessionId, its creator session id in sessionIds, and the release artifact exactly in answer.",
  follow:
    "Follow the worker in session orchid-072 using this HTTP API until it reports its final release artifact. Report that artifact exactly in answer; observe its completion rather than guessing from its title.",
  reconnect:
    "Read session orchid-072 through the follow endpoint with maxMessages=1. Then reconnect with that cursor but maxMessages=20. Does the response explicitly tell you to replace the window? Report supported=true if reset is true, and the release artifact exactly in answer.",
  conversation:
    "Inspect the compact conversation of session orchid-072. Report the exact release artifact named in the agent answer, without tool logs.",
  evidence:
    "Read the conversation and activity of session orchid-072. Can you establish that its task completed successfully? Set complete=false if its coverage/activity cannot establish this, and explain briefly.",
  identity: "Report the server id and your owning YA session id from this API.",
  project:
    "Find the project named exactly Orchid and report its API project id.",
  pagination:
    "Find every session in the project named exactly Orchid whose title is exactly Release review. Report all their session ids. Do not assume the first page is the whole catalog.",
  detail:
    "Among the Release review sessions in Orchid, identify the one last updated at 2026-01-01T00:01:12.000Z. Inspect that session and report its id and provider in answer.",
  incomplete:
    "Inspect the session catalog. Can you conclude that a session named Missing review does not exist? Report complete=false if the catalog cannot establish absence, otherwise complete=true.",
  unsupported:
    "Check advertised servers and operations. Can this API currently create a session on another authorized machine? Report supported and explain briefly.",
  control:
    "Calculate 17 times 23. Put the decimal result in answer. This task needs no YA information.",
} as const;
export type CaseId = keyof typeof CASES;
export interface Answer {
  serverId: string | null;
  sessionId: string | null;
  projectId: string | null;
  sessionIds: string[];
  complete: boolean | null;
  supported: boolean | null;
  answer: string;
}
export interface Trace {
  inspection?: ApiSessionInspection;
  receipt?: {
    id: string;
    kind: string;
    delivery: string;
    state?: string;
    result?: Record<string, unknown>;
  };
  sessionState?: string;
  pendingId?: string;
  artifact?: string;
  follow?: { cursor: string; reset: boolean; changed: boolean };
  method: string;
  path: string;
  status: number;
  bytes: number;
  elapsedMs: number;
  atMs: number;
}
export const answerSchema = {
  type: "object",
  properties: {
    serverId: { type: ["string", "null"] },
    sessionId: { type: ["string", "null"] },
    projectId: { type: ["string", "null"] },
    sessionIds: { type: "array", items: { type: "string" } },
    complete: { type: ["boolean", "null"] },
    supported: { type: ["boolean", "null"] },
    answer: { type: "string" },
  },
  required: [
    "serverId",
    "sessionId",
    "projectId",
    "sessionIds",
    "complete",
    "supported",
    "answer",
  ],
  additionalProperties: false,
};
export function grade(
  caseId: CaseId,
  answer: Answer | null,
  trace: Trace[],
  operationsInContext = false,
  targetServerId = SERVER_ID,
) {
  const read = (path: string) =>
    trace.some(
      (entry) =>
        entry.method === "GET" &&
        entry.status === 200 &&
        entry.path.split("?")[0] === path,
    );
  const root = `/v0/servers/${targetServerId}`;
  if (
    !answer ||
    !Array.isArray(answer.sessionIds) ||
    !answer.sessionIds.every((id) => typeof id === "string") ||
    typeof answer.answer !== "string"
  )
    return false;
  // self is interpreted at the access server; normalize for evidence matching.
  trace = trace.map((entry) => ({
    ...entry,
    path: entry.path.replace(
      "/v0/servers/self/",
      `/v0/servers/${targetServerId}/`,
    ),
  }));
  switch (caseId) {
    case "target_contract":
      return (
        answer.answer === TARGET_ARTIFACT &&
        read(`${root}/help`) &&
        trace.some(
          (t) =>
            t.status === 200 &&
            t.path === `${root}/schema?operation=targetProbe`,
        ) &&
        trace.some(
          (t) =>
            t.status === 200 &&
            t.path === `${root}/extension/probe?proof=${TARGET_PROOF}` &&
            t.artifact === TARGET_ARTIFACT,
        )
      );
    case "approval":
      return (
        answer.sessionId === "approval-worker" &&
        answer.answer === "approved-artifact-4d8" &&
        trace.some(
          (t) =>
            t.status === 200 &&
            t.path === `${root}/sessions/approval-worker/requests` &&
            t.pendingId === "permission-001",
        ) &&
        trace.some(
          (t) =>
            t.method === "POST" &&
            t.status === 202 &&
            t.path ===
              `${root}/sessions/approval-worker/requests/permission-001/response`,
        ) &&
        trace.some(
          (t) =>
            t.status === 200 &&
            t.receipt?.kind === "respond" &&
            t.receipt.state === "accepted" &&
            t.receipt.result?.accepted === true,
        ) &&
        trace.some(
          (t) =>
            t.status === 200 &&
            t.path.startsWith(
              `${root}/sessions/approval-worker/conversation`,
            ) &&
            t.artifact === "approved-artifact-4d8",
        )
      );
    case "controls":
      return (
        answer.answer === "idle|terminated" &&
        ["interrupt-worker", "stop-worker"].every((id) =>
          answer.sessionIds.includes(id),
        ) &&
        ["cancel", "stop"].every(
          (kind) =>
            trace.some(
              (t) =>
                t.method === "POST" &&
                t.status === 202 &&
                t.path ===
                  `${root}/sessions/${kind === "cancel" ? "interrupt" : "stop"}-worker/${kind}`,
            ) &&
            trace.some(
              (t) =>
                t.status === 200 &&
                t.receipt?.kind === kind &&
                t.receipt.state === "accepted" &&
                (kind === "cancel"
                  ? t.receipt.result?.interrupted === true
                  : t.receipt.result?.stopped === true),
            ),
        ) &&
        trace.some(
          (t) =>
            t.status === 200 &&
            t.path === `${root}/sessions/interrupt-worker` &&
            t.sessionState === "idle",
        ) &&
        trace.some(
          (t) =>
            t.status === 200 &&
            t.path === `${root}/sessions/stop-worker` &&
            t.sessionState === "terminated",
        )
      );
    case "operation":
      return (
        /\bcreateSession\b/.test(answer.answer) &&
        trace.some(
          (entry) =>
            entry.status === 200 &&
            [
              "/v0/schema?operation=createSession",
              `${root}/schema?operation=createSession`,
            ].includes(entry.path),
        ) &&
        !trace.some(
          (entry) => entry.status === 200 && isFullSchemaPath(entry.path),
        )
      );
    case "selection":
      return (
        answer.sessionId === "eval-worker-1" &&
        answer.supported === true &&
        answer.answer ===
          "release-model|high|priority|release-pool|release-account|plan" &&
        trace.some(
          (entry) =>
            entry.status === 200 &&
            entry.path.startsWith(`${root}/selection?`) &&
            new URL(entry.path, "http://fixture").searchParams.get(
              "provider",
            ) === "codex",
        ) &&
        trace.some(
          (entry) =>
            entry.method === "POST" &&
            entry.status === 202 &&
            entry.path === `${root}/sessions`,
        ) &&
        trace.some(
          (entry) =>
            entry.status === 200 &&
            entry.path === `${root}/sessions/eval-worker-1` &&
            correctSelection(entry.inspection),
        )
      );
    case "workflow": {
      const sent = trace.filter(
        (entry) =>
          entry.method === "POST" &&
          entry.status === 202 &&
          entry.path === `${root}/sessions/eval-worker-1/prompts` &&
          entry.receipt?.kind === "prompt",
      );
      const repeated =
        sent.length >= 2 &&
        sent.some((first, index) =>
          sent
            .slice(index + 1)
            .some((next) => next.receipt?.id === first.receipt?.id),
        );
      const consumed = sent.some((entry) =>
        trace.some(
          (observation) =>
            observation.method === "GET" &&
            observation.status === 200 &&
            observation.receipt?.id === entry.receipt?.id &&
            observation.receipt?.delivery === "consumed",
        ),
      );
      return (
        repeated &&
        consumed &&
        answer.sessionId === "eval-worker-1" &&
        answer.sessionIds.includes(OWN_SESSION_ID) &&
        answer.answer.trim() === "followup-c82" &&
        read(`${root}/sessions/eval-worker-1/relationships`) &&
        (read(`${root}/sessions/eval-worker-1/conversation`) ||
          read(`${root}/sessions/eval-worker-1/conversation/follow`))
      );
    }
    case "create":
      return (
        answer.sessionId === "eval-worker-1" &&
        answer.sessionIds.includes(OWN_SESSION_ID) &&
        answer.answer.trim() === "created-5b7" &&
        trace.some(
          (entry) =>
            entry.method === "POST" &&
            entry.status === 202 &&
            entry.path === `${root}/sessions`,
        ) &&
        read(`${root}/sessions/eval-worker-1/relationships`) &&
        (read(`${root}/sessions/eval-worker-1/conversation`) ||
          read(`${root}/sessions/eval-worker-1/conversation/follow`))
      );
    case "follow":
      return (
        answer.answer.trim() === "worker-9c4" &&
        trace.filter(
          (entry) =>
            entry.status === 200 &&
            entry.method === "GET" &&
            [
              `${root}/sessions/orchid-072/conversation`,
              `${root}/sessions/orchid-072/conversation/follow`,
            ].includes(entry.path.split("?")[0]!),
        ).length >= 2
      );
    case "reconnect": {
      const observations = trace.filter(
        (entry) =>
          entry.status === 200 &&
          entry.method === "GET" &&
          entry.path.split("?")[0] ===
            `${root}/sessions/orchid-072/conversation/follow`,
      );
      return (
        answer.answer.trim() === "worker-9c4" &&
        answer.supported === true &&
        observations.some((initial, index) => {
          const first = new URL(initial.path, "http://fixture");
          return (
            first.searchParams.get("maxMessages") === "1" &&
            Boolean(initial.follow?.cursor) &&
            observations.slice(index + 1).some((next) => {
              const query = new URL(next.path, "http://fixture").searchParams;
              return (
                query.get("after") === initial.follow!.cursor &&
                (query.get("maxMessages") ?? "20") === "20" &&
                next.follow?.reset === true &&
                next.follow.changed === true
              );
            })
          );
        })
      );
    }
    case "conversation":
      return (
        answer.answer.trim() === "orchid-7f2" &&
        read(`${root}/sessions/orchid-072/conversation`)
      );
    case "evidence":
      return (
        answer.complete === false &&
        read(`${root}/sessions/orchid-072/conversation`)
      );
    case "identity":
      return (
        answer.serverId === SERVER_ID &&
        answer.sessionId === OWN_SESSION_ID &&
        read("/v0/me")
      );
    case "project":
      return answer.projectId === PROJECT_ID && read(`${root}/projects`);
    case "pagination":
      return (
        JSON.stringify([...answer.sessionIds].sort()) ===
          JSON.stringify([...REVIEW_IDS].sort()) && read(`${root}/sessions`)
      );
    case "detail":
      return (
        answer.sessionId === REVIEW_IDS[1] &&
        answer.answer.trim().toLowerCase() === "codex" &&
        read(`${root}/sessions/${REVIEW_IDS[1]}`)
      );
    case "incomplete":
      return answer.complete === false && read(`${root}/sessions`);
    case "unsupported":
      return (
        answer.supported === false &&
        read("/v0/servers") &&
        (operationsInContext ||
          read(`${root}/capabilities`) ||
          read(`${root}/access`) ||
          read("/v0/schema") ||
          read("/v0/help") ||
          read("/v0")) &&
        trace.every((entry) => entry.method === "GET")
      );
    case "control":
      return answer.answer.trim() === "391" && trace.length === 0;
  }
}
