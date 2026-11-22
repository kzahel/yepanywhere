import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  antigravityCliVersionRefusal,
  antigravityVersionRefusal,
  readAgyVersion,
} from "../../../src/sdk/providers/antigravity-version.js";

const refusal = (installed: string) =>
  `Antigravity requires agy 1.5.13 or later; the installed runtime ${installed}. Run \`agy update\`, or install the agy CLI.`;

describe("Antigravity version floor", () => {
  it.each([
    ["1.5.13", undefined],
    ["1.5.14", undefined],
    ["1.6.0-rc.1", undefined],
    ["1.5.13+build.7", undefined],
    ["2.0.0", undefined],
    ["1.5.12", refusal("reports version 1.5.12")],
    // A prerelease precedes the release it names.
    ["1.5.13-rc.1", refusal("reports version 1.5.13-rc.1")],
    ["1.4.5", refusal("reports version 1.4.5")],
    [
      "version unknown; Node.js 24.22.1",
      refusal(
        'reports an unrecognized version "version unknown; Node.js 24.22.1"',
      ),
    ],
    ["agy 1.5.13", refusal('reports an unrecognized version "agy 1.5.13"')],
    ["1.6.0-0", undefined],
    // Malformed versions are unrecognized, whatever their numbers.
    ["01.5.13", refusal('reports an unrecognized version "01.5.13"')],
    ["1.5.13+.", refusal('reports an unrecognized version "1.5.13+."')],
    ["1.6.0-..", refusal('reports an unrecognized version "1.6.0-.."')],
    ["1.6.0-01", refusal('reports an unrecognized version "1.6.0-01"')],
    ["", refusal("did not report a version")],
    [undefined, refusal("did not report a version")],
    [15, refusal("did not report a version")],
  ])("ACP version %j", (reported, expected) => {
    expect(antigravityVersionRefusal(reported)).toBe(expected);
  });

  it.each([
    ["1.4.12\n", refusal("reports version 1.4.12")],
    ["1.5.13-rc.1\n", refusal("reports version 1.5.13-rc.1")],
    ["1.5.13\n", undefined],
    // Unreadable --version output keeps the native failure.
    ["v24.22.1\n", undefined],
    ["Node.js 1.4.12\n", undefined],
    ["01.4.12\n", undefined],
  ])("agy --version output %j", (output, expected) => {
    expect(antigravityCliVersionRefusal(output)).toBe(expected);
  });
});

describe.skipIf(process.platform === "win32")("agy --version probe", () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "ya-agy-version-"));
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  });

  async function script(name: string, body: string) {
    const path = join(directory, name);
    await writeFile(path, `#!${process.execPath}\n${body}\n`);
    await chmod(path, 0o755);
    return path;
  }

  it("runs without YA credentials", async () => {
    vi.stubEnv("AUTH_COOKIE_SECRET", "COOKIE_CANARY");
    vi.stubEnv("AGENT_YA_V0_AUTHORIZATION", "V0_CANARY");
    const agy = await script(
      "agy",
      "console.log(JSON.stringify(process.env).includes('CANARY') ? 'leaked' : '1.5.13');",
    );
    expect(await readAgyVersion(agy)).toBe("1.5.13");
  });

  // The wrapper prints a version and starts a helper in its process group.
  // On deadline and cancel the leader is still alive, so the group is
  // signalled then; on completion the leader exits first and the group is
  // signalled as its exit is handled, whether or not the helper holds stdout.
  it.each([
    ["deadline", "waits for it", "holds stdout", undefined],
    ["cancel", "waits for it", "holds stdout", undefined],
    ["completion", "exits", "holds stdout", "1.5.13"],
    ["completion", "exits", "closes its streams", "1.5.13"],
  ] as const)(
    "ends a same-group helper on %s when the leader %s (helper %s)",
    async (ending, leader, streams, expected) => {
      const marker = join(directory, "helper.pid");
      const redirect = streams === "holds stdout" ? "" : " >/dev/null 2>&1";
      const last = leader === "exits" ? "exit 0" : "wait";
      const agy = join(directory, "agy");
      await writeFile(
        agy,
        `#!/bin/sh\necho 1.5.13\nsleep 60${redirect} &\necho $! > ${JSON.stringify(marker)}\n${last}\n`,
      );
      await chmod(agy, 0o755);
      const controller = new AbortController();
      const probe = readAgyVersion(
        agy,
        controller.signal,
        ending === "deadline" ? 1_000 : 60_000,
      );
      if (ending === "cancel") {
        await vi.waitFor(() => readFile(marker, "utf8"), { timeout: 5_000 });
        controller.abort();
      }
      expect(await probe).toBe(expected);
      const helper = Number(await readFile(marker, "utf8"));
      await vi.waitFor(() => expect(() => process.kill(helper, 0)).toThrow(), {
        timeout: 2_000,
      });
    },
  );

  it("sends no group signal after the leader's exit has been handled", async () => {
    // The helper starts its own session and holds stdout past the deadline.
    const marker = join(directory, "helper.pid");
    const agy = await script(
      "agy",
      `const fs = require('node:fs');
fs.writeSync(1, '1.5.13\\n');
const helper = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: ['ignore', 'inherit', 'ignore'] });
fs.writeFileSync(${JSON.stringify(marker)}, String(helper.pid));
process.exit(0);`,
    );
    const kill = vi.spyOn(process, "kill");
    let helper = 0;
    try {
      expect(await readAgyVersion(agy, undefined, 1_000)).toBeUndefined();
      helper = Number(await readFile(marker, "utf8"));
      // Only the signal sent while handling the leader's exit.
      expect(
        kill.mock.calls.filter(([pid]) => typeof pid === "number" && pid < 0),
      ).toHaveLength(1);
      expect(() => process.kill(helper, 0)).not.toThrow();
    } finally {
      kill.mockRestore();
      if (helper) process.kill(helper, "SIGKILL");
    }
  });

  it.each(["deadline", "cancel"] as const)(
    "kills and reaps a probe that ignores SIGTERM on %s",
    async (ending) => {
      const marker = join(directory, "pid");
      const agy = await script(
        "agy",
        `require('node:fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid));
process.on('SIGTERM', () => {});
setInterval(() => {}, 1000);`,
      );
      const controller = new AbortController();
      const started = Date.now();
      const probe = readAgyVersion(
        agy,
        controller.signal,
        ending === "deadline" ? 1_500 : 60_000,
      );
      if (ending === "cancel") {
        await vi.waitFor(() => readFile(marker, "utf8"), { timeout: 5_000 });
        controller.abort();
      }
      expect(await probe).toBeUndefined();
      expect(Date.now() - started).toBeLessThan(5_000);
      const pid = Number(await readFile(marker, "utf8"));
      expect(() => process.kill(pid, 0)).toThrow();
    },
  );
});
