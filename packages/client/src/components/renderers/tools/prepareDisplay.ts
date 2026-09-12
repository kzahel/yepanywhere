import type { z } from "zod";
import type { ToolCallItem } from "@yep-anywhere/shared/transcript/items";

export type DisplayStatus = ToolCallItem["status"];
export interface DisplayRecord {
  input: unknown;
  result?: unknown;
  status: DisplayStatus;
  isError?: boolean;
  toolName?: string;
}
export interface DisplayContract<I extends z.ZodType, R extends z.ZodType> {
  input: I;
  result: R;
  partialResult?: z.ZodType<string>;
  failure?: z.ZodType<z.output<R>>;
  variants: readonly [string, ...string[]];
  standaloneResult: boolean;
  standaloneResultSchema?: z.ZodType<z.output<R>>;
}

/** Bounded, data-only preparation shared by native parity and mounted dispatch.
 * A rejection has its own optional display contract, never the success schema.
 * There is no transcript scan, mutation, cache, or provider conversion here.
 */
export function prepareDisplay<I extends z.ZodType, R extends z.ZodType>(
  contract: DisplayContract<I, R>,
  record: DisplayRecord,
) {
  const isError = record.isError ?? record.status === "error";
  const input = contract.input.safeParse(record.input);
  const resultSchema = isError
    ? contract.failure
    : record.input === undefined
      ? (contract.standaloneResultSchema ?? contract.result)
      : contract.result;
  const result =
    record.result === undefined
      ? undefined
      : resultSchema?.safeParse(record.result);
  const partialResult =
    !isError && result && !result.success
      ? contract.partialResult?.safeParse(record.result)
      : undefined;
  const inputEligible =
    input.success ||
    (record.input === undefined &&
      contract.standaloneResult &&
      (result?.success || partialResult?.success));
  const reason = !inputEligible
    ? ("input" as const)
    : (isError && !contract.failure) ||
        (result && !result.success && !partialResult?.success)
      ? ("result" as const)
      : undefined;
  return {
    kind: reason
      ? ("raw" as const)
      : partialResult?.success
        ? ("partial" as const)
        : ("rich" as const),
    reason,
    status: record.status,
    isError,
    input,
    result,
    partialResult,
    inputEligible,
  };
}
