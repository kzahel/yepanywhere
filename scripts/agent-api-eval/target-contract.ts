import {
  CoreApi,
  CoreApiError,
} from "../../packages/server/src/core-api/service.js";
import { assertPeerOperation } from "../../packages/server/src/core-api/peer-policy.js";
import type { Operation } from "../../packages/server/src/core-api/contracts.js";

export const TARGET_OPERATION = "targetProbe";
export const TARGET_PROOF = "target-shape-37";
export const TARGET_ARTIFACT = "target-artifact-6e2";

/** This operation deliberately does not exist in the access server's operation table. */
export class TargetContractFixture extends CoreApi {
  override async read(...args: Parameters<CoreApi["read"]>): Promise<unknown> {
    const [operation, caller, input = {}] = args;
    if (operation === "capabilities" || operation === "access") {
      const facts = (await super.read(...args)) as { operations: string[] };
      return {
        ...facts,
        operations: [
          ...facts.operations,
          ...(operation === "capabilities" ||
          caller.kind !== "peer" ||
          caller.operations.includes(TARGET_OPERATION)
            ? [TARGET_OPERATION]
            : []),
        ],
      };
    }
    if (operation === "targetHelp") {
      assertPeerOperation(caller, operation);
      if (input.query?.operation && input.query.operation !== TARGET_OPERATION)
        return super.read(...args);
      const docs = `Target-only operation ${TARGET_OPERATION}: GET /v0/servers/${this.serverId}/extension/probe. Read this target's /schema?operation=${TARGET_OPERATION} for its required proof query, then return extensionResult.artifact.`;
      return input.query?.operation
        ? docs
        : `${await super.read(...args)}\n\n${docs}`;
    }
    if (
      operation === "targetSchema" &&
      input.query?.operation === TARGET_OPERATION
    ) {
      assertPeerOperation(caller, operation);
      return {
        operationId: TARGET_OPERATION,
        method: "GET",
        path: `/v0/servers/${this.serverId}/extension/probe`,
        query: {
          proof: { type: "string", const: TARGET_PROOF, required: true },
        },
        result: { extensionResult: { artifact: "string" } },
      };
    }
    if (
      input.http &&
      new URL(input.http.path, "http://fixture").pathname ===
        `/v0/servers/${this.serverId}/extension/probe`
    ) {
      assertPeerOperation(caller, TARGET_OPERATION as Operation);
      if (
        input.http.method !== "GET" ||
        new URL(input.http.path, "http://fixture").searchParams.get("proof") !==
          TARGET_PROOF
      )
        throw new CoreApiError(
          "invalid_request",
          "Read targetProbe's schema for its proof query",
          400,
        );
      return {
        extensionResult: { artifact: TARGET_ARTIFACT },
        unfamiliarField: ["retained", 37],
      };
    }
    return super.read(...args);
  }
}
