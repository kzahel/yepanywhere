import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  agentApiBootstrapInstructions,
  stripAgentApiBootstrapPrefix,
} from "../src/agent-api-bootstrap.js";

const legacy = readFileSync(
  new URL("./fixtures/agent-api-bootstrap-legacy.txt", import.meta.url),
  "utf8",
).trimEnd();
describe("exact historical API bootstrap presentation", () => {
  it("preserves actual user prose, whitespace and headings after the old injected prefix", () => {
    const task =
      "  Fix this.\n\n[Yep Anywhere API]\nThis heading is part of my request.  ";
    expect(stripAgentApiBootstrapPrefix(`${legacy}\n\n${task}`)).toBe(task);
    expect(
      stripAgentApiBootstrapPrefix(
        `${agentApiBootstrapInstructions(false)}\n\n${task}`,
      ),
    ).toBe(task);
  });
  it("keeps partial, quoted and user-authored lookalikes intact", () => {
    for (const text of [
      "[Yep Anywhere API]\nMy own request",
      legacy,
      `${legacy}\nMy own request`,
      `Please inspect this:\n\n${legacy}\n\nDo not remove it.`,
      legacy.replace("Inspect your owning", "Inspect my owning") + "\n\nTask",
    ]) {
      expect(stripAgentApiBootstrapPrefix(text)).toBe(text);
    }
  });
});
