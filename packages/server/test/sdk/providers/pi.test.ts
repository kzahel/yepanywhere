import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { MessageQueue } from "../../../src/sdk/messageQueue.js";
import { PI_EFFORT_RETRY_COMMAND } from "../../../src/sdk/providers/pi-effort-retry.js";
import {
  attachJsonlLineReader,
  PiRpcClient,
} from "../../../src/sdk/providers/pi-rpc-client.js";
import {
  PiProvider,
  loweredEffortForRejection,
  piVersionUsesAgentSettled,
} from "../../../src/sdk/providers/pi.js";
import type { SDKMessage } from "../../../src/sdk/types.js";

type PiEvent = { type: string; [key: string]: unknown };

const originalPiExecutable = process.env.PI_EXECUTABLE;

afterEach(() => {
  if (originalPiExecutable === undefined) {
    delete process.env.PI_EXECUTABLE;
  } else {
    process.env.PI_EXECUTABLE = originalPiExecutable;
  }
});

function makeStream(terminalEvent: "agent_end" | "agent_settled") {
  return {
    currentAssistantId: null,
    text: "",
    thinking: "",
    runUsage: null,
    runCostUsd: null,
    terminalEvent,
    turnError: null,
    toolStates: new Map(),
  };
}

function mapPiEvent(
  provider: PiProvider,
  event: PiEvent,
  sessionId: string,
  stream: ReturnType<typeof makeStream>,
) {
  const privateProvider = provider as unknown as {
    mapEvent(
      event: PiEvent,
      sessionId: string,
      stream: ReturnType<typeof makeStream>,
    ): unknown[];
  };
  return privateProvider.mapEvent(event, sessionId, stream);
}

describe("PiProvider event mapping", () => {
  it("keeps an unlaunchable explicit path authoritative", async () => {
    process.env.PI_EXECUTABLE = `${process.execPath}.missing-pi`;
    const provider = new PiProvider({ piPath: process.execPath });

    await expect(provider.isInstalled()).resolves.toBe(false);
  });

  it("selects the terminal event from the Pi version boundary", () => {
    expect(piVersionUsesAgentSettled("0.80.3")).toBe(false);
    expect(piVersionUsesAgentSettled("pi 0.80.4")).toBe(true);
    expect(piVersionUsesAgentSettled("0.81.1")).toBe(true);
    expect(piVersionUsesAgentSettled("unknown")).toBeNull();
  });

  it("waits for agent_settled before completing a YA turn", () => {
    const provider = new PiProvider();
    const stream = makeStream("agent_settled");
    const mapEvent = (event: PiEvent) =>
      mapPiEvent(provider, event, "pi-session", stream);

    expect(
      mapEvent({
        type: "turn_end",
        message: {
          usage: {
            input: 11,
            output: 7,
            cacheRead: 5,
            cacheWrite: 3,
            cost: { total: 0.012 },
          },
        },
      }),
    ).toEqual([]);

    expect(
      mapEvent({
        type: "agent_end",
        messages: [],
        willRetry: false,
      }),
    ).toEqual([]);

    expect(mapEvent({ type: "agent_settled" })).toEqual([
      {
        type: "result",
        session_id: "pi-session",
        usage: {
          input_tokens: 11,
          output_tokens: 7,
          cache_read_input_tokens: 5,
          cache_creation_input_tokens: 3,
        },
        total_cost_usd: 0.012,
      },
    ]);
  });

  it("reports every model request of the run on its result, not the last", () => {
    const provider = new PiProvider();
    const stream = makeStream("agent_settled");
    const mapEvent = (event: PiEvent) =>
      mapPiEvent(provider, event, "pi-session", stream);

    // A tool round makes a second request; both are charged.
    mapEvent({
      type: "turn_end",
      message: {
        usage: { input: 11, output: 7, cacheRead: 5, cacheWrite: 3 },
      },
    });
    mapEvent({
      type: "turn_end",
      message: {
        usage: {
          input: 2,
          output: 4,
          cacheRead: 19,
          cacheWrite: 0,
          cost: { total: 0.004 },
        },
      },
    });

    expect(mapEvent({ type: "agent_settled" })).toEqual([
      {
        type: "result",
        session_id: "pi-session",
        usage: {
          input_tokens: 13,
          output_tokens: 11,
          cache_read_input_tokens: 24,
          cache_creation_input_tokens: 3,
        },
        total_cost_usd: 0.004,
      },
    ]);
    // The next run starts from nothing.
    expect(mapEvent({ type: "agent_settled" })).toEqual([
      { type: "result", session_id: "pi-session" },
    ]);
  });

  it("keeps agent_end as the legacy pre-0.80.4 boundary", () => {
    const provider = new PiProvider();
    const stream = makeStream("agent_end");
    const mapEvent = (event: PiEvent) =>
      mapPiEvent(provider, event, "legacy-pi-session", stream);

    expect(mapEvent({ type: "agent_settled" })).toEqual([]);
    expect(mapEvent({ type: "agent_end", willRetry: false })).toEqual([
      {
        type: "result",
        session_id: "legacy-pi-session",
      },
    ]);
  });
});

