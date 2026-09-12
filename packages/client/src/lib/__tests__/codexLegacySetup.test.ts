import { describe, expect, it } from "vitest";
import {
  isLegacyCodexEnvironmentContextText,
  isLegacyCodexSetupText,
} from "@yep-anywhere/shared/transcript/codexLegacySetup";

const environment =
  "<environment_context>\n<cwd>/repo</cwd>\n</environment_context>";

describe("legacy Codex setup compatibility", () => {
  it("recognizes exact provider setup block sequences", () => {
    const plugins = "<recommended_plugins>\n- GitHub\n</recommended_plugins>";
    const agents = [
      "# AGENTS.md instructions for /repo",
      "<INSTRUCTIONS>",
      "Follow the repository rules.",
      "</INSTRUCTIONS>",
    ].join("\n");

    expect(isLegacyCodexSetupText(`${plugins}${environment}`)).toBe(true);
    expect(
      isLegacyCodexSetupText(`${plugins}\n${agents}\n${environment}`),
    ).toBe(true);
    expect(isLegacyCodexEnvironmentContextText(environment)).toBe(true);
  });

  it("does not classify loose or incomplete prefixes", () => {
    expect(isLegacyCodexSetupText("# AGENTS.md instructions\nUse rules")).toBe(
      false,
    );
    expect(isLegacyCodexSetupText("<environment_context>\n<cwd />")).toBe(
      false,
    );
    expect(
      isLegacyCodexSetupText(`${environment}\nPlease do the actual work`),
    ).toBe(false);
  });

  it("defers to server provenance and live SDK authorship", () => {
    expect(
      isLegacyCodexSetupText(environment, [
        { codexUserTurnProvenance: "paired", _source: "jsonl" },
      ]),
    ).toBe(false);
    expect(isLegacyCodexSetupText(environment, [{ _source: "sdk" }])).toBe(
      false,
    );
  });
});
