import { z } from "zod";
import { parseShellToolOutput } from "@yep-anywhere/shared/transcript/shellToolOutput";
export const BashOutputSchema = z
  .object({
    stdout: z.string().optional(),
    stderr: z.string().optional(),
    interrupted: z.boolean().default(false),
    isImage: z.boolean().default(false),
    backgroundTaskId: z.string().optional(),
    exitCode: z.number().optional(),
    durationSeconds: z.number().optional(),
  })
  .refine(
    (value) =>
      value.stdout !== undefined ||
      value.stderr !== undefined ||
      value.backgroundTaskId !== undefined,
  )
  .transform((value) => ({
    ...value,
    stdout: value.stdout ?? "",
    stderr: value.stderr ?? "",
  }));
export type BashOutput = z.output<typeof BashOutputSchema>;
export function normalizeBashResult(
  result: unknown,
  isError: boolean,
): BashOutput {
  if (!result) {
    return { stdout: "", stderr: "", interrupted: false, isImage: false };
  }
  if (typeof result === "string") {
    const parsed = parseShellToolOutput(result, {
      bareExitCodeIsEnvelope: isError,
    });
    const output = parsed.hasEnvelope ? parsed.output : result;
    // A recognized provider envelope carries combined command output. A raw
    // error string without that metadata remains stderr.
    return {
      stdout: !isError || parsed.hasEnvelope ? output : "",
      stderr: isError && !parsed.hasEnvelope ? output : "",
      interrupted: false,
      isImage: false,
      ...(parsed.exitCode !== undefined ? { exitCode: parsed.exitCode } : {}),
    };
  }
  const checked = BashOutputSchema.safeParse(result);
  return checked.success
    ? checked.data
    : { stdout: "", stderr: "", interrupted: false, isImage: false };
}
