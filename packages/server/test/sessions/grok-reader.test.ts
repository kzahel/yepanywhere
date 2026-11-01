import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  nativeSessionRef,
  parseNativeSessionId,
  parseYaSessionId,
  toUrlProjectId,
} from "@yep-anywhere/shared";
import { afterEach, describe, expect, it } from "vitest";
import {
  TOOL_RESULT_MEDIA_CANDIDATES,
  type ToolResultMediaCandidateCarrier,
} from "../../src/media/inlineImageData.js";
import { GrokSessionReader } from "../../src/sessions/grok-reader.js";
import { BoundSessionReads } from "../../src/sessions/bound-session-reader.js";

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true });
  }
});

function canonicalMeta(
  name: string,
  kind: string,
  label: string,
  input: Record<string, unknown> = {},
) {
  return {
    _meta: {
      "x.ai/tool": {
        version: 1,
        name,
        kind,
        namespace: "xai",
        label,
        read_only: kind.includes("read"),
        input,
      },
    },
  };
}

describe("GrokSessionReader tool replay", () => {
  it("joins lifecycle updates once and preserves image media candidates", async () => {
    const root = mkdtempSync(join(tmpdir(), "grok-reader-tools-"));
    tempRoots.push(root);
    const sessionsDir = join(root, "sessions");
    const projectPath = join(root, "project");
    const sessionId = "grok-session-1";
    const sessionDir = join(
      sessionsDir,
      encodeURIComponent(projectPath),
      sessionId,
    );
    mkdirSync(projectPath, { recursive: true });
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      join(sessionDir, "summary.json"),
      JSON.stringify({
        info: { id: sessionId, cwd: projectPath },
        created_at: "2026-07-29T00:00:00.000Z",
        updated_at: "2026-07-29T00:01:00.000Z",
        generated_title: "Grok vocabulary",
        num_messages: 4,
        current_model_id: "grok-4.5",
      }),
    );

    const updates = [
      {
        sessionUpdate: "tool_call",
        toolCallId: "edit-1",
        kind: "edit",
        title: "Starting edit",
        rawInput: {
          variant: "SearchReplace",
          file_path: join(projectPath, "note.txt"),
          old_string: "old\n",
          new_string: "new\n",
        },
        ...canonicalMeta("search_replace", "file.edit", "Edit"),
      },
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "edit-1",
        status: "in_progress",
        title: "Replacing text in note.txt",
      },
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "edit-1",
        status: "completed",
        rawOutput: {
          type: "SearchReplace",
          EditsApplied: {
            absolute_path: join(projectPath, "note.txt"),
            old_string: "old\n",
            new_string: "new\n",
          },
        },
      },
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "edit-1",
        status: "completed",
        rawOutput: {
          type: "SearchReplace",
          EditsApplied: {
            absolute_path: join(projectPath, "note.txt"),
            old_string: "old\n",
            new_string: "new\n",
          },
        },
      },
      {
        sessionUpdate: "tool_call",
        toolCallId: "image-1",
        rawInput: { variant: "ImageGen", prompt: "violet circuit" },
        ...canonicalMeta("image_gen", "image.generate", "Generate Image"),
      },
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "image-1",
        status: "completed",
        rawOutput: {
          type: "ImageGen",
          path: join(sessionDir, "images", "1.jpg"),
          filename: "1.jpg",
          session_folder: sessionDir,
        },
      },
    ];
    writeFileSync(
      join(sessionDir, "updates.jsonl"),
      updates
        .map((update, index) =>
          JSON.stringify({
            timestamp: 1_775_000_000 + index,
            params: { update },
          }),
        )
        .join("\n"),
    );

    const reader = new GrokSessionReader({ sessionsDir, projectPath });
    const loaded = await reader.getSession(
      sessionId,
      toUrlProjectId(projectPath),
    );

    expect(loaded?.data.provider).toBe("grok");
    if (loaded?.data.provider !== "grok") {
      throw new Error("Expected a Grok session");
    }
    const messages = loaded.data.session.messages;
    expect(messages).toHaveLength(4);
    expect(messages[0]).toMatchObject({
      uuid: "edit-1",
      toolUse: {
        id: "edit-1",
        name: "Edit",
        input: {
          old_string: "old\n",
          new_string: "new\n",
          title: "Replacing text in note.txt",
          status: "completed",
        },
      },
    });
    expect(messages[1]).toMatchObject({
      uuid: "edit-1:result",
      toolUseResult: {
        filePath: join(projectPath, "note.txt"),
        oldString: "old\n",
        newString: "new\n",
      },
    });
    expect(messages[2]).toMatchObject({
      uuid: "image-1",
      toolUse: { id: "image-1", name: "ImageGen" },
    });
    expect(
      (messages[3] as ToolResultMediaCandidateCarrier)[
        TOOL_RESULT_MEDIA_CANDIDATES
      ],
    ).toEqual([
      {
        originalPath: join(sessionDir, "images", "1.jpg"),
        filename: "1.jpg",
      },
    ]);
  });
});

