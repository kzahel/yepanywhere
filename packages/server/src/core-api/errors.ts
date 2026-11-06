/** Wire errors shared by core and the trusted provider/controller bridge. */
const statuses = {
  unauthorized: 401,
  peer_unavailable: 503,
  peer_unsupported: 501,
  peer_identity_mismatch: 502,
  peer_state_unavailable: 503,
  peer_record_conflict: 409,
  peer_response_too_large: 502,
  forbidden: 403,
  session_not_running: 409,
  identity_pending: 409,
  project_not_found: 404,
  receipt_not_found: 404,
  request_id_conflict: 409,
  receipt_capacity: 503,
  command_capacity: 503,
  invalid_request: 400,
  server_not_found: 404,
  session_not_found: 404,
  catalog_not_ready: 503,
  controller_unavailable: 503,
  conversation_unavailable: 503,
  relationships_unavailable: 503,
  anchor_unavailable: 404,
} as const;
export class CoreApiError extends Error {
  constructor(
    readonly code: keyof typeof statuses,
    message: string,
    readonly status: (typeof statuses)[keyof typeof statuses],
  ) {
    super(message);
  }

  static restore(value: unknown): CoreApiError | undefined {
    if (!value || typeof value !== "object") return;
    const error = value as {
      code?: unknown;
      message?: unknown;
      status?: unknown;
    };
    if (typeof error.code !== "string" || !Object.hasOwn(statuses, error.code))
      return;
    const code = error.code as keyof typeof statuses;
    if (error.status !== statuses[code]) return;
    return new CoreApiError(
      code,
      typeof error.message === "string"
        ? error.message.slice(0, 512)
        : "API operation failed",
      statuses[code],
    );
  }
}
