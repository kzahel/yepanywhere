import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  realpath,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  InstructionRestoration,
  withInstructionRestoration,
} from "../src/sdk/providers/instruction-restoration.js";
import {
  essentialInstructions,
  instructionHash,
} from "../src/sdk/providers/instruction-packets.js";
import { MessageQueue } from "../src/sdk/messageQueue.js";
import type { AgentSession } from "../src/sdk/providers/types.js";
import type { SDKMessage } from "../src/sdk/types.js";
import { ProviderSessionOwner } from "../src/sdk/providers/provider-session-owner.js";
import { ServerSettingsService } from "../src/services/ServerSettingsService.js";
import { createSettingsRoutes } from "../src/routes/settings.js";
import { Supervisor } from "../src/supervisor/Supervisor.js";
import type { AgentProvider } from "../src/sdk/providers/types.js";

describe("instruction restoration", () => {
  let root: string;
  let file: string;
  let source: string;
  let tracker: InstructionRestoration;
  let session: AgentSession;
  const diagnostic = vi.fn();
  let sequence = 0;
  const boundary = (): SDKMessage => ({
    type: "system",
    subtype: "compact_boundary",
    uuid: `compact-${++sequence}`,
  });
  const result = (): SDKMessage => ({
    type: "result",
    uuid: `result-${++sequence}`,
  });
  const settings = () => ({
    providers: { codex: true },
    pathPrefix: path.join(root, "topics"),
    pattern: "*.md",
    delayTurns: 0,
  });

  async function read(text: string, name = file, command = `cat '${name}'`) {
    const id = `read-${++sequence}`;
    await tracker.observe({
      type: "assistant",
      message: {
        content: [{ type: "tool_use", id, name: "Bash", input: { command } }],
      },
    });
    await tracker.observe({
      type: "user",
      message: {
        content: [{ type: "tool_result", tool_use_id: id, content: text }],
      },
    });
  }

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "instruction-restoration-"));
    await mkdir(path.join(root, "topics"));
    file = path.join(root, "topics", "example.md");
    source = `<!-- reread:begin -->\n${Array.from({ length: 123 }, (_, i) => `Essential instruction ${i}`).join("\n")}\n<!-- reread:end -->`;
    await writeFile(file, source);
    const essential = essentialInstructions(source);
    await writeFile(
      file.replace(/\.md$/, ".mandatory-reread.md"),
      `<!-- reread-coverage: ${JSON.stringify({ "topics/example.md": instructionHash(essential) })} -->\n<!-- reread-source-hashes: ${JSON.stringify({ "topics/example.md": instructionHash(source) })} -->\n<!-- source: topics/example.md -->\n${essential}\n`,
    );
    diagnostic.mockClear();
    tracker = new InstructionRestoration(root, diagnostic);
    tracker.configure({ settings: settings() });
    session = {
      iterator: (async function* () {})(),
      queue: new MessageQueue(),
      abort: vi.fn(),
      appendConversationContext: vi.fn(async () => true),
    };
  });
  afterEach(async () => {
    await rm(root, { recursive: true });
  });

  it("restores through the real adapter wrapper only when enabled", async () => {
    const id = "first-read";
    const messages: SDKMessage[] = [
      {
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", id, name: "Read", input: { file_path: file } },
          ],
        },
      },
      {
        type: "user",
        message: {
          content: [{ type: "tool_result", tool_use_id: id, content: source }],
        },
      },
      boundary(),
      result(),
    ];
    for (const enabled of [false, true]) {
      const append = vi.fn(async () => true);
      const wrapped = withInstructionRestoration(
        {
          ...session,
          appendConversationContext: append,
          iterator: (async function* () {
            yield* messages;
          })(),
        },
        { cwd: root, instructionRestoration: enabled ? settings() : undefined },
      );
      for await (const _message of wrapped.iterator) {
        /* drain actual execution boundary */
      }
      expect(append).toHaveBeenCalledTimes(enabled ? 1 : 0);
      if (enabled)
        expect(append.mock.calls[0]).toEqual([
          [
            {
              role: "user",
              text: expect.stringContaining("Essential instruction 122"),
            },
          ],
        ]);
    }
  });

  it("forgives a delivered head or tail of 100 of 125 lines", async () => {
    await read(source);
    for (const text of [
      source.split("\n").slice(0, 100).join("\n"),
      source.split("\n").slice(-100).join("\n"),
    ]) {
      await tracker.observe(boundary());
      await read(text, file, `head -100 '${file}'`);
      await tracker.idle(session);
    }
    expect(session.appendConversationContext).not.toHaveBeenCalled();
  });

  it("counts distinct subsequent turns, suspends for input, and honors queued user work", async () => {
    tracker.configure({ settings: { ...settings(), delayTurns: 2 } });
    await read(source);
    await tracker.observe(boundary());
    await tracker.observe(result());
    const first = result();
    await tracker.observe(first);
    await tracker.observe(first);
    await tracker.idle(session);
    expect(session.appendConversationContext).not.toHaveBeenCalled();
    await tracker.observe(result());
    tracker.configure({
      settings: { ...settings(), delayTurns: 2 },
      paused: true,
    });
    await tracker.idle(session);
    expect(session.appendConversationContext).not.toHaveBeenCalled();
    tracker.configure({
      settings: { ...settings(), delayTurns: 2 },
      paused: false,
    });
    session.queue.push({ text: "user priority" });
    await tracker.idle(session);
    expect(session.appendConversationContext).not.toHaveBeenCalled();
    session.queue.drain();
    await tracker.idle(session);
    expect(session.appendConversationContext).toHaveBeenCalledOnce();
  });

  it("recovers persisted reads and accepted restoration before processing the live stream", async () => {
    await read(source);
    await tracker.observe(boundary());
    await tracker.idle(session);
    const restored = vi.mocked(session.appendConversationContext!).mock
      .calls[0]![0][0]!.text;
    const append = vi.fn(async () => true);
    const wrapped = withInstructionRestoration(
      {
        ...session,
        appendConversationContext: append,
        iterator: (async function* () {
          yield result();
          yield result();
        })(),
      },
      {
        cwd: root,
        instructionRestoration: settings(),
        instructionReadHistory: [
          boundary(),
          { type: "user", message: { content: restored } },
        ],
      },
    );
    for await (const _message of wrapped.iterator) {
      /* consume replay plus live events */
    }
    expect(append).not.toHaveBeenCalled();
  });

  it("hydrates worker history before observing live compaction", async () => {
    const wrapped = withInstructionRestoration(
      {
        ...session,
        iterator: (async function* () {
          yield boundary();
          yield result();
        })(),
      },
      {
        cwd: root,
        instructionRestoration: settings(),
        deferInstructionHistory: true,
      },
    );
    const draining = (async () => {
      for await (const _message of wrapped.iterator) {
        /* consume live stream */
      }
    })();
    await wrapped.hydrateInstructionReadHistory!(
      [
        {
          type: "assistant",
          content: [
            {
              type: "tool_use",
              id: "seed",
              name: "Read",
              input: { file_path: file },
            },
          ],
        },
      ],
      false,
    );
    expect(session.appendConversationContext).not.toHaveBeenCalled();
    await wrapped.hydrateInstructionReadHistory!(
      [
        {
          type: "user",
          content: [
            { type: "tool_result", tool_use_id: "seed", content: source },
          ],
        },
      ],
      true,
    );
    await draining;
    expect(session.appendConversationContext).toHaveBeenCalledOnce();
  });

  it("verifies command output recorded in code-mode logs", async () => {
    await read(source);
    await tracker.observe(boundary());
    await tracker.observe({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "exec-batch",
            name: "Exec",
            input: {
              calls: [
                {
                  toolName: "exec_command",
                  input: {
                    cmd: "tail -100 example.md",
                    workdir: path.dirname(file),
                  },
                },
              ],
            },
          },
        ],
      },
    });
    await tracker.observe({
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "exec-batch",
            content: JSON.stringify({
              exit_code: 0,
              output: source.split("\n").slice(-100).join("\n"),
            }),
          },
        ],
      },
    });
    await tracker.idle(session);
    expect(session.appendConversationContext).not.toHaveBeenCalled();
  });

  it("recursive reads discharge included sources using delivered bodies, not coverage headers", async () => {
    const packet = await readFile(
      file.replace(/\.md$/, ".mandatory-reread.md"),
      "utf8",
    );
    const recursive = file.replace(/\.md$/, ".mandatory-reread.recursive.md");
    await writeFile(recursive, packet);
    await read(source);
    await tracker.observe(boundary());
    await read(packet.split("\n").slice(0, 2).join("\n"), recursive);
    await tracker.idle(session);
    expect(session.appendConversationContext).toHaveBeenCalledOnce();
    await tracker.observe(boundary());
    await read(packet, recursive);
    await tracker.idle(session);
    expect(session.appendConversationContext).toHaveBeenCalledOnce();
  });

  it("exposes force read through the provider owner without a browser", async () => {
    const owner = new ProviderSessionOwner({ runtimeId: "restoration-test" });
    await owner.start(async () => ({
      session: withInstructionRestoration(session, {
        cwd: root,
        instructionRestoration: settings(),
      }),
    }));
    expect(owner.readyMetadata().capabilities.instructionRestoration).toBe(
      true,
    );
    const frames: unknown[] = [];
    owner.attach("test-controller", "test-generation", (frame) =>
      frames.push(frame),
    );
    await owner.handleControllerRequest("test-controller", {
      type: "rpc",
      id: 1,
      method: "forceReadInstructions",
      args: [[file]],
    });
    expect(session.appendConversationContext).toHaveBeenCalledOnce();
    expect(frames).toContainEqual(
      expect.objectContaining({ result: "native-history" }),
    );
    await owner.shutdown("test complete");
  });

  it("carries persisted read evidence through the supervisor launch and observes compaction", async () => {
    const append = vi.fn(async () => true);
    const history: SDKMessage[] = [
      {
        type: "assistant",
        uuid: "old-read",
        message: {
          content: [
            {
              type: "tool_use",
              id: "old-tool",
              name: "Read",
              input: { file_path: file },
            },
          ],
        },
      },
      {
        type: "user",
        uuid: "old-output",
        message: {
          content: [
            { type: "tool_result", tool_use_id: "old-tool", content: source },
          ],
        },
      },
    ];
    const provider: AgentProvider = {
      name: "codex",
      displayName: "Codex",
      supportsPermissionMode: true,
      supportsThinkingToggle: false,
      supportsSlashCommands: true,
      supportsSteering: false,
      isInstalled: async () => true,
      isAuthenticated: async () => true,
      getAuthStatus: async () => ({
        installed: true,
        authenticated: true,
        enabled: true,
      }),
      getAvailableModels: async () => [],
      startSession: async (options) => {
        const queue = new MessageQueue();
        let stopped = false;
        return withInstructionRestoration(
          {
            queue,
            appendConversationContext: append,
            abort: () => {
              stopped = true;
              queue.push({ text: "stop" });
            },
            iterator: (async function* () {
              yield {
                type: "system",
                subtype: "init",
                session_id: "restoration-supervisor",
              };
              for await (const _message of queue) {
                if (stopped) return;
                yield boundary();
                yield result();
              }
            })(),
          },
          options,
        );
      },
    };
    const supervisor = new Supervisor({
      provider,
      getInstructionRestorationSettings: settings,
      readInstructionHistory: async () => history,
    });
    try {
      const started = await supervisor.resumeSession(
        "restoration-supervisor",
        root,
        { text: "continue" },
      );
      expect("id" in started).toBe(true);
      await vi.waitFor(() => expect(append).toHaveBeenCalledOnce());
      if ("id" in started) await supervisor.abortProcess(started.id);
    } finally {
      await supervisor.stopBackgroundTasks();
    }
  });

  it("persists per-provider controls and previews canonical matches without arming reads", async () => {
    const service = new ServerSettingsService({
      dataDir: path.join(root, "data"),
    });
    await service.initialize();
    const routes = createSettingsRoutes({ serverSettingsService: service });
    expect(service.getSetting("instructionRestoration")?.providers).toEqual({});
    const response = await routes.request("/", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ instructionRestoration: settings() }),
    });
    expect(response.status).toBe(200);
    const reloaded = new ServerSettingsService({
      dataDir: path.join(root, "data"),
    });
    await reloaded.initialize();
    expect(reloaded.getSetting("instructionRestoration")).toEqual(settings());
    const preview = await routes.request("/instruction-restoration/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(settings()),
    });
    expect(await preview.json()).toEqual({
      prefix: await realpath(path.dirname(file)),
      matches: [await realpath(file)],
      truncated: false,
    });
  });

  it("does not credit command success, a header, or unseen truncated output", async () => {
    await read(source);
    await tracker.observe(boundary());
    await read(
      `${source.split("\n").slice(0, 20).join("\n")}\nOutput truncated`,
    );
    await tracker.idle(session);
    expect(session.appendConversationContext).toHaveBeenCalledOnce();
  });

  it("joins read ranges and rearms on the next distinct compaction", async () => {
    await read(source);
    const compact = boundary();
    await tracker.observe(compact);
    await read(source.split("\n").slice(0, 65).join("\n"));
    await read(source.split("\n").slice(65).join("\n"));
    await tracker.observe(compact);
    await tracker.idle(session);
    expect(session.appendConversationContext).not.toHaveBeenCalled();
    await tracker.observe(boundary());
    await tracker.idle(session);
    expect(session.appendConversationContext).toHaveBeenCalledOnce();
  });

  it("validates current sources and never falls back after uncertain acceptance", async () => {
    await read(source);
    await tracker.observe(boundary());
    await writeFile(file, `${source}\nchanged`);
    await tracker.idle(session);
    expect(session.appendConversationContext).not.toHaveBeenCalled();
    expect(diagnostic).toHaveBeenCalledWith(expect.stringContaining("stale"));
    await writeFile(file, source);
    await tracker.observe(boundary());
    session.appendConversationContext = vi.fn(async () => {
      throw new Error("connection lost");
    });
    await tracker.idle(session);
    await tracker.idle(session);
    expect(session.appendConversationContext).toHaveBeenCalledOnce();
    expect(session.queue.depth).toBe(0);
  });

  it("cancels a queued fallback when paused and restores after resuming", async () => {
    session.appendConversationContext = undefined;
    await read(source);
    await tracker.observe(boundary());
    await tracker.idle(session);
    expect(session.queue.depth).toBe(1);
    tracker.configure({ settings: settings(), paused: true });
    expect(session.queue.depth).toBe(0);
    tracker.configure({ settings: settings() });
    await tracker.idle(session);
    expect(session.queue.depth).toBe(1);
    tracker.dispose();
    expect(session.queue.depth).toBe(0);
  });

  it("rejects failed logged command output as read evidence", async () => {
    await read(JSON.stringify({ exit_code: 1, output: source }));
    await tracker.observe(boundary());
    await tracker.idle(session);
    expect(session.appendConversationContext).not.toHaveBeenCalled();
  });

  it("credits each included recursive source independently", async () => {
    const other = path.join(root, "topics", "other.md");
    const otherSource =
      "<!-- reread:begin -->\nA different essential rule\n<!-- reread:end -->";
    await writeFile(other, otherSource);
    const bodies = {
      "topics/example.md": essentialInstructions(source),
      "topics/other.md": essentialInstructions(otherSource),
    };
    const recursive = file.replace(/\.md$/, ".mandatory-reread.recursive.md");
    const packet = `<!-- reread-coverage: ${JSON.stringify(Object.fromEntries(Object.entries(bodies).map(([key, body]) => [key, instructionHash(body)])))} -->\n<!-- reread-source-hashes: ${JSON.stringify({ "topics/example.md": instructionHash(source), "topics/other.md": instructionHash(otherSource) })} -->\n${Object.entries(
      bodies,
    )
      .map(([key, body]) => `<!-- source: ${key} -->\n${body}`)
      .join("\n")}`;
    await writeFile(recursive, packet);
    await read(source);
    await read(otherSource, other);
    await tracker.observe(boundary());
    await read(packet, recursive);
    await tracker.idle(session);
    expect(session.appendConversationContext).not.toHaveBeenCalled();
  });

  it("rejects symlink escapes and cancels disabled restoration", async () => {
    const outside = path.join(root, "outside.md");
    await writeFile(outside, source);
    const alias = path.join(root, "topics", "alias.md");
    await symlink(outside, alias);
    await read(source, alias);
    await tracker.observe(boundary());
    await tracker.idle(session);
    expect(session.appendConversationContext).not.toHaveBeenCalled();
    await read(source);
    await tracker.observe(boundary());
    tracker.configure({ settings: null });
    await tracker.idle(session);
    expect(session.appendConversationContext).not.toHaveBeenCalled();
  });
});