// Captured from pi 0.85.1 driving vLLM 0.29 with reasoning_effort "high": the
// failure arrives as an assistant message_end, not as an event of its own, and
// the server names the whole set it does accept.
const VLLM_REFUSAL =
  '400: {"message":"Unexpected reasoning effort high. Supported types are ' +
  'xhigh (default), medium, and low.","type":"BadRequestError",' +
  '"param":null,"code":400}';

describe("thinking level a rejected pi turn retries at", () => {
  it("takes the highest accepted level at or below the one refused", () => {
    expect(loweredEffortForRejection(VLLM_REFUSAL, "high")).toBe("medium");
    expect(loweredEffortForRejection(VLLM_REFUSAL, "max")).toBe("xhigh");
  });

  it("steps down one level when the server only says the level is wrong", () => {
    expect(
      loweredEffortForRejection("unsupported reasoning_effort", "high"),
    ).toBe("medium");
    // Nothing below the lowest level, so there is no retry to make.
    expect(
      loweredEffortForRejection("unsupported reasoning_effort", "low"),
    ).toBeUndefined();
  });

  it("leaves an unrelated failure alone", () => {
    expect(
      loweredEffortForRejection("context length exceeded", "high"),
    ).toBeUndefined();
    // A level the server does accept is not a reason to lower anything.
    expect(loweredEffortForRejection(VLLM_REFUSAL, "medium")).toBeUndefined();
    expect(loweredEffortForRejection(VLLM_REFUSAL, undefined)).toBeUndefined();
  });
});

/**
 * A stand-in `pi --mode rpc` child: it answers commands the way pi 0.85.1 does
 * and refuses the first prompt over its thinking level, so the provider's
 * retry sequence can be read back from what it wrote to stdin.
 */
function refusingPiProcess(options: {
  extensionLoaded: boolean;
  commandFails?: boolean;
}) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const proc = Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    stderr: new PassThrough(),
    killed: false,
    exitCode: null,
    signalCode: null,
    kill() {
      proc.killed = true;
      proc.emit("exit", 0, null);
      return true;
    },
  });
  const commands: string[] = [];
  const send = (line: object) => stdout.write(`${JSON.stringify(line)}\n`);
  let prompts = 0;
  attachJsonlLineReader(stdin, (line) => {
    const command = JSON.parse(line) as {
      type: string;
      id?: string;
      message?: string;
      level?: string;
    };
    const reply = (data?: object) =>
      send({
        type: "response",
        id: command.id,
        command: command.type,
        success: true,
        ...(data ? { data } : {}),
      });
    if (command.type === "prompt" && command.message?.startsWith("/")) {
      commands.push(`command ${command.message.split(" ")[0]}`);
      if (options.commandFails) {
        send({
          type: "extension_error",
          extensionPath: `command:${PI_EFFORT_RETRY_COMMAND}`,
          event: "command",
          error:
            "Yep Anywhere effort retry: the session does not end in a failed reply",
        });
      }
      reply();
      return;
    }
    if (command.type === "prompt") {
      commands.push(`prompt ${command.message}`);
      prompts += 1;
      if (prompts === 1) {
        send({
          type: "message_end",
          message: {
            role: "assistant",
            stopReason: "error",
            errorMessage: VLLM_REFUSAL,
          },
        });
      } else {
        send({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: "pong" },
        });
        send({ type: "message_end", message: { role: "assistant" } });
      }
      send({ type: "agent_settled" });
      return;
    }
    commands.push(
      command.level ? `${command.type} ${command.level}` : command.type,
    );
    if (command.type === "get_commands") {
      reply({
        commands: options.extensionLoaded
          ? [{ name: PI_EFFORT_RETRY_COMMAND, source: "extension" }]
          : [],
      });
      return;
    }
    reply();
  });
  return { proc, commands };
}

