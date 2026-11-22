import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toUrlProjectId } from "@yep-anywhere/shared";
import { AntigravityProvider } from "../../../src/sdk/providers/antigravity.js";
import { MAX_PENDING_PERMISSIONS } from "../../../src/sdk/providers/antigravity-permission-requests.js";
import { AntigravityRuntime } from "../../../src/sdk/providers/antigravity-runtime.js";
import type { AgentSession } from "../../../src/sdk/providers/types.js";
import type { CanUseTool, SDKMessage } from "../../../src/sdk/types.js";
import { Process } from "../../../src/supervisor/Process.js";
import { writeAntigravitySummaries } from "../../utils/antigravity-store.js";

/**
 * A controlled `agy` for permission requests. `agy` 1.5.13 and 1.5.14 send
 * `session/request_permission` with string JSON-RPC IDs. The peer logs every
 * method it receives and every answer to its own requests
 * (`answer <id as JSON> <optionId | cancelled | error code>`), and chooses
 * its behavior by prompt text.
 */
const nativeId = "11111111-1111-4111-8111-111111111111";
const childId = "22222222-2222-4222-8222-222222222222";
const peer = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const id = '${nativeId}';
const child = '${childId}';
const log = line => fs.appendFileSync(process.env.AGY_TEST_LOG, line + '\\n');
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
const reply = (rid, result) => send({ jsonrpc: '2.0', id: rid, result });
const update = text => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: id, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } });
const ask = (rid, sessionId = id) => send({ jsonrpc: '2.0', id: rid, method: 'session/request_permission', params: { sessionId,
  toolCall: { toolCallId: 'tool-' + rid, title: 'Write file ' + rid, kind: 'edit' },
  options: [{ optionId: 'native-allow', name: 'Allow', kind: 'allow_once' }, { optionId: 'native-deny', name: 'Deny', kind: 'reject_once' }] } });
