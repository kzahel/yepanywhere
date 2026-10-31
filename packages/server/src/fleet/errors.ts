import type { ContentfulStatusCode } from "hono/utils/http-status";

export class FleetError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: ContentfulStatusCode = 400,
  ) {
    super(message);
  }
}
