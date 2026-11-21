import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { expect, it, vi } from "vitest";
import { CodexAppServerClient } from "../../../src/sdk/providers/codex-app-server-client.js";
import { log } from "../../../src/sdk/providers/codex-log.js";

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: vi.fn(),
}));

it("preserves multibyte text split across Codex stdout and stderr chunks", async () => {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = Object.assign(new EventEmitter(), { stdout, stderr });
  vi.mocked(spawn).mockReturnValueOnce(child as unknown as ChildProcess);

  const client = new CodexAppServerClient("unused-codex", ".", {});
  const observer = vi.fn();
  const debug = vi.spyOn(log, "debug").mockImplementation(() => {});
  client.setNotificationObserver(observer);
  try {
    const connected = client.connect();
    child.emit("spawn");
    await connected;

    const notification = {
      method: "item/agentMessage/delta",
      params: { delta: "a😀\u2028b" },
    };
    const bytes = Buffer.from(`${JSON.stringify(notification)}\n`);
    const split = bytes.indexOf(Buffer.from("😀")) + 1;

    stdout.write(bytes.subarray(0, split));
    expect(observer).not.toHaveBeenCalled();
    stdout.write(bytes.subarray(split));

    await vi.waitFor(() =>
      expect(observer).toHaveBeenCalledExactlyOnceWith(notification),
    );

    const errorText = Buffer.from("😀 diagnostic\n");
    stderr.write(errorText.subarray(0, 1));
    stderr.write(errorText.subarray(1));
    await vi.waitFor(() =>
      expect(debug).toHaveBeenCalledExactlyOnceWith(
        { stderr: "😀 diagnostic" },
        "codex app-server stderr",
      ),
    );
  } finally {
    stdout.destroy();
    stderr.destroy();
    debug.mockRestore();
    await client.close();
  }
});
