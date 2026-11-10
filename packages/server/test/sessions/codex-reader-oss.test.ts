import { randomUUID } from "node:crypto";
import {
  appendFile,
  mkdir,
  rm,
  rename,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as zlib from "node:zlib";
import type { CodexSessionEntry, UrlProjectId } from "@yep-anywhere/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionIndexService } from "../../src/indexes/SessionIndexService.js";
import { SqliteSessionSummaryIndex } from "../../src/indexes/SqliteSessionSummaryIndex.js";
import { getLogger } from "../../src/logging/logger.js";
import { encodeProjectId } from "../../src/projects/paths.js";
import { CodexSessionReader } from "../../src/sessions/codex-reader.js";
import { findSessionListSummaryAcrossProviders } from "../../src/sessions/provider-resolution.js";
import {
  getCodexMessageSourceByteCursor,
  normalizeSession,
  parseCodexSourceByteCursor,
} from "../../src/sessions/normalization.js";
import type { SummaryParserClient } from "../../src/sessions/summary-parser-worker-client.js";
import type { SessionSummary } from "../../src/supervisor/types.js";
import { getCodexRolloutActivityTimeMs } from "../../src/utils/codexRolloutFiles.js";
import { isZstdJsonlSupported } from "../../src/utils/jsonl.js";
import {
  closeTestDiscoveryDatabases,
  openTestDiscoveryDatabase,
} from "../utils/session-metadata-database.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const zstdCompressSync = (
  zlib as typeof zlib & {
    zstdCompressSync?: (buffer: Buffer) => Buffer;
  }
).zstdCompressSync;
const hasNativeZstd =
  typeof zstdCompressSync === "function" && isZstdJsonlSupported();
const itIfNativeZstd = hasNativeZstd ? it : it.skip;
const itIfNoNativeZstd = hasNativeZstd ? it.skip : it;
const itIfWindows = process.platform === "win32" ? it : it.skip;

interface CodexEntryReadInternals {
  entryReadOwners: Map<string, { joinedCallers: number }>;
  readCompactTailSnapshot(...args: unknown[]): Promise<unknown>;
  buildSessionSummaryFromEntries(
    sessionId: string,
    projectId: UrlProjectId,
    entries: CodexSessionEntry[],
    transcriptSnapshotUpdatedAt: string,
  ): Promise<SessionSummary | null>;
  readFileRange(
    filePath: string,
    start: number,
    length: number,
  ): Promise<Buffer>;
}

function zstdCompressed(content: string): Buffer {
  if (!zstdCompressSync) {
    throw new Error("zstd compression is unavailable in this Node.js");
  }
  return zstdCompressSync(Buffer.from(content, "utf-8"));
}