describe("GrokSessionReader interject replay", () => {
  it("strips Grok's outer steer envelope from user_message_chunk text", async () => {
    const root = mkdtempSync(join(tmpdir(), "grok-reader-interject-"));
    tempRoots.push(root);
    const sessionsDir = join(root, "sessions");
    const projectPath = join(root, "project");
    const sessionId = "grok-session-interject";
    const sessionDir = join(
      sessionsDir,
      encodeURIComponent(projectPath),
      sessionId,
    );
    mkdirSync(projectPath, { recursive: true });
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      join(sessionDir, "summary.json"),
      JSON.stringify({
        info: { id: sessionId, cwd: projectPath },
        created_at: "2026-08-17T00:00:00.000Z",
        updated_at: "2026-08-17T00:01:00.000Z",
        generated_title: "Interject",
        num_messages: 1,
        current_model_id: "grok-4.6",
      }),
    );
    const inner = [
      "keep this quoted example",
      "<user_query>",
      "quoted inner",
      "</user_query>",
    ].join("\n");
    writeFileSync(
      join(sessionDir, "updates.jsonl"),
      `${JSON.stringify({
        timestamp: 1_775_000_000,
        params: {
          update: {
            sessionUpdate: "user_message_chunk",
            content: {
              type: "text",
              text: [
                "The user sent a message while you were working:",
                "<user_query>",
                inner,
                "</user_query>",
                "Make sure to complete any unfinished tasks from previous turns.",
              ].join("\n"),
            },
          },
        },
      })}\n`,
    );

    const reader = new GrokSessionReader({ sessionsDir, projectPath });
    const loaded = await reader.getSession(
      sessionId,
      toUrlProjectId(projectPath),
    );
    expect(loaded?.data.provider).toBe("grok");
    if (loaded?.data.provider !== "grok") {
      throw new Error("Expected a Grok session");
    }
    expect(loaded.data.session.messages).toMatchObject([
      {
        type: "user",
        message: { role: "user", content: inner },
      },
    ]);
  });

  it("splits concatenated interject envelopes into one user turn each", async () => {
    const root = mkdtempSync(join(tmpdir(), "grok-reader-split-interject-"));
    tempRoots.push(root);
    const sessionsDir = join(root, "sessions");
    const projectPath = join(root, "project");
    const sessionId = "grok-session-split-interject";
    const sessionDir = join(
      sessionsDir,
      encodeURIComponent(projectPath),
      sessionId,
    );
    mkdirSync(projectPath, { recursive: true });
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      join(sessionDir, "summary.json"),
      JSON.stringify({
        info: { id: sessionId, cwd: projectPath },
        created_at: "2026-09-09T00:00:00.000Z",
        updated_at: "2026-09-09T00:01:00.000Z",
        generated_title: "Split interject",
        num_messages: 2,
        current_model_id: "grok-4.6",
      }),
    );
    const wrap = (inner: string) =>
      [
        "The user sent a message while you were working:",
        "<user_query>",
        inner,
        "</user_query>",
        "Make sure to complete any unfinished tasks from previous turns.",
      ].join("\n");
    writeFileSync(
      join(sessionDir, "updates.jsonl"),
      `${JSON.stringify({
        timestamp: 1_775_000_000,
        params: {
          update: {
            sessionUpdate: "user_message_chunk",
            content: {
              type: "text",
              text: `${wrap("first steer")}${wrap("second steer")}`,
            },
          },
          _meta: { eventId: `${sessionId}-2` },
        },
      })}\n`,
    );

    const reader = new GrokSessionReader({ sessionsDir, projectPath });
    const loaded = await reader.getSession(
      sessionId,
      toUrlProjectId(projectPath),
    );
    if (loaded?.data.provider !== "grok") {
      throw new Error("Expected a Grok session");
    }
    expect(
      loaded.data.session.messages.map((message) => [
        message.uuid,
        message.message?.content,
      ]),
    ).toEqual([
      [`grok-evt-${sessionId}-2`, "first steer"],
      [`grok-evt-${sessionId}-2#1`, "second steer"],
    ]);
  });

  it("splits a prompt glued to a following interject envelope", async () => {
    const root = mkdtempSync(join(tmpdir(), "grok-reader-glued-interject-"));
    tempRoots.push(root);
    const sessionsDir = join(root, "sessions");
    const projectPath = join(root, "project");
    const sessionId = "grok-session-glued-interject";
    const sessionDir = join(
      sessionsDir,
      encodeURIComponent(projectPath),
      sessionId,
    );
    mkdirSync(projectPath, { recursive: true });
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      join(sessionDir, "summary.json"),
      JSON.stringify({
        info: { id: sessionId, cwd: projectPath },
        created_at: "2026-09-09T00:00:00.000Z",
        updated_at: "2026-09-09T00:01:00.000Z",
        generated_title: "Glued interject",
        num_messages: 2,
        current_model_id: "grok-4.6",
      }),
    );
    const first =
      "grok message acknowledgment gap:\ndisplayed\nso i'm saying: use handles";
    const second =
      "you know better than i what additional client resident turns data model exists";
    writeFileSync(
      join(sessionDir, "updates.jsonl"),
      `${JSON.stringify({
        timestamp: 1_775_000_000,
        params: {
          update: {
            sessionUpdate: "user_message_chunk",
            content: {
              type: "text",
              // Live Grok glued the next envelope onto the first suffix with
              // no extra newline (`turns.The user sent…`).
              text: `${first}\n</user_query>\nMake sure to complete any unfinished tasks from previous turns.The user sent a message while you were working:\n<user_query>\n${second}`,
            },
          },
          _meta: { eventId: `${sessionId}-2` },
        },
      })}\n`,
    );

    const reader = new GrokSessionReader({ sessionsDir, projectPath });
    const loaded = await reader.getSession(
      sessionId,
      toUrlProjectId(projectPath),
    );
    if (loaded?.data.provider !== "grok") {
      throw new Error("Expected a Grok session");
    }
    expect(
      loaded.data.session.messages.map((message) => [
        message.uuid,
        message.message?.content,
      ]),
    ).toEqual([
      [`grok-evt-${sessionId}-2`, first],
      [`grok-evt-${sessionId}-2#1`, second],
    ]);
  });

  it("does not join consecutive user_message_chunk updates", async () => {
    const root = mkdtempSync(join(tmpdir(), "grok-reader-user-chunks-"));
    tempRoots.push(root);
    const sessionsDir = join(root, "sessions");
    const projectPath = join(root, "project");
    const sessionId = "grok-session-user-chunks";
    const sessionDir = join(
      sessionsDir,
      encodeURIComponent(projectPath),
      sessionId,
    );
    mkdirSync(projectPath, { recursive: true });
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      join(sessionDir, "summary.json"),
      JSON.stringify({
        info: { id: sessionId, cwd: projectPath },
        created_at: "2026-09-09T00:00:00.000Z",
        updated_at: "2026-09-09T00:01:00.000Z",
        generated_title: "User chunks",
        num_messages: 2,
        current_model_id: "grok-4.6",
      }),
    );
    const wrap = (inner: string) =>
      [
        "The user sent a message while you were working:",
        "<user_query>",
        inner,
        "</user_query>",
        "Make sure to complete any unfinished tasks from previous turns.",
      ].join("\n");
    const chunk = (eventSuffix: number, inner: string) => ({
      timestamp: 1_775_000_000 + eventSuffix,
      params: {
        update: {
          sessionUpdate: "user_message_chunk",
          content: { type: "text", text: wrap(inner) },
        },
        _meta: { eventId: `${sessionId}-${eventSuffix}` },
      },
    });
    writeFileSync(
      join(sessionDir, "updates.jsonl"),
      `${[
        chunk(513, "delay impl until the other session finishes"),
        chunk(514, "coordinate active claims"),
      ]
        .map((record) => JSON.stringify(record))
        .join("\n")}\n`,
    );

    const reader = new GrokSessionReader({ sessionsDir, projectPath });
    const loaded = await reader.getSession(
      sessionId,
      toUrlProjectId(projectPath),
    );
    if (loaded?.data.provider !== "grok") {
      throw new Error("Expected a Grok session");
    }
    expect(
      loaded.data.session.messages.map((message) => [
        message.uuid,
        message.message?.content,
      ]),
    ).toEqual([
      [
        `grok-evt-${sessionId}-513`,
        "delay impl until the other session finishes",
      ],
      [`grok-evt-${sessionId}-514`, "coordinate active claims"],
    ]);
  });
});

