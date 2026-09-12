import { describe, expect, it } from "vitest";
import {
  formatCommandTurn,
  isCompactionLocalCommandOutput,
  isLocalCommandCaveatOnly,
  parseCommandTurn,
  parseLocalCommandStdout,
} from "@yep-anywhere/shared/transcript/commandTurn";

describe("parseCommandTurn", () => {
  it("extracts the command from a wrapped no-arg turn", () => {
    const text =
      "<command-name>/model</command-name>\n" +
      "<command-message>model</command-message>\n" +
      "<command-args></command-args>";
    expect(parseCommandTurn(text)).toEqual({ command: "/model", args: "" });
  });

  it("extracts the command and its args", () => {
    const text =
      "<command-name>/harsh-review</command-name>\n" +
      "<command-message>harsh-review</command-message>\n" +
      "<command-args>the 4 kzahel commits</command-args>";
    expect(parseCommandTurn(text)).toEqual({
      command: "/harsh-review",
      args: "the 4 kzahel commits",
    });
  });

  it("returns null for an ordinary prose turn", () => {
    expect(parseCommandTurn("please review the diff")).toBeNull();
  });

  it("returns null when the command name is empty", () => {
    expect(
      parseCommandTurn(
        "<command-name></command-name><command-args></command-args>",
      ),
    ).toBeNull();
  });

  it("trims surrounding whitespace in name and args", () => {
    const text =
      "<command-name>  /foo  </command-name><command-args>  bar baz  </command-args>";
    expect(parseCommandTurn(text)).toEqual({
      command: "/foo",
      args: "bar baz",
    });
  });

  it("accepts Claude local-command caveat wrappers around command tags", () => {
    const text =
      "<local-command-caveat>Caveat: local command.</local-command-caveat>\n" +
      "<command-name>/clear</command-name>\n" +
      "<command-message>clear</command-message>\n" +
      "<command-args></command-args>\n" +
      "<local-command-caveat>Caveat: local command.</local-command-caveat>";

    expect(parseCommandTurn(text)).toEqual({ command: "/clear", args: "" });
  });

  it("does not parse command tags quoted inside prose", () => {
    expect(
      parseCommandTurn(
        "The raw text was <command-name>/clear</command-name><command-args></command-args>.",
      ),
    ).toBeNull();
  });

  it("formats a command turn for display", () => {
    expect(formatCommandTurn({ command: "/clear", args: "" })).toBe("/clear");
    expect(formatCommandTurn({ command: "/foo", args: "bar" })).toBe(
      "/foo bar",
    );
  });

  it("recognizes standalone local-command caveats", () => {
    expect(
      isLocalCommandCaveatOnly(
        "<local-command-caveat>Caveat.</local-command-caveat>",
      ),
    ).toBe(true);
    expect(
      isLocalCommandCaveatOnly(
        "<local-command-caveat>Caveat.</local-command-caveat>\nextra",
      ),
    ).toBe(false);
  });

  it("unwraps local-command stdout and strips ANSI escapes", () => {
    expect(
      parseLocalCommandStdout(
        "<local-command-stdout>\u001b[2mCompacted (ctrl+o)\u001b[22m</local-command-stdout>",
      ),
    ).toBe("Compacted (ctrl+o)");
    expect(parseLocalCommandStdout("ordinary text")).toBeNull();
  });

  it("recognizes compact stdout acknowledgements", () => {
    expect(isCompactionLocalCommandOutput("Compacted")).toBe(true);
    expect(isCompactionLocalCommandOutput("Compacted (ctrl+o)")).toBe(true);
    expect(isCompactionLocalCommandOutput("Set model to Opus")).toBe(false);
  });
});
