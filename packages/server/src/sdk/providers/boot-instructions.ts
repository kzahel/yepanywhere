import { readFileSync, statSync } from "node:fs";
import {
  BOOT_INSTRUCTIONS_MAX_CHARACTERS,
  type BootInstructions,
  type BootInstructionsLaunch,
} from "../../sessions/session-boot-instructions.js";

/**
 * The text that replaces a session's user-level instructions. A path is read
 * at every launch, so a resume sees the file as it is now; a missing,
 * non-regular or oversized file fails the launch rather than falling back.
 */
export function readBootInstructionText(source: BootInstructions): string {
  if ("text" in source) return source.text;
  let text: string;
  try {
    if (!statSync(source.path).isFile()) throw new Error("not a regular file");
    text = readFileSync(source.path, "utf8");
  } catch (error) {
    throw new Error(
      `Boot instructions file unreadable: ${source.path} (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  if (text.length > BOOT_INSTRUCTIONS_MAX_CHARACTERS)
    throw new Error(
      `Boot instructions file too long: ${source.path} exceeds ${BOOT_INSTRUCTIONS_MAX_CHARACTERS} characters`,
    );
  return text;
}

/**
 * Instructions a launch appends to the provider's system prompt: the
 * server-wide instructions, then the session's boot text.
 */
export function appendBootInstructions(launch: {
  globalInstructions?: string;
  bootInstructions?: BootInstructionsLaunch;
}): string | undefined {
  const boot = launch.bootInstructions
    ? readBootInstructionText(launch.bootInstructions.source)
    : undefined;
  return (
    [launch.globalInstructions, boot].filter(Boolean).join("\n\n") || undefined
  );
}
