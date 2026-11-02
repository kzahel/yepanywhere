import { EventEmitter, once } from "node:events";
import { spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  attachJsonlLineReader,
  PiRpcClient,
} from "../../../src/sdk/providers/pi-rpc-client.js";

describe("attachJsonlLineReader", () => {
  function collect(): {
    stream: PassThrough;
    lines: string[];
    detach: () => void;
  } {
    const stream = new PassThrough();
    const lines: string[] = [];
    const detach = attachJsonlLineReader(stream, (line) => lines.push(line));
    return { stream, lines, detach };
  }

  it("splits on LF only and preserves U+2028/U+2029 inside payloads", () => {
    const { stream, lines } = collect();
    // A JSON string legally containing the Unicode line/paragraph separators
    // that node:readline would (wrongly) split on.
    const payload = JSON.stringify({ text: "a b c" });
    stream.write(`${payload}\n`);
    expect(lines).toEqual([payload]);
    expect(JSON.parse(lines[0]).text).toBe("a b c");
  });

  it("strips a trailing CR (tolerates CRLF input)", () => {
    const { stream, lines } = collect();
    stream.write('{"a":1}\r\n');
    expect(lines).toEqual(['{"a":1}']);
  });

  it("reassembles a record split across chunks", () => {
    const { stream, lines } = collect();
    stream.write('{"par');
    stream.write('t":true}\n');
    expect(lines).toEqual(['{"part":true}']);
  });

  it("flushes a final unterminated line on end", async () => {
    const { stream, lines } = collect();
    stream.write('{"tail":1}');
    stream.end();
    await once(stream, "end");
    expect(lines).toEqual(['{"tail":1}']);
  });
});

/** A minimal ChildProcess stand-in: stdout/stdin streams + exit events. */
function fakeProc(): {
  proc: EventEmitter & { stdout: PassThrough; stdin: PassThrough };
  written: string[];
} {
  const stdout = new PassThrough();
  const stdin = new PassThrough();
  const written: string[] = [];
  stdin.on("data", (chunk: Buffer) => written.push(chunk.toString()));
  const proc = Object.assign(new EventEmitter(), { stdout, stdin });
  return { proc: proc as never, written };
}

describe("PiRpcClient", () => {
  it("rejects a real asynchronous spawn failure without an unhandled error", async () => {
    const proc = spawn(process.execPath + "-missing-pi-fixture", []);
    const client = new PiRpcClient(proc);
    await expect(client.request({ type: "get_state" })).rejects.toThrow(
      /ENOENT/,
    );
    expect(proc.pid).toBeUndefined();
  });

  it.skipIf(process.platform === "win32")(
    "rejects an actual broken pipe and terminates its owned peer",
    async () => {
      const proc = spawn(process.execPath, [
        "-e",
        "require('node:fs').closeSync(0);console.log('READY');setInterval(()=>{},1000)",
      ]);
      try {
        await once(proc.stdout!, "data");
        const client = new PiRpcClient(proc);
        const exited = once(proc, "exit");
        await expect(client.request({ type: "get_state" })).rejects.toThrow(
          /EPIPE|closed|writable/,
        );
        await exited;
        expect(proc.exitCode !== null || proc.signalCode !== null).toBe(true);
      } finally {
        proc.kill("SIGKILL");
      }
    },
  );

  it("correlates a response to its request by id", async () => {
    const { proc, written } = fakeProc();
    const client = new PiRpcClient(proc as never);

    const pending = client.request({ type: "get_state" });
    // The client assigns an id; echo it back in a matching response.
    const sent = JSON.parse(written[0]);
    expect(sent.type).toBe("get_state");
    expect(typeof sent.id).toBe("string");

    proc.stdout.write(
      `${JSON.stringify({
        type: "response",
        id: sent.id,
        command: "get_state",
        success: true,
        data: { sessionId: "s1" },
      })}\n`,
    );

    const response = await pending;
    expect(response.success).toBe(true);
    expect((response.data as { sessionId: string }).sessionId).toBe("s1");
  });

  it("delivers agent events to subscribers but not extension requests", async () => {
    const { proc } = fakeProc();
    const client = new PiRpcClient(proc as never);

    const events: string[] = [];
    client.subscribe((event) => events.push(event.type));
    const extension = vi.fn();
    client.onExtensionRequest(extension);

    proc.stdout.write(`${JSON.stringify({ type: "agent_start" })}\n`);
    proc.stdout.write(
      `${JSON.stringify({
        type: "extension_ui_request",
        id: "x1",
        method: "confirm",
      })}\n`,
    );
    proc.stdout.write(`${JSON.stringify({ type: "agent_end" })}\n`);

    expect(events).toEqual(["agent_start", "agent_end"]);
    expect(extension).toHaveBeenCalledTimes(1);
  });

  it("rejects in-flight requests when the process exits", async () => {
    const { proc } = fakeProc();
    const client = new PiRpcClient(proc as never);

    const pending = client.request({ type: "get_state" });
    proc.emit("exit");
    await expect(pending).rejects.toThrow(/exited/);
  });
});
