import type { TranscriptDisplayObject } from "@yep-anywhere/shared";

/** Recovery transforms only interrupted work; completed objects keep identity. */
export function recoverInterruptedDisplayObjects(
  objects: TranscriptDisplayObject[],
): TranscriptDisplayObject[] {
  return objects.map((object) => {
    if (object.status === "generating") {
      return {
        ...object,
        status: "error" as const,
        error: "Fork summary interrupted by server restart",
      };
    }
    if (object.kind === "bang-command" && object.status === "running") {
      return {
        ...object,
        status: "killed" as const,
        error: "Interrupted by server restart",
      };
    }
    return object;
  });
}
