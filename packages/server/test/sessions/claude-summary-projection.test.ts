import { mkdtemp, writeFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { ClaudeSessionEntry, UrlProjectId } from "@yep-anywhere/shared";
import {
  createParseState,
  addEntryToState,
  buildSummaryFromState,
} from "../../src/sessions/claude-summary.js";
import { projectClaudeSummary } from "../../src/sessions/claude-summary-projection.js";
it("shares one parse-version summary without freezing context changes or leaking mutations", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ya-summary-projection-")),
    file = join(dir, "source.jsonl");
  try {
    await writeFile(file, "\n");
    const state = createParseState();
    const entry = (id: string, parent: string | null, type: string) =>
      ({
        type,
        uuid: id,
        parentUuid: parent,
        timestamp: `2026-01-01T00:00:0${id}.000Z`,
        message: {
          content:
            type === "user" ? "Title" : [{ type: "text", text: "answer" }],
          model: "claude-fable-5",
          usage: { input_tokens: 500 },
        },
      }) as ClaudeSessionEntry;
    addEntryToState(state, entry("1", null, "user"), 0);
    addEntryToState(state, entry("2", "1", "assistant"), 1);
    let window = 1000;
    const options = {
      filePath: file,
      stats: await stat(file),
      sessionId: "session",
      projectId: "project" as UrlProjectId,
      resolveContextWindow: () => window,
    };
    const expected = buildSummaryFromState(state, options);
    const walks = vi.spyOn(state.nodeMap, "values");
    const first = projectClaudeSummary(state, options),
      count = walks.mock.calls.length;
    expect(first).toEqual(expected);
    first!.title = "caller mutation";
    expect(projectClaudeSummary(state, options)).toEqual(expected);
    expect(walks).toHaveBeenCalledTimes(count);
    window = 2000;
    expect(projectClaudeSummary(state, options)).toEqual(
      buildSummaryFromState(state, options),
    );
    addEntryToState(state, entry("3", "2", "user"), 2);
    expect(projectClaudeSummary(state, options)).toEqual(
      buildSummaryFromState(state, options),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