let prompt, text, cancelled = false, many = 0;
const answers = new Map();
const finish = stopReason => { const p = prompt; prompt = undefined; if (p !== undefined) reply(p, { stopReason }); };
// A cancelled prompt returns only once agy has both the cancel and the answer.
const settleCancel = rid => { if (cancelled && answers.has(rid)) finish('cancelled'); };
process.on('SIGTERM', () => {
  if (process.env.AGY_TEST_ASK_ON_SIGTERM) ask('on-sigterm');
  setTimeout(() => process.exit(0), 50);
});
readline.createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line);
  if (!('method' in m)) {
    const outcome = m.result ? (m.result.outcome?.optionId ?? m.result.outcome?.outcome) : 'error ' + m.error?.code;
    log('answer ' + JSON.stringify(m.id) + ' ' + outcome);
    answers.set(m.id, outcome);
    if (text === 'hold' || text === 'child' || text === 'reuse-a') return settleCancel('1');
    if (text === 'reuse-b' || text === 'dup' || text === 'approve') return setTimeout(() => finish('end_turn'), 100);
    if (text === 'many') return ++many < 20 ? ask('m' + (many + 1)) : (update('MANY_DONE'), finish('end_turn'));
    return;
  }
  log(m.method);
  if (m.method === 'initialize') {
    if (process.env.AGY_TEST_DECOYS) {
      // Neither is the answer to YA's numeric request: method present, string ID.
      send({ jsonrpc: '2.0', id: m.id, method: null, result: { protocolVersion: 1, agentInfo: { version: '1.4.5' } } });
      reply(String(m.id), { protocolVersion: 1, agentInfo: { version: '1.4.5' } });
    }
    return reply(m.id, { protocolVersion: 1, agentInfo: { version: '1.5.13' } });
  }
  if (m.method === 'session/new') {
    fs.mkdirSync(path.join(process.env.GEMINI_HOME, 'antigravity-cli', 'conversations'), { recursive: true });
    return reply(m.id, { sessionId: id, models: { currentModelId: 'native-default', availableModels: [] } });
  }
  if (m.method === 'session/prompt') {
    prompt = m.id; text = m.params.prompt[0].text; cancelled = false; answers.clear();
    if (text === 'hold' || text === 'reuse-a' || text === 'reuse-b' || text === 'approve') return ask('1');
    if (text === 'child') { ask('1'); return ask('2', child); }
    if (text === 'dup') { ask('1'); return ask('1'); }
    if (text === 'many') return ask('m1');
    if (text === 'late') return update('Waiting');
    if (text === 'exit') {
      for (let i = 1; i <= 100; i++) ask('x' + i);
      return process.stdout.write('', () => process.exit(0));
    }
    if (text === 'malformed') {
      send({ jsonrpc: '2.0', id: 'u1', method: 'session/update', params: { sessionId: id, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'NOT_AN_UPDATE' } } } });
      send({ id: 'v1', method: 'session/request_permission', params: {} });
      send({ jsonrpc: '2.0', id: 'p1', method: 'session/request_permission', params: { sessionId: id } });
      send({ jsonrpc: '2.0', id: null, method: 5 });
      return setTimeout(() => { update('MALFORMED_DONE'); finish('end_turn'); }, 100);
    }
    update('Hello');
    return finish('end_turn');
  }
  if (m.method === 'session/cancel') {
    cancelled = true;
    // As if the request had been raised before the cancel but its frame
    // reached YA only after it.
    if (text === 'late') { ask('1'); return finish('cancelled'); }
    if (text === 'hold' || text === 'child' || text === 'reuse-a') return settleCancel('1');
    return finish('cancelled');
  }
  if ('id' in m) reply(m.id, {});
});
`;

setFlagsFromString("--expose-gc");
const gc = runInNewContext("gc") as () => void;

describe("Antigravity permission requests", () => {
  let directory: string;
  let log: string;
  beforeEach(async () => {
    directory = await realpath(
      await mkdtemp(join(tmpdir(), "ya-agy-permission-")),
    );
    await mkdir(join(directory, "bin"));
    const executable = join(directory, "bin", "agy");
    log = join(directory, "methods.log");
    await writeFile(executable, peer);
    await chmod(executable, 0o755);
    const home = join(directory, "home");
    await writeAntigravitySummaries(join(home, ".gemini", "antigravity-cli"), [
      { id: nativeId, cwd: directory },
    ]);
    vi.stubEnv("HOME", home);
    vi.stubEnv("GEMINI_HOME", join(home, ".gemini"));
    vi.stubEnv("ANTIGRAVITY_ACP_PATH", executable);
    vi.stubEnv("AGY_TEST_LOG", log);
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  });

  const lines = async () => (await readFile(log, "utf8")).trim().split("\n");
  const answers = async () =>
    (await lines()).filter((line) => line.startsWith("answer "));

  // next() rather than for-await: breaking a for-await would end the session.
  async function untilResult(session: AgentSession) {
    const messages: SDKMessage[] = [];
    for (;;) {
      const { value, done } = await session.iterator.next();
      if (done) return messages;
      messages.push(value);
      if (value.type === "result" || value.type === "error") return messages;
    }
  }

  /** A YA Process over the provider session, answering through its own UI path. */
  async function owned(
    text: string,
    onAsk?: (approval: Parameters<CanUseTool>[2]) => void,
  ) {
    const holder: { proc?: Process } = {};
    const session = await new AntigravityProvider().startSession({
      cwd: directory,
      permissionMode: "default",
      initialMessage: { text, uuid: randomUUID() },
      onToolApproval: (tool, input, options) => {
        onAsk?.(options);
        return holder.proc!.handleToolApproval(tool, input, options);
      },
    });
    const proc = new Process(session.iterator, {
      sessionId: randomUUID(),
      projectPath: directory,
      projectId: toUrlProjectId(directory),
      provider: "antigravity",
      permissionMode: "default",
      queue: session.queue,
      abortFn: session.abort,
      interruptFn: session.interrupt,
      isProcessAlive: session.isProcessAlive,
      deferredDelivery: {
        joinWindowSeconds: 0,
        composeAnchors: false,
        turnTimestamps: "off",
      },
      idleTimeoutMs: 60_000,
    });
    holder.proc = proc;
    const until = (test: () => boolean) =>
      new Promise<void>((resolve, reject) => {
        const check = () => {
          if (proc.state.type === "terminated") {
            off();
            reject(new Error(`terminated: ${JSON.stringify(proc.state)}`));
          } else if (test()) {
            off();
            resolve();
          }
        };
        const off = proc.subscribe(check);
        check();
      });
    return { proc, session, until };
  }

  it("answers agy's string-ID request through Process, echoing the ID", async () => {
    const { proc, session, until } = await owned("approve");
    try {
      await until(() => proc.state.type === "waiting-input");
      const request = proc.getPendingInputRequest()!;
      expect(request.toolName).toBe("Write file 1");
      expect(proc.respondToInput(request.id, "approve")).toBe(true);
      await until(() => proc.state.type === "idle");
      expect(await answers()).toEqual(['answer "1" native-allow']);
    } finally {
      await session.abort();
    }
  });

  it("Stop withdraws an open prompt; a late answer is refused while deferred input waits", async () => {
    let signal: AbortSignal | undefined;
    const { proc, session, until } = await owned("hold", (options) => {
      signal = options.signal;
    });
    try {
      await until(() => proc.state.type === "waiting-input");
      const stale = proc.getPendingInputRequest()!.id;
      await proc.interrupt();
      await until(() => proc.state.type === "idle");
      expect(signal?.aborted).toBe(true);
      // Exactly one terminal answer, the cancellation; the prompt was
      // released only after agy had both the cancel and that answer.
      expect(await answers()).toEqual(['answer "1" cancelled']);
      expect(
        proc.deferMessage({ text: "AFTER_STOP", tempId: "after" }).success,
      ).toBe(true);
      expect(proc.respondToInput(stale, "approve")).toBe(false);
      // The refused answer neither reached agy nor moved YA back in-turn,
      // and the deferred input is still waiting.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(proc.state.type).toBe("idle");
      expect(proc.getDeferredQueueSummary()).toHaveLength(1);
      expect(await answers()).toEqual(['answer "1" cancelled']);
      expect(
        (await lines()).filter((line) => line === "session/prompt"),
      ).toHaveLength(1);
      expect(proc.cancelDeferredMessage("after")).toBe(true);
    } finally {
      await session.abort();
    }
  });

  it("a request arriving after Stop, before the prompt settles, is answered cancelled without a prompt", async () => {
    let asked = 0;
    const { proc, session, until } = await owned("late", () => {
      asked++;
    });
    try {
      // The prompt is running in agy once its first output arrives.
      await until(() =>
        JSON.stringify(proc.getMessageHistory()).includes("Waiting"),
      );
      await proc.interrupt();
      await until(() => proc.state.type === "idle");
      expect(asked).toBe(0);
      expect(proc.getPendingInputRequest()).toBeNull();
      expect(
        proc.deferMessage({ text: "AFTER_LATE", tempId: "after" }).success,
      ).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(proc.state.type).toBe("idle");
      expect(proc.getDeferredQueueSummary()).toHaveLength(1);
      expect(proc.cancelDeferredMessage("after")).toBe(true);
      expect(await answers()).toEqual(['answer "1" cancelled']);
    } finally {
      await session.abort();
    }
  });

  it("root Stop withdraws the root conversation's prompt and leaves a child's open", async () => {
    const asked: Array<{
      title: string;
      signal: AbortSignal;
      answer(allow: boolean): void;
    }> = [];
    const session = await new AntigravityProvider().startSession({
      cwd: directory,
      initialMessage: { text: "child", uuid: randomUUID() },
      onToolApproval: (tool, input, { signal }) =>
        new Promise((resolve) => {
          asked.push({
            title: tool,
            signal,
            answer: (allow) =>
              resolve(
                allow
                  ? { behavior: "allow", updatedInput: input }
                  : { behavior: "deny" },
              ),
          });
          signal.addEventListener("abort", () => resolve({ behavior: "deny" }));
        }),
    });
    try {
      const done = untilResult(session);
      await vi.waitFor(() => expect(asked).toHaveLength(2));
      expect(await session.interrupt?.()).toBe(true);
      expect((await done).at(-1)?.type).toBe("result");
      const root = asked.find((entry) => entry.title === "Write file 1")!;
      const child = asked.find((entry) => entry.title === "Write file 2")!;
      expect(root.signal.aborted).toBe(true);
      expect(child.signal.aborted).toBe(false);
      child.answer(true);
      await vi.waitFor(async () =>
        expect(await answers()).toEqual([
          'answer "1" cancelled',
          'answer "2" native-allow',
        ]),
      );
    } finally {
      await session.abort();
    }
  });

  it("an overlapping duplicate ID gets one terminal reply and withdraws the first prompt", async () => {
    let signal: AbortSignal | undefined;
    const session = await new AntigravityProvider().startSession({
      cwd: directory,
      initialMessage: { text: "dup", uuid: randomUUID() },
      onToolApproval: (_tool, input, options) => {
        signal = options.signal;
        return new Promise((resolve) => {
          options.signal.addEventListener("abort", () =>
            setTimeout(
              () => resolve({ behavior: "allow", updatedInput: input }),
              20,
            ),
          );
        });
      },
    });
    try {
      expect((await untilResult(session)).at(-1)?.type).toBe("result");
      expect(signal?.aborted).toBe(true);
      expect(await answers()).toEqual(['answer "1" error -32600']);
    } finally {
      await session.abort();
    }
  });

  it("a late answer to a cancelled request never answers a new request that reuses its ID", async () => {
    const pending: Array<(allow: boolean) => void> = [];
    const session = await new AntigravityProvider().startSession({
      cwd: directory,
      initialMessage: { text: "reuse-a", uuid: randomUUID() },
      // Ignores its signal, so the first answer arrives after cancellation.
      onToolApproval: (_tool, input) =>
        new Promise((resolve) => {
          pending.push((allow) =>
            resolve(
              allow
                ? { behavior: "allow", updatedInput: input }
                : { behavior: "deny" },
            ),
          );
        }),
    });
    try {
      const first = untilResult(session);
      await vi.waitFor(() => expect(pending).toHaveLength(1));
      expect(await session.interrupt?.()).toBe(true);
      await first;
      session.queue.push({ text: "reuse-b", uuid: randomUUID() });
      const second = untilResult(session);
      await vi.waitFor(() => expect(pending).toHaveLength(2));
      pending[0]!(true);
      await new Promise((resolve) => setTimeout(resolve, 20));
      pending[1]!(false);
      expect((await second).at(-1)?.type).toBe("result");
      expect(await answers()).toEqual([
        'answer "1" cancelled',
        'answer "1" native-deny',
      ]);
    } finally {
      await session.abort();
    }
  });

  it("does not retain completed approvals for the session's lifetime", async () => {
    const signals: Array<WeakRef<AbortSignal>> = [];
    const { proc, session, until } = await owned("many", (options) => {
      signals.push(new WeakRef(options.signal));
    });
    const off = proc.subscribe(() => {
      const request = proc.getPendingInputRequest();
      if (proc.state.type === "waiting-input" && request)
        proc.respondToInput(request.id, "approve");
    });
    try {
      await until(() => proc.state.type === "idle" && signals.length === 20);
      await new Promise((resolve) => setTimeout(resolve, 20));
      for (let pass = 0; pass < 5; pass++) gc();
      expect(signals.filter((ref) => ref.deref() !== undefined)).toHaveLength(
        0,
      );
      expect(session.isProcessAlive?.()).toBe(true);
    } finally {
      off();
      await session.abort();
    }
  });

  it("validates envelopes before dispatch and keeps the real initialize answer", async () => {
    vi.stubEnv("AGY_TEST_DECOYS", "1");
    const session = await new AntigravityProvider().startSession({
      cwd: directory,
      initialMessage: { text: "malformed", uuid: randomUUID() },
      onToolApproval: async () => {
        throw new Error("no prompt may open for an invalid request");
      },
    });
    try {
      const messages = await untilResult(session);
      expect(messages.at(-1)?.type).toBe("result");
      expect(JSON.stringify(messages)).not.toContain("NOT_AN_UPDATE");
      expect(JSON.stringify(messages)).toContain("MALFORMED_DONE");
      expect(await answers()).toEqual([
        // The initialize decoy with \`method: null\` is an invalid request.
        "answer 1 error -32600",
        'answer "u1" error -32601',
        'answer "v1" error -32600',
        'answer "p1" error -32602',
        "answer null error -32600",
      ]);
    } finally {
      await session.abort();
    }
  });

  it("closes intake on connection loss: held approvals end and admission is capped", async () => {
    const runtime = new AntigravityRuntime();
    const signals: AbortSignal[] = [];
    runtime.onPermission = (_params, signal) =>
      new Promise((resolve) => {
        signals.push(signal);
        signal.addEventListener("abort", () =>
          resolve({ outcome: { outcome: "cancelled" } }),
        );
      });
    try {
      await runtime.connect(process.env.ANTIGRAVITY_ACP_PATH!, directory, [
        "acp",
      ]);
      await expect(
        runtime.call(
          "session/prompt",
          { sessionId: nativeId, prompt: [{ type: "text", text: "exit" }] },
          0,
        ),
      ).rejects.toThrow("closed");
      await runtime.closed;
      expect(signals).toHaveLength(MAX_PENDING_PERMISSIONS);
      expect(signals.every((signal) => signal.aborted)).toBe(true);
    } finally {
      await runtime.close();
    }
  });

  it("ignores a permission request flushed while the runtime shuts down", async () => {
    vi.stubEnv("AGY_TEST_ASK_ON_SIGTERM", "1");
    const runtime = new AntigravityRuntime();
    let asked = 0;
    runtime.onPermission = async () => {
      asked++;
      return { outcome: { outcome: "cancelled" } };
    };
    await runtime.connect(process.env.ANTIGRAVITY_ACP_PATH!, directory, [
      "acp",
    ]);
    await runtime.close();
    expect(asked).toBe(0);
  });
});