describe("GrokSessionReader message identity", () => {
  it("keys each buffered run on its first chunk's update event id", async () => {
    const root = mkdtempSync(join(tmpdir(), "grok-reader-identity-"));
    tempRoots.push(root);
    const sessionsDir = join(root, "sessions");
    const projectPath = join(root, "project");
    const sessionId = "grok-session-identity";
    const sessionDir = join(
      sessionsDir,
      encodeURIComponent(projectPath),
      sessionId,
    );
    mkdirSync(projectPath, { recursive: true });
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      join(sessionDir, "summary.json"),
      JSON.stringify({
        info: { id: sessionId, cwd: projectPath },
        created_at: "2026-09-08T00:00:00.000Z",
        updated_at: "2026-09-08T00:01:00.000Z",
        generated_title: "Identity",
        num_messages: 4,
        current_model_id: "grok-4.6",
      }),
    );

    const chunk = (
      eventSuffix: number,
      sessionUpdate: string,
      text: string,
    ) => ({
      timestamp: 1_788_901_556 + eventSuffix,
      params: {
        update: { sessionUpdate, content: { type: "text", text } },
        _meta: { eventId: `${sessionId}-${eventSuffix}` },
      },
    });

    writeFileSync(
      join(sessionDir, "updates.jsonl"),
      `${[
        chunk(2, "user_message_chunk", "look into the stall"),
        chunk(44, "agent_thought_chunk", "Checking "),
        chunk(45, "agent_thought_chunk", "host pressure."),
        chunk(85, "agent_message_chunk", "Host is fine; "),
        chunk(86, "agent_message_chunk", "relay is healthy."),
        // A thought after text starts a new run rather than reopening the
        // earlier thinking block, matching how the live stream groups chunks.
        chunk(90, "agent_thought_chunk", "Now the queue."),
      ]
        .map((record) => JSON.stringify(record))
        .join("\n")}\n`,
    );

    const reader = new GrokSessionReader({ sessionsDir, projectPath });
    const loaded = await reader.getSession(
      sessionId,
      toUrlProjectId(projectPath),
    );
    if (loaded?.data.provider !== "grok") {
      throw new Error("Expected a Grok session");
    }

    expect(
      loaded.data.session.messages.map((message) => [
        message.uuid,
        message.message?.content,
      ]),
    ).toEqual([
      [`grok-evt-${sessionId}-2`, "look into the stall"],
      [
        `grok-evt-${sessionId}-44`,
        [{ type: "thinking", thinking: "Checking host pressure." }],
      ],
      [`grok-evt-${sessionId}-85`, "Host is fine; relay is healthy."],
      [
        `grok-evt-${sessionId}-90`,
        [{ type: "thinking", thinking: "Now the queue." }],
      ],
    ]);
  });

  it("falls back to positional ids for transcripts with no event ids", async () => {
    const root = mkdtempSync(join(tmpdir(), "grok-reader-legacy-id-"));
    tempRoots.push(root);
    const sessionsDir = join(root, "sessions");
    const projectPath = join(root, "project");
    const sessionId = "grok-session-legacy-id";
    const sessionDir = join(
      sessionsDir,
      encodeURIComponent(projectPath),
      sessionId,
    );
    mkdirSync(projectPath, { recursive: true });
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      join(sessionDir, "summary.json"),
      JSON.stringify({
        info: { id: sessionId, cwd: projectPath },
        created_at: "2026-09-08T00:00:00.000Z",
        updated_at: "2026-09-08T00:01:00.000Z",
        num_messages: 1,
        current_model_id: "grok-4.6",
      }),
    );
    writeFileSync(
      join(sessionDir, "updates.jsonl"),
      `${JSON.stringify({
        timestamp: 1_775_000_000,
        params: {
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "older transcript" },
          },
        },
      })}\n`,
    );

    const reader = new GrokSessionReader({ sessionsDir, projectPath });
    const loaded = await reader.getSession(
      sessionId,
      toUrlProjectId(projectPath),
    );
    if (loaded?.data.provider !== "grok") {
      throw new Error("Expected a Grok session");
    }
    expect(loaded.data.session.messages[0]?.uuid).toBe("grok-0-assistant-text");
  });
});