describe("CodexSessionReader - OSS Support", () => {
  let testDir: string;
  let reader: CodexSessionReader;
  let extraTempDirs: string[];

  beforeEach(async () => {
    testDir = join(tmpdir(), `codex-reader-oss-test-${randomUUID()}`);
    extraTempDirs = [];
    await mkdir(testDir, { recursive: true });
    reader = new CodexSessionReader({ sessionsDir: testDir });
  });

  afterEach(async () => {
    closeTestDiscoveryDatabases();
    await Promise.all(
      [testDir, ...extraTempDirs].map((dir) =>
        rm(dir, { recursive: true, force: true }),
      ),
    );
  });

  const createSessionFile = async (
    sessionId: string,
    provider: string | undefined,
    model: string | undefined,
    originator?: string,
    tokenUsage?: {
      totalInputTokens: number;
      totalCachedInputTokens?: number;
      lastInputTokens?: number;
      lastCachedInputTokens?: number;
      modelContextWindow?: number;
    },
  ) => {
    const metaPayload = {
      id: sessionId,
      cwd: "/test/project",
      timestamp: new Date().toISOString(),
      ...(provider ? { model_provider: provider } : {}),
      ...(originator ? { originator } : {}),
    };

    const lines = [
      JSON.stringify({
        type: "session_meta",
        timestamp: new Date().toISOString(),
        payload: metaPayload,
      }),
    ];

    if (model) {
      lines.push(
        JSON.stringify({
          type: "turn_context",
          timestamp: new Date().toISOString(),
          payload: { model },
        }),
      );
    }

    // Add a user message so it's a valid session with messages
    lines.push(
      JSON.stringify({
        type: "event_msg",
        timestamp: new Date().toISOString(),
        payload: {
          type: "user_message",
          message: "Hello world",
        },
      }),
    );

    if (tokenUsage) {
      lines.push(
        JSON.stringify({
          type: "event_msg",
          timestamp: new Date().toISOString(),
          payload: {
            type: "token_count",
            info: {
              total_token_usage: {
                input_tokens: tokenUsage.totalInputTokens,
                cached_input_tokens: tokenUsage.totalCachedInputTokens ?? 0,
                output_tokens: 10,
                total_tokens: tokenUsage.totalInputTokens + 10,
              },
              ...(tokenUsage.lastInputTokens !== undefined && {
                last_token_usage: {
                  input_tokens: tokenUsage.lastInputTokens,
                  cached_input_tokens: tokenUsage.lastCachedInputTokens ?? 0,
                  output_tokens: 5,
                  total_tokens: tokenUsage.lastInputTokens + 5,
                },
              }),
              model_context_window: tokenUsage.modelContextWindow ?? 258400,
            },
          },
        }),
      );
    }

    await writeFile(
      join(testDir, `${sessionId}.jsonl`),
      `${lines.join("\n")}\n`,
    );
  };

  it("discovers recent async questions without loading transcript history", async () => {
    const sessionId = "questions-without-open-transcript";
    await createSessionFile(sessionId, "openai", "gpt-6-astra");
    const filePath = join(testDir, `${sessionId}.jsonl`);
    const event = (payload: object) =>
      JSON.stringify({
        type: "event_msg",
        timestamp: new Date().toISOString(),
        payload,
      });
    const question = event({
      type: "item_completed",
      item: {
        type: "AgentMessage",
        id: "question-source",
        delivery: "async",
        content: [{ type: "Text", text: "Which path?" }],
        questions: [{ title: "Which path?", options: ["First", "Second"] }],
      },
    });
    await appendFile(
      filePath,
      `\n${event({ type: "agent_message", message: "x".repeat(2 * 1024 * 1024) })}\n${question}\n`,
    );
    const projectId = "test-project" as UrlProjectId;
    const first = await reader.getSessionListSummary(sessionId, projectId);
    expect(first?.asyncQuestions).toEqual({
      questions: [
        {
          messageId: "question-source",
          index: 0,
          title: "Which path?",
          age: 0,
        },
      ],
      omitted: true,
    });
    expect(first).not.toHaveProperty("messageCount");
    expect(reader.getEntryCacheStats().entries).toBe(0);
    await appendFile(
      filePath,
      `${event({ type: "user_message", message: "Keep working" })}\n`,
    );
    const next = await reader.getSessionListSummary(sessionId, projectId);
    expect(next?.asyncQuestions?.questions[0]?.age).toBe(1);
    expect(first?.asyncQuestions?.questions[0]?.age).toBe(0);
    const full = await reader.getSessionSummary(sessionId, projectId);
    expect(full?.asyncQuestions).toEqual(next?.asyncQuestions);
    await appendFile(
      filePath,
      `${event({ type: "user_message", message: "> Which path?\n\nSecond" })}\n`,
    );
    const answered = await reader.getSessionListSummary(sessionId, projectId);
    expect(answered?.asyncQuestions?.questions).toEqual([]);
    await appendFile(
      filePath,
      `${question.replace("question-source", "repeated-source")}\n`,
    );
    const repeated = await reader.getSessionListSummary(sessionId, projectId);
    expect(repeated?.asyncQuestions?.questions).toEqual([
      {
        messageId: "repeated-source",
        index: 0,
        title: "Which path?",
        age: 0,
      },
    ]);
    await appendFile(
      filePath,
      `${event({
        type: "item_completed",
        item: {
          type: "UserMessage",
          id: "modern-reply",
          content: [{ type: "text", text: "> Which path?\n\nFirst" }],
        },
      })}\n`,
    );
    const modern = await reader.getSessionListSummary(sessionId, projectId);
    expect(modern?.asyncQuestions?.questions).toEqual([]);
  });

  it("adds question previews to a fresh indexed row without rereading its head", async () => {
    const sessionId = "indexed-before-question-previews";
    await createSessionFile(sessionId, "openai", "gpt-6-astra");
    const projectId = "test-project" as UrlProjectId;
    const dataDir = join(testDir, "indexes");
    const initialDatabase = openTestDiscoveryDatabase(testDir);
    const initialIndex = new SessionIndexService({
      database: initialDatabase,
      dataDir,
    });
    await initialIndex.initialize();
    const indexed = await initialIndex.getSessionSummaryWithCache(
      testDir,
      projectId,
      sessionId,
      reader,
    );
    expect(indexed).not.toBeNull();
    initialIndex.dispose();
    const scope = reader.getIndexScopeKey(testDir);
    const store = new SqliteSessionSummaryIndex(initialDatabase);
    const persisted = store.read(scope)!;
    delete persisted.sessions[sessionId]!.asyncQuestions;
    store.save(scope, { ...persisted, version: 5 });
    const index = new SessionIndexService({
      database: openTestDiscoveryDatabase(testDir),
      dataDir,
    });
    await index.initialize();
    const freshReader = new CodexSessionReader({ sessionsDir: testDir });
    try {
      const resolved = await findSessionListSummaryAcrossProviders(
        {
          id: projectId,
          path: "/test/project",
          name: "test",
          sessionCount: 1,
          sessionDir: testDir,
          activeOwnedCount: 0,
          activeExternalCount: 0,
          lastActivity: null,
          provider: "codex",
        },
        sessionId,
        projectId,
        {
          readerFactory: () => freshReader,
          codexReaderFactory: () => freshReader,
          sessionIndexService: index,
        },
        "codex",
      );
      const summary = resolved?.summary;
      expect(summary?.title).toBe(indexed!.title);
      expect(summary?.asyncQuestions).toEqual({
        questions: [],
        omitted: false,
      });
      expect(freshReader.getLastSummaryStreamMetrics()).toBeNull();
      expect(summary).not.toHaveProperty("messageCount");
      expect(store.read(scope)).toEqual(persisted);
    } finally {
      index.dispose();
      await freshReader.close();
    }
  });

  it("identifies session as codex-oss when model_provider is ollama", async () => {
    const sessionId = "oss-session-1";
    await createSessionFile(sessionId, "ollama", "mistral");

    const summary = await reader.getSessionSummary(
      sessionId,
      "test-project" as UrlProjectId,
    );
    expect(summary?.provider).toBe("codex-oss");

    const session = await reader.getSession(
      sessionId,
      "test-project" as UrlProjectId,
    );
    expect(session?.data.provider).toBe("codex-oss");
  });

  it("does not retain full entries for summary-only reads", async () => {
    const sessionId = "summary-cache-session";
    await createSessionFile(sessionId, "openai", "gpt-5");

    expect(reader.getEntryCacheStats().sessions).toBe(0);

    const summary = await reader.getSessionSummary(
      sessionId,
      "test-project" as UrlProjectId,
    );
    expect(summary?.id).toBe(sessionId);
    expect(reader.getEntryCacheStats()).toMatchObject({
      sessions: 0,
      entries: 0,
      sourceBytes: 0,
    });

    const session = await reader.getSession(
      sessionId,
      "test-project" as UrlProjectId,
    );
    expect(session?.data.session.entries.length).toBeGreaterThan(0);
    expect(reader.getEntryCacheStats()).toMatchObject({
      sessions: 1,
      sourceBytes: expect.any(Number),
    });
  });

  itIfWindows(
    "advances list recency while a Windows rollout mtime stays fixed",
    async () => {
      const sessionId = "windows-open-rollout";
      const filePath = join(testDir, `${sessionId}.jsonl`);
      const fixedTime = new Date("2026-01-01T00:00:00.000Z");
      await createSessionFile(sessionId, "openai", "gpt-5");
      await utimes(filePath, fixedTime, fixedTime);

      const before = await reader.getSessionListSummary(
        sessionId,
        "test-project" as UrlProjectId,
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
      await appendFile(
        filePath,
        `${JSON.stringify({
          type: "event_msg",
          timestamp: new Date().toISOString(),
          payload: { type: "agent_message", message: "More output" },
        })}\n`,
      );
      await utimes(filePath, fixedTime, fixedTime);
      const afterStats = await stat(filePath);

      const after = await reader.getSessionListSummary(
        sessionId,
        "test-project" as UrlProjectId,
      );

      expect(afterStats.mtimeMs).toBe(fixedTime.getTime());
      expect(Date.parse(after?.updatedAt ?? "")).toBe(
        Math.trunc(afterStats.ctimeMs),
      );
      expect(Date.parse(after?.updatedAt ?? "")).toBeGreaterThan(
        Date.parse(before?.updatedAt ?? ""),
      );
    },
  );

  it("streams summary state without full entry retention", async () => {
    const sessionId = "summary-stream-session";
    const now = new Date().toISOString();
    const responseUser = {
      type: "response_item",
      timestamp: now,
      payload: {
        id: "msg-user-1",
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "response title" }],
      },
    };
    const lines = [
      JSON.stringify({
        type: "session_meta",
        timestamp: now,
        payload: {
          id: sessionId,
          cwd: "/test/project",
          timestamp: now,
          forked_from_id: "parent-session",
          model_provider: "local",
          originator: "yep-anywhere",
          cli_version: "1.2.3",
          source: "exec",
        },
      }),
      JSON.stringify({
        type: "turn_context",
        timestamp: now,
        payload: {
          cwd: "/test/project",
          approval_policy: "on-request",
          sandbox_policy: {
            type: "workspace-write",
            network_access: true,
            exclude_tmpdir_env_var: false,
            exclude_slash_tmp: true,
          },
          model: "gpt-4o",
        },
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: now,
        payload: {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "<environment_context>\nignored" },
          ],
        },
      }),
      JSON.stringify(responseUser),
      JSON.stringify({
        ...responseUser,
        payload: { ...responseUser.payload, id: "msg-user-2" },
      }),
      JSON.stringify({
        type: "event_msg",
        timestamp: now,
        payload: {
          type: "user_message",
          message: "response title",
        },
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: now,
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "visible response" }],
        },
      }),
      JSON.stringify({
        type: "turn_context",
        timestamp: now,
        payload: {
          cwd: "/test/project",
          approval_policy: "never",
          model: "qwen2.5-coder",
        },
      }),
      JSON.stringify({
        type: "event_msg",
        timestamp: now,
        payload: {
          type: "token_count",
          info: {
            last_token_usage: {
              input_tokens: 120,
              cached_input_tokens: 0,
              output_tokens: 10,
              total_tokens: 130,
            },
            model_context_window: 1000,
          },
        },
      }),
      JSON.stringify({
        type: "event_msg",
        timestamp: now,
        payload: {
          type: "token_count",
          info: {
            last_token_usage: {
              input_tokens: 0,
              cached_input_tokens: 0,
              output_tokens: 0,
              total_tokens: 0,
            },
            model_context_window: 1000,
          },
        },
      }),
    ];

    await writeFile(
      join(testDir, `${sessionId}.jsonl`),
      `${lines.join("\n")}\n`,
    );

    const summary = await reader.getSessionSummary(
      sessionId,
      "test-project" as UrlProjectId,
    );

    expect(summary).toMatchObject({
      id: sessionId,
      title: "response title",
      fullTitle: "response title",
      messageCount: 2,
      provider: "codex-oss",
      model: "qwen2.5-coder",
      forkedFromSessionId: "parent-session",
      originator: "yep-anywhere",
      cliVersion: "1.2.3",
      source: "exec",
      approvalPolicy: "on-request",
      sandboxPolicy: {
        type: "workspace-write",
        networkAccess: true,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: true,
      },
      contextUsage: {
        inputTokens: 120,
        percentage: 12,
        contextWindow: 1000,
      },
    });
    expect(reader.getEntryCacheStats()).toMatchObject({
      sessions: 0,
      entries: 0,
      sourceBytes: 0,
    });
    expect(reader.getLastSummaryStreamMetrics()).toMatchObject({
      event: "codex_summary_stream",
      sessionId,
      compressed: false,
      lineCount: lines.length,
      parsedEntries: lines.length,
      dedupedEntries: lines.length,
      skippedDuplicateEntries: 0,
      entryCache: {
        sessions: 0,
        entries: 0,
        sourceBytes: 0,
      },
    });

    const full = await reader.getSession(
      sessionId,
      "test-project" as UrlProjectId,
    );
    expect(full?.summary).toMatchObject({
      title: summary?.title,
      fullTitle: summary?.fullTitle,
      messageCount: summary?.messageCount,
      provider: summary?.provider,
      model: summary?.model,
      forkedFromSessionId: summary?.forkedFromSessionId,
      contextUsage: summary?.contextUsage,
    });
  });

  it("recovers launch settings from the latest Codex turn context", async () => {
    const sessionId = "recovered-launch-settings";
    const now = new Date().toISOString();
    const lines = [
      JSON.stringify({
        type: "session_meta",
        timestamp: now,
        payload: {
          id: sessionId,
          cwd: "/test/project",
          timestamp: now,
          model_provider: "openai",
        },
      }),
      JSON.stringify({
        type: "turn_context",
        timestamp: now,
        payload: {
          cwd: "/test/project",
          approval_policy: "on-request",
          sandbox_policy: { type: "workspace-write" },
          model: "gpt-5.4",
          effort: "none",
        },
      }),
      JSON.stringify({
        type: "turn_context",
        timestamp: now,
        payload: {
          cwd: "/test/project",
          approval_policy: "never",
          sandbox_policy: { type: "danger-full-access" },
          model: "gpt-5.6-sol",
          effort: "xhigh",
        },
      }),
    ];
    await writeFile(
      join(testDir, `${sessionId}.jsonl`),
      `${lines.join("\n")}\n`,
    );

    await expect(reader.getRecoveredLaunchSettings(sessionId)).resolves.toEqual(
      {
        permissionMode: "bypassPermissions",
        requestedModel: "gpt-5.6-sol",
        thinking: { type: "adaptive", display: "summarized" },
        effort: "xhigh",
      },
    );
    expect(reader.getEntryCacheStats()).toEqual({
      sessions: 0,
      entries: 0,
      sourceBytes: 0,
      partialLineBytes: 0,
    });
  });

  it.each([
    {
      name: "Plan and disabled thinking",
      approvalPolicy: "on-request",
      sandboxType: "read-only",
      effort: "none",
      expected: {
        permissionMode: "plan",
        requestedModel: "gpt-5",
        thinking: { type: "disabled" },
      },
    },
    {
      name: "ambiguous workspace write",
      approvalPolicy: "on-request",
      sandboxType: "workspace-write",
      effort: "minimal",
      expected: {
        permissionMode: "default",
        requestedModel: "gpt-5",
      },
    },
    {
      name: "incomplete Bypass evidence",
      approvalPolicy: "never",
      sandboxType: "workspace-write",
      effort: undefined,
      expected: {
        permissionMode: "default",
        requestedModel: "gpt-5",
      },
    },
  ])(
    "recovers $name conservatively",
    async ({ approvalPolicy, sandboxType, effort, expected }) => {
      const sessionId = `recovered-${sandboxType}-${approvalPolicy}-${effort ?? "unset"}`;
      const now = new Date().toISOString();
      const lines = [
        JSON.stringify({
          type: "session_meta",
          timestamp: now,
          payload: {
            id: sessionId,
            cwd: "/test/project",
            timestamp: now,
            model_provider: "openai",
          },
        }),
        JSON.stringify({
          type: "turn_context",
          timestamp: now,
          payload: {
            cwd: "/test/project",
            approval_policy: approvalPolicy,
            sandbox_policy: { type: sandboxType },
            model: "gpt-5",
            ...(effort ? { effort } : {}),
          },
        }),
      ];
      await writeFile(
        join(testDir, `${sessionId}.jsonl`),
        `${lines.join("\n")}\n`,
      );

      await expect(
        reader.getRecoveredLaunchSettings(sessionId),
      ).resolves.toEqual(expected);
    },
  );

  it("skips plugin-prefixed startup instructions when deriving titles", async () => {
    const sessionId = "plugin-prefixed-startup-title";
    const now = new Date().toISOString();
    const startupInstructions = [
      "<recommended_plugins>",
      "- GitHub (github@openai-curated-remote)",
      "</recommended_plugins>",
      "# AGENTS.md instructions for /test/project",
      "<INSTRUCTIONS>",
      "Follow the project instructions.",
      "</INSTRUCTIONS>",
    ].join("\n");
    const lines = [
      JSON.stringify({
        type: "session_meta",
        timestamp: now,
        payload: {
          id: sessionId,
          cwd: "/test/project",
          timestamp: now,
          model_provider: "openai",
        },
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: now,
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: startupInstructions }],
        },
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: now,
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "actual first turn" }],
        },
      }),
    ];
    await writeFile(
      join(testDir, `${sessionId}.jsonl`),
      `${lines.join("\n")}\n`,
    );

    const headSummary = await reader.getSessionSummary(
      sessionId,
      "test-project" as UrlProjectId,
      { readMode: "head" },
    );
    expect(headSummary).toMatchObject({
      title: "actual first turn",
      fullTitle: "actual first turn",
    });

    const session = await reader.getSession(
      sessionId,
      "test-project" as UrlProjectId,
    );
    expect(session?.summary).toMatchObject({
      title: "actual first turn",
      fullTitle: "actual first turn",
    });
  });

  it("uses user-turn provenance when plugins are followed by environment", async () => {
    const sessionId = "plugin-environment-startup-title";
    const now = new Date().toISOString();
    const actualPrompt = "actual first turn";
    const lines = [
      JSON.stringify({
        type: "session_meta",
        timestamp: now,
        payload: {
          id: sessionId,
          cwd: "/test/project",
          timestamp: now,
          model_provider: "openai",
          cli_version: "0.144.1",
          originator: "yep-anywhere",
        },
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: now,
        payload: {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: "<recommended_plugins>\n- GitHub\n</recommended_plugins>",
            },
            {
              type: "input_text",
              text: "<environment_context>\n<cwd>/repo</cwd>\n</environment_context>",
            },
          ],
        },
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: now,
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: actualPrompt }],
        },
      }),
      JSON.stringify({
        type: "event_msg",
        timestamp: now,
        payload: { type: "user_message", message: actualPrompt },
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: now,
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "visible response" }],
        },
      }),
    ];
    await writeFile(
      join(testDir, `${sessionId}.jsonl`),
      `${lines.join("\n")}\n`,
    );

    const headSummary = await reader.getSessionSummary(
      sessionId,
      "test-project" as UrlProjectId,
      { readMode: "head" },
    );
    expect(headSummary).toMatchObject({
      title: actualPrompt,
      fullTitle: actualPrompt,
      messageCount: 1,
    });

    const session = await reader.getSession(
      sessionId,
      "test-project" as UrlProjectId,
    );
    expect(session?.summary).toMatchObject({
      title: actualPrompt,
      fullTitle: actualPrompt,
      messageCount: 2,
    });
  });

  it("can read a cheap head summary without scanning trailing transcript", async () => {
    const sessionId = "cheap-summary-session";
    const now = new Date().toISOString();
    const trailingMessages = Array.from({ length: 250 }, (_, index) =>
      JSON.stringify({
        type: "response_item",
        timestamp: now,
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: `bulk ${index}` }],
        },
      }),
    );
    const lines = [
      JSON.stringify({
        type: "session_meta",
        timestamp: now,
        payload: {
          id: sessionId,
          cwd: "/test/project",
          timestamp: now,
          model_provider: "openai",
        },
      }),
      JSON.stringify({
        type: "turn_context",
        timestamp: now,
        payload: {
          cwd: "/test/project",
          approval_policy: "never",
          model: "gpt-5",
        },
      }),
      JSON.stringify({
        type: "event_msg",
        timestamp: now,
        payload: {
          type: "user_message",
          message: "cheap summary title",
        },
      }),
      ...trailingMessages,
      JSON.stringify({
        type: "turn_context",
        timestamp: now,
        payload: {
          cwd: "/test/project",
          model: "late-model",
        },
      }),
      JSON.stringify({
        type: "event_msg",
        timestamp: now,
        payload: {
          type: "token_count",
          info: {
            last_token_usage: {
              input_tokens: 900,
              cached_input_tokens: 0,
              output_tokens: 10,
              total_tokens: 910,
            },
            model_context_window: 1000,
          },
        },
      }),
    ];

    await writeFile(
      join(testDir, `${sessionId}.jsonl`),
      `${lines.join("\n")}\n`,
    );

    const cheap = await reader.getSessionSummary(
      sessionId,
      "test-project" as UrlProjectId,
      { readMode: "head" },
    );

    expect(cheap).toMatchObject({
      id: sessionId,
      title: "cheap summary title",
      fullTitle: "cheap summary title",
      messageCount: 1,
      provider: "codex",
      model: "gpt-5",
      approvalPolicy: "never",
    });
    expect(cheap?.contextUsage).toBeUndefined();
    expect(reader.getLastSummaryStreamMetrics()).toMatchObject({
      event: "codex_summary_stream",
      readMode: "head",
      lineCount: 3,
      parsedEntries: 3,
      stoppedEarly: true,
      stopReason: "head_complete",
    });

    const listSummary = await reader.getSessionListSummary(
      sessionId,
      "test-project" as UrlProjectId,
    );
    expect(listSummary).toMatchObject({
      id: sessionId,
      projectId: "test-project",
      title: "cheap summary title",
    });
    expect(Object.keys(listSummary ?? {}).sort()).toEqual([
      "asyncQuestions",
      "createdAt",
      "fullTitle",
      "id",
      "projectId",
      "provider",
      "title",
      "updatedAt",
    ]);

    const full = await reader.getSessionSummary(
      sessionId,
      "test-project" as UrlProjectId,
    );

    expect(full).toMatchObject({
      title: "cheap summary title",
      messageCount: 251,
      model: "late-model",
      contextUsage: {
        inputTokens: 900,
        percentage: 90,
        contextWindow: 1000,
      },
    });
    expect(reader.getLastSummaryStreamMetrics()).toMatchObject({
      event: "codex_summary_stream",
      readMode: "full",
      lineCount: lines.length,
      stoppedEarly: false,
      stopReason: "eof",
    });
  });

  it("coalesces full summary parses for the same Codex file version", async () => {
    const sessionId = "coalesced-full-summary";
    const filePath = join(testDir, `${sessionId}.jsonl`);
    const now = new Date().toISOString();
    await writeFile(
      filePath,
      `${[
        JSON.stringify({
          type: "session_meta",
          timestamp: now,
          payload: {
            id: sessionId,
            cwd: "/test/project",
            timestamp: now,
            model_provider: "openai",
          },
        }),
        JSON.stringify({
          type: "event_msg",
          timestamp: now,
          payload: {
            type: "user_message",
            message: "Coalesce this full parse",
          },
        }),
      ].join("\n")}\n`,
    );

    let releaseParse!: () => void;
    const parseGate = new Promise<void>((resolve) => {
      releaseParse = resolve;
    });
    let firstParseStarted!: () => void;
    const firstParseStart = new Promise<void>((resolve) => {
      firstParseStarted = resolve;
    });
    const parse = vi.fn<SummaryParserClient["parse"]>(
      async (request, inProcessParser) => {
        firstParseStarted();
        await parseGate;
        const summary = await inProcessParser?.(request);
        return {
          summary: summary ?? null,
          status: summary ? "ok" : "empty",
          source: "worker",
        };
      },
    );
    const coalescingReader = new CodexSessionReader({
      sessionsDir: testDir,
      summaryParserWorkerMode: "required",
      summaryParserClient: { parse } as unknown as SummaryParserClient,
    });
    const projectId = "test-project" as UrlProjectId;

    const first = coalescingReader.getSessionSummary(sessionId, projectId);
    await firstParseStart;
    const second = coalescingReader.getSessionSummary(sessionId, projectId);
    releaseParse();
    const [firstSummary, secondSummary] = await Promise.all([first, second]);

    expect(parse).toHaveBeenCalledTimes(1);
    expect(firstSummary?.title).toBe("Coalesce this full parse");
    expect(secondSummary?.title).toBe("Coalesce this full parse");
    expect(firstSummary).not.toBe(secondSummary);

    await coalescingReader.getSessionSummary(sessionId, projectId);
    expect(parse).toHaveBeenCalledTimes(1);

    await appendFile(
      filePath,
      `${JSON.stringify({
        type: "event_msg",
        timestamp: new Date().toISOString(),
        payload: {
          type: "agent_message",
          message: "A new version should parse again.",
        },
      })}\n`,
    );
    await coalescingReader.getSessionSummary(sessionId, projectId);
    expect(parse).toHaveBeenCalledTimes(2);
  });

  itIfNativeZstd("loads zstd-compressed rollout files", async () => {
    const sessionId = "zstd-rollout";
    const now = new Date().toISOString();
    const lines = [
      JSON.stringify({
        type: "session_meta",
        timestamp: now,
        payload: {
          id: sessionId,
          cwd: "/test/project",
          timestamp: now,
          model_provider: "openai",
        },
      }),
      JSON.stringify({
        type: "event_msg",
        timestamp: now,
        payload: {
          type: "user_message",
          message: "Hello compressed history",
        },
      }),
    ];

    await writeFile(
      join(testDir, `${sessionId}.jsonl.zst`),
      zstdCompressed(`${lines.join("\n")}\n`),
    );

    const summaries = await reader.listSessions("test-project" as UrlProjectId);
    const summary = summaries.find((candidate) => candidate.id === sessionId);
    expect(summary).toBeDefined();
    if (!summary) throw new Error("Expected the compressed rollout summary");

    const session = await reader.getSession(
      sessionId,
      "test-project" as UrlProjectId,
      undefined,
      {
        tailCompactions: 2,
        beforeMessageId: "codex-cursor-byte-1",
        summaryHint: summary,
      },
    );
    expect(session?.readWindow).toBeUndefined();
    expect(session?.summary.title).toBe("Hello compressed history");
    expect(session?.data.session.entries).toHaveLength(2);
  });

  itIfNoNativeZstd(
    "skips zstd-compressed rollouts without native zstd",
    async () => {
      const sessionId = "unsupported-zstd-rollout";
      const now = new Date().toISOString();
      const lines = [
        JSON.stringify({
          type: "session_meta",
          timestamp: now,
          payload: {
            id: sessionId,
            cwd: "/test/project",
            timestamp: now,
            model_provider: "openai",
          },
        }),
        JSON.stringify({
          type: "event_msg",
          timestamp: now,
          payload: {
            type: "user_message",
            message: "Hello compressed history",
          },
        }),
      ];

      await writeFile(
        join(testDir, `${sessionId}.jsonl.zst`),
        Buffer.from(`${lines.join("\n")}\n`),
      );

      await expect(
        reader.listSessions("test-project" as UrlProjectId),
      ).resolves.toEqual([]);

      const metrics = reader.getLastScanMetrics();
      expect(metrics).toMatchObject({
        compressedRolloutFiles: 1,
        sessionsParsed: 0,
        failedFiles: 1,
        sessionsReturned: 0,
        discovery: {
          zstdUnsupported: 1,
          firstLineReadsZstd: 0,
          metadataReadFailures: 0,
        },
      });

      await expect(
        reader.getSession(sessionId, "test-project" as UrlProjectId),
      ).resolves.toBeNull();
    },
  );

  it("records reader scan metrics and shared cache hits", async () => {
    const dataDir = join(tmpdir(), `codex-reader-data-${randomUUID()}`);
    extraTempDirs.push(dataDir);
    await createSessionFile("metrics-one", "openai", "gpt-4o");
    await createSessionFile("metrics-two", "openai", "gpt-4o");

    const metricsReader = new CodexSessionReader({
      sessionsDir: testDir,
      dataDir,
      slowLogThresholdMs: 60_000,
    });

    const files = await metricsReader.listSessionFiles(testDir);
    expect(files).toHaveLength(2);

    const missMetrics = metricsReader.getLastScanMetrics();
    expect(missMetrics).toMatchObject({
      sessionsDir: testDir,
      cacheKey: `${testDir}::activeAfter=all`,
      sharedCacheStatus: "miss",
      sessionsDirExists: true,
      rolloutFilesFound: 2,
      rolloutFilesAfterPrecedence: 2,
      plainRolloutFiles: 2,
      compressedRolloutFiles: 0,
      precedenceSkippedCompressed: 0,
      sessionsParsed: 2,
      failedFiles: 0,
      subagentSessionsSkipped: 0,
      sessionsReturned: 2,
      discovery: {
        statCalls: 2,
        discoveryIndexMisses: 2,
        firstLineReadsPlain: 2,
        metadataReadFailures: 0,
      },
    });
    expect(missMetrics?.directoriesVisited).toBeGreaterThanOrEqual(1);
    expect(missMetrics?.durationMs).toBeGreaterThanOrEqual(0);

    const cachedFiles = await metricsReader.listSessionFiles(testDir);
    expect(cachedFiles).toHaveLength(2);

    const hitMetrics = metricsReader.getLastScanMetrics();
    expect(hitMetrics).toMatchObject({
      sessionsDir: testDir,
      sharedCacheStatus: "hit",
      directoriesVisited: 0,
      rolloutFilesFound: 0,
      sessionsParsed: 0,
      failedFiles: 0,
      sessionsReturned: 2,
      discovery: {
        statCalls: 0,
        discoveryIndexHits: 0,
        firstLineReadsPlain: 0,
      },
    });
  });

  it("keeps only the latest settled active-after cutoff scan", async () => {
    const dataDir = join(tmpdir(), `codex-reader-data-${randomUUID()}`);
    extraTempDirs.push(dataDir);
    await createSessionFile("cutoff-one", "openai", "gpt-4o");
    const cutoffReader = new CodexSessionReader({
      sessionsDir: testDir,
      dataDir,
      slowLogThresholdMs: 60_000,
    });
    const status = async (activeAfterMs?: number) => {
      await cutoffReader.listSessionFiles(testDir, { activeAfterMs });
      return cutoffReader.getLastScanMetrics()?.sharedCacheStatus;
    };

    expect(await status()).toBe("miss");
    expect(await status(1)).toBe("miss");
    expect(await status(1)).toBe("hit");
    expect(await status(2)).toBe("miss");
    expect(await status(2)).toBe("hit");
    expect(await status()).toBe("hit");
    expect(await status(1)).toBe("miss");
  });

  it("identifies session as codex-oss when model_provider is local", async () => {
    const sessionId = "oss-session-2";
    await createSessionFile(sessionId, "local", "deepseek-coder");

    const summary = await reader.getSessionSummary(
      sessionId,
      "test-project" as UrlProjectId,
    );
    expect(summary?.provider).toBe("codex-oss");
  });

  it("identifies session as codex when model_provider is openai", async () => {
    const sessionId = "openai-session-1";
    await createSessionFile(sessionId, "openai", "gpt-4o");

    const summary = await reader.getSessionSummary(
      sessionId,
      "test-project" as UrlProjectId,
    );
    expect(summary?.provider).toBe("codex");
  });

  it("falls back to codex-oss based on model name (llama)", async () => {
    const sessionId = "heuristic-session-1";
    await createSessionFile(sessionId, undefined, "llama-3-8b");

    const summary = await reader.getSessionSummary(
      sessionId,
      "test-project" as UrlProjectId,
    );
    expect(summary?.provider).toBe("codex-oss");
  });

  it("falls back to codex-oss based on model name (qwen)", async () => {
    const sessionId = "heuristic-session-2";
    await createSessionFile(sessionId, undefined, "qwen2.5-coder");

    const summary = await reader.getSessionSummary(
      sessionId,
      "test-project" as UrlProjectId,
    );
    expect(summary?.provider).toBe("codex-oss");
  });

  it("defaults to codex when no provider and unknown model", async () => {
    const sessionId = "unknown-session";
    await createSessionFile(sessionId, undefined, "unknown-model");

    const summary = await reader.getSessionSummary(
      sessionId,
      "test-project" as UrlProjectId,
    );
    expect(summary?.provider).toBe("codex");
  });

  it("filters mixed-slash Windows cwd variants as the same project", async () => {
    const sessionId = "windows-mixed-slash";
    await createSessionFile(
      sessionId,
      "openai",
      "gpt-4o",
      undefined,
      undefined,
    );

    await writeFile(
      join(testDir, `${sessionId}.jsonl`),
      `${[
        JSON.stringify({
          type: "session_meta",
          timestamp: new Date().toISOString(),
          payload: {
            id: sessionId,
            cwd: "C:\\Users\\kyle\\Documents\\webvam",
            timestamp: new Date().toISOString(),
            model_provider: "openai",
          },
        }),
        JSON.stringify({
          type: "event_msg",
          timestamp: new Date().toISOString(),
          payload: {
            type: "user_message",
            message: "Hello world",
          },
        }),
      ].join("\n")}\n`,
    );

    const filteredReader = new CodexSessionReader({
      sessionsDir: testDir,
      projectPath: "c:/Users/kyle/Documents/webvam",
    });

    const summaries = await filteredReader.listSessions(
      encodeProjectId("C:/Users/kyle/Documents/webvam"),
    );
    expect(summaries).toHaveLength(1);
    expect(summaries[0].id).toBe(sessionId);
  });

  it("filters Windows cwd case variants as the same project", async () => {
    const upperSessionId = "windows-case-upper";
    const lowerSessionId = "windows-case-lower";
    const now = new Date().toISOString();
    for (const [sessionId, cwd] of [
      [upperSessionId, "C:/Users/sox/Documents/code/mclone"],
      [lowerSessionId, "c:/users/sox/documents/code/mclone"],
    ] as const) {
      await writeFile(
        join(testDir, `${sessionId}.jsonl`),
        `${[
          JSON.stringify({
            type: "session_meta",
            timestamp: now,
            payload: {
              id: sessionId,
              cwd,
              timestamp: now,
              model_provider: "openai",
            },
          }),
          JSON.stringify({
            type: "event_msg",
            timestamp: now,
            payload: {
              type: "user_message",
              message: "Hello world",
            },
          }),
        ].join("\n")}\n`,
      );
    }

    const filteredReader = new CodexSessionReader({
      sessionsDir: testDir,
      projectPath: "C:/Users/sox/Documents/code/mclone",
    });

    const summaries = await filteredReader.listSessions(
      encodeProjectId("C:/Users/sox/Documents/code/mclone"),
    );
    expect(summaries.map((summary) => summary.id).sort()).toEqual([
      lowerSessionId,
      upperSessionId,
    ]);
  });

  it("identifies codex based on model name (gpt-4)", async () => {
    const sessionId = "heuristic-openai";
    await createSessionFile(sessionId, undefined, "gpt-4-turbo");

    const summary = await reader.getSessionSummary(
      sessionId,
      "test-project" as UrlProjectId,
    );
    expect(summary?.provider).toBe("codex");
  });

  it("uses last_token_usage input_tokens for context usage", async () => {
    const sessionId = "context-last-usage";
    await createSessionFile(sessionId, "openai", "gpt-5.3-codex", undefined, {
      totalInputTokens: 236_673,
      totalCachedInputTokens: 116_000,
      lastInputTokens: 120_000,
      lastCachedInputTokens: 118_000,
      modelContextWindow: 258_000,
    });

    const summary = await reader.getSessionSummary(
      sessionId,
      "test-project" as UrlProjectId,
    );

    expect(summary?.contextUsage?.inputTokens).toBe(120_000);
    expect(summary?.contextUsage?.percentage).toBe(47);
    expect(summary?.contextUsage?.contextWindow).toBe(258_000);
  });

  it("falls back to total_token_usage input_tokens when last_token_usage is absent", async () => {
    const sessionId = "context-total-fallback";
    await createSessionFile(sessionId, "openai", "gpt-5.3-codex", undefined, {
      totalInputTokens: 85_000,
      totalCachedInputTokens: 40_000,
      modelContextWindow: 258_000,
    });

    const summary = await reader.getSessionSummary(
      sessionId,
      "test-project" as UrlProjectId,
    );

    expect(summary?.contextUsage?.inputTokens).toBe(85_000);
    expect(summary?.contextUsage?.percentage).toBe(33);
  });

  it("excludes developer messages from messageCount", async () => {
    const sessionId = "developer-filter";
    const now = new Date().toISOString();
    const lines = [
      JSON.stringify({
        type: "session_meta",
        timestamp: now,
        payload: {
          id: sessionId,
          cwd: "/test/project",
          timestamp: now,
          model_provider: "openai",
        },
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: now,
        payload: {
          type: "message",
          role: "developer",
          content: [{ type: "input_text", text: "internal instructions" }],
        },
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: now,
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "visible response" }],
        },
      }),
    ];

    await writeFile(
      join(testDir, `${sessionId}.jsonl`),
      `${lines.join("\n")}\n`,
    );

    const summary = await reader.getSessionSummary(
      sessionId,
      "test-project" as UrlProjectId,
    );
    expect(summary?.messageCount).toBe(1);
  });

  it("counts async agent messages without counting ordinary duplicates", async () => {
    const sessionId = "async-agent-message-count";
    const now = new Date().toISOString();
    const lines = [
      JSON.stringify({
        type: "session_meta",
        timestamp: now,
        payload: {
          id: sessionId,
          cwd: "/test/project",
          timestamp: now,
          model_provider: "openai",
        },
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: now,
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "start" }],
        },
      }),
      JSON.stringify({
        type: "event_msg",
        timestamp: now,
        payload: { type: "agent_message", message: "ordinary duplicate" },
      }),
      JSON.stringify({
        type: "event_msg",
        timestamp: now,
        payload: {
          type: "item_completed",
          item: {
            type: "AgentMessage",
            id: "async-message-1",
            content: [{ type: "Text", text: "Choose a mode" }],
            delivery: "async",
            questions: [{ title: "Choose a mode", options: null }],
          },
        },
      }),
    ];

    await writeFile(
      join(testDir, `${sessionId}.jsonl`),
      `${lines.join("\n")}\n`,
    );

    const summary = await reader.getSessionSummary(
      sessionId,
      "test-project" as UrlProjectId,
    );
    expect(summary?.messageCount).toBe(2);
  });

  it("preserves originator from session metadata", async () => {
    const sessionId = "originator-passthrough";
    await createSessionFile(sessionId, "openai", "gpt-4o", "yep-anywhere");

    const summary = await reader.getSessionSummary(
      sessionId,
      "test-project" as UrlProjectId,
    );
    expect(summary?.originator).toBe("yep-anywhere");
  });

  it("reuses cached Codex entries and parses appended JSONL", async () => {
    const sessionId = "append-cache";
    const now = new Date().toISOString();
    const sessionPath = join(testDir, `${sessionId}.jsonl`);
    await writeFile(
      sessionPath,
      `${[
        JSON.stringify({
          type: "session_meta",
          timestamp: now,
          payload: {
            id: sessionId,
            cwd: "/test/project",
            timestamp: now,
            model_provider: "openai",
          },
        }),
        JSON.stringify({
          type: "event_msg",
          timestamp: now,
          payload: {
            type: "user_message",
            message: "first",
          },
        }),
      ].join("\n")}\n`,
    );

    const first = await reader.getSession(
      sessionId,
      "test-project" as UrlProjectId,
    );
    expect(first?.data.session.entries).toHaveLength(2);

    await appendFile(
      sessionPath,
      `${JSON.stringify({
        type: "event_msg",
        timestamp: new Date().toISOString(),
        payload: {
          type: "user_message",
          message: "second",
        },
      })}\n`,
    );

    const second = await reader.getSession(
      sessionId,
      "test-project" as UrlProjectId,
    );
    expect(second?.data.session.entries).toHaveLength(3);
    expect(
      second?.data.session.entries.filter(
        (entry) =>
          entry.type === "event_msg" && entry.payload.type === "user_message",
      ),
    ).toHaveLength(2);
  });

  it("loads an appended suffix without one whole-suffix string", async () => {
    const sessionId = "bounded-append-rollout";
    const now = new Date().toISOString();
    const sessionPath = join(testDir, `${sessionId}.jsonl`);
    await writeFile(
      sessionPath,
      `${[
        JSON.stringify({
          type: "session_meta",
          timestamp: now,
          payload: {
            id: sessionId,
            cwd: "/test/project",
            timestamp: now,
            model_provider: "openai",
          },
        }),
        JSON.stringify({
          type: "event_msg",
          timestamp: now,
          payload: { type: "user_message", message: "first" },
        }),
      ].join("\n")}\n`,
    );
    await expect(
      reader.getSession(sessionId, "test-project" as UrlProjectId),
    ).resolves.not.toBeNull();

    const maxReadBytes = 1024 * 1024;
    const assistantText = `before-${"😀".repeat(300_000)}-after`;
    await appendFile(
      sessionPath,
      `${JSON.stringify({
        type: "response_item",
        timestamp: now,
        payload: {
          id: "assistant-appended",
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: assistantText }],
        },
      })}\n`,
    );

    const internals = reader as unknown as CodexEntryReadInternals;
    const originalReadFileRange = internals.readFileRange.bind(reader);
    vi.spyOn(internals, "readFileRange").mockImplementation(
      async (filePath, start, length) => {
        if (length > maxReadBytes) {
          throw new RangeError("Invalid string length");
        }
        return originalReadFileRange(filePath, start, length);
      },
    );

    const loaded = await reader.getSession(
      sessionId,
      "test-project" as UrlProjectId,
    );

    expect(loaded?.data.provider).toBe("codex");
    if (loaded?.data.provider !== "codex") {
      throw new Error("Expected the appended Codex detail read");
    }
    expect(loaded.data.session.entries).toHaveLength(3);
    expect(
      loaded.data.session.entries.find(
        (entry) =>
          entry.type === "response_item" &&
          entry.payload.type === "message" &&
          entry.payload.id === "assistant-appended",
      ),
    ).toMatchObject({
      payload: {
        content: [{ type: "output_text", text: assistantText }],
      },
    });
  });

  it("reuses the normalized Codex prefix after an append", async () => {
    const sessionId = "normalized-append-cache";
    const now = new Date().toISOString();
    const sessionPath = join(testDir, `${sessionId}.jsonl`);
    const initialEntries = [
      {
        type: "session_meta",
        timestamp: now,
        payload: {
          id: sessionId,
          cwd: "/test/project",
          timestamp: now,
          model_provider: "openai",
        },
      },
      {
        type: "event_msg",
        timestamp: now,
        payload: { type: "user_message", message: "first" },
      },
      ...Array.from({ length: 1_000 }, (_, index) => ({
        type: "response_item",
        timestamp: now,
        payload: {
          id: `assistant-${index}`,
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: `response ${index}` }],
        },
      })),
    ];
    await writeFile(
      sessionPath,
      `${initialEntries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    );

    const first = await reader.getSession(
      sessionId,
      "test-project" as UrlProjectId,
    );
    expect(first).not.toBeNull();
    if (!first) throw new Error("Expected the initial Codex detail read");
    const firstNormalized = normalizeSession(first);

    await appendFile(
      sessionPath,
      `${JSON.stringify({
        type: "response_item",
        timestamp: now,
        payload: {
          id: "assistant-appended",
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "appended" }],
        },
      })}\n`,
    );

    const second = await reader.getSession(
      sessionId,
      "test-project" as UrlProjectId,
      "assistant-999",
    );
    expect(second).not.toBeNull();
    if (!second) throw new Error("Expected the appended Codex detail read");
    const secondNormalized = normalizeSession(second);

    expect(secondNormalized.messages).not.toBe(firstNormalized.messages);
    expect(secondNormalized.messages[0]).toBe(firstNormalized.messages[0]);
    expect(secondNormalized.messages[1_000]).toBe(
      firstNormalized.messages[1_000],
    );
    expect(firstNormalized.messages).toHaveLength(1_001);
    expect(secondNormalized.messages).toHaveLength(1_002);
    expect(secondNormalized.messages.at(-1)?.uuid).toBe("assistant-appended");
  });

  it("resolves a user response whose event arrives in the next append", async () => {
    const sessionId = "split-user-turn-append";
    const now = new Date().toISOString();
    const sessionPath = join(testDir, `${sessionId}.jsonl`);
    await writeFile(
      sessionPath,
      `${[
        JSON.stringify({
          type: "session_meta",
          timestamp: now,
          payload: {
            id: sessionId,
            cwd: "/test/project",
            timestamp: now,
            model_provider: "openai",
          },
        }),
        JSON.stringify({
          type: "event_msg",
          timestamp: now,
          payload: { type: "user_message", message: "first" },
        }),
        JSON.stringify({
          type: "response_item",
          timestamp: now,
          payload: {
            id: "user-response",
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "second" }],
          },
        }),
      ].join("\n")}\n`,
    );

    const first = await reader.getSession(
      sessionId,
      "test-project" as UrlProjectId,
    );
    expect(first).not.toBeNull();
    if (!first) throw new Error("Expected the provisional Codex detail read");
    const firstNormalized = normalizeSession(first);
    expect(firstNormalized.messages).toHaveLength(1);

    await appendFile(
      sessionPath,
      `${JSON.stringify({
        type: "event_msg",
        timestamp: now,
        payload: {
          type: "user_message",
          message: "second",
          client_id: "client-second",
        },
      })}\n`,
    );

    const second = await reader.getSession(
      sessionId,
      "test-project" as UrlProjectId,
    );
    expect(second).not.toBeNull();
    if (!second) throw new Error("Expected the completed Codex detail read");
    const secondNormalized = normalizeSession(second);

    expect(firstNormalized.messages).toHaveLength(1);
    expect(secondNormalized.messages).toHaveLength(2);
    expect(secondNormalized.messages[0]).toBe(firstNormalized.messages[0]);
    expect(secondNormalized.messages[1]).toMatchObject({
      uuid: "client-second",
      codexUserTurnProvenance: "paired",
    });
  });

  it("resolves a Codex 0.151 user item in the next append", async () => {
    const sessionId = "split-completed-user-turn-append";
    const now = new Date().toISOString();
    const sessionPath = join(testDir, `${sessionId}.jsonl`);
    await writeFile(
      sessionPath,
      `${[
        JSON.stringify({
          type: "session_meta",
          timestamp: now,
          payload: {
            id: sessionId,
            cwd: "/test/project",
            timestamp: now,
            model_provider: "openai",
          },
        }),
        JSON.stringify({
          type: "response_item",
          timestamp: now,
          payload: {
            id: "first-user-response",
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "first" }],
          },
        }),
        JSON.stringify({
          type: "event_msg",
          timestamp: now,
          payload: {
            type: "item_completed",
            thread_id: sessionId,
            turn_id: "turn-1",
            item: {
              type: "UserMessage",
              id: "first-user-item",
              client_id: "first-optimistic-user",
              content: [{ type: "text", text: "first", text_elements: [] }],
            },
          },
        }),
        JSON.stringify({
          type: "response_item",
          timestamp: now,
          payload: {
            id: "second-user-response",
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "peer is clear" }],
          },
        }),
      ].join("\n")}\n`,
    );

    const first = await reader.getSession(
      sessionId,
      "test-project" as UrlProjectId,
    );
    expect(first).not.toBeNull();
    if (!first) throw new Error("Expected the provisional Codex detail read");
    const firstNormalized = normalizeSession(first);
    expect(firstNormalized.messages).toHaveLength(1);
    expect(firstNormalized.messages[0]?.uuid).toBe("first-optimistic-user");

    await appendFile(
      sessionPath,
      `${JSON.stringify({
        type: "event_msg",
        timestamp: now,
        payload: {
          type: "item_completed",
          thread_id: sessionId,
          turn_id: "turn-2",
          item: {
            type: "UserMessage",
            id: "item-user-1",
            client_id: "optimistic-user-1",
            content: [
              { type: "text", text: "peer is clear", text_elements: [] },
            ],
          },
        },
      })}\n`,
    );

    const second = await reader.getSession(
      sessionId,
      "test-project" as UrlProjectId,
    );
    expect(second).not.toBeNull();
    if (!second) throw new Error("Expected the completed Codex detail read");
    const secondNormalized = normalizeSession(second);

    expect(secondNormalized.messages).toHaveLength(2);
    expect(secondNormalized.messages[0]).toBe(firstNormalized.messages[0]);
    expect(secondNormalized.messages[1]).toMatchObject({
      uuid: "optimistic-user-1",
      codexUserTurnProvenance: "paired",
    });
  });

  it("carries tool normalization state across an append without mutating the prior projection", async () => {
    const sessionId = "tool-state-append";
    const now = new Date().toISOString();
    const sessionPath = join(testDir, `${sessionId}.jsonl`);
    const patch =
      "*** Begin Patch\n*** Add File: /repo/demo.txt\n+new\n*** End Patch";
    await writeFile(
      sessionPath,
      `${[
        JSON.stringify({
          type: "session_meta",
          timestamp: now,
          payload: {
            id: sessionId,
            cwd: "/test/project",
            timestamp: now,
            model_provider: "openai",
          },
        }),
        JSON.stringify({
          type: "event_msg",
          timestamp: now,
          payload: { type: "user_message", message: "edit" },
        }),
        JSON.stringify({
          type: "response_item",
          timestamp: now,
          payload: {
            type: "custom_tool_call",
            call_id: "edit-call",
            name: "exec",
            input: `const patch = ${JSON.stringify(patch)}; text(await tools.apply_patch(patch));`,
          },
        }),
      ].join("\n")}\n`,
    );

    const first = await reader.getSession(
      sessionId,
      "test-project" as UrlProjectId,
    );
    expect(first).not.toBeNull();
    if (!first) throw new Error("Expected the initial tool detail read");
    const firstNormalized = normalizeSession(first);
    const firstToolContent = firstNormalized.messages[1]?.message?.content;
    const firstToolUse = Array.isArray(firstToolContent)
      ? firstToolContent[0]
      : undefined;
    expect(firstToolUse).toMatchObject({
      type: "tool_use",
      input: { _rawPatch: patch },
    });
    expect(firstToolUse).not.toHaveProperty("input.changes");

    await appendFile(
      sessionPath,
      `${[
        JSON.stringify({
          type: "event_msg",
          timestamp: now,
          payload: {
            type: "patch_apply_end",
            call_id: "provider-edit-call",
            turn_id: "turn-1",
            stdout: "Done!",
            stderr: "",
            success: true,
            status: "completed",
            changes: {
              "/repo/demo.txt": {
                type: "add",
                unified_diff: "@@ -0,0 +1 @@\n+new",
              },
            },
          },
        }),
        JSON.stringify({
          type: "response_item",
          timestamp: now,
          payload: {
            type: "custom_tool_call_output",
            call_id: "edit-call",
            output: [
              { type: "input_text", text: "Script completed\nOutput:\n{}" },
            ],
          },
        }),
      ].join("\n")}\n`,
    );

    const second = await reader.getSession(
      sessionId,
      "test-project" as UrlProjectId,
    );
    expect(second).not.toBeNull();
    if (!second) throw new Error("Expected the completed tool detail read");
    const secondNormalized = normalizeSession(second);
    const secondToolContent = secondNormalized.messages[1]?.message?.content;
    const secondToolUse = Array.isArray(secondToolContent)
      ? secondToolContent[0]
      : undefined;

    expect(secondNormalized.messages[0]).toBe(firstNormalized.messages[0]);
    expect(secondNormalized.messages[1]).not.toBe(firstNormalized.messages[1]);
    expect(firstToolUse).not.toHaveProperty("input.changes");
    expect(secondToolUse).toMatchObject({
      type: "tool_use",
      input: {
        _rawPatch: patch,
        changes: [{ path: "/repo/demo.txt", type: "add" }],
      },
    });
    expect(secondNormalized.messages[2]).toMatchObject({
      uuid: "edit-call-result",
      type: "user",
    });
  });

  it("cold-loads a rollout without one whole-file string", async () => {
    const sessionId = "bounded-cold-rollout";
    const now = new Date().toISOString();
    const sessionPath = join(testDir, `${sessionId}.jsonl`);
    const maxReadBytes = 1024 * 1024;
    const assistantText = `before-${"😀".repeat(300_000)}-after`;
    const lines = [
      JSON.stringify({
        type: "session_meta",
        timestamp: now,
        payload: {
          id: sessionId,
          cwd: "/test/project",
          timestamp: now,
          model_provider: "openai",
        },
      }),
      JSON.stringify({
        type: "event_msg",
        timestamp: now,
        payload: { type: "user_message", message: "load history" },
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: now,
        payload: {
          id: "assistant-1",
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: assistantText }],
        },
      }),
    ];
    await writeFile(sessionPath, `${lines.join("\n")}\n`);

    const internals = reader as unknown as CodexEntryReadInternals;
    const originalReadFileRange = internals.readFileRange.bind(reader);
    vi.spyOn(internals, "readFileRange").mockImplementation(
      async (filePath, start, length) => {
        if (length > maxReadBytes) {
          throw new RangeError("Invalid string length");
        }
        return originalReadFileRange(filePath, start, length);
      },
    );

    const loaded = await reader.getSession(
      sessionId,
      "test-project" as UrlProjectId,
    );

    expect(loaded?.data.provider).toBe("codex");
    if (loaded?.data.provider !== "codex") {
      throw new Error("Expected the cold Codex detail read");
    }
    expect(loaded.data.session.entries).toHaveLength(3);
    expect(
      loaded.data.session.entries.find(
        (entry) =>
          entry.type === "response_item" &&
          entry.payload.type === "message" &&
          entry.payload.id === "assistant-1",
      ),
    ).toMatchObject({
      payload: {
        content: [{ type: "output_text", text: assistantText }],
      },
    });
  });

  it("reverse-reads a large plain rollout from the requested compact tail", async () => {
    const sessionId = "reverse-compact-tail";
    const compactTimestamps = [
      "2026-09-02T01:00:00.000Z",
      "2026-09-02T02:00:00.000Z",
      "2026-09-02T03:00:00.000Z",
      "2026-09-02T04:00:00.000Z",
      "2026-09-02T05:00:00.000Z",
    ];
    const sessionPath = join(testDir, `${sessionId}.jsonl`);
    const lines = [
      JSON.stringify({
        type: "session_meta",
        timestamp: "2026-09-02T00:00:00.000Z",
        payload: {
          id: sessionId,
          cwd: "/test/project",
          timestamp: "2026-09-02T00:00:00.000Z",
          model_provider: "openai",
        },
      }),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-09-02T00:00:01.000Z",
        payload: { type: "user_message", message: "first turn" },
      }),
      JSON.stringify({
        type: "world_state",
        timestamp: "2026-09-02T00:00:02.000Z",
        payload: { full: true, state: { filler: "x".repeat(5 * 1024 * 1024) } },
      }),
      ...compactTimestamps.flatMap((timestamp, index) => [
        JSON.stringify({
          type: "compacted",
          timestamp,
          payload: { message: `compact ${index + 1}` },
        }).replace('"type":"compacted"', '"type": "compacted"'),
        JSON.stringify({
          type: "event_msg",
          timestamp: timestamp.replace("00.000Z", "01.000Z"),
          payload: { type: "user_message", message: `turn ${index + 1}` },
        }),
        ...(index === 3
          ? [
              JSON.stringify({
                type: "world_state",
                timestamp: "2026-09-02T04:00:02.000Z",
                payload: {
                  full: true,
                  state: { filler: "y".repeat(2 * 1024 * 1024) },
                },
              }),
            ]
          : []),
      ]),
    ];
    await writeFile(sessionPath, `${lines.join("\n")}\n`);
    const summary = await reader.getSessionSummary(
      sessionId,
      "test-project" as UrlProjectId,
    );
    expect(summary).not.toBeNull();
    if (!summary) throw new Error("Expected the indexed summary hint");

    const internals = reader as unknown as CodexEntryReadInternals;
    const originalReadFileRange = internals.readFileRange.bind(reader);
    const ranges: Array<{ start: number; length: number }> = [];
    vi.spyOn(internals, "readFileRange").mockImplementation(
      async (filePath, start, length) => {
        ranges.push({ start, length });
        return originalReadFileRange(filePath, start, length);
      },
    );

    const loadedTail = await reader.getSession(
      sessionId,
      "test-project" as UrlProjectId,
      undefined,
      { tailCompactions: 2, summaryHint: summary },
    );
    expect(loadedTail?.readWindow).toMatchObject({
      kind: "compact-tail",
      omittedPrefix: true,
      compactBoundaries: 2,
    });
    if (
      !loadedTail ||
      (loadedTail.data.provider !== "codex" &&
        loadedTail.data.provider !== "codex-oss")
    ) {
      throw new Error("Expected the compact-tail detail read");
    }
    expect(loadedTail.data.session.entries.map((entry) => entry.type)).toEqual([
      "compacted",
      "event_msg",
      "world_state",
      "compacted",
      "event_msg",
    ]);
    expect(ranges.length).toBeGreaterThan(1);
    expect(ranges[1]?.start).toBeLessThan(ranges[0]?.start ?? 0);
    expect(
      ranges.every((range) => range.start > 0 || range.length <= 1024),
    ).toBe(true);
    expect(reader.getEntryCacheStats().sessions).toBe(0);

    const normalizedTail = normalizeSession(loadedTail);
    const tailBoundaryId = normalizedTail.messages[0]?.uuid;
    expect(tailBoundaryId).toMatch(/^codex-compacted-byte-\d+-/);
    if (!tailBoundaryId || loadedTail.readWindow?.kind !== "compact-tail") {
      throw new Error("Expected a source-backed compact-tail cursor");
    }

    const narrowedCursor = normalizedTail.messages[1]
      ? getCodexMessageSourceByteCursor(normalizedTail.messages[1])
      : undefined;
    expect(narrowedCursor).toMatch(/^codex-cursor-byte-\d+$/);
    if (!narrowedCursor) {
      throw new Error("Expected a source cursor for the narrowed turn window");
    }
    const narrowedOlderPage = await reader.getSession(
      sessionId,
      "test-project" as UrlProjectId,
      undefined,
      {
        tailCompactions: 2,
        beforeMessageId: narrowedCursor,
        summaryHint: summary,
      },
    );
    expect(narrowedOlderPage?.readWindow).toMatchObject({
      kind: "compact-page",
      omittedPrefix: true,
      compactBoundaries: 2,
    });
    if (
      !narrowedOlderPage ||
      (narrowedOlderPage.data.provider !== "codex" &&
        narrowedOlderPage.data.provider !== "codex-oss")
    ) {
      throw new Error("Expected an older page before the narrowed turn cursor");
    }
    expect(
      narrowedOlderPage.data.session.entries.map((entry) => entry.type),
    ).toEqual(["compacted", "event_msg", "compacted"]);

    const olderPage = await reader.getSession(
      sessionId,
      "test-project" as UrlProjectId,
      undefined,
      {
        tailCompactions: 2,
        beforeMessageId: tailBoundaryId,
        summaryHint: summary,
      },
    );
    expect(olderPage?.readWindow).toMatchObject({
      kind: "compact-page",
      omittedPrefix: true,
      endByte: loadedTail.readWindow.startByte,
      compactBoundaries: 2,
    });
    if (
      !olderPage ||
      (olderPage.data.provider !== "codex" &&
        olderPage.data.provider !== "codex-oss") ||
      olderPage.readWindow?.kind !== "compact-page"
    ) {
      throw new Error("Expected the first bounded older page");
    }
    expect(olderPage.data.session.entries.map((entry) => entry.type)).toEqual([
      "compacted",
      "event_msg",
      "compacted",
      "event_msg",
    ]);

    const olderBoundaryId = normalizeSession(olderPage).messages[0]?.uuid;
    expect(olderBoundaryId).toMatch(/^codex-compacted-byte-\d+-/);
    if (!olderBoundaryId) {
      throw new Error("Expected the next source-backed older-page cursor");
    }
    const firstPage = await reader.getSession(
      sessionId,
      "test-project" as UrlProjectId,
      undefined,
      {
        tailCompactions: 2,
        beforeMessageId: olderBoundaryId,
        summaryHint: summary,
      },
    );
    expect(firstPage?.readWindow).toMatchObject({
      kind: "compact-page",
      omittedPrefix: false,
      startByte: 0,
      endByte: olderPage.readWindow.startByte,
      compactBoundaries: 2,
    });
    if (
      !firstPage ||
      (firstPage.data.provider !== "codex" &&
        firstPage.data.provider !== "codex-oss")
    ) {
      throw new Error("Expected the beginning older page");
    }
    expect(firstPage.data.session.entries[0]?.type).toBe("session_meta");
    expect(
      firstPage.data.session.entries.filter(
        (entry) => entry.type === "compacted",
      ),
    ).toHaveLength(1);
    expect(reader.getEntryCacheStats().sessions).toBe(0);

    const loadedFull = await reader.getSession(
      sessionId,
      "test-project" as UrlProjectId,
      undefined,
      {
        tailCompactions: 2,
        beforeMessageId: `codex-compacted-3-${compactTimestamps[3]}`,
        summaryHint: summary,
      },
    );
    expect(loadedFull?.readWindow).toBeUndefined();
    expect(loadedFull).not.toBeNull();
    if (!loadedFull)
      throw new Error("Expected the legacy-cursor fallback read");
    const matchingFullBoundary = normalizeSession(loadedFull).messages.find(
      (message) => message.timestamp === compactTimestamps[3],
    );
    expect(tailBoundaryId).toBe(matchingFullBoundary?.uuid);
  });

  it("bounds incremental reads while preserving old cursors and append reuse", async () => {
    const sessionId = "bounded-incremental";
    const projectId = "test-project" as UrlProjectId;
    const sessionPath = join(testDir, `${sessionId}.jsonl`);
    const timestamp = "2026-09-08T00:00:00.000Z";
    const message = (id: string) => ({
      type: "response_item",
      timestamp,
      payload: {
        type: "message",
        role: "assistant",
        id,
        content: [{ type: "output_text", text: id }],
      },
    });
    const lines = [
      {
        type: "session_meta",
        timestamp,
        payload: {
          id: sessionId,
          cwd: "/test/project",
          timestamp,
        },
      },
      message("old-anchor"),
      {
        type: "response_item",
        timestamp,
        payload: {
          type: "function_call",
          name: "shell_command",
          call_id: "old-call",
          arguments: JSON.stringify({ command: "true" }),
        },
      },
      {
        type: "world_state",
        timestamp,
        payload: {
          full: true,
          state: { filler: "x".repeat(5 * 1024 * 1024) },
        },
      },
      ...[1, 2, 3].flatMap((i) => [
        { type: "compacted", timestamp, payload: { message: `compact ${i}` } },
        message(`anchor-${i}`),
      ]),
    ];
    await writeFile(
      sessionPath,
      `${lines.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    );
    const summary = await reader.getSessionSummary(sessionId, projectId);
    if (!summary) throw new Error("Expected summary");
    const options = { tailCompactions: 2, summaryHint: summary };
    const first = await reader.getSession(
      sessionId,
      projectId,
      "anchor-3",
      options,
    );
    if (!first) throw new Error("Expected incremental session");
    const normalized = normalizeSession(first);
    expect(normalized.messages.map((m) => m.uuid)).not.toContain("old-anchor");
    expect(reader.getEntryCacheStats().sourceBytes).toBeLessThan(4096);

    const reads = vi.spyOn(
      reader as unknown as CodexEntryReadInternals,
      "readFileRange",
    );
    const unchanged = await reader.getSession(
      sessionId,
      projectId,
      "anchor-3",
      options,
    );
    if (!unchanged) throw new Error("Expected unchanged session");
    expect(normalizeSession(unchanged).messages).toBe(normalized.messages);
    expect(reads).not.toHaveBeenCalled();
    await appendFile(sessionPath, `${JSON.stringify(message("appended"))}\n`);
    const appended = await reader.getSession(
      sessionId,
      projectId,
      "anchor-3",
      options,
    );
    if (!appended) throw new Error("Expected appended session");
    const appendedMessages = normalizeSession(appended).messages;
    expect(appendedMessages.at(-1)?.uuid).toBe("appended");
    expect(appendedMessages[0]).toBe(normalized.messages[0]);
    expect(normalized.messages.at(-1)?.uuid).toBe("anchor-3");

    const old = await reader.getSession(
      sessionId,
      projectId,
      "old-anchor",
      options,
    );
    if (!old) throw new Error("Expected old cursor fallback");
    expect(old.readWindow).toBeUndefined();
    expect(normalizeSession(old).messages.map((m) => m.uuid)).toContain(
      "old-anchor",
    );
    const recent = await reader.getSession(
      sessionId,
      projectId,
      "appended",
      options,
    );
    if (!recent) throw new Error("Expected recent cursor");
    expect(reader.getEntryCacheStats().sourceBytes).toBeLessThan(4096);
    expect(normalizeSession(recent).messages).toEqual(appendedMessages);

    await appendFile(
      sessionPath,
      `${JSON.stringify({ type: "compacted", timestamp, payload: { message: "compact 4" } })}\n${JSON.stringify(message("after-compact"))}\n`,
    );
    const rotated = await reader.getSession(
      sessionId,
      projectId,
      "appended",
      options,
    );
    if (!rotated) throw new Error("Expected rotated window");
    expect(normalizeSession(rotated).messages.map((m) => m.uuid)).not.toContain(
      "anchor-2",
    );
    expect(normalizeSession(rotated).messages.at(-1)?.uuid).toBe(
      "after-compact",
    );

    const partial = Buffer.from(`${JSON.stringify(message("partial-😀"))}\n`);
    const split = partial.indexOf(Buffer.from("😀")) + 2;
    await appendFile(sessionPath, partial.subarray(0, split));
    await reader.getSession(sessionId, projectId, "after-compact", options);
    await appendFile(sessionPath, partial.subarray(split));
    const [bounded, full] = await Promise.all([
      reader.getSession(sessionId, projectId, "after-compact", options),
      reader.getSession(sessionId, projectId),
    ]);
    if (!bounded || !full) throw new Error("Expected concurrent snapshots");
    expect(normalizeSession(bounded).messages.at(-1)?.uuid).toBe("partial-😀");
    expect(normalizeSession(full).messages.map((m) => m.uuid)).toContain(
      "old-anchor",
    );
    expect(normalizeSession(bounded).messages).toEqual(
      normalizeSession(full).messages.slice(
        -normalizeSession(bounded).messages.length,
      ),
    );

    await appendFile(
      sessionPath,
      `${JSON.stringify({
        type: "response_item",
        timestamp,
        payload: {
          type: "function_call_output",
          call_id: "old-call",
          output: "late output",
        },
      })}\n`,
    );
    const dependent = await reader.getSession(
      sessionId,
      projectId,
      "after-compact",
      options,
    );
    if (!dependent) throw new Error("Expected prefix-dependent result");
    expect(dependent.readWindow).toBeUndefined();
    expect(normalizeSession(dependent).messages.map((m) => m.uuid)).toContain(
      "old-anchor",
    );
  });

  it("keeps the agent mappings a complete read cached when a bounded window follows", async () => {
    const sessionId = "bounded-agent-mappings";
    const projectId = "test-project" as UrlProjectId;
    const sessionPath = join(testDir, `${sessionId}.jsonl`);
    const timestamp = "2026-09-08T00:00:00.000Z";
    const message = (id: string) => ({
      type: "response_item",
      timestamp,
      payload: {
        type: "message",
        role: "assistant",
        id,
        content: [{ type: "output_text", text: id }],
      },
    });
    const lines = [
      {
        type: "session_meta",
        timestamp,
        payload: { id: sessionId, cwd: "/test/project", timestamp },
      },
      {
        type: "response_item",
        timestamp,
        payload: {
          type: "function_call",
          name: "spawn_agent",
          call_id: "call-spawn",
          arguments: JSON.stringify({ role: "reviewer", prompt: "Review" }),
        },
      },
      {
        type: "response_item",
        timestamp,
        payload: {
          type: "function_call_output",
          call_id: "call-spawn",
          output: JSON.stringify({ agent_id: "child-thread" }),
        },
      },
      // A bounded window is only located above an estimated size per
      // compaction, so the prefix has to be large enough to earn one.
      {
        type: "world_state",
        timestamp,
        payload: { full: true, state: { filler: "x".repeat(5 * 1024 * 1024) } },
      },
      ...[1, 2, 3].flatMap((i) => [
        { type: "compacted", timestamp, payload: { message: `compact ${i}` } },
        message(`anchor-${i}`),
      ]),
    ];
    await writeFile(
      sessionPath,
      `${lines.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    );
    const summary = await reader.getSessionSummary(sessionId, projectId);
    if (!summary) throw new Error("Expected summary");

    await reader.getSession(sessionId, projectId);
    expect(reader.getAgentMappingCacheStats()).toEqual({
      sessions: 1,
      mappings: 1,
    });

    // The window starts at the second-from-last compaction, so its entries
    // hold no spawn_agent call: caching from them would claim the whole file
    // has no subagents.
    await appendFile(sessionPath, `${JSON.stringify(message("appended"))}\n`);
    const bounded = await reader.getSession(sessionId, projectId, "anchor-3", {
      tailCompactions: 2,
      summaryHint: summary,
    });
    if (!bounded?.readWindow) throw new Error("Expected a bounded window read");

    expect(reader.getAgentMappingCacheStats()).toEqual({
      sessions: 1,
      mappings: 1,
    });
    await expect(reader.getAgentMappings(sessionId)).resolves.toEqual([
      { toolUseId: "call-spawn", agentId: "child-thread" },
    ]);
    await appendFile(
      sessionPath,
      [
        {
          type: "response_item",
          timestamp,
          payload: {
            type: "function_call",
            name: "spawn_agent",
            call_id: "call-new",
            arguments: JSON.stringify({
              task_name: "new-child",
              message: "new",
            }),
          },
        },
        {
          type: "event_msg",
          timestamp,
          payload: {
            type: "item_completed",
            item: {
              type: "SubAgentActivity",
              id: "call-new",
              kind: "started",
              agent_thread_id: "new-child",
              agent_path: "/owned",
              model: null,
              reasoning_effort: null,
            },
          },
        },
      ]
        .map((v) => JSON.stringify(v))
        .join("\n") + "\n",
    );
    const cold = new CodexSessionReader({ sessionsDir: testDir });
    try {
      const tail = await cold.getSession(sessionId, projectId, undefined, {
        tailCompactions: 2,
        summaryHint: summary,
      });
      expect(tail?.readWindow).toBeDefined();
      // Positive partial extraction may know the new call, but the lazy route
      // must still recover the older launch outside that window.
      expect(cold.getAgentMappingCacheStats()).toEqual({
        sessions: 1,
        mappings: 1,
      });
      await expect(cold.getAgentMappings(sessionId)).resolves.toEqual([
        { toolUseId: "call-spawn", agentId: "child-thread" },
        { toolUseId: "call-new", agentId: "new-child" },
      ]);
      cold.invalidateCache();
      const end = Buffer.byteLength(
        lines
          .slice(0, 3)
          .map((v) => JSON.stringify(v))
          .join("\n") + "\n",
      );
      const oldest = await cold.getSession(sessionId, projectId, undefined, {
        tailCompactions: 2,
        beforeMessageId: `codex-cursor-byte-${end}`,
        summaryHint: summary,
      });
      expect(oldest?.readWindow).toMatchObject({
        kind: "compact-page",
        omittedPrefix: false,
      });
      // Starting at zero does not imply that an older page read the newer tail.
      expect(cold.getAgentMappingCacheStats()).toEqual({
        sessions: 1,
        mappings: 1,
      });
      await expect(cold.getAgentMappings(sessionId)).resolves.toEqual([
        { toolUseId: "call-spawn", agentId: "child-thread" },
        { toolUseId: "call-new", agentId: "new-child" },
      ]);
    } finally {
      await cold.close();
    }
  });

  it("keeps the compact tail when the rollout grew past its indexed summary", async () => {
    const sessionId = "growing-compact-tail";
    const sessionPath = join(testDir, `${sessionId}.jsonl`);
    const compactTimestamps = [
      "2026-09-02T01:00:00.000Z",
      "2026-09-02T02:00:00.000Z",
      "2026-09-02T03:00:00.000Z",
    ];
    const lines = [
      JSON.stringify({
        type: "session_meta",
        timestamp: "2026-09-02T00:00:00.000Z",
        payload: {
          id: sessionId,
          cwd: "/test/project",
          timestamp: "2026-09-02T00:00:00.000Z",
          model_provider: "openai",
        },
      }),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-09-02T00:00:01.000Z",
        payload: { type: "user_message", message: "first turn" },
      }),
      JSON.stringify({
        type: "world_state",
        timestamp: "2026-09-02T00:00:02.000Z",
        payload: { full: true, state: { filler: "x".repeat(5 * 1024 * 1024) } },
      }),
      ...compactTimestamps.flatMap((timestamp, index) => [
        JSON.stringify({
          type: "compacted",
          timestamp,
          payload: { message: `compact ${index + 1}` },
        }),
        JSON.stringify({
          type: "event_msg",
          timestamp: timestamp.replace("00.000Z", "01.000Z"),
          payload: { type: "user_message", message: `turn ${index + 1}` },
        }),
      ]),
    ];
    await writeFile(sessionPath, `${lines.join("\n")}\n`);

    // The hint an index pass would have produced for the file as it stood.
    const summary = await reader.getSessionSummary(
      sessionId,
      "test-project" as UrlProjectId,
    );
    if (!summary) throw new Error("Expected the indexed summary hint");

    // Codex keeps writing: the hint is now a correct prefix, not current truth.
    await appendFile(
      sessionPath,
      `${JSON.stringify({
        type: "event_msg",
        timestamp: "2026-09-02T04:00:00.000Z",
        payload: { type: "user_message", message: "turn while live" },
      })}\n`,
    );
    await utimes(sessionPath, new Date(), new Date());

    const loaded = await reader.getSession(
      sessionId,
      "test-project" as UrlProjectId,
      undefined,
      { tailCompactions: 2, summaryHint: summary },
    );

    expect(loaded?.readWindow).toMatchObject({
      kind: "compact-tail",
      omittedPrefix: true,
      compactBoundaries: 2,
    });
    if (
      !loaded ||
      (loaded.data.provider !== "codex" && loaded.data.provider !== "codex-oss")
    ) {
      throw new Error("Expected the compact-tail detail read");
    }
    expect(loaded.data.session.entries.map((entry) => entry.type)).toEqual([
      "compacted",
      "event_msg",
      "compacted",
      "event_msg",
      "event_msg",
    ]);
    // The appended turn is inside the window, and the reported snapshot time
    // comes from the live file rather than the older indexed summary.
    expect(loaded.summary.updatedAt).toBe(loaded.transcriptSnapshotUpdatedAt);
    expect(loaded.summary.updatedAt).not.toBe(summary.updatedAt);
  });

  it("falls back to a full read when the hint claims to be newer than the file", async () => {
    const sessionId = "rewound-compact-tail";
    const sessionPath = join(testDir, `${sessionId}.jsonl`);
    const lines = [
      JSON.stringify({
        type: "session_meta",
        timestamp: "2026-09-02T00:00:00.000Z",
        payload: {
          id: sessionId,
          cwd: "/test/project",
          timestamp: "2026-09-02T00:00:00.000Z",
          model_provider: "openai",
        },
      }),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-09-02T00:00:01.000Z",
        payload: { type: "user_message", message: "first turn" },
      }),
      JSON.stringify({
        type: "world_state",
        timestamp: "2026-09-02T00:00:02.000Z",
        payload: { full: true, state: { filler: "x".repeat(5 * 1024 * 1024) } },
      }),
      JSON.stringify({
        type: "compacted",
        timestamp: "2026-09-02T01:00:00.000Z",
        payload: { message: "compact 1" },
      }),
      JSON.stringify({
        type: "compacted",
        timestamp: "2026-09-02T02:00:00.000Z",
        payload: { message: "compact 2" },
      }),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-09-02T02:00:01.000Z",
        payload: { type: "user_message", message: "last turn" },
      }),
    ];
    await writeFile(sessionPath, `${lines.join("\n")}\n`);

    const summary = await reader.getSessionSummary(
      sessionId,
      "test-project" as UrlProjectId,
    );
    if (!summary) throw new Error("Expected the indexed summary hint");

    const compactTailRead = vi.spyOn(
      reader as unknown as CodexEntryReadInternals,
      "readCompactTailSnapshot",
    );
    const loaded = await reader.getSession(
      sessionId,
      "test-project" as UrlProjectId,
      undefined,
      {
        tailCompactions: 2,
        summaryHint: {
          ...summary,
          updatedAt: new Date(Date.now() + 60_000).toISOString(),
        },
      },
    );

    expect(compactTailRead).not.toHaveBeenCalled();
    expect(loaded?.readWindow).toBeUndefined();
  });

  it("accepts only well-formed safe source byte cursors", () => {
    expect(parseCodexSourceByteCursor("codex-cursor-byte-42")).toBe(42);
    expect(
      parseCodexSourceByteCursor(
        "codex-compacted-byte-314-2026-09-02T04:00:00.000Z",
      ),
    ).toBe(314);

    for (const cursor of [
      "codex-cursor-byte--1",
      "codex-cursor-byte-1.5",
      "codex-cursor-byte-12junk",
      "codex-cursor-byte-9007199254740992",
      "codex-compacted-3-2026-09-02T04:00:00.000Z",
    ]) {
      expect(parseCodexSourceByteCursor(cursor)).toBeNull();
    }
  });

  it("still attempts the compact tail with a summary hint older than the file", async () => {
    // An older hint describes an indexed prefix of an append-only rollout, which
    // is exactly the state of a session Codex is still writing. The window
    // itself comes from the live file, so the read is attempted; this fixture is
    // too small for a compact tail, so it falls back to the complete reader.
    const sessionId = "stale-compact-tail-summary";
    await createSessionFile(sessionId, "openai", "gpt-5");
    const summary = await reader.getSessionSummary(
      sessionId,
      "test-project" as UrlProjectId,
    );
    expect(summary).not.toBeNull();
    if (!summary) throw new Error("Expected the indexed summary hint");

    const compactTailRead = vi.spyOn(
      reader as unknown as CodexEntryReadInternals,
      "readCompactTailSnapshot",
    );
    const loaded = await reader.getSession(
      sessionId,
      "test-project" as UrlProjectId,
      undefined,
      {
        tailCompactions: 1,
        summaryHint: {
          ...summary,
          updatedAt: "2000-01-01T00:00:00.000Z",
        },
      },
    );

    expect(compactTailRead).toHaveBeenCalledTimes(1);
    expect(loaded?.readWindow).toBeUndefined();
    expect(loaded?.data.session.entries[0]?.type).toBe("session_meta");
  });

  it("uses the complete reader for a source cursor past end of file", async () => {
    const sessionId = "past-end-source-cursor";
    const sessionPath = join(testDir, `${sessionId}.jsonl`);
    await createSessionFile(sessionId, "openai", "gpt-5");
    const summary = await reader.getSessionSummary(
      sessionId,
      "test-project" as UrlProjectId,
    );
    expect(summary).not.toBeNull();
    if (!summary) throw new Error("Expected the indexed summary hint");
    const stats = await stat(sessionPath);

    const loaded = await reader.getSession(
      sessionId,
      "test-project" as UrlProjectId,
      undefined,
      {
        tailCompactions: 1,
        beforeMessageId: `codex-cursor-byte-${Number(stats.size) + 1}`,
        summaryHint: summary,
      },
    );

    expect(loaded?.readWindow).toBeUndefined();
    expect(loaded?.data.session.entries[0]?.type).toBe("session_meta");
  });

  it("keeps the forward reader below the compact-tail crossover", async () => {
    const sessionId = "small-compact-tail";
    await createSessionFile(sessionId, "openai", "gpt-5");
    const summary = await reader.getSessionSummary(
      sessionId,
      "test-project" as UrlProjectId,
    );
    expect(summary).not.toBeNull();
    if (!summary) throw new Error("Expected the small rollout summary");

    const loaded = await reader.getSession(
      sessionId,
      "test-project" as UrlProjectId,
      undefined,
      { tailCompactions: 1, summaryHint: summary },
    );

    expect(loaded?.readWindow).toBeUndefined();
    if (
      !loaded ||
      (loaded.data.provider !== "codex" && loaded.data.provider !== "codex-oss")
    ) {
      throw new Error("Expected the complete Codex detail read");
    }
    expect(loaded.data.session.entries[0]?.type).toBe("session_meta");
  });

  it("falls back to a complete read when the large rollout has too few compactions", async () => {
    const sessionId = "sparse-large-compact-tail";
    const sessionPath = join(testDir, `${sessionId}.jsonl`);
    const lines = [
      JSON.stringify({
        type: "session_meta",
        timestamp: "2026-09-02T00:00:00.000Z",
        payload: {
          id: sessionId,
          cwd: "/test/project",
          timestamp: "2026-09-02T00:00:00.000Z",
          model_provider: "openai",
        },
      }),
      JSON.stringify({
        type: "world_state",
        timestamp: "2026-09-02T00:00:01.000Z",
        payload: { full: true, state: { filler: "x".repeat(5 * 1024 * 1024) } },
      }),
      JSON.stringify({
        type: "compacted",
        timestamp: "2026-09-02T01:00:00.000Z",
        payload: { message: "only compact" },
      }),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-09-02T01:00:01.000Z",
        payload: { type: "user_message", message: "current tail" },
      }),
    ];
    await writeFile(sessionPath, `${lines.join("\n")}\n`);
    const summary = await reader.getSessionSummary(
      sessionId,
      "test-project" as UrlProjectId,
    );
    expect(summary).not.toBeNull();
    if (!summary) throw new Error("Expected the indexed summary hint");

    const internals = reader as unknown as CodexEntryReadInternals;
    const originalReadFileRange = internals.readFileRange.bind(reader);
    const ranges: Array<{ start: number; length: number }> = [];
    vi.spyOn(internals, "readFileRange").mockImplementation(
      async (filePath, start, length) => {
        ranges.push({ start, length });
        return originalReadFileRange(filePath, start, length);
      },
    );

    const loaded = await reader.getSession(
      sessionId,
      "test-project" as UrlProjectId,
      undefined,
      { tailCompactions: 2, summaryHint: summary },
    );

    expect(loaded?.readWindow).toBeUndefined();
    if (
      !loaded ||
      (loaded.data.provider !== "codex" && loaded.data.provider !== "codex-oss")
    ) {
      throw new Error("Expected the complete Codex detail read");
    }
    expect(loaded.data.session.entries[0]?.type).toBe("session_meta");
    expect(ranges.some((range) => range.start > 0)).toBe(true);
    expect(ranges.some((range) => range.start === 0)).toBe(true);
  });

  it("surfaces detail read failures for a discovered rollout", async () => {
    const sessionId = "failed-detail-read";
    await createSessionFile(sessionId, "openai", "gpt-5");
    const internals = reader as unknown as CodexEntryReadInternals;
    vi.spyOn(internals, "readFileRange").mockRejectedValue(
      new Error("simulated detail read failure"),
    );
    const errorLog = vi
      .spyOn(getLogger(), "error")
      .mockImplementation(() => undefined);

    await expect(
      reader.getSession(sessionId, "test-project" as UrlProjectId),
    ).rejects.toThrow("simulated detail read failure");
    expect(errorLog).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "codex_session_detail_read_failed",
        sessionId,
        error: "simulated detail read failure",
      }),
      "CODEX_READER: detail read failed",
    );
  });

  it("accepts a complete final entry without a trailing newline", async () => {
    const sessionId = "complete-unterminated-entry";
    const now = new Date().toISOString();
    await writeFile(
      join(testDir, `${sessionId}.jsonl`),
      [
        JSON.stringify({
          type: "session_meta",
          timestamp: now,
          payload: {
            id: sessionId,
            cwd: "/test/project",
            timestamp: now,
            model_provider: "openai",
          },
        }),
        JSON.stringify({
          type: "event_msg",
          timestamp: now,
          payload: { type: "user_message", message: "complete" },
        }),
      ].join("\n"),
    );

    const loaded = await reader.getSession(
      sessionId,
      "test-project" as UrlProjectId,
    );
    expect(loaded?.data.session.entries).toHaveLength(2);
    expect(reader.getEntryCacheStats().partialLineBytes).toBeGreaterThan(0);
    await appendFile(join(testDir, `${sessionId}.jsonl`), "\n");
    const committed = await reader.getSession(
      sessionId,
      "test-project" as UrlProjectId,
    );
    expect(committed?.data.session.entries).toHaveLength(2);
    expect(reader.getEntryCacheStats().partialLineBytes).toBe(0);
  });

  it("replays an unterminated row when continuation invalidates the provisional JSON", async () => {
    const id = "provisional-json-replay",
      path = join(testDir, `${id}.jsonl`);
    const header = JSON.stringify({
      type: "session_meta",
      timestamp: "2026-01-01T00:00:00Z",
      payload: {
        id,
        cwd: "/test/project",
        timestamp: "2026-01-01T00:00:00Z",
        model_provider: "openai",
      },
    });
    const msg = (text: string) =>
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-01-01T00:00:01Z",
        payload: { type: "user_message", message: text },
      });
    await writeFile(path, `${header}\n${msg("provisional")}`);
    await reader.getSession(id, "test-project" as UrlProjectId);
    await appendFile(
      path,
      ` ${msg("joined without newline")}\n${msg("after")}\n`,
    );
    const actual = await reader.getSession(id, "test-project" as UrlProjectId);
    reader.invalidateCache();
    const expected = await reader.getSession(
      id,
      "test-project" as UrlProjectId,
    );
    expect(normalizeSession(actual!).messages).toEqual(
      normalizeSession(expected!).messages,
    );
    expect(actual?.data.session.entries).toHaveLength(2);
  });

  it("recovers when an admitted append is truncated during byte acquisition", async () => {
    const id = "append-truncate-race",
      path = join(testDir, `${id}.jsonl`);
    const header = JSON.stringify({
      type: "session_meta",
      timestamp: "2026-01-01T00:00:00Z",
      payload: {
        id,
        cwd: "/test/project",
        timestamp: "2026-01-01T00:00:00Z",
        model_provider: "openai",
      },
    });
    const msg = (text: string) =>
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-01-01T00:00:01Z",
        payload: { type: "user_message", message: text },
      });
    await writeFile(path, `${header}\n${msg("old")}\n`);
    await reader.getSession(id, "test-project" as UrlProjectId);
    await appendFile(path, msg("append".repeat(2000)) + "\n");
    const internals = reader as unknown as CodexEntryReadInternals,
      original = internals.readFileRange.bind(reader);
    let truncated = false;
    vi.spyOn(internals, "readFileRange").mockImplementation(async (...args) => {
      if (!truncated && args[2] > 1024) {
        truncated = true;
        await writeFile(path, `${header}\n${msg("old")}\n`);
      }
      return original(...args);
    });
    const actual = await reader.getSession(id, "test-project" as UrlProjectId);
    reader.invalidateCache();
    const expected = await reader.getSession(
      id,
      "test-project" as UrlProjectId,
    );
    expect(truncated).toBe(true);
    expect(actual).not.toBeNull();
    expect(normalizeSession(actual!).messages).toEqual(
      normalizeSession(expected!).messages,
    );
  });

  it("rejects replacement between append admission and acquiring its bytes", async () => {
    const id = "append-admission-race",
      path = join(testDir, `${id}.jsonl`);
    const header = JSON.stringify({
      type: "session_meta",
      timestamp: "2026-01-01T00:00:00Z",
      payload: {
        id,
        cwd: "/test/project",
        timestamp: "2026-01-01T00:00:00Z",
        model_provider: "openai",
      },
    });
    const msg = (text: string) =>
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-01-01T00:00:01Z",
        payload: { type: "user_message", message: text },
      });
    await writeFile(path, `${header}\n${msg("old")}\n`);
    await reader.getSession(id, "test-project" as UrlProjectId);
    await appendFile(path, msg("append") + "\n");
    const windows = (
      reader as unknown as {
        rolloutWindowReader: import("../../src/sessions/codex-rollout-window.js").CodexRolloutWindowReader;
      }
    ).rolloutWindowReader;
    const original = windows.readEntryRange.bind(windows);
    let replaced = false;
    vi.spyOn(windows, "readEntryRange").mockImplementation(async (...args) => {
      if (args[1] > 0 && !replaced) {
        replaced = true;
        const replacement = join(testDir, "replacement.jsonl");
        await writeFile(replacement, `${header}\n${msg("new".repeat(300))}\n`);
        await rename(replacement, path);
      }
      return original(...args);
    });
    const actual = await reader.getSession(id, "test-project" as UrlProjectId);
    reader.invalidateCache();
    const expected = await reader.getSession(
      id,
      "test-project" as UrlProjectId,
    );
    expect(actual).not.toBeNull();
    expect(normalizeSession(actual!).messages).toEqual(
      normalizeSession(expected!).messages,
    );
  });

  it("rebuilds when a growing rollout replaces the cached file", async () => {
    const id = "replaced-growth",
      path = join(testDir, `${id}.jsonl`);
    const header = JSON.stringify({
      type: "session_meta",
      timestamp: "2026-01-01T00:00:00Z",
      payload: {
        id,
        cwd: "/test/project",
        timestamp: "2026-01-01T00:00:00Z",
        model_provider: "openai",
      },
    });
    const msg = (text: string) =>
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-01-01T00:00:01Z",
        payload: { type: "user_message", message: text },
      });
    await writeFile(path, `${header}\n${msg("old")}\n`);
    await reader.getSession(id, "test-project" as UrlProjectId);
    const replacement = join(testDir, "replacement.jsonl");
    await writeFile(replacement, `${header}\n${msg("new".repeat(500))}\n`);
    await rename(replacement, path);
    const loaded = await reader.getSession(id, "test-project" as UrlProjectId);
    expect(loaded?.data.session.entries).toHaveLength(2);
    const actual = normalizeSession(loaded!).messages;
    reader.invalidateCache();
    const rebuilt = await reader.getSession(id, "test-project" as UrlProjectId);
    expect(actual).toEqual(normalizeSession(rebuilt!).messages);
    expect(JSON.stringify(actual)).toContain("newnew");
  });

  it("finishes an incomplete final entry on the next append", async () => {
    const sessionId = "provisional-final-entry";
    const now = new Date().toISOString();
    const sessionPath = join(testDir, `${sessionId}.jsonl`);
    const message = JSON.stringify({
      type: "event_msg",
      timestamp: now,
      payload: { type: "user_message", message: "completed later" },
    });
    const splitAt = Math.floor(message.length / 2);
    await writeFile(
      sessionPath,
      `${JSON.stringify({
        type: "session_meta",
        timestamp: now,
        payload: {
          id: sessionId,
          cwd: "/test/project",
          timestamp: now,
          model_provider: "openai",
        },
      })}\n${message.slice(0, splitAt)}`,
    );

    await expect(
      reader.getSession(sessionId, "test-project" as UrlProjectId),
    ).resolves.toBeNull();
    expect(reader.getEntryCacheStats().partialLineBytes).toBeGreaterThan(0);

    await appendFile(sessionPath, `${message.slice(splitAt)}\n`);
    const loaded = await reader.getSession(
      sessionId,
      "test-project" as UrlProjectId,
    );
    expect(loaded?.data.session.entries).toHaveLength(2);
    expect(
      loaded?.data.session.entries.filter(
        (entry) =>
          entry.type === "event_msg" &&
          entry.payload.type === "user_message" &&
          entry.payload.message === "completed later",
      ),
    ).toHaveLength(1);
    expect(reader.getEntryCacheStats().partialLineBytes).toBe(0);
  });

  it("finishes a UTF-8 code point split across appended ranges", async () => {
    const sessionId = "provisional-utf8-entry";
    const now = new Date().toISOString();
    const sessionPath = join(testDir, `${sessionId}.jsonl`);
    const sessionMeta = JSON.stringify({
      type: "session_meta",
      timestamp: now,
      payload: {
        id: sessionId,
        cwd: "/test/project",
        timestamp: now,
        model_provider: "openai",
      },
    });
    const message = Buffer.from(
      JSON.stringify({
        type: "event_msg",
        timestamp: now,
        payload: {
          type: "user_message",
          message: "before-😀-after",
        },
      }),
    );
    const emojiStart = message.indexOf(Buffer.from("😀"));
    expect(emojiStart).toBeGreaterThan(0);
    const splitAt = emojiStart + 1;

    await writeFile(
      sessionPath,
      Buffer.concat([
        Buffer.from(`${sessionMeta}\n`),
        message.subarray(0, splitAt),
      ]),
    );
    await reader.getSession(sessionId, "test-project" as UrlProjectId);
    expect(reader.getEntryCacheStats().partialLineBytes).toBe(splitAt);

    await appendFile(
      sessionPath,
      Buffer.concat([message.subarray(splitAt), Buffer.from("\n")]),
    );
    const loaded = await reader.getSession(
      sessionId,
      "test-project" as UrlProjectId,
    );

    expect(
      loaded?.data.session.entries.find(
        (entry) =>
          entry.type === "event_msg" && entry.payload.type === "user_message",
      ),
    ).toMatchObject({
      payload: { message: "before-😀-after" },
    });
    expect(reader.getEntryCacheStats().partialLineBytes).toBe(0);
  });

  it("coalesces overlapping appends without duplicating the final response", async () => {
    const sessionId = "concurrent-append-cache";
    const now = new Date().toISOString();
    const sessionPath = join(testDir, `${sessionId}.jsonl`);
    await writeFile(
      sessionPath,
      `${[
        JSON.stringify({
          type: "session_meta",
          timestamp: now,
          payload: {
            id: sessionId,
            cwd: "/test/project",
            timestamp: now,
            model_provider: "openai",
          },
        }),
        JSON.stringify({
          type: "response_item",
          timestamp: now,
          payload: {
            id: "user-1",
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "start" }],
          },
        }),
      ].join("\n")}\n`,
    );

    await expect(
      reader.getSession(sessionId, "test-project" as UrlProjectId),
    ).resolves.toMatchObject({
      data: { session: { entries: expect.any(Array) } },
    });

    const finalResponse = {
      type: "response_item",
      timestamp: new Date().toISOString(),
      payload: {
        id: "assistant-final",
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "final response" }],
      },
    };
    const completion = {
      type: "event_msg",
      timestamp: new Date().toISOString(),
      payload: {
        type: "task_complete",
        turn_id: "turn-1",
        last_agent_message: "final response",
      },
    };
    await appendFile(
      sessionPath,
      `${[
        JSON.stringify({
          type: "response_item",
          timestamp: new Date().toISOString(),
          payload: {
            id: "reasoning-1",
            type: "reasoning",
            summary: [{ type: "summary_text", text: "checking" }],
          },
        }),
        JSON.stringify(finalResponse),
        JSON.stringify(completion),
      ].join("\n")}\n`,
    );

    const internals = reader as unknown as CodexEntryReadInternals;
    const originalReadFileRange = internals.readFileRange.bind(reader);
    let signalRangeStarted!: () => void;
    const rangeStarted = new Promise<void>((resolve) => {
      signalRangeStarted = resolve;
    });
    let releaseRange!: () => void;
    const rangeGate = new Promise<void>((resolve) => {
      releaseRange = resolve;
    });
    let blocked = false;
    const rangeSpy = vi
      .spyOn(internals, "readFileRange")
      .mockImplementation(async (filePath, start, length) => {
        if (!blocked && start > 0) {
          blocked = true;
          signalRangeStarted();
          await rangeGate;
        }
        return originalReadFileRange(filePath, start, length);
      });

    const firstRead = reader.getSession(
      sessionId,
      "test-project" as UrlProjectId,
    );
    await rangeStarted;
    const secondRead = reader.getSession(
      sessionId,
      "test-project" as UrlProjectId,
    );
    await vi.waitFor(() => {
      expect(
        internals.entryReadOwners.get(sessionId)?.joinedCallers,
      ).toBeGreaterThanOrEqual(1);
    });
    releaseRange();

    const [first, second] = await Promise.all([firstRead, secondRead]);
    expect(first?.data.session.entries).toEqual(second?.data.session.entries);
    expect(first?.data.session.entries).toHaveLength(5);
    expect(
      first?.data.session.entries.filter(
        (entry) =>
          entry.type === "response_item" &&
          entry.payload.type === "message" &&
          entry.payload.role === "assistant" &&
          entry.payload.id === "assistant-final",
      ),
    ).toHaveLength(1);
    expect(
      first?.data.session.entries.filter(
        (entry) =>
          entry.type === "event_msg" && entry.payload.type === "task_complete",
      ),
    ).toHaveLength(1);
    expect(first).not.toBeNull();
    if (!first) throw new Error("Expected the first concurrent detail read");
    const normalized = normalizeSession(first);
    expect(
      normalized.messages.filter(
        (message) => message.uuid === "assistant-final",
      ),
    ).toHaveLength(1);
    expect(
      normalized.messages.filter(
        (message) =>
          message.type === "system" && message.subtype === "turn_complete",
      ),
    ).toHaveLength(1);

    const retained = await reader.getSession(
      sessionId,
      "test-project" as UrlProjectId,
    );
    expect(retained?.data.session.entries).toEqual(first?.data.session.entries);
    expect(retained).not.toBeNull();
    if (!retained) throw new Error("Expected the retained detail read");
    expect(normalizeSession(retained).messages).toBe(normalized.messages);

    const reordered = await reader.getSession(
      sessionId,
      "test-project" as UrlProjectId,
    );
    expect(reordered).not.toBeNull();
    if (!reordered) throw new Error("Expected a reorderable detail read");
    const reorderedEntries = reordered.data.session.entries;
    [reorderedEntries[1], reorderedEntries[2]] = [
      reorderedEntries[2],
      reorderedEntries[1],
    ];
    expect(normalizeSession(reordered).messages).not.toBe(normalized.messages);
    expect(rangeSpy.mock.calls.length).toBeGreaterThan(0);
  });

  it("bounds a cold read when the transcript grows during file I/O", async () => {
    const sessionId = "bounded-cold-read";
    const now = new Date().toISOString();
    const sessionPath = join(testDir, `${sessionId}.jsonl`);
    await writeFile(
      sessionPath,
      `${[
        JSON.stringify({
          type: "session_meta",
          timestamp: now,
          payload: {
            id: sessionId,
            cwd: "/test/project",
            timestamp: now,
            model_provider: "openai",
          },
        }),
        JSON.stringify({
          type: "event_msg",
          timestamp: now,
          payload: { type: "user_message", message: "initial" },
        }),
      ].join("\n")}\n`,
    );

    const internals = reader as unknown as CodexEntryReadInternals;
    const originalReadFileRange = internals.readFileRange.bind(reader);
    let signalRangeStarted!: () => void;
    const rangeStarted = new Promise<void>((resolve) => {
      signalRangeStarted = resolve;
    });
    let releaseRange!: () => void;
    const rangeGate = new Promise<void>((resolve) => {
      releaseRange = resolve;
    });
    let blocked = false;
    vi.spyOn(internals, "readFileRange").mockImplementation(
      async (filePath, start, length) => {
        if (!blocked && start === 0) {
          blocked = true;
          signalRangeStarted();
          await rangeGate;
        }
        return originalReadFileRange(filePath, start, length);
      },
    );

    const coldRead = reader.getSession(
      sessionId,
      "test-project" as UrlProjectId,
    );
    await rangeStarted;
    await appendFile(
      sessionPath,
      `${JSON.stringify({
        type: "event_msg",
        timestamp: new Date().toISOString(),
        payload: { type: "user_message", message: "appended" },
      })}\n`,
    );
    releaseRange();

    const beforeAppendPass = await coldRead;
    expect(beforeAppendPass?.data.session.entries).toHaveLength(2);

    const afterAppendPass = await reader.getSession(
      sessionId,
      "test-project" as UrlProjectId,
    );
    expect(afterAppendPass?.data.session.entries).toHaveLength(3);
    expect(
      afterAppendPass?.data.session.entries.filter(
        (entry) =>
          entry.type === "event_msg" &&
          entry.payload.type === "user_message" &&
          entry.payload.message === "appended",
      ),
    ).toHaveLength(1);
  });

  it("binds the transcript version to rows accepted before summary work", async () => {
    const sessionId = "summary-race-snapshot";
    const timestamp = "2026-08-28T06:00:00.000Z";
    const sessionPath = join(testDir, `${sessionId}.jsonl`);
    await writeFile(
      sessionPath,
      `${[
        JSON.stringify({
          type: "session_meta",
          timestamp,
          payload: {
            id: sessionId,
            cwd: "/test/project",
            timestamp,
            model_provider: "openai",
          },
        }),
        JSON.stringify({
          type: "event_msg",
          timestamp,
          payload: { type: "user_message", message: "initial" },
        }),
      ].join("\n")}\n`,
    );
    const firstStats = await stat(sessionPath);
    const expectedFirstVersion = new Date(
      getCodexRolloutActivityTimeMs(sessionPath, firstStats),
    ).toISOString();

    const internals = reader as unknown as CodexEntryReadInternals;
    const originalBuildSummary =
      internals.buildSessionSummaryFromEntries.bind(reader);
    let signalSummaryStarted!: () => void;
    const summaryStarted = new Promise<void>((resolve) => {
      signalSummaryStarted = resolve;
    });
    let releaseSummary!: () => void;
    const summaryGate = new Promise<void>((resolve) => {
      releaseSummary = resolve;
    });
    vi.spyOn(internals, "buildSessionSummaryFromEntries").mockImplementation(
      async (...args) => {
        signalSummaryStarted();
        await summaryGate;
        return originalBuildSummary(...args);
      },
    );

    const firstRead = reader.getSession(
      sessionId,
      "test-project" as UrlProjectId,
    );
    await summaryStarted;
    await appendFile(
      sessionPath,
      `${JSON.stringify({
        type: "event_msg",
        timestamp: "2026-08-28T06:01:00.000Z",
        payload: { type: "agent_message", message: "appended" },
      })}\n`,
    );
    const appendedMtime = new Date(Math.ceil(firstStats.mtimeMs) + 1_000);
    await utimes(sessionPath, firstStats.atime, appendedMtime);
    const appendedStats = await stat(sessionPath);
    const expectedAppendedVersion = new Date(
      getCodexRolloutActivityTimeMs(sessionPath, appendedStats),
    ).toISOString();
    releaseSummary();

    const beforeAppendPass = await firstRead;
    expect(beforeAppendPass?.data.session.entries).toHaveLength(2);
    expect(beforeAppendPass?.transcriptSnapshotUpdatedAt).toBe(
      expectedFirstVersion,
    );
    expect(beforeAppendPass?.summary.updatedAt).toBe(expectedFirstVersion);

    const afterAppendPass = await reader.getSession(
      sessionId,
      "test-project" as UrlProjectId,
    );
    expect(afterAppendPass?.data.session.entries).toHaveLength(3);
    expect(afterAppendPass?.transcriptSnapshotUpdatedAt).toBe(
      expectedAppendedVersion,
    );
  });

  it("does not publish an entry read invalidated while it is in flight", async () => {
    const sessionId = "invalidated-entry-read";
    const now = new Date().toISOString();
    const sessionPath = join(testDir, `${sessionId}.jsonl`);
    await writeFile(
      sessionPath,
      `${[
        JSON.stringify({
          type: "session_meta",
          timestamp: now,
          payload: {
            id: sessionId,
            cwd: "/test/project",
            timestamp: now,
            model_provider: "openai",
          },
        }),
        JSON.stringify({
          type: "event_msg",
          timestamp: now,
          payload: { type: "user_message", message: "initial" },
        }),
      ].join("\n")}\n`,
    );
    await reader.getSession(sessionId, "test-project" as UrlProjectId);
    await appendFile(
      sessionPath,
      `${JSON.stringify({
        type: "event_msg",
        timestamp: new Date().toISOString(),
        payload: { type: "user_message", message: "after invalidation" },
      })}\n`,
    );

    const internals = reader as unknown as CodexEntryReadInternals;
    const originalReadFileRange = internals.readFileRange.bind(reader);
    let signalRangeStarted!: () => void;
    const rangeStarted = new Promise<void>((resolve) => {
      signalRangeStarted = resolve;
    });
    let releaseRange!: () => void;
    const rangeGate = new Promise<void>((resolve) => {
      releaseRange = resolve;
    });
    let blocked = false;
    const rangeSpy = vi
      .spyOn(internals, "readFileRange")
      .mockImplementation(async (filePath, start, length) => {
        if (!blocked && start > 0) {
          blocked = true;
          signalRangeStarted();
          await rangeGate;
        }
        return originalReadFileRange(filePath, start, length);
      });

    const inFlight = reader.getSession(
      sessionId,
      "test-project" as UrlProjectId,
    );
    await rangeStarted;
    reader.invalidateCache();
    releaseRange();

    const loaded = await inFlight;
    expect(loaded?.data.session.entries).toHaveLength(3);
    expect(
      loaded?.data.session.entries.filter(
        (entry) =>
          entry.type === "event_msg" &&
          entry.payload.type === "user_message" &&
          entry.payload.message === "after invalidation",
      ),
    ).toHaveLength(1);
    expect(rangeSpy.mock.calls.length).toBeGreaterThan(0);
  });

  it("preserves identical Codex messages at distinct log positions", async () => {
    const sessionId = "duplicate-records";
    const now = new Date().toISOString();
    const sessionPath = join(testDir, `${sessionId}.jsonl`);
    const userMessage = {
      type: "response_item",
      timestamp: now,
      payload: {
        id: "msg-user-1",
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "start here" }],
      },
    };
    await writeFile(
      sessionPath,
      `${[
        JSON.stringify({
          type: "session_meta",
          timestamp: now,
          payload: {
            id: sessionId,
            cwd: "/test/project",
            timestamp: now,
            model_provider: "openai",
          },
        }),
        JSON.stringify(userMessage),
        JSON.stringify({
          ...userMessage,
          payload: { ...userMessage.payload, id: "msg-user-2" },
        }),
      ].join("\n")}\n`,
    );

    const loaded = await reader.getSession(
      sessionId,
      "test-project" as UrlProjectId,
    );

    expect(loaded?.data.session.entries).toHaveLength(3);
    expect(
      loaded?.data.session.entries.filter(
        (entry) =>
          entry.type === "response_item" &&
          entry.payload.type === "message" &&
          entry.payload.role === "user",
      ),
    ).toHaveLength(2);
  });

  it("does not expose the mutable Codex entry cache", async () => {
    const sessionId = "entry-cache-copy";
    const now = new Date().toISOString();
    await writeFile(
      join(testDir, `${sessionId}.jsonl`),
      `${[
        JSON.stringify({
          type: "session_meta",
          timestamp: now,
          payload: {
            id: sessionId,
            cwd: "/test/project",
            timestamp: now,
            model_provider: "openai",
          },
        }),
        JSON.stringify({
          type: "response_item",
          timestamp: now,
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "first turn" }],
          },
        }),
      ].join("\n")}\n`,
    );

    const first = await reader.getSession(
      sessionId,
      "test-project" as UrlProjectId,
    );
    const duplicate = first?.data.session.entries[1];
    expect(duplicate).toBeDefined();
    if (duplicate) {
      first?.data.session.entries.push(duplicate);
    }

    const second = await reader.getSession(
      sessionId,
      "test-project" as UrlProjectId,
    );

    expect(second?.data.session.entries).toHaveLength(2);
  });
});
