import type { ContentfulStatusCode } from "hono/utils/http-status";

export class IdentityServiceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: ContentfulStatusCode = 400,
  ) {
    super(message);
  }
}