describe("GrokSessionReader provider children", () => {
  it("lists parent/subagents metas and hides child dirs from top-level lists", async () => {
    const root = mkdtempSync(join(tmpdir(), "grok-reader-children-"));
    tempRoots.push(root);
    const sessionsDir = join(root, "sessions");
    const projectPath = join(root, "project");
    const encoded = encodeURIComponent(projectPath);
    const parentId = "grok-parent-1";
    const childId = "grok-child-1";
    const parentDir = join(sessionsDir, encoded, parentId);
    const childDir = join(sessionsDir, encoded, childId);
    mkdirSync(projectPath, { recursive: true });
    mkdirSync(join(parentDir, "subagents", childId), { recursive: true });
    mkdirSync(childDir, { recursive: true });
    writeFileSync(
      join(parentDir, "summary.json"),
      JSON.stringify({
        info: { id: parentId, cwd: projectPath },
        created_at: "2026-08-16T00:00:00.000Z",
        updated_at: "2026-08-16T00:02:00.000Z",
        generated_title: "Parent turn",
        num_messages: 2,
        current_model_id: "grok-4.6",
      }),
    );
    writeFileSync(join(parentDir, "updates.jsonl"), "");
    writeFileSync(
      join(parentDir, "subagents", childId, "meta.json"),
      JSON.stringify({
        subagent_id: childId,
        parent_session_id: parentId,
        child_session_id: childId,
        subagent_type: "explore",
        description: "Search the repo",
        status: "completed",
        started_at: "2026-08-16T00:00:10.000Z",
        completed_at: "2026-08-16T00:01:40.000Z",
      }),
    );
    writeFileSync(
      join(childDir, "summary.json"),
      JSON.stringify({
        info: { id: childId, cwd: projectPath },
        created_at: "2026-08-16T00:00:10.000Z",
        updated_at: "2026-08-16T00:01:40.000Z",
        generated_title: "Search the repo",
        num_messages: 1,
        current_model_id: "grok-4.6",
      }),
    );
    writeFileSync(
      join(childDir, "updates.jsonl"),
      `${JSON.stringify({
        timestamp: 1_775_000_100,
        params: {
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "Found two matches." },
          },
        },
      })}\n`,
    );

    const reader = new GrokSessionReader({ sessionsDir, projectPath });
    const projectId = toUrlProjectId(projectPath);

    await expect(reader.listSessions(projectId)).resolves.toEqual([
      expect.objectContaining({ id: parentId, title: "Parent turn" }),
    ]);
    await expect(reader.listSessionFiles(sessionsDir)).resolves.toEqual([
      expect.objectContaining({ sessionId: parentId }),
    ]);
    await expect(reader.listProviderChildSessions(parentId)).resolves.toEqual([
      {
        id: childId,
        parentSessionId: parentId,
        title: "Search the repo",
        agentType: "explore",
        updatedAt: "2026-08-16T00:01:40.000Z",
      },
    ]);

    const agent = await reader.getAgentSession(childId, parentId);
    expect(agent?.status).toBe("completed");
    expect(agent?.agentType).toBe("explore");
    expect(agent?.description).toBe("Search the repo");
    expect(agent?.messages.length).toBeGreaterThan(0);
  });
});

