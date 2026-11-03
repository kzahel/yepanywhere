/**
 * Unit tests for OpenCodeProvider.startSession() blocking session-ID resolution.
 *
 * The core invariant: startSession() must resolve with an iterator whose FIRST
 * yield is already the init message carrying the real ses_* session ID.  That
 * establishes the native binding before input; public YA identity stays separate.
 */

import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// --- helpers ---

function makeFakeProcess(): ChildProcess {
  const emitter = new EventEmitter() as ChildProcess;
  emitter.pid = 12345;
  emitter.killed = false;
  emitter.exitCode = null;
  emitter.signalCode = null;
  emitter.kill = vi.fn(() => true) as unknown as ChildProcess["kill"];
  const fakeStream = new EventEmitter() as unknown as import("stream").Readable;
  emitter.stdout = fakeStream;
  emitter.stderr = fakeStream;
  return emitter;
}

// Minimal Response-like object for mocking global fetch
function jsonResponse(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
    text: async () => JSON.stringify(data),
  } as unknown as Response;
}

function sseResponse(events: unknown[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
        );
      }
      controller.close();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

describe("OpenCodeProvider.startSession — blocking session ID", () => {
  let spawnMock: ReturnType<typeof vi.fn>;
  let execFileMock: ReturnType<typeof vi.fn>;
  let fetchMock: ReturnType<typeof vi.fn>;
  let fakeProcess: ChildProcess;

  beforeEach(async () => {
    fakeProcess = makeFakeProcess();
    spawnMock = vi.fn(() => fakeProcess);
    execFileMock = vi.fn(
      (
        _file: string,
        _args: string[],
        _options: unknown,
        callback: (
          error: Error | null,
          stdout?: string,
          stderr?: string,
        ) => void,
      ) => callback(new Error("execFile not mocked")),
    );
    fetchMock = vi.fn();

    // Patch module-level imports
    vi.doMock("node:child_process", async (importOriginal) => {
      const actual =
        await importOriginal<typeof import("node:child_process")>();
      return {
        ...actual,
        spawn: spawnMock,
        exec: actual.exec,
        execFile: execFileMock,
      };
    });

    vi.doMock("node:fs", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:fs")>();
      return {
        ...actual,
        existsSync: (p: string) =>
          p.includes("opencode") || actual.existsSync(p),
      };
    });

    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("startSession resolves before the iterator is consumed and first yield is init with ses_ ID", async () => {
    const expectedSessionId = "ses_abc123testid";

    // GET /session (waitForServer poll) → OK
    // POST /session (session creation) → { id: "ses_abc123testid" }
    fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        return Promise.resolve(jsonResponse({ id: expectedSessionId }));
      }
      // GET — server health check
      return Promise.resolve(jsonResponse({ sessions: [] }));
    });

    const { OpenCodeProvider } = await import(
      "../../../src/sdk/providers/opencode.js"
    );
    const provider = new OpenCodeProvider({ opencodePath: "/fake/opencode" });

    // startSession must resolve (blocking work done) before we pull from iterator
    const session = await provider.startSession({
      cwd: "/tmp/test",
    });

    expect(spawnMock).toHaveBeenCalledOnce();
    expect(spawnMock).toHaveBeenCalledWith(
      "/fake/opencode",
      expect.arrayContaining(["serve"]),
      expect.any(Object),
    );
    const createCall = fetchMock.mock.calls.find(
      ([url, init]) =>
        String(url).endsWith("/session") && init?.method === "POST",
    );
    expect(JSON.parse(String(createCall?.[1]?.body))).toEqual({
      title: "Yep Anywhere Session",
    });

    // The very first value from the iterator must be the init message
    const first = await session.iterator.next();
    expect(first.done).toBe(false);
    expect(first.value).toMatchObject({
      type: "system",
      subtype: "init",
      session_id: expectedSessionId,
    });

    // Abort to clean up (kills the fake server process)
    session.abort();
  });

  it("only permits OpenCode automatic titles by explicit opt-in", async () => {
    fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        return Promise.resolve(jsonResponse({ id: "ses_auto_title" }));
      }
      return Promise.resolve(jsonResponse({ sessions: [] }));
    });

    const { OpenCodeProvider } = await import(
      "../../../src/sdk/providers/opencode.js"
    );
    const provider = new OpenCodeProvider({ opencodePath: "/fake/opencode" });
    const session = await provider.startSession({
      cwd: "/tmp/test",
      sessionOptions: { automaticTitle: true },
    });

    const createCall = fetchMock.mock.calls.find(
      ([url, init]) =>
        String(url).endsWith("/session") && init?.method === "POST",
    );
    expect(JSON.parse(String(createCall?.[1]?.body))).toEqual({});
    await expect(
      session.setSessionOptions?.({ automaticTitle: false }),
    ).resolves.toMatchObject({
      automaticTitle: { requested: false, status: "restart-required" },
    });
    session.abort();
  });

  it("returns error iterator immediately when opencode binary is not found", async () => {
    vi.doMock("node:fs", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:fs")>();
      // existsSync returns false for everything → binary not found
      return { ...actual, existsSync: () => false };
    });

    // Also make exec (which command) fail
    vi.doMock("node:child_process", async (importOriginal) => {
      const actual =
        await importOriginal<typeof import("node:child_process")>();
      return {
        ...actual,
        spawn: spawnMock,
        exec: (
          _cmd: string,
          _opts: unknown,
          cb: (err: Error | null) => void,
        ) => {
          cb(new Error("not found"));
          return {} as ChildProcess;
        },
        execFile: actual.execFile,
      };
    });

    const { OpenCodeProvider } = await import(
      "../../../src/sdk/providers/opencode.js"
    );
    const provider = new OpenCodeProvider();

    const session = await provider.startSession({ cwd: "/tmp/test" });

    const first = await session.iterator.next();
    expect(first.done).toBe(false);
    expect(first.value).toMatchObject({ type: "error" });
    expect((first.value as { error: string }).error).toMatch(/not found/i);

    // spawn should not have been called
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("returns error iterator when server fails to start within timeout", async () => {
    // Simulate server never becoming ready
    fetchMock.mockResolvedValue({
      ok: false,
      status: 503,
    } as Response);

    const { OpenCodeProvider } = await import(
      "../../../src/sdk/providers/opencode.js"
    );
    // waitForServer is overridden below with a short timeout so the test
    // doesn't actually wait 10 seconds.
    const provider = new OpenCodeProvider({
      opencodePath: "/fake/opencode",
    });

    // Override waitForServer by giving a minimal timeout via a subclass
    // We need to test this faster — use a derived class with tiny timeout
    const fastProvider = Object.create(provider) as typeof provider;
    // Access private method via prototype to inject a short timeout
    const origWaitForServer = (
      provider as unknown as {
        waitForServer: (url: string, timeout: number) => Promise<boolean>;
      }
    ).waitForServer.bind(provider);
    (
      fastProvider as unknown as {
        waitForServer: (url: string, timeout: number) => Promise<boolean>;
      }
    ).waitForServer = (_url: string) => origWaitForServer(_url, 200);

    const session = await fastProvider.startSession({ cwd: "/tmp/test" });

    const first = await session.iterator.next();
    expect(first.done).toBe(false);
    expect(first.value).toMatchObject({ type: "error" });
    expect((first.value as { error: string }).error).toMatch(
      /failed to start/i,
    );
  });

  it("uses ses_ resumeSessionId directly without creating a new session", async () => {
    const resumeId = "ses_existing_session";

    // GET /session for health check
    fetchMock.mockResolvedValue(jsonResponse({ sessions: [] }));

    const { OpenCodeProvider } = await import(
      "../../../src/sdk/providers/opencode.js"
    );
    const provider = new OpenCodeProvider({ opencodePath: "/fake/opencode" });

    const session = await provider.startSession({
      cwd: "/tmp/test",
      resumeSessionId: resumeId,
    });

    // POST /session should NOT have been called (we resumed)
    const postCalls = fetchMock.mock.calls.filter(
      ([, init]: [string, RequestInit?]) => init?.method === "POST",
    );
    expect(postCalls).toHaveLength(0);

    const first = await session.iterator.next();
    expect(first.value).toMatchObject({
      type: "system",
      subtype: "init",
      session_id: resumeId,
    });

    session.abort();
  });

  it("sends explicit provider/model selection in the message body", async () => {
    const sessionId = "ses_model_selection";
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes("/event")) {
        return Promise.resolve(
          sseResponse([
            {
              type: "session.status",
              properties: { sessionID: sessionId, status: { type: "busy" } },
            },
            { type: "session.idle", properties: { sessionID: sessionId } },
          ]),
        );
      }
      if (url.endsWith(`/session/${sessionId}/message`)) {
        return Promise.resolve(jsonResponse({ ok: true }));
      }
      if (init?.method === "POST") {
        return Promise.resolve(jsonResponse({ id: sessionId }));
      }
      return Promise.resolve(jsonResponse({ sessions: [] }));
    });

    const { OpenCodeProvider } = await import(
      "../../../src/sdk/providers/opencode.js"
    );
    const provider = new OpenCodeProvider({ opencodePath: "/fake/opencode" });

    const session = await provider.startSession({
      cwd: "/tmp/test",
      initialMessage: { text: "hello" },
      model: "opencode/gpt-5-nano",
    });

    await session.iterator.next();
    await session.iterator.next();
    await session.iterator.next();

    const messagePost = fetchMock.mock.calls.find(
      ([url, init]: [string, RequestInit?]) =>
        url.endsWith(`/session/${sessionId}/message`) &&
        init?.method === "POST",
    );
    expect(messagePost).toBeDefined();
    expect(JSON.parse(String(messagePost?.[1]?.body))).toMatchObject({
      model: { providerID: "opencode", modelID: "gpt-5-nano" },
      parts: [{ type: "text", text: "hello" }],
    });

    expect(session.getProviderActivity?.()).toMatchObject({
      lastRawProviderEventSource: "opencode:sse:session.idle",
    });

    session.abort();
  });

  it("lists local-glm OpenCode models first and marks the first as default", async () => {
    execFileMock.mockImplementation(
      (
        _file: string,
        _args: string[],
        _options: unknown,
        callback: (
          error: Error | null,
          stdout?: string,
          stderr?: string,
        ) => void,
      ) =>
        callback(
          null,
          [
            "opencode/big-pickle",
            "github-copilot/gpt-5-mini",
            "local-glm/Qwen/Qwen3.6-27B",
          ].join("\n"),
          "",
        ),
    );

    const { OpenCodeProvider } = await import(
      "../../../src/sdk/providers/opencode.js"
    );
    const provider = new OpenCodeProvider({ opencodePath: "/fake/opencode" });

    await expect(provider.getAvailableModels()).resolves.toEqual([
      {
        id: "local-glm/Qwen/Qwen3.6-27B",
        name: "local-glm/Qwen/Qwen3.6-27B",
        description:
          "Start matching vLLM server: pixi run vllm serve Qwen/Qwen3.6-27B-FP8 --served-model-name Qwen/Qwen3.6-27B --tool-call-parser qwen3_coder --reasoning-parser qwen3 --enable-auto-tool-choice --port 8001",
        isDefault: true,
      },
      {
        id: "default",
        name: "Default",
        description: "Use the default configured in opencode.json",
      },
      { id: "opencode/big-pickle", name: "opencode/big-pickle" },
      { id: "github-copilot/gpt-5-mini", name: "github-copilot/gpt-5-mini" },
    ]);
  });

  it("does not render OpenCode user text parts as assistant messages", async () => {
    const sessionId = "ses_user_part_filter";
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes("/event")) {
        return Promise.resolve(
          sseResponse([
            {
              type: "message.updated",
              properties: {
                info: { id: "msg_user", sessionID: sessionId, role: "user" },
              },
            },
            {
              type: "message.part.updated",
              properties: {
                part: {
                  id: "part_user",
                  sessionID: sessionId,
                  messageID: "msg_user",
                  type: "text",
                  text: "hello",
                },
              },
            },
            {
              type: "message.updated",
              properties: {
                info: {
                  id: "msg_assistant",
                  sessionID: sessionId,
                  role: "assistant",
                },
              },
            },
            {
              type: "message.part.updated",
              properties: {
                part: {
                  id: "part_assistant",
                  sessionID: sessionId,
                  messageID: "msg_assistant",
                  type: "text",
                  text: "assistant reply",
                },
              },
            },
            { type: "session.idle", properties: { sessionID: sessionId } },
          ]),
        );
      }
      if (url.endsWith(`/session/${sessionId}/message`)) {
        return Promise.resolve(jsonResponse({ ok: true }));
      }
      if (init?.method === "POST") {
        return Promise.resolve(jsonResponse({ id: sessionId }));
      }
      return Promise.resolve(jsonResponse({ sessions: [] }));
    });

    const { OpenCodeProvider } = await import(
      "../../../src/sdk/providers/opencode.js"
    );
    const provider = new OpenCodeProvider({ opencodePath: "/fake/opencode" });
    const session = await provider.startSession({
      cwd: "/tmp/test",
      initialMessage: { text: "hello" },
    });

    const messages = [];
    for (let i = 0; i < 6; i += 1) {
      const next = await session.iterator.next();
      if (next.done) {
        break;
      }
      messages.push(next.value);
      if (next.value.type === "result") {
        break;
      }
    }

    const assistantTexts = messages
      .filter(
        (message) => message.type === "assistant" && !message._isStreaming,
      )
      .map((message) => message.message?.content);
    expect(assistantTexts).toEqual(["assistant reply"]);

    session.abort();
  });

  it("renders a unified type:'tool' part as one tool_use plus a tool_result", async () => {
    const sessionId = "ses_unified_tool";
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes("/event")) {
        return Promise.resolve(
          sseResponse([
            {
              type: "message.updated",
              properties: {
                info: {
                  id: "msg_a",
                  sessionID: sessionId,
                  role: "assistant",
                },
              },
            },
            // Same part streamed twice: running (input present) then completed.
            {
              type: "message.part.updated",
              properties: {
                part: {
                  id: "prt_tool",
                  sessionID: sessionId,
                  messageID: "msg_a",
                  type: "tool",
                  tool: "bash",
                  callID: "call_1",
                  state: {
                    status: "running",
                    input: { command: "echo hi" },
                  },
                },
              },
            },
            {
              type: "message.part.updated",
              properties: {
                part: {
                  id: "prt_tool",
                  sessionID: sessionId,
                  messageID: "msg_a",
                  type: "tool",
                  tool: "bash",
                  callID: "call_1",
                  state: {
                    status: "completed",
                    input: { command: "echo hi" },
                    output: "hi\n",
                  },
                },
              },
            },
            { type: "session.idle", properties: { sessionID: sessionId } },
          ]),
        );
      }
      if (url.endsWith(`/session/${sessionId}/message`)) {
        return Promise.resolve(jsonResponse({ ok: true }));
      }
      if (init?.method === "POST") {
        return Promise.resolve(jsonResponse({ id: sessionId }));
      }
      return Promise.resolve(jsonResponse({ sessions: [] }));
    });

    const { OpenCodeProvider } = await import(
      "../../../src/sdk/providers/opencode.js"
    );
    const provider = new OpenCodeProvider({ opencodePath: "/fake/opencode" });
    const session = await provider.startSession({
      cwd: "/tmp/test",
      initialMessage: { text: "run echo" },
    });

    const messages = [];
    for (let i = 0; i < 10; i += 1) {
      const next = await session.iterator.next();
      if (next.done) break;
      messages.push(next.value);
      if (next.value.type === "result") break;
    }

    const toolUses = messages.flatMap((m) =>
      Array.isArray(m.message?.content)
        ? m.message.content.filter(
            (b: { type?: string }) => b.type === "tool_use",
          )
        : [],
    );
    const toolResults = messages.flatMap((m) =>
      Array.isArray(m.message?.content)
        ? m.message.content.filter(
            (b: { type?: string }) => b.type === "tool_result",
          )
        : [],
    );

    // Streamed across two updates but deduped to exactly one of each.
    expect(toolUses).toHaveLength(1);
    expect(toolUses[0]).toMatchObject({
      type: "tool_use",
      id: "call_1",
      name: "Bash", // normalized from opencode "bash"
      input: { command: "echo hi" },
    });
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0]).toMatchObject({
      type: "tool_result",
      tool_use_id: "call_1",
      content: "hi\n",
    });

    session.abort();
  });

  it("treats step-finish as nonterminal and aggregates usage at session.idle", async () => {
    const sessionId = "ses_multi_step";
    const firstStep = {
      id: "prt_step_1",
      sessionID: sessionId,
      messageID: "msg_a",
      type: "step-finish",
      tokens: {
        input: 10,
        output: 2,
        cache: { read: 3, write: 1 },
      },
    };
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes("/event")) {
        return Promise.resolve(
          sseResponse([
            {
              type: "message.updated",
              properties: {
                info: {
                  id: "msg_a",
                  sessionID: sessionId,
                  role: "assistant",
                },
              },
            },
            {
              type: "message.part.updated",
              properties: { part: firstStep },
            },
            // Repeated updates for one part replace its usage; they do not
            // double-count it.
            {
              type: "message.part.updated",
              properties: { part: firstStep },
            },
            {
              type: "message.part.updated",
              properties: {
                part: {
                  id: "prt_text",
                  sessionID: sessionId,
                  messageID: "msg_a",
                  type: "text",
                  text: "after the first model step",
                },
              },
            },
            {
              type: "message.part.updated",
              properties: {
                part: {
                  id: "prt_step_2",
                  sessionID: sessionId,
                  messageID: "msg_a",
                  type: "step-finish",
                  tokens: {
                    input: 5,
                    output: 4,
                    cache: { read: 2, write: 3 },
                  },
                },
              },
            },
            { type: "session.idle", properties: { sessionID: sessionId } },
          ]),
        );
      }
      if (url.endsWith(`/session/${sessionId}/message`)) {
        return Promise.resolve(jsonResponse({ ok: true }));
      }
      if (init?.method === "POST") {
        return Promise.resolve(jsonResponse({ id: sessionId }));
      }
      return Promise.resolve(jsonResponse({ sessions: [] }));
    });

    const { OpenCodeProvider } = await import(
      "../../../src/sdk/providers/opencode.js"
    );
    const provider = new OpenCodeProvider({ opencodePath: "/fake/opencode" });
    const session = await provider.startSession({
      cwd: "/tmp/test",
      initialMessage: { text: "take multiple steps" },
    });

    const messages = [];
    for (let i = 0; i < 10; i += 1) {
      const next = await session.iterator.next();
      if (next.done) break;
      messages.push(next.value);
      if (next.value.type === "result") break;
    }

    expect(
      messages.filter((message) => message.type === "result"),
    ).toHaveLength(1);
    expect(
      messages.find((message) => message.type === "assistant"),
    ).toMatchObject({
      message: { content: "after the first model step" },
    });
    expect(messages.at(-1)).toMatchObject({
      type: "result",
      usage: {
        input_tokens: 15,
        output_tokens: 6,
        cache_read_input_tokens: 5,
        cache_creation_input_tokens: 4,
      },
    });

    session.abort();
  });

  it("preserves image attachments on live read tool results", async () => {
    const sessionId = "ses_tool_image";
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes("/event")) {
        return Promise.resolve(
          sseResponse([
            {
              type: "message.updated",
              properties: {
                info: {
                  id: "msg_a",
                  sessionID: sessionId,
                  role: "assistant",
                },
              },
            },
            {
              type: "message.part.updated",
              properties: {
                part: {
                  id: "prt_tool",
                  sessionID: sessionId,
                  messageID: "msg_a",
                  type: "tool",
                  tool: "read",
                  callID: "call_image",
                  state: {
                    status: "completed",
                    input: { filePath: "fixture.png" },
                    output: "Image read successfully",
                    attachments: [
                      {
                        type: "file",
                        mime: "image/png",
                        url: "data:image/png;base64,aGVsbG8=",
                      },
                    ],
                  },
                },
              },
            },
            { type: "session.idle", properties: { sessionID: sessionId } },
          ]),
        );
      }
      if (url.endsWith(`/session/${sessionId}/message`)) {
        return Promise.resolve(jsonResponse({ ok: true }));
      }
      if (init?.method === "POST") {
        return Promise.resolve(jsonResponse({ id: sessionId }));
      }
      return Promise.resolve(jsonResponse({ sessions: [] }));
    });

    const { OpenCodeProvider } = await import(
      "../../../src/sdk/providers/opencode.js"
    );
    const provider = new OpenCodeProvider({ opencodePath: "/fake/opencode" });
    const session = await provider.startSession({
      cwd: "/tmp/test",
      initialMessage: { text: "read the image" },
    });

    const messages = [];
    for (let i = 0; i < 10; i += 1) {
      const next = await session.iterator.next();
      if (next.done) break;
      messages.push(next.value);
      if (next.value.type === "result") break;
    }

    const result = messages.find(
      (message) =>
        message.type === "user" &&
        Array.isArray(message.message?.content) &&
        message.message.content.some((block) => block.type === "tool_result"),
    );
    expect(result).toMatchObject({
      toolUseResult: {
        type: "image",
        file: {
          base64: "aGVsbG8=",
          type: "image/png",
          originalSize: 5,
        },
      },
    });

    session.abort();
  });

  it("routes a permission.asked event to onToolApproval and replies once on allow", async () => {
    const sessionId = "ses_perm_bridge";
    const onToolApproval = vi.fn().mockResolvedValue({ behavior: "allow" });
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes("/event")) {
        return Promise.resolve(
          sseResponse([
            {
              type: "permission.asked",
              properties: {
                id: "per_1",
                sessionID: sessionId,
                permission: "bash",
                patterns: ["echo hi"],
                metadata: { command: "echo hi", description: "say hi" },
                always: ["echo *"],
                tool: { messageID: "msg_a", callID: "call_1" },
              },
            },
            { type: "session.idle", properties: { sessionID: sessionId } },
          ]),
        );
      }
      if (url.endsWith(`/session/${sessionId}/message`)) {
        return Promise.resolve(jsonResponse({ ok: true }));
      }
      if (url.includes("/permission/per_1/reply")) {
        return Promise.resolve(jsonResponse({ ok: true }));
      }
      if (init?.method === "POST") {
        return Promise.resolve(jsonResponse({ id: sessionId }));
      }
      return Promise.resolve(jsonResponse({ sessions: [] }));
    });

    const { OpenCodeProvider } = await import(
      "../../../src/sdk/providers/opencode.js"
    );
    const provider = new OpenCodeProvider({ opencodePath: "/fake/opencode" });
    const session = await provider.startSession({
      cwd: "/tmp/test",
      initialMessage: { text: "run echo" },
      onToolApproval,
    });

    for (let i = 0; i < 10; i += 1) {
      const next = await session.iterator.next();
      if (next.done || next.value.type === "result") break;
    }
    // Let the fire-and-forget approval handler settle.
    await new Promise((r) => setTimeout(r, 50));

    expect(onToolApproval).toHaveBeenCalledWith(
      "Bash",
      { command: "echo hi", description: "say hi" },
      expect.objectContaining({ signal: expect.anything() }),
    );
    const replyCall = fetchMock.mock.calls.find((c: unknown[]) =>
      String(c[0]).includes("/permission/per_1/reply"),
    );
    expect(replyCall).toBeDefined();
    expect(JSON.parse(String((replyCall?.[1] as RequestInit)?.body))).toEqual({
      reply: "once",
    });

    session.abort();
  });

  it("sends the YA effort as an OpenCode model variant", async () => {
    const sessionId = "ses_effort";
    let messageBody: Record<string, unknown> | null = null;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes("/event")) {
        return Promise.resolve(
          sseResponse([
            { type: "session.idle", properties: { sessionID: sessionId } },
          ]),
        );
      }
      if (url.endsWith(`/session/${sessionId}/message`)) {
        messageBody = JSON.parse(String(init?.body));
        return Promise.resolve(jsonResponse({ ok: true }));
      }
      if (init?.method === "POST") {
        return Promise.resolve(jsonResponse({ id: sessionId }));
      }
      return Promise.resolve(jsonResponse({ sessions: [] }));
    });

    const { OpenCodeProvider } = await import(
      "../../../src/sdk/providers/opencode.js"
    );
    const provider = new OpenCodeProvider({ opencodePath: "/fake/opencode" });
    const session = await provider.startSession({
      cwd: "/tmp/test",
      initialMessage: { text: "hi" },
      model: "github-copilot/claude-opus-4.8",
      effort: "high",
    });
    for (let i = 0; i < 6; i += 1) {
      const next = await session.iterator.next();
      if (next.done || next.value.type === "result") break;
    }
    expect(messageBody).toMatchObject({
      model: { providerID: "github-copilot", modelID: "claude-opus-4.8" },
      variant: "high",
    });
    session.abort();
  });

  it("sends image content blocks as OpenCode file parts (data URLs)", async () => {
    const sessionId = "ses_image";
    // 1x1 PNG (magic bytes detected as image/png by the queue)
    const pngBase64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    let messageBody: { parts?: Array<Record<string, unknown>> } | null = null;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes("/event")) {
        return Promise.resolve(
          sseResponse([
            { type: "session.idle", properties: { sessionID: sessionId } },
          ]),
        );
      }
      if (url.endsWith(`/session/${sessionId}/message`)) {
        messageBody = JSON.parse(String(init?.body));
        return Promise.resolve(jsonResponse({ ok: true }));
      }
      if (init?.method === "POST") {
        return Promise.resolve(jsonResponse({ id: sessionId }));
      }
      return Promise.resolve(jsonResponse({ sessions: [] }));
    });

    const { OpenCodeProvider } = await import(
      "../../../src/sdk/providers/opencode.js"
    );
    const provider = new OpenCodeProvider({ opencodePath: "/fake/opencode" });
    const session = await provider.startSession({
      cwd: "/tmp/test",
      initialMessage: { text: "what is this?", images: [pngBase64] },
    });
    for (let i = 0; i < 6; i += 1) {
      const next = await session.iterator.next();
      if (next.done || next.value.type === "result") break;
    }
    const parts = messageBody?.parts ?? [];
    expect(parts).toContainEqual({ type: "text", text: "what is this?" });
    const filePart = parts.find((p) => p.type === "file");
    expect(filePart).toMatchObject({
      type: "file",
      mime: "image/png",
      url: `data:image/png;base64,${pngBase64}`,
    });

    session.abort();
  });

  it("interrupt() posts to the OpenCode session abort endpoint", async () => {
    const sessionId = "ses_interrupt";
    let abortCalled = false;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes("/event")) {
        return Promise.resolve(
          sseResponse([
            { type: "session.idle", properties: { sessionID: sessionId } },
          ]),
        );
      }
      if (
        url.endsWith(`/session/${sessionId}/abort`) &&
        init?.method === "POST"
      ) {
        abortCalled = true;
        return Promise.resolve(jsonResponse({ ok: true }));
      }
      if (url.endsWith(`/session/${sessionId}/message`)) {
        return Promise.resolve(jsonResponse({ ok: true }));
      }
      if (init?.method === "POST") {
        return Promise.resolve(jsonResponse({ id: sessionId }));
      }
      return Promise.resolve(jsonResponse({ sessions: [] }));
    });

    const { OpenCodeProvider } = await import(
      "../../../src/sdk/providers/opencode.js"
    );
    const provider = new OpenCodeProvider({ opencodePath: "/fake/opencode" });
    const session = await provider.startSession({ cwd: "/tmp/test" });

    const result = await session.interrupt?.();
    expect(result).toBe(true);
    expect(abortCalled).toBe(true);

    session.abort();
  });

  it("uses the OpenCode message POST body when SSE closes before content", async () => {
    const sessionId = "ses_post_body_fallback";
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes("/event")) {
        return Promise.resolve(
          sseResponse([{ type: "server.connected", properties: {} }]),
        );
      }
      if (url.endsWith(`/session/${sessionId}/message`)) {
        return Promise.resolve(
          jsonResponse({
            info: {
              id: "msg_assistant",
              sessionID: sessionId,
              role: "assistant",
              providerID: "local-glm",
              modelID: "Qwen/Qwen3.6-27B",
            },
            parts: [
              {
                id: "part_reasoning",
                sessionID: sessionId,
                messageID: "msg_assistant",
                type: "reasoning",
                text: "thinking it through",
              },
              {
                id: "part_text",
                sessionID: sessionId,
                messageID: "msg_assistant",
                type: "text",
                text: "assistant reply",
              },
            ],
          }),
        );
      }
      if (init?.method === "POST") {
        return Promise.resolve(jsonResponse({ id: sessionId }));
      }
      return Promise.resolve(jsonResponse({ sessions: [] }));
    });

    const { OpenCodeProvider } = await import(
      "../../../src/sdk/providers/opencode.js"
    );
    const provider = new OpenCodeProvider({ opencodePath: "/fake/opencode" });
    const session = await provider.startSession({
      cwd: "/tmp/test",
      initialMessage: { text: "hello" },
    });

    const messages = [];
    for (let i = 0; i < 5; i += 1) {
      const next = await session.iterator.next();
      if (next.done) break;
      messages.push(next.value);
      if (next.value.type === "result") break;
    }

    const assistant = messages.find((message) => message.type === "assistant");
    expect(assistant).toMatchObject({
      uuid: "msg_assistant",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "thinking it through" },
          { type: "text", text: "assistant reply" },
        ],
      },
    });

    session.abort();
  });

  it("streams OpenCode message.part.delta text without duplicating final updates", async () => {
    const sessionId = "ses_delta_stream";
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes("/event")) {
        return Promise.resolve(
          sseResponse([
            {
              type: "message.updated",
              properties: {
                info: {
                  id: "msg_assistant",
                  sessionID: sessionId,
                  role: "assistant",
                },
              },
            },
            {
              type: "message.part.updated",
              properties: {
                part: {
                  id: "part_text",
                  sessionID: sessionId,
                  messageID: "msg_assistant",
                  type: "text",
                  text: "",
                },
              },
            },
            {
              type: "message.part.delta",
              properties: {
                sessionID: sessionId,
                messageID: "msg_assistant",
                partID: "part_text",
                field: "text",
                delta: "hello ",
              },
            },
            {
              type: "message.part.delta",
              properties: {
                sessionID: sessionId,
                messageID: "msg_assistant",
                partID: "part_text",
                field: "text",
                delta: "world",
              },
            },
            {
              type: "message.part.updated",
              properties: {
                part: {
                  id: "part_text",
                  sessionID: sessionId,
                  messageID: "msg_assistant",
                  type: "text",
                  text: "hello world",
                  time: { end: 123 },
                },
              },
            },
            { type: "session.idle", properties: { sessionID: sessionId } },
          ]),
        );
      }
      if (url.endsWith(`/session/${sessionId}/message`)) {
        return Promise.resolve(jsonResponse({ ok: true }));
      }
      if (init?.method === "POST") {
        return Promise.resolve(jsonResponse({ id: sessionId }));
      }
      return Promise.resolve(jsonResponse({ sessions: [] }));
    });

    const { OpenCodeProvider } = await import(
      "../../../src/sdk/providers/opencode.js"
    );
    const provider = new OpenCodeProvider({ opencodePath: "/fake/opencode" });
    const session = await provider.startSession({
      cwd: "/tmp/test",
      initialMessage: { text: "hello" },
    });

    const messages = [];
    for (let i = 0; i < 6; i += 1) {
      const next = await session.iterator.next();
      if (next.done) break;
      messages.push(next.value);
      if (next.value.type === "result") break;
    }

    // Each live message carries the reply so far under the durable id, since
    // the client replaces a same-id row; the ended part commits it.
    const assistantMessages = messages
      .filter((message) => message.type === "assistant")
      .map((message) => ({
        uuid: message.uuid,
        content: message.message?.content,
        streaming: message._isStreaming === true,
      }));
    expect(assistantMessages).toEqual([
      { uuid: "msg_assistant", content: "hello ", streaming: true },
      { uuid: "msg_assistant", content: "hello world", streaming: true },
      { uuid: "msg_assistant", content: "hello world", streaming: false },
    ]);

    session.abort();
  });

  it("commits an OpenCode message only when the message completes", async () => {
    const sessionId = "ses_commit_once";
    const part = (id: string, type: string, text: string, end?: number) => ({
      type: "message.part.updated",
      properties: {
        part: {
          id,
          sessionID: sessionId,
          messageID: "msg_steps",
          type,
          text,
          ...(end ? { time: { start: 1, end } } : {}),
        },
      },
    });
    const info = (completed?: number) => ({
      type: "message.updated",
      properties: {
        info: {
          id: "msg_steps",
          sessionID: sessionId,
          role: "assistant",
          time: { created: 1, ...(completed ? { completed } : {}) },
        },
      },
    });
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes("/event")) {
        return Promise.resolve(
          sseResponse([
            info(),
            // The reasoning part ends before the text part starts: every part
            // seen so far has ended, but the message is not complete.
            part("part_reasoning", "reasoning", "pondering", 2),
            part("part_text", "text", "answer", 3),
            info(4),
            { type: "session.idle", properties: { sessionID: sessionId } },
          ]),
        );
      }
      if (url.endsWith(`/session/${sessionId}/message`)) {
        return Promise.resolve(jsonResponse({ ok: true }));
      }
      if (init?.method === "POST") {
        return Promise.resolve(jsonResponse({ id: sessionId }));
      }
      return Promise.resolve(jsonResponse({ sessions: [] }));
    });

    const { OpenCodeProvider } = await import(
      "../../../src/sdk/providers/opencode.js"
    );
    const provider = new OpenCodeProvider({ opencodePath: "/fake/opencode" });
    const session = await provider.startSession({
      cwd: "/tmp/test",
      initialMessage: { text: "hello" },
    });

    const messages = [];
    for (let i = 0; i < 8; i += 1) {
      const next = await session.iterator.next();
      if (next.done) break;
      messages.push(next.value);
      if (next.value.type === "result") break;
    }

    const thinking = { type: "thinking", thinking: "pondering" };
    const text = { type: "text", text: "answer" };
    expect(
      messages
        .filter((message) => message.type === "assistant")
        .map((message) => ({
          content: message.message?.content,
          streaming: message._isStreaming === true,
        })),
    ).toEqual([
      { content: [thinking], streaming: true },
      { content: [thinking, text], streaming: true },
      { content: [thinking, text], streaming: false },
    ]);

    session.abort();
  });

  it("yields live output while the prompt POST is still pending", async () => {
    const sessionId = "ses_pending_post";
    // OpenCode answers the prompt POST only once the turn has finished.
    let finishPost: (() => void) | undefined;
    const pendingPost = new Promise<Response>((resolve) => {
      finishPost = () => resolve(jsonResponse({ ok: true }));
    });
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes("/event")) {
        return Promise.resolve(
          sseResponse([
            {
              type: "message.updated",
              properties: {
                info: {
                  id: "msg_live",
                  sessionID: sessionId,
                  role: "assistant",
                },
              },
            },
            {
              type: "message.part.updated",
              properties: {
                part: {
                  id: "part_live",
                  sessionID: sessionId,
                  messageID: "msg_live",
                  type: "text",
                  text: "",
                },
              },
            },
            {
              type: "message.part.delta",
              properties: {
                sessionID: sessionId,
                messageID: "msg_live",
                partID: "part_live",
                field: "text",
                delta: "streaming now",
              },
            },
            { type: "session.idle", properties: { sessionID: sessionId } },
          ]),
        );
      }
      if (url.endsWith(`/session/${sessionId}/message`)) {
        return pendingPost;
      }
      if (init?.method === "POST") {
        return Promise.resolve(jsonResponse({ id: sessionId }));
      }
      return Promise.resolve(jsonResponse({ sessions: [] }));
    });

    const { OpenCodeProvider } = await import(
      "../../../src/sdk/providers/opencode.js"
    );
    const provider = new OpenCodeProvider({ opencodePath: "/fake/opencode" });
    const session = await provider.startSession({
      cwd: "/tmp/test",
      initialMessage: { text: "hello" },
    });

    let live: unknown;
    for (let i = 0; i < 6 && !live; i += 1) {
      const next = await session.iterator.next();
      if (next.done) break;
      if (next.value.type === "assistant") live = next.value;
    }
    expect(live).toMatchObject({
      uuid: "msg_live",
      _isStreaming: true,
      message: { content: "streaming now" },
    });

    // The turn result still waits for the POST to settle.
    finishPost?.();
    let sawResult = false;
    for (let i = 0; i < 6 && !sawResult; i += 1) {
      const next = await session.iterator.next();
      if (next.done) break;
      sawResult = next.value.type === "result";
    }
    expect(sawResult).toBe(true);

    session.abort();
  });

  it("reports OpenCode session/status as active liveness evidence", async () => {
    const sessionId = "ses_active_status";
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.endsWith("/session/status")) {
        return Promise.resolve(jsonResponse({ [sessionId]: { type: "busy" } }));
      }
      if (init?.method === "POST") {
        return Promise.resolve(jsonResponse({ id: sessionId }));
      }
      return Promise.resolve(jsonResponse({ sessions: [] }));
    });

    const { OpenCodeProvider } = await import(
      "../../../src/sdk/providers/opencode.js"
    );
    const provider = new OpenCodeProvider({ opencodePath: "/fake/opencode" });
    const session = await provider.startSession({ cwd: "/tmp/test" });

    await expect(session.probeLiveness?.()).resolves.toMatchObject({
      status: "active",
      source: "opencode:session/status",
    });

    session.abort();
  });

  it("reports OpenCode retry session/status as active liveness evidence", async () => {
    const sessionId = "ses_retry_status";
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.endsWith("/session/status")) {
        return Promise.resolve(
          jsonResponse({
            [sessionId]: {
              type: "retry",
              attempt: 2,
              message: "rate limited",
              next: Date.now() + 1000,
            },
          }),
        );
      }
      if (init?.method === "POST") {
        return Promise.resolve(jsonResponse({ id: sessionId }));
      }
      return Promise.resolve(jsonResponse({ sessions: [] }));
    });

    const { OpenCodeProvider } = await import(
      "../../../src/sdk/providers/opencode.js"
    );
    const provider = new OpenCodeProvider({ opencodePath: "/fake/opencode" });
    const session = await provider.startSession({ cwd: "/tmp/test" });

    await expect(session.probeLiveness?.()).resolves.toMatchObject({
      status: "active",
      source: "opencode:session/status",
      detail: "OpenCode is retrying attempt 2: rate limited",
    });

    session.abort();
  });

  it("reports a missing OpenCode session/status entry as idle", async () => {
    const sessionId = "ses_idle_status";
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.endsWith("/session/status")) {
        return Promise.resolve(jsonResponse({}));
      }
      if (init?.method === "POST") {
        return Promise.resolve(jsonResponse({ id: sessionId }));
      }
      return Promise.resolve(jsonResponse({ sessions: [] }));
    });

    const { OpenCodeProvider } = await import(
      "../../../src/sdk/providers/opencode.js"
    );
    const provider = new OpenCodeProvider({ opencodePath: "/fake/opencode" });
    const session = await provider.startSession({ cwd: "/tmp/test" });

    await expect(session.probeLiveness?.()).resolves.toMatchObject({
      status: "idle",
      source: "opencode:session/status",
    });

    session.abort();
  });

  it("reports an unrecognized OpenCode session/status entry as an error", async () => {
    const sessionId = "ses_bad_status";
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.endsWith("/session/status")) {
        return Promise.resolve(
          jsonResponse({ [sessionId]: { type: "paused" } }),
        );
      }
      if (init?.method === "POST") {
        return Promise.resolve(jsonResponse({ id: sessionId }));
      }
      return Promise.resolve(jsonResponse({ sessions: [] }));
    });

    const { OpenCodeProvider } = await import(
      "../../../src/sdk/providers/opencode.js"
    );
    const provider = new OpenCodeProvider({ opencodePath: "/fake/opencode" });
    const session = await provider.startSession({ cwd: "/tmp/test" });

    await expect(session.probeLiveness?.()).resolves.toMatchObject({
      status: "error",
      source: "opencode:session/status",
    });

    session.abort();
  });
});
