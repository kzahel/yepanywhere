import { readOperationIds, type Operation } from "./core-api/contracts.js";
import { CoreApiError, type ApiReadPort } from "./core-api/service.js";
import { admitServerRequest } from "./server-restart-control.js";

const reads = new Set<Operation>(readOperationIds);

/** Provider-owned sockets reach this port without traversing Hono middleware. */
export function serverAgentApiAdmission(read: ApiReadPort): ApiReadPort {
  return async (operation, caller, input) => {
    const release = admitServerRequest(!reads.has(operation));
    if (!release)
      throw new CoreApiError(
        "controller_unavailable",
        "Server is restarting",
        503,
      );
    try {
      return await read(operation, caller, input);
    } finally {
      release();
    }
  };
}