describe("GrokSessionReader retirement", () => {
  function fixture() {
    const root = mkdtempSync(join(tmpdir(), "grok-reader-retirement-"));
    tempRoots.push(root);
    const sessionsDir = join(root, "sessions");
    const projectPath = join(root, "project");
    for (const id of ["first", "second"]) {
      const directory = join(sessionsDir, encodeURIComponent(projectPath), id);
      mkdirSync(directory, { recursive: true });
      writeFileSync(
        join(directory, "summary.json"),
        JSON.stringify({ info: { id, cwd: projectPath }, generated_title: id }),
      );
      writeFileSync(
        join(directory, "updates.jsonl"),
        JSON.stringify({
          params: {
            update: {
              sessionUpdate: "user_message_chunk",
              content: { type: "text", text: id },
            },
          },
        }) + "\n",
      );
    }
    return {
      reader: new GrokSessionReader({ sessionsDir, projectPath }),
      projectId: toUrlProjectId(projectPath),
    };
  }

  it.each(["history", "summary", "file", "project"] as const)(
    "discards a real pending %s read after retirement",
    async (method) => {
      const { reader, projectId } = fixture();
      expect(await reader.getSession("first", projectId)).not.toBeNull();
      const hooks = reader as unknown as {
        readStoredSummary(info: unknown): Promise<unknown>;
        loadUpdatesSnapshot(info: unknown): Promise<unknown>;
      };
      if (method === "history") {
        const read = hooks.loadUpdatesSnapshot.bind(reader);
        hooks.loadUpdatesSnapshot = (info) => {
          const pending = read(info);
          void pending.then(() => reader.close());
          return pending;
        };
      } else {
        const read = hooks.readStoredSummary.bind(reader);
        hooks.readStoredSummary = (info) => {
          const pending = read(info);
          void pending.then(() => reader.close());
          return pending;
        };
      }
      try {
        const result = await (method === "history"
          ? reader.getSession("first", projectId)
          : method === "summary"
            ? reader.getSessionSummary("first", projectId)
            : method === "file"
              ? reader.getSessionFilePath("first")
              : reader.getSessionProjectPath("first"));
        expect(result).toBeNull();
        expect(await reader.listSessions(projectId)).toEqual([]);
      } finally {
        reader.close();
      }
    },
  );

  it("discards a partial list when the next real summary read retires the reader", async () => {
    const { reader, projectId } = fixture();
    const hooks = reader as unknown as {
      readStoredSummary(info: unknown): Promise<unknown>;
    };
    const read = hooks.readStoredSummary.bind(reader);
    let count = 0;
    hooks.readStoredSummary = async (info) => {
      const result = await read(info);
      if (++count === 2) reader.close();
      return result;
    };
    try {
      expect(await reader.listSessions(projectId)).toEqual([]);
      expect(count).toBe(2);
    } finally {
      reader.close();
    }
  });
});