async function runRefusedTurn(
  pi: ReturnType<typeof refusingPiProcess>,
): Promise<SDKMessage[]> {
  const provider = new PiProvider();
  const queue = new MessageQueue();
  queue.push({ text: "ping" });
  const abort = new AbortController();
  const run = (
    provider as unknown as {
      runSession(...args: unknown[]): AsyncIterableIterator<SDKMessage>;
    }
  ).runSession(
    new PiRpcClient(pi.proc as unknown as ChildProcess),
    pi.proc,
    "pi-session",
    queue,
    abort.signal,
    { cwd: "/tmp", effort: "high" },
    { lastRawProviderEventAt: null, lastRawProviderEventSource: null },
    "agent_settled",
  );
  const yielded: SDKMessage[] = [];
  for await (const message of run) {
    yielded.push(message);
    if (message.type === "result") break;
  }
  abort.abort();
  return yielded;
}

function textOf(message: SDKMessage | undefined): string {
  return String(message?.message?.content ?? "");
}

describe("PiProvider turn refused over its thinking level", () => {
  it("sets the refused turn aside before lowering the level and resending", async () => {
    const pi = refusingPiProcess({ extensionLoaded: true });
    const yielded = await runRefusedTurn(pi);
    expect(pi.commands).toEqual([
      "prompt ping",
      "get_commands",
      `command /${PI_EFFORT_RETRY_COMMAND}`,
      "set_thinking_level medium",
      "prompt ping",
    ]);
    expect(yielded.map((message) => message.type)).toEqual([
      "system",
      "user",
      "assistant",
      "assistant",
      "result",
    ]);
    expect(textOf(yielded[2])).toContain("retried at **medium**");
    expect(textOf(yielded[3])).toBe("pong");
    expect(yielded.at(-1)).not.toHaveProperty("error");
  });

  it("ends the turn with the refusal when pi did not load YA's extension", async () => {
    const pi = refusingPiProcess({ extensionLoaded: false });
    const yielded = await runRefusedTurn(pi);
    // The command would otherwise have reached the model as a prompt.
    expect(pi.commands).toEqual([
      "prompt ping",
      "get_commands",
      "set_thinking_level medium",
    ]);
    expect(textOf(yielded.at(-2))).toContain("Later turns ask for **medium**");
    expect(yielded.at(-1)).toMatchObject({
      type: "result",
      error: VLLM_REFUSAL,
    });
  });

  it("does not resend a prompt the extension could not set aside", async () => {
    const pi = refusingPiProcess({ extensionLoaded: true, commandFails: true });
    const yielded = await runRefusedTurn(pi);
    expect(pi.commands).toEqual([
      "prompt ping",
      "get_commands",
      `command /${PI_EFFORT_RETRY_COMMAND}`,
      "set_thinking_level medium",
    ]);
    expect(yielded.at(-1)).toMatchObject({
      type: "result",
      error: VLLM_REFUSAL,
    });
  });
});

