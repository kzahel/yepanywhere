import { describe, expect, it } from "vitest";
import {
  detectNestedHarnessLaunch,
  detectScopedNestedHarnessLaunch,
} from "../src/nested-harness-launch.js";

const CHILD = "28dad9a6-9c40-4d90-af7e-84d0ed4db9a4";

describe("detectNestedHarnessLaunch", () => {
  it("reads the resumed session from a backgrounded launch", () => {
    // Recorded shape from a real launcher transcript.
    expect(
      detectNestedHarnessLaunch(
        `claude --resume ${CHILD} --model claude-opus-5 --permission-mode acceptEdits --allowedTools Read Edit Write Bash Grep Glob --print --output-format stream-json --verbose < tasks/opus-v2-intake-tests.md`,
      ),
    ).toEqual({ harness: "claude", sessionId: CHILD });
  });

  it("accepts the short and attached spellings of the session flags", () => {
    for (const command of [
      `claude -p hi -r ${CHILD}`,
      `claude --resume=${CHILD} --print`,
      `claude --session-id ${CHILD} --print`,
    ]) {
      expect(detectNestedHarnessLaunch(command)).toMatchObject({
        sessionId: CHILD,
      });
    }
  });

  it("normalizes an uppercase session id", () => {
    expect(
      detectNestedHarnessLaunch(`claude --resume ${CHILD.toUpperCase()} -p x`),
    ).toEqual({ harness: "claude", sessionId: CHILD });
  });

  it("reports a fresh non-interactive launch with no session to link", () => {
    expect(
      detectNestedHarnessLaunch(
        "claude --model claude-opus-5 --print < tasks/opus-v2-stage1-contract.md",
      ),
    ).toEqual({ harness: "claude" });
  });

  it("finds the harness behind an environment prefix or wrapper", () => {
    expect(
      detectNestedHarnessLaunch(
        `nohup env FOO=1 claude --resume ${CHILD} -p x`,
      ),
    ).toMatchObject({ sessionId: CHILD });
    expect(
      detectNestedHarnessLaunch(`/home/graehl/.claude/local/claude -p hi`),
    ).toEqual({ harness: "claude" });
  });

  it("reports the directory an earlier cd moved to", () => {
    expect(
      detectNestedHarnessLaunch(
        `cd /local/graehl/other && claude --resume ${CHILD} -p go`,
      ),
    ).toEqual({
      harness: "claude",
      sessionId: CHILD,
      workingDirectory: "/local/graehl/other",
    });
  });

  it("ignores an interactive or informational invocation", () => {
    expect(detectNestedHarnessLaunch("claude --version")).toBeUndefined();
    expect(
      detectNestedHarnessLaunch("claude --help | rg -n 'resume|print'"),
    ).toBeUndefined();
    expect(detectNestedHarnessLaunch("claude")).toBeUndefined();
  });

  it("ignores a --resume whose value is not a session id", () => {
    expect(detectNestedHarnessLaunch("claude --resume")).toBeUndefined();
    expect(detectNestedHarnessLaunch("claude --resume latest")).toBeUndefined();
  });

  it("ignores the harness appearing as an argument, path, or match", () => {
    for (const command of [
      "command -v claude || true; node -p 'require.resolve(\"x\")'",
      "which claude; claude --version 2>/dev/null",
      "rg -n 'claude --resume' packages/server/src --print",
      "git show -s --format='%H' 842dd0da; stat --printf='%y' packages/server/src/sdk/providers/claude-gateway.ts",
    ]) {
      expect(detectNestedHarnessLaunch(command)).toBeUndefined();
    }
  });

  it("does not read a command quoted inside a heredoc body", () => {
    // Observed false positive: a commit message describing the very feature.
    const command = [
      "git commit -q -F - <<'EOF'",
      "Link a backgrounded launch to its session",
      "",
      `A session started by claude --resume ${CHILD} --print is shown nowhere.`,
      "EOF",
      "git --no-pager log --oneline -1",
    ].join("\n");
    expect(detectNestedHarnessLaunch(command)).toBeUndefined();
  });

  it("still reads a launch after a heredoc closes", () => {
    const command = [
      "cat > task.md <<-EOF",
      "\tdo the thing",
      "\tEOF",
      `claude --resume ${CHILD} --print < task.md`,
    ].join("\n");
    expect(detectNestedHarnessLaunch(command)).toMatchObject({
      sessionId: CHILD,
    });
  });

  it("keeps a descriptor duplication out of the argument scan", () => {
    expect(
      detectNestedHarnessLaunch(
        `claude -p go 2>&1 --resume ${CHILD} > /tmp/out.log`,
      ),
    ).toMatchObject({ sessionId: CHILD });
  });

  it("joins a line continuation into one invocation", () => {
    expect(
      detectNestedHarnessLaunch(`claude --print \\\n  --resume ${CHILD}`),
    ).toMatchObject({ sessionId: CHILD });
  });

  it("does not descend into a quoted shell argument", () => {
    expect(
      detectNestedHarnessLaunch(`bash -lc 'claude --resume ${CHILD} --print'`),
    ).toBeUndefined();
  });
});

describe("durable scoped harness selection", () => {
  it("selects a single explicit directory and named inherited-store invocation", () => {
    for (const command of [
      `cd '/owned/project space' && claude --session-id ${CHILD} --print go`,
      `unset CLAUDECODE; cd '/owned/project space' && env CLAUDECODE= /opt/claude --resume=${CHILD} --print go`,
    ])
      expect(detectScopedNestedHarnessLaunch(command)).toMatchObject({
        sessionId: CHILD,
        workingDirectory: "/owned/project space",
      });
  });
  it("withholds shell branching, store overrides, forks, expansion and unnamed invocations", () => {
    for (const command of [
      `claude --session-id ${CHILD} -p go`,
      `cd /owned && claude -p go # --session-id ${CHILD}`,
      `cd /owned && claude -pc --session-id ${CHILD}`,
      `cd /owned && claude -pw --session-id ${CHILD}`,
      `cd /owned && claude --session-id ${CHILD} -p go &`,
      `cd /owned && claude --session-id ${CHILD} --help`,
      `cd /owned && claude --session-id ${CHILD} --version`,
      `cd /owned && claude --session-id ${CHILD} --no-session-persistence -p go`,
      `cd /owned; claude --session-id ${CHILD} -p go`,
      `cd /owned || claude --session-id ${CHILD} -p go`,
      `cd /owned && claude --session-id ${CHILD} -p go | cat`,
      `cd /owned && HOME=/foreign claude --session-id ${CHILD} -p go`,
      `cd /owned && env CLAUDE_CONFIG_DIR=/foreign claude --session-id ${CHILD} -p go`,
      `cd /owned && claude --resume ${CHILD} --fork-session -p go`,
      `cd /owned && claude --session-id ${CHILD} --settings /foreign -p go`,
      `cd /owned && claude --session-id ${CHILD} --worktree -p go`,
      `cd /owned && claude --session-id ${CHILD} --resume ${CHILD} -p go`,
      'cd "$ROOT" && claude --resume ' + CHILD + " -p go",
      `cd /owned && claude --session-id ${CHILD} -p \`hostname\``,
      `cd /owned && claude -p go`,
      `cat <<EOF\ncd /owned && claude --session-id ${CHILD} -p go\nEOF`,
      `echo 'cd /owned && claude --session-id ${CHILD} -p go'`,
    ])
      expect(detectScopedNestedHarnessLaunch(command), command).toBeUndefined();
  });
});