describe("Grok canonical native acquisition", () => {
  it.each([false, true])(
    "refuses a foreign canonical id under the requested directory (warmed=%s)",
    async (warmed) => {
      const root = mkdtempSync(join(tmpdir(), "grok-native-collision-"));
      tempRoots.push(root);
      const sessionsDir = join(root, "sessions"),
        projectPath = join(root, "project"),
        directory = join(
          sessionsDir,
          encodeURIComponent(projectPath),
          "native-N",
        );
      mkdirSync(directory, { recursive: true });
      const summaryPath = join(directory, "summary.json");
      const writeSummary = (id: string) =>
        writeFileSync(
          summaryPath,
          JSON.stringify({
            info: { id, cwd: projectPath },
            generated_title: id,
          }),
        );
      writeSummary(warmed ? "native-N" : "native-M");
      writeFileSync(
        join(directory, "updates.jsonl"),
        JSON.stringify({
          params: {
            update: {
              sessionUpdate: "user_message_chunk",
              content: { type: "text", text: "foreign native history" },
            },
          },
        }) + "\n",
      );
      const reader = new GrokSessionReader({ sessionsDir, projectPath }),
        projectId = toUrlProjectId(projectPath);
      const bound = new BoundSessionReads({ readerFactory: () => reader });
      const input = {
        sessionId: parseYaSessionId("public-P"),
        provider: "grok" as const,
        native: nativeSessionRef(
          "grok",
          sessionsDir,
          parseNativeSessionId("native-N"),
        ),
        transcriptProject: {
          id: projectId,
          path: projectPath,
          name: "fixture",
          sessionDir: sessionsDir,
          provider: "grok" as const,
        },
        projectId,
      };
      try {
        if (warmed) {
          expect(await bound.read(input)).not.toBeNull();
          writeSummary("native-M");
        }
        // Repeating forces the post-invalidation scan as well as the warmed path.
        for (let attempt = 0; attempt < 2; attempt++) {
          expect(await bound.read(input)).toBeNull();
          expect(
            await reader.getSessionSummary("native-N", projectId),
          ).toBeNull();
          expect(await reader.getSessionFilePath("native-N")).toBeNull();
          expect(await reader.getSessionProjectPath("native-N")).toBeNull();
          expect(
            await reader.getNativeSessionRef(parseNativeSessionId("native-N")),
          ).toBeNull();
          expect(await reader.listProviderChildSessions("native-N")).toEqual(
            [],
          );
          expect(await reader.getAgentSession("child", "native-N")).toBeNull();
        }
        expect(
          (await reader.getSession("native-M", projectId))?.summary.id,
        ).toBe("native-M");
      } finally {
        reader.close();
      }
    },
  );
});
