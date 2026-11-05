import { describe, expect, it } from "vitest";
import { unwrapCodexCommandExecutionShell } from "../codex-tool-correlation.js";

describe("literal Codex commandExecution shell envelope", () => {
  it.each([
    ["/bin/bash -lc \"printf '%s' 'café path'\"", "printf '%s' 'café path'"],
    ["bash -c 'printf \"$HOME\"'", 'printf "$HOME"'],
    ["/bin/sh -c \"printf '\\$HOME'\"", "printf '$HOME'"],
    ["/bin/sh -c \"printf '\\q'\"", "printf '\\q'"],
    ['/bin/zsh -lc "printf \\"quoted\\""', 'printf "quoted"'],
    ["/bin/bash \\\n-lc 'echo done'", "echo done"],
    ["/bin/sh -c ''", ""],
    ["/bin/sh -c \"bash -lc 'echo done'\"", "bash -lc 'echo done'"],
  ])("decodes one literal wrapper: %s", (source, expected) => {
    expect(unwrapCodexCommandExecutionShell(source)).toBe(expected);
  });

  it.each([
    "/bin/bash -lc 'echo done' extra",
    "/bin/bash -lc 'echo done' ''",
    "/bin/bash -lc 'echo done'; echo extra",
    "/bin/bash -lc 'echo done' > output",
    "env /bin/bash -lc 'echo done'",
    '/bin/bash -lc "echo $HOME"',
    '/bin/bash -lc "echo $(pwd)"',
    '/bin/bash -lc "echo `pwd`"',
    "/bin/bash -lc echo*",
    "/bin/bash -lc 'echo done' # comment",
    "/bin/bash -lc 'echo done'\necho extra",
    "/bin/bash -lc 'unclosed",
    "/bin/bash -lc trailing\\",
    "/bin/fish -c 'echo done'",
    "custom/bash -c 'echo done'",
    "/bin/bash -cl 'echo done'",
    "/bin/bash -lc 'echo\0done'",
  ])("leaves expansion or non-envelope syntax unknown: %s", (source) => {
    expect(unwrapCodexCommandExecutionShell(source)).toBeNull();
  });
});
