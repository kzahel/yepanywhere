import { describe, expect, it } from "vitest";
import { projectTranscriptMessages } from "../src/transcript/messageProjection.js";

describe("Claude session_writes_lost", () => {
  it("projects as a warning naming what was lost and why", () => {
    const [item] = projectTranscriptMessages([
      {
        type: "system",
        subtype: "session_writes_lost",
        uuid: "lost-1",
        session_id: "s1",
        error_code: "ENOSPC",
        lost: ["transcript", "global_config"],
        transcript_session_ids: ["s1"],
      },
    ] as never);

    expect(item).toMatchObject({ type: "system", subtype: "warning" });
    expect((item as { content: string }).content).toBe(
      "Claude Code could not write to disk: the disk was full. Part of the session transcript was not saved, so resuming may miss part of the conversation. Settings changes to ~/.claude.json were not saved.",
    );
  });
});
