import {
  assertUrlProjectId,
  parseYaSessionId,
  type ProviderName,
  type SessionCreationStatus,
} from "@yep-anywhere/shared";
import type { SessionCreationProjection } from "./SessionCreationStore.js";
export interface ProjectionRow {
  creation_id: string;
  generation: number;
  session_id: string;
  project_id: string;
  provider: ProviderName;
  created_at: string;
  updated_at: string;
  native_bound: number;
  deleted: number;
  input_expected: number;
  attempt_id: string;
  state: SessionCreationStatus["state"];
  delivery: SessionCreationStatus["delivery"];
  detail_json: string;
}
export const CREATION_PROJECTION_SQL =
  "SELECT c.id AS creation_id, a.generation, i.session_id, i.project_id, i.provider, i.created_at, a.updated_at, i.native_id IS NOT NULL AS native_bound, c.deleted, c.input_expected, a.id AS attempt_id, a.state, a.delivery, a.detail_json FROM session_creations c JOIN session_identities i ON i.session_id = c.session_id JOIN session_creation_attempts a ON a.id = c.current_attempt";
export function creationProjection(
  row: ProjectionRow,
): SessionCreationProjection {
  assertUrlProjectId(row.project_id);
  const detail: Pick<
    SessionCreationStatus,
    "failure" | "failureDetail" | "kind"
  > = JSON.parse(row.detail_json);
  return {
    sessionId: parseYaSessionId(row.session_id),
    projectId: row.project_id,
    provider: row.provider,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    nativeBound: row.native_bound === 1,
    deleted: row.deleted === 1,
    creation: {
      state: row.state,
      attemptId: row.attempt_id,
      updatedAt: row.updated_at,
      delivery: row.delivery,
      ...(row.input_expected === 0
        ? { initialInputExpected: false as const }
        : {}),
      ...(detail.kind === "copy" ? { kind: "copy" as const } : {}),
      ...(detail.failure ? { failure: detail.failure } : {}),
      ...(detail.failureDetail ? { failureDetail: detail.failureDetail } : {}),
    },
  };
}