/**
 * A stand-in pi 1.x child whose extension consumes the user's prompt: it
 * answers `disposition: "handled"`, and when `startsRun` is set the command
 * then starts its own run, as an extension calling `pi.sendMessage()` would.
 */
function handlingPiProcess(options: { startsRun: boolean }) {
  const pi = refusingPiProcess({ extensionLoaded: true });
  const stdin = new PassThrough();
  const send = (line: object) =>
    pi.proc.stdout.write(`${JSON.stringify(line)}\n`);
  const commands: string[] = [];
  attachJsonlLineReader(stdin, (line) => {
    const command = JSON.parse(line) as { type: string; id?: string };
    commands.push(command.type);
    const reply = (data: object) =>
      send({
        type: "response",
        id: command.id,
        command: command.type,
        success: true,
        data,
      });
    if (command.type === "prompt") {
      if (options.startsRun) send({ type: "agent_start" });
      reply({ disposition: "handled" });
      if (options.startsRun) {
        send({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: "from command" },
        });
        send({ type: "message_end", message: { role: "assistant" } });
        send({ type: "agent_settled" });
      }
      return;
    }
    if (command.type === "get_state") {
      reply({ sessionId: "pi-session", isStreaming: false });
    }
  });
  return { proc: Object.assign(pi.proc, { stdin }), commands };
}

describe("PiProvider prompt consumed by an extension command", () => {
  async function runHandledTurn(startsRun: boolean) {
    const pi = handlingPiProcess({ startsRun });
    const yielded = await runRefusedTurn(pi);
    return { pi, yielded };
  }

  it("ends the turn when the handled prompt starts no run", async () => {
    const { pi, yielded } = await runHandledTurn(false);
    expect(pi.commands).toEqual(["prompt", "get_state"]);
    expect(yielded.map((message) => message.type)).toEqual([
      "system",
      "user",
      "result",
    ]);
    expect(yielded.at(-1)).not.toHaveProperty("error");
  });

  it("waits for the run a handled command starts", async () => {
    const { pi, yielded } = await runHandledTurn(true);
    expect(pi.commands).toEqual(["prompt"]);
    expect(yielded.map((message) => message.type)).toEqual([
      "system",
      "user",
      "assistant",
      "result",
    ]);
    expect(textOf(yielded[2])).toBe("from command");
  });
});

describe("PiProvider turn failure reporting", () => {
  it("carries pi's error message into the turn result", () => {
    const provider = new PiProvider();
    const stream = makeStream("agent_settled");
    const mapEvent = (event: PiEvent) =>
      mapPiEvent(provider, event, "pi-session", stream);

    expect(
      mapEvent({
        type: "message_end",
        message: {
          role: "assistant",
          stopReason: "error",
          errorMessage: "400: nope",
        },
      }),
    ).toEqual([]);
    expect(mapEvent({ type: "agent_settled" })).toEqual([
      expect.objectContaining({ type: "result", error: "400: nope" }),
    ]);
    // The next turn starts clean rather than reporting the last one's failure.
    expect(mapEvent({ type: "agent_settled" })).toEqual([
      expect.not.objectContaining({ error: expect.anything() }),
    ]);
  });
});

describe("PiProvider model list", () => {
  it("labels its fallback and bypasses the cache on force", async () => {
    const provider = new PiProvider();
    const internals = provider as unknown as {
      cachedModels: { at: number; models: Array<{ id: string }> } | null;
      findPiLaunchTarget: () => Promise<null>;
    };
    internals.findPiLaunchTarget = async () => null;
    internals.cachedModels = { at: Date.now(), models: [{ id: "cached" }] };

    expect((await provider.getAvailableModels())[0]?.id).toBe("cached");
    expect(
      (await provider.getAvailableModels({ forceRefresh: true }))[0]?.id,
    ).toBe("default");
    expect(provider.getModelCatalogStatus()).toMatchObject({
      source: "fallback",
      error: "pi is not installed",
    });
  });
});
