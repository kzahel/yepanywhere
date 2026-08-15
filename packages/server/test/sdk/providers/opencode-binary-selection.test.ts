/**
 * Unit tests for selectOpenCodeBinary().
 *
 * Regression cover for OpenCode being undetectable on Windows: `where` prints one
 * line per PATHEXT match, so trimming the whole stdout produced a multi-line string
 * that existsSync() always rejected and findOpenCodePath() returned null. Sessions
 * still showed up (the reader parses OpenCode's storage directly and needs no
 * binary), but none of them could be started.
 */

import { describe, expect, it } from "vitest";

import { selectOpenCodeBinary } from "../../../src/sdk/providers/opencode-binary-selection.js";

// Verbatim `where opencode` output on Windows with opencode installed via npm.
const WINDOWS_WHERE_OUTPUT =
  "C:\\nvm4w\\nodejs\\opencode\r\nC:\\nvm4w\\nodejs\\opencode.cmd\r\n";

const NPM_SHIM = "C:\\nvm4w\\nodejs\\opencode";
const NPM_CMD_SHIM = "C:\\nvm4w\\nodejs\\opencode.cmd";
const PACKAGED_EXE =
  "C:\\nvm4w\\nodejs\\node_modules\\opencode-ai\\bin\\opencode.exe";

/** Model a filesystem where only the listed paths exist. */
function fakeFs(...existing: string[]) {
  const present = new Set(existing);
  return (path: string) => present.has(path);
}

describe("selectOpenCodeBinary", () => {
  it("resolves the packaged .exe from multi-line Windows `where` output", () => {
    const selected = selectOpenCodeBinary(
      WINDOWS_WHERE_OUTPUT,
      "win32",
      fakeFs(NPM_SHIM, NPM_CMD_SHIM, PACKAGED_EXE),
    );

    expect(selected).toBe(PACKAGED_EXE);
  });

  it("prefers a .exe that `where` reported directly", () => {
    const standaloneExe = "C:\\Users\\me\\.opencode\\bin\\opencode.exe";

    const selected = selectOpenCodeBinary(
      `${NPM_SHIM}\r\n${standaloneExe}\r\n`,
      "win32",
      fakeFs(NPM_SHIM, standaloneExe),
    );

    expect(selected).toBe(standaloneExe);
  });

  it("falls back to the first PATH hit when no .exe can be resolved", () => {
    // A shim `spawn(..., { shell: true })` can still run, so `opencode serve`
    // works even though `execFile`-based model discovery will not.
    const selected = selectOpenCodeBinary(
      WINDOWS_WHERE_OUTPUT,
      "win32",
      fakeFs(NPM_SHIM, NPM_CMD_SHIM),
    );

    expect(selected).toBe(NPM_SHIM);
  });

  it("returns null when nothing reported on PATH exists", () => {
    const selected = selectOpenCodeBinary(
      WINDOWS_WHERE_OUTPUT,
      "win32",
      fakeFs(),
    );

    expect(selected).toBeNull();
  });

  it("returns null for empty `where` output", () => {
    expect(selectOpenCodeBinary("\r\n", "win32", fakeFs())).toBeNull();
  });

  it("returns the single `which` hit on posix", () => {
    const selected = selectOpenCodeBinary(
      "/usr/local/bin/opencode\n",
      "linux",
      fakeFs("/usr/local/bin/opencode"),
    );

    expect(selected).toBe("/usr/local/bin/opencode");
  });

  it("takes the first existing hit from multi-line `which -a` output on posix", () => {
    const selected = selectOpenCodeBinary(
      "/opt/homebrew/bin/opencode\n/usr/local/bin/opencode\n",
      "darwin",
      fakeFs("/opt/homebrew/bin/opencode", "/usr/local/bin/opencode"),
    );

    expect(selected).toBe("/opt/homebrew/bin/opencode");
  });

  it("skips reported paths that no longer exist", () => {
    const selected = selectOpenCodeBinary(
      "/stale/bin/opencode\n/usr/local/bin/opencode\n",
      "linux",
      fakeFs("/usr/local/bin/opencode"),
    );

    expect(selected).toBe("/usr/local/bin/opencode");
  });
});
