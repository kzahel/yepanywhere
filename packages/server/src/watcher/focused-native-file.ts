import { dirname, join } from "node:path";
import type { NativeSessionRef } from "@yep-anywhere/shared";

/** Native families whose stored YA identities get a focused session watch. */
export const FOCUSED_NATIVE_FAMILIES: readonly string[] = [
  "claude",
  "codex",
  "opencode",
  "pi",
  "grok",
  "gemini",
];

/** What a focused watch follows for a native session file. */
export const focusedNativeFile = (
  filePath: string,
  native: Pick<NativeSessionRef, "family">,
) => ({
  filePath,
  provider: native.family,
  ...(native.family === "opencode" && filePath.endsWith("opencode.db")
    ? { additionalFilePaths: [`${filePath}-wal`] }
    : native.family === "grok"
      ? {
          additionalFilePaths: [
            "chat_history.jsonl",
            "events.jsonl",
            "updates.jsonl",
          ].map((name) => join(dirname(filePath), name)),
        }
      : {}),
});
