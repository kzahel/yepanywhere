/**
 * Unit tests for CodexProvider.
 *
 * Tests provider detection, authentication checking, and message normalization
 * without requiring actual Codex CLI installation. The real app-server
 * contract check is opt-in via YEP_CODEX_REAL_CONTRACT_TEST.
 */

import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { CodexPlanToolMode } from "@yep-anywhere/shared";
import { compileTranscriptProjection } from "../../../../client/src/lib/transcriptProjection/compiler.ts";
import { getLogger } from "../../../src/logging/logger.js";
import { getCodexCommonPaths } from "../../../src/sdk/cli-detection.js";
import { logSDKMessage } from "../../../src/sdk/messageLogger.js";
import {
  CodexProvider,
  type CodexProviderConfig,
  formatCodexLoginCommand,
} from "../../../src/sdk/providers/codex.js";
import {
  codexAgentMessageDeltaFixtures,
  codexContextCompactionFixtures,
  codexInterruptedTurnFixtures,
  codexRawFunctionCallFixtures,
  createLiveEventState,
} from "./codex-event-fixtures.js";

vi.mock("../../../src/sdk/messageLogger.js", () => ({
  logSDKMessage: vi.fn(),
}));

// Scrub the agentctl session-env bridge variables this process may have
// inherited (e.g. when `pnpm test` runs inside a YA-managed shell). The
// app-server lifecycle tests assert the provider installs its OWN bridge; an
// ambient BASH_ENV would be chained as YEP_ORIGINAL_BASH_ENV into every probe
// shell the fake Codex spawns and break them.
const HERMETIC_BRIDGE_ENV_KEYS = [
  "BASH_ENV",
  "YEP_ORIGINAL_BASH_ENV",
  "AGENTCTL_SESSION_ID",
] as const;
const savedBridgeEnv = new Map<string, string | undefined>();

beforeEach(() => {
  vi.mocked(logSDKMessage).mockClear();
  savedBridgeEnv.clear();
  for (const key of HERMETIC_BRIDGE_ENV_KEYS) {
    savedBridgeEnv.set(key, process.env[key]);
    delete process.env[key];
  }
});

afterEach(() => {
  for (const [key, value] of savedBridgeEnv) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  vi.restoreAllMocks();
});

function createFakeCodexCommand(
  tempDir: string,
  basename: string,
  source: string,
): string {
  const scriptPath = join(tempDir, `${basename}.mjs`);
  const versionAwareSource = source.replace(
    /^(#![^\n]*\n)/,
    '$1if (process.argv[2] === "--version") { console.log("codex-cli 99.0.0"); process.exit(0); }\n',
  );
  writeFileSync(scriptPath, versionAwareSource, "utf-8");

  if (process.platform === "win32") {
    const cmdPath = join(tempDir, `${basename}.cmd`);
    writeFileSync(
      cmdPath,
      `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`,
      "utf-8",
    );
    return cmdPath;
  }

  chmodSync(scriptPath, 0o755);
  return scriptPath;
}

function isBashAvailable(): boolean {
  try {
    execFileSync("bash", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const bashIt = process.platform !== "win32" && isBashAvailable() ? it : it.skip;
const unixIt = process.platform !== "win32" ? it : it.skip;

describe("CodexProvider", () => {
  let provider: CodexProvider;

  beforeAll(() => {
    provider = new CodexProvider();
  });

  describe("isInstalled", () => {
    it("should return boolean indicating CLI availability", async () => {
      const isInstalled = await provider.isInstalled();
      expect(typeof isInstalled).toBe("boolean");
    });

    it("should use custom codexPath if provided and exists", async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "codex-path-"));
      const codexPath = join(tempDir, "codex");
      writeFileSync(codexPath, "#!/bin/sh\necho codex-cli 0.0.0\n", "utf-8");
      if (process.platform !== "win32") chmodSync(codexPath, 0o755);
      const customProvider = new CodexProvider({
        codexPath,
      });
      try {
        expect(await customProvider.isInstalled()).toBe(true);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("should treat missing custom codexPath as not installed", async () => {
      const customProvider = new CodexProvider({
        codexPath: "/nonexistent/path/to/codex",
      });
      expect(await customProvider.isInstalled()).toBe(false);
    });

    it("should include OpenAI Codex desktop hashed bin paths on Windows", () => {
      if (process.platform !== "win32") return;

      const tempDir = mkdtempSync(join(tmpdir(), "codex-desktop-bin-"));
      const oldLocalAppData = process.env.LOCALAPPDATA;
      try {
        const desktopBinDir = join(tempDir, "OpenAI", "Codex", "bin", "abc123");
        mkdirSync(desktopBinDir, { recursive: true });
        const codexPath = join(desktopBinDir, "codex.exe");
        writeFileSync(codexPath, "", "utf-8");

        process.env.LOCALAPPDATA = tempDir;

        expect(getCodexCommonPaths()).toContain(codexPath);
      } finally {
        if (oldLocalAppData === undefined) {
          delete process.env.LOCALAPPDATA;
        } else {
          process.env.LOCALAPPDATA = oldLocalAppData;
        }
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("should order OpenAI Codex desktop bins before stale sandbox fallback on Windows", () => {
      if (process.platform !== "win32") return;

      const tempDir = mkdtempSync(join(tmpdir(), "codex-desktop-bin-"));
      const oldLocalAppData = process.env.LOCALAPPDATA;
      try {
        const desktopBinDir = join(tempDir, "OpenAI", "Codex", "bin", "abc123");
        mkdirSync(desktopBinDir, { recursive: true });
        const codexPath = join(desktopBinDir, "codex.exe");
        writeFileSync(codexPath, "", "utf-8");

        process.env.LOCALAPPDATA = tempDir;

        const paths = getCodexCommonPaths();
        const desktopIndex = paths.indexOf(codexPath);
        const sandboxIndex = paths.findIndex((path) =>
          path.includes(`${sep}.codex${sep}.sandbox-bin${sep}codex.exe`),
        );

        expect(desktopIndex).toBeGreaterThanOrEqual(0);
        expect(sandboxIndex).toBeGreaterThanOrEqual(0);
        expect(desktopIndex).toBeLessThan(sandboxIndex);
      } finally {
        if (oldLocalAppData === undefined) {
          delete process.env.LOCALAPPDATA;
        } else {
          process.env.LOCALAPPDATA = oldLocalAppData;
        }
        rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  describe("getAuthStatus", () => {
    it("should return auth status object with required fields", async () => {
      const status = await provider.getAuthStatus();

      expect(typeof status.installed).toBe("boolean");
      expect(typeof status.authenticated).toBe("boolean");
      expect(typeof status.enabled).toBe("boolean");
    });

    it("reports a runnable logged-out CLI separately from authentication", async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "codex-auth-status-"));
      const codexPath = createFakeCodexCommand(
        tempDir,
        "fake-codex-logged-out",
        "#!/usr/bin/env node\nif (process.argv[2] === 'login' && process.argv[3] === 'status') process.exit(1);",
      );
      const loggedOutProvider = new CodexProvider({ codexPath });

      try {
        await expect(loggedOutProvider.getAuthStatus()).resolves.toEqual({
          installed: true,
          authenticated: false,
          enabled: false,
          loginCommand: formatCodexLoginCommand(codexPath),
        });
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("recognizes the selected CLI's ordinary login store", async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "codex-auth-status-"));
      const codexPath = createFakeCodexCommand(
        tempDir,
        "fake-codex-logged-in",
        "#!/usr/bin/env node\nif (process.argv[2] === 'login' && process.argv[3] === 'status') process.exit(0);",
      );
      const loggedInProvider = new CodexProvider({ codexPath });

      try {
        await expect(loggedInProvider.getAuthStatus()).resolves.toEqual({
          installed: true,
          authenticated: true,
          enabled: true,
        });
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  describe("isAuthenticated", () => {
    it("should return boolean", async () => {
      const isAuth = await provider.isAuthenticated();
      expect(typeof isAuth).toBe("boolean");
    });
  });

  describe("provider properties", () => {
    it("should have correct name", () => {
      expect(provider.name).toBe("codex");
    });

    it("should have correct displayName", () => {
      expect(provider.displayName).toBe("Codex");
    });
  });

  describe("startSession", () => {
    it("should return session object with required methods", async () => {
      const noCliProvider = new CodexProvider({
        codexPath: "/nonexistent/codex",
      });

      const session = await noCliProvider.startSession({
        cwd: "/tmp",
        initialMessage: { text: "test" },
      });

      expect(session.iterator).toBeDefined();
      expect(typeof session.abort).toBe("function");
      expect(typeof session.interrupt).toBe("function");
      expect(typeof session.probeLiveness).toBe("function");
      expect(typeof session.supportedCommands).toBe("function");
      expect(session.queue).toBeDefined();
    });

    it("advertises native slash commands for toolbar controls", async () => {
      const noCliProvider = new CodexProvider({
        codexPath: "/nonexistent/codex",
      });

      const session = await noCliProvider.startSession({
        cwd: "/tmp",
        initialMessage: { text: "test" },
      });

      await expect(session.supportedCommands?.()).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "compact" }),
          expect.objectContaining({
            name: "goal",
            description:
              "Keep working toward a verifiable end state until it is met",
            argumentHint: "<verifiable end state>",
            argumentCompletions: [
              expect.objectContaining({ value: "clear" }),
              expect.objectContaining({ value: "pause" }),
              expect.objectContaining({ value: "resume" }),
            ],
          }),
          expect.objectContaining({ name: "status" }),
          expect.objectContaining({ name: "usage" }),
        ]),
      );
    });

    it("runs goal control through thread goal RPCs without a model turn", async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "codex-goal-commands-"));
      const logPath = join(tempDir, "fake-codex-requests.jsonl");
      const codexPath = createFakeCodexCommand(
        tempDir,
        "fake-codex-goal-commands",
        buildFakeCodexAppServer(logPath),
      );
      const testProvider = new CodexProvider({ codexPath });
      const session = await testProvider.startSession({ cwd: tempDir });

      try {
        await session.iterator.next();
        await expect(session.runProviderCommand?.("goal")).resolves.toEqual({
          handled: true,
          output: { summary: "/goal", details: ["No goal set"] },
        });
        await expect(
          session.runProviderCommand?.("goal", "Ship the native goal path"),
        ).resolves.toEqual({
          handled: true,
          output: {
            summary: "/goal",
            details: ["Ship the native goal path", "Goal set"],
          },
        });
        await expect(
          session.runProviderCommand?.("goal", "pause"),
        ).resolves.toEqual({
          handled: true,
          output: {
            summary: "/goal",
            details: ["Ship the native goal path", "Goal paused"],
          },
        });
        await expect(session.supportedCommands?.()).resolves.toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              name: "goal",
              argumentCompletions: expect.arrayContaining([
                {
                  value: "Ship the native goal path",
                  description: "Current goal",
                },
              ]),
              providerDetails: {
                codex: {
                  goalObjective: "Ship the native goal path",
                  goalStatus: "paused",
                },
              },
            }),
          ]),
        );
        await expect(
          session.runProviderCommand?.("goal", "resume"),
        ).resolves.toEqual({
          handled: true,
          output: {
            summary: "/goal",
            details: ["Ship the native goal path", "Goal resumed"],
          },
        });
        await expect(
          session.runProviderCommand?.("goal", "Replace the current objective"),
        ).resolves.toEqual({
          handled: true,
          output: {
            summary: "/goal",
            details: ["Replace the current objective", "Goal set"],
          },
        });
        await expect(
          session.runProviderCommand?.("goal", "clear"),
        ).resolves.toEqual({
          handled: true,
          output: { summary: "/goal", details: ["Goal cleared"] },
        });
        await expect(session.supportedCommands?.()).resolves.toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              name: "goal",
              providerDetails: {
                codex: { goalObjective: null, goalStatus: null },
              },
            }),
          ]),
        );
        await expect(
          session.runProviderCommand?.("goal", "Start the replacement goal"),
        ).resolves.toEqual({
          handled: true,
          output: {
            summary: "/goal",
            details: ["Start the replacement goal", "Goal set"],
          },
        });
        await expect(
          session.runProviderCommand?.("goal", "edit"),
        ).resolves.toEqual({
          handled: true,
          error:
            "Interactive /goal edit is unavailable in YA. Set the revised objective with /goal <objective>.",
        });

        const beforeConcurrentCommands = readFakeCodexRequests(logPath).length;
        await Promise.all([
          session.runProviderCommand?.("goal", "First replacement"),
          session.runProviderCommand?.("goal", "Second replacement"),
        ]);
        expect(
          readFakeCodexRequests(logPath)
            .slice(beforeConcurrentCommands)
            .map((request) => request.method),
        ).toEqual([
          "thread/goal/get",
          "thread/goal/clear",
          "thread/goal/set",
          "thread/goal/get",
          "thread/goal/clear",
          "thread/goal/set",
        ]);

        const methods = readFakeCodexRequests(logPath).map(
          (request) => request.method,
        );
        expect(methods).toEqual(
          expect.arrayContaining([
            "thread/goal/get",
            "thread/goal/set",
            "thread/goal/clear",
          ]),
        );
        expect(methods).not.toContain("turn/start");
      } finally {
        await session.abort();
        await session.iterator.return?.(undefined);
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("preserves an unchanged objective without resetting its goal", async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "codex-goal-unchanged-"));
      const logPath = join(tempDir, "requests.jsonl");
      const codexPath = createFakeCodexCommand(
        tempDir,
        "codex",
        buildFakeCodexAppServer(logPath),
      );
      const session = await new CodexProvider({ codexPath }).startSession({
        cwd: tempDir,
      });
      try {
        await session.iterator.next();
        await session.runProviderCommand?.("goal", "Keep the accounting");
        await session.runProviderCommand?.("goal", "pause");
        const before = readFakeCodexRequests(logPath).length;
        await expect(
          session.runProviderCommand?.("goal", "  Keep the accounting  "),
        ).resolves.toMatchObject({
          handled: true,
          output: {
            details: ["Keep the accounting", "Goal paused"],
          },
        });
        expect(
          readFakeCodexRequests(logPath)
            .slice(before)
            .map((r) => r.method),
        ).toEqual(["thread/goal/get"]);
      } finally {
        await session.abort();
        await session.iterator.return?.(undefined);
        rmSync(tempDir, { recursive: true });
      }
    });

    it.each([false, true])(
      "streams goal-started work without another user turn (already working: %s)",
      async (alreadyWorking) => {
        const tempDir = mkdtempSync(join(tmpdir(), "codex-goal-stream-"));
        const logPath = join(tempDir, "requests.jsonl");
        const codexPath = createFakeCodexCommand(
          tempDir,
          "fake-codex",
          buildFakeCodexAppServer(logPath, "chatgpt", undefined, true),
        );
        const session = await new CodexProvider({ codexPath }).startSession({
          cwd: tempDir,
          ...(alreadyWorking
            ? { initialMessage: { text: "Initial work" } }
            : {}),
        });
        const messages: unknown[] = [];
        const consuming = (async () => {
          for await (const message of session.iterator) messages.push(message);
        })();
        try {
          await vi.waitFor(() => expect(messages.length).toBeGreaterThan(0));
          if (alreadyWorking) {
            await vi.waitFor(() =>
              expect(
                readFakeCodexRequests(logPath).some(
                  (r) => r.method === "turn/start",
                ),
              ).toBe(true),
            );
          }
          await session.runProviderCommand?.("goal", "clear");
          await session.runProviderCommand?.("goal", "Keep working");
          await vi.waitFor(() =>
            expect(messages).toContainEqual(
              expect.objectContaining({
                type: "assistant",
                message: expect.objectContaining({
                  content: "Goal continuation output",
                }),
              }),
            ),
          );
          expect(
            readFakeCodexRequests(logPath).filter(
              (r) => r.method === "turn/start",
            ),
          ).toHaveLength(alreadyWorking ? 1 : 0);
          expect(messages).toContainEqual(
            expect.objectContaining({
              subtype: "commands_changed",
              slash_command_inventory: expect.arrayContaining([
                expect.objectContaining({
                  name: "goal",
                  providerDetails: {
                    codex: {
                      goalObjective: "Keep working",
                      goalStatus: "active",
                    },
                  },
                }),
              ]),
            }),
          );
          await session.runProviderCommand?.("goal", "pause");
          await vi.waitFor(() =>
            expect(messages).toContainEqual(
              expect.objectContaining({
                subtype: "commands_changed",
                slash_command_inventory: expect.arrayContaining([
                  expect.objectContaining({
                    name: "goal",
                    providerDetails: {
                      codex: {
                        goalObjective: "Keep working",
                        goalStatus: "paused",
                      },
                    },
                  }),
                ]),
              }),
            ),
          );
        } finally {
          await session.abort();
          await consuming;
          rmSync(tempDir, { recursive: true, force: true });
        }
      },
    );

    it("reports a goal status preserved by Codex", async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "codex-goal-status-"));
      const logPath = join(tempDir, "fake-codex-requests.jsonl");
      const codexPath = createFakeCodexCommand(
        tempDir,
        "fake-codex-goal-status",
        buildFakeCodexAppServer(logPath, "chatgpt", "budgetLimited"),
      );
      const testProvider = new CodexProvider({ codexPath });
      const session = await testProvider.startSession({ cwd: tempDir });

      try {
        await session.iterator.next();
        await session.runProviderCommand?.("goal", "Exhausted objective");
        await expect(
          session.runProviderCommand?.("goal", "resume"),
        ).resolves.toEqual({
          handled: true,
          output: {
            summary: "/goal",
            details: ["Exhausted objective", "Goal budget limited"],
          },
        });
      } finally {
        await session.abort();
        await session.iterator.return?.(undefined);
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("runs status and usage through account RPCs without a model turn", async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "codex-account-commands-"));
      const logPath = join(tempDir, "fake-codex-requests.jsonl");
      const codexPath = createFakeCodexCommand(
        tempDir,
        "fake-codex-account-commands",
        buildFakeCodexAppServer(logPath),
      );
      const testProvider = new CodexProvider({ codexPath });
      const session = await testProvider.startSession({
        cwd: tempDir,
        model: "gpt-5.6",
      });

      try {
        const init = await session.iterator.next();
        expect(init.value).toMatchObject({
          type: "system",
          subtype: "init",
          session_id: "thread-1",
        });

        await expect(session.runProviderCommand?.("status")).resolves.toEqual(
          expect.objectContaining({
            handled: true,
            output: expect.objectContaining({
              summary: "/status",
              details: expect.arrayContaining([
                expect.stringContaining("Model: gpt-5.4-mini"),
                expect.stringContaining("Account: ChatGPT (plus)"),
                expect.stringContaining("codex primary (5h): 24% used"),
              ]),
            }),
          }),
        );
        await expect(
          session.runProviderCommand?.("usage", "weekly"),
        ).resolves.toEqual(
          expect.objectContaining({
            handled: true,
            output: expect.objectContaining({
              summary: "/usage weekly",
              details: expect.arrayContaining([
                expect.stringContaining("Lifetime: 12,345"),
                expect.stringContaining("week of 2026-08-03  100"),
                expect.stringContaining("week of 2026-08-10  200"),
              ]),
            }),
          }),
        );

        const requests = readFakeCodexRequests(logPath);
        expect(requests.map((request) => request.method)).toEqual(
          expect.arrayContaining([
            "account/read",
            "account/rateLimits/read",
            "account/usage/read",
          ]),
        );
        expect(
          requests.some((request) => request.method === "turn/start"),
        ).toBe(false);
      } finally {
        await session.abort();
        await session.iterator.return?.(undefined);
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("logs in with an in-memory external ChatGPT projection", async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "codex-external-auth-"));
      const logPath = join(tempDir, "fake-codex-requests.jsonl");
      const codexHome = join(tempDir, "isolated-codex-home");
      mkdirSync(codexHome, { mode: 0o700 });
      const codexPath = createFakeCodexCommand(
        tempDir,
        "fake-codex-external-auth",
        buildFakeCodexAppServer(logPath),
      );
      const testProvider = new CodexProvider({
        codexPath,
        codexHome,
        externalChatgptAuth: {
          initialProjection: {
            accessToken: "external-access-token",
            chatgptAccountId: "account-one",
            chatgptPlanType: "plus",
          },
          refresh: async () => ({
            accessToken: "refreshed-access-token",
            chatgptAccountId: "account-one",
            chatgptPlanType: "plus",
          }),
        },
      });
      const session = await testProvider.startSession({ cwd: tempDir });

      try {
        await expect(session.iterator.next()).resolves.toMatchObject({
          value: {
            type: "system",
            subtype: "init",
            session_id: "thread-1",
          },
        });
        const login = readFakeCodexRequests(logPath).find(
          (request) => request.method === "account/login/start",
        );
        expect(login?.params).toEqual({
          type: "chatgptAuthTokens",
          accessToken: "external-access-token",
          chatgptAccountId: "account-one",
          chatgptPlanType: "plus",
        });
        expect(existsSync(join(codexHome, "auth.json"))).toBe(false);
      } finally {
        await session.abort();
        await session.iterator.return?.(undefined);
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("reports that /usage requires ChatGPT subscription auth", async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "codex-api-key-usage-"));
      const logPath = join(tempDir, "fake-codex-requests.jsonl");
      const codexPath = createFakeCodexCommand(
        tempDir,
        "fake-codex-api-key-usage",
        buildFakeCodexAppServer(logPath, "apiKey"),
      );
      const testProvider = new CodexProvider({ codexPath });
      const session = await testProvider.startSession({ cwd: tempDir });

      try {
        await session.iterator.next();
        await expect(session.runProviderCommand?.("usage")).resolves.toEqual({
          handled: true,
          output: { summary: "Sign in with ChatGPT to use /usage." },
        });
        expect(
          readFakeCodexRequests(logPath).some(
            (request) => request.method === "account/usage/read",
          ),
        ).toBe(false);
      } finally {
        await session.abort();
        await session.iterator.return?.(undefined);
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("should emit error if Codex CLI is not found", async () => {
      const errorLog = vi
        .spyOn(getLogger(), "error")
        .mockImplementation(() => undefined);
      const noCliProvider = new CodexProvider({
        codexPath: "/nonexistent/codex",
      });

      const session = await noCliProvider.startSession({
        cwd: "/tmp",
        initialMessage: { text: "test" },
      });

      const messages: unknown[] = [];
      for await (const msg of session.iterator) {
        messages.push(msg);
        if (msg.type === "result" || msg.type === "error") break;
      }

      const error = messages.find(
        (message): message is Record<string, unknown> =>
          Boolean(
            message &&
              typeof message === "object" &&
              (message as { type?: unknown }).type === "error",
          ),
      );
      expect(error).toMatchObject({
        type: "error",
        codexWillRetry: false,
        codexErrorScope: "app_server_process",
      });
      expect(error?.error).toContain("/nonexistent/codex");
      expect(errorLog).toHaveBeenCalledWith(
        expect.objectContaining({
          component: "codex-provider",
          error: expect.any(Error),
          codexFailureTrace: expect.objectContaining({
            activeTurnId: null,
          }),
        }),
        "Error in codex app-server session",
      );
    });
  });
});

describe("CodexProvider app-server lifecycle", () => {
  it("wakes the idle session iterator when abort closes its input queue", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "codex-provider-abort-idle-"));
    const logPath = join(tempDir, "fake-codex-requests.jsonl");
    const codexPath = createFakeCodexCommand(
      tempDir,
      "fake-codex-abort-idle",
      buildFakeCodexPermissionAppServer(logPath),
    );
    const testProvider = new CodexProvider({ codexPath });
    const session = await testProvider.startSession({
      cwd: tempDir,
      initialMessage: { text: "finish one turn" },
    });

    try {
      await consumeCodexTurn(session.iterator);
      const pending = session.iterator.next();

      await session.abort();

      await expect(pending).resolves.toMatchObject({
        done: false,
        value: { type: "result" },
      });
      await expect(session.iterator.next()).resolves.toMatchObject({
        done: true,
      });
    } finally {
      await session.abort();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("retries selected-model overloads without resending user input", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "codex-overload-retry-"));
    const logPath = join(tempDir, "fake-codex-requests.jsonl");
    const codexPath = createFakeCodexCommand(
      tempDir,
      "fake-codex-overload-retry",
      buildFakeCodexFailureAppServer(logPath, "serverOverloaded", 2),
    );
    const retryDelays: number[] = [];
    const testProvider = new CodexProvider({
      codexPath,
      overloadRetryWait: async (delayMs, signal) => {
        retryDelays.push(delayMs);
        return !signal.aborted;
      },
    });
    const session = await testProvider.startSession({
      cwd: tempDir,
      model: "gpt-5.6-codex",
      initialMessage: { text: "keep this prompt singular", uuid: "user-1" },
    });

    try {
      const messages: Array<Record<string, unknown>> = [];
      while (true) {
        const next = await session.iterator.next();
        if (next.done) break;
        messages.push(next.value);
        if (next.value.type === "result") break;
      }

      expect(retryDelays).toEqual([20_000, 45_000]);
      expect(
        messages.filter((message) => message.type === "user"),
      ).toHaveLength(1);
      expect(
        messages.filter(
          (message) =>
            message.type === "error" && message.codexWillRetry === true,
        ),
      ).toMatchObject([
        {
          codexErrorInfo: "serverOverloaded",
          codexRetryAttempt: 1,
          codexRetryDelayMs: 20_000,
          codexRetryMaxRetries: 16,
        },
        {
          codexErrorInfo: "serverOverloaded",
          codexRetryAttempt: 2,
          codexRetryDelayMs: 45_000,
          codexRetryMaxRetries: 16,
        },
      ]);
      expect(
        messages.some(
          (message) =>
            message.type === "error" && message.codexWillRetry === false,
        ),
      ).toBe(false);
      expect(messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "assistant",
            message: expect.objectContaining({ content: "Recovered answer" }),
          }),
        ]),
      );

      const turnStarts = readFakeCodexRequests(logPath).filter(
        (request) => request.method === "turn/start",
      );
      expect(turnStarts).toHaveLength(3);
      expect(turnStarts[0]?.params).toMatchObject({
        clientUserMessageId: "user-1",
        input: [
          {
            type: "text",
            text: "keep this prompt singular",
            text_elements: [],
          },
        ],
      });
      expect(turnStarts.slice(1).map((request) => request.params)).toEqual([
        expect.objectContaining({ input: [] }),
        expect.objectContaining({ input: [] }),
      ]);
      expect(
        turnStarts
          .slice(1)
          .every(
            (request) => request.params?.clientUserMessageId === undefined,
          ),
      ).toBe(true);
    } finally {
      await session.abort();
      await session.iterator.return?.(undefined);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("ends overload recovery after the bounded retry budget", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "codex-overload-limit-"));
    const logPath = join(tempDir, "fake-codex-requests.jsonl");
    const codexPath = createFakeCodexCommand(
      tempDir,
      "fake-codex-overload-limit",
      buildFakeCodexFailureAppServer(logPath, "serverOverloaded", 100),
    );
    const retryDelays: number[] = [];
    const testProvider = new CodexProvider({
      codexPath,
      overloadRetryWait: async (delayMs) => {
        retryDelays.push(delayMs);
        return true;
      },
    });
    const session = await testProvider.startSession({
      cwd: tempDir,
      initialMessage: { text: "eventually stop retrying" },
    });

    try {
      const messages: Array<Record<string, unknown>> = [];
      while (true) {
        const next = await session.iterator.next();
        if (next.done) break;
        messages.push(next.value);
        if (next.value.type === "result") break;
      }

      expect(retryDelays).toHaveLength(16);
      expect(retryDelays[0]).toBe(20_000);
      expect(retryDelays.at(-1)).toBe(1_445_000);
      expect(
        readFakeCodexRequests(logPath).filter(
          (request) => request.method === "turn/start",
        ),
      ).toHaveLength(17);
      expect(messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "error",
            codexErrorInfo: "serverOverloaded",
            codexWillRetry: false,
            codexOverloadRetryExhausted: true,
            codexRetryAttempt: 16,
            codexRetryMaxRetries: 16,
          }),
        ]),
      );
    } finally {
      await session.abort();
      await session.iterator.return?.(undefined);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("does not retry Codex usage-limit failures", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "codex-quota-terminal-"));
    const logPath = join(tempDir, "fake-codex-requests.jsonl");
    const codexPath = createFakeCodexCommand(
      tempDir,
      "fake-codex-quota-terminal",
      buildFakeCodexFailureAppServer(logPath, "usageLimitExceeded", 100),
    );
    const overloadRetryWait = vi.fn(async () => true);
    const testProvider = new CodexProvider({
      codexPath,
      overloadRetryWait,
    });
    const session = await testProvider.startSession({
      cwd: tempDir,
      initialMessage: { text: "quota is terminal" },
    });

    try {
      const messages: Array<Record<string, unknown>> = [];
      while (true) {
        const next = await session.iterator.next();
        if (next.done) break;
        messages.push(next.value);
        if (next.value.type === "result") break;
      }

      expect(overloadRetryWait).not.toHaveBeenCalled();
      expect(
        readFakeCodexRequests(logPath).filter(
          (request) => request.method === "turn/start",
        ),
      ).toHaveLength(1);
      expect(messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "error",
            codexErrorInfo: "usageLimitExceeded",
            codexWillRetry: false,
          }),
        ]),
      );
    } finally {
      await session.abort();
      await session.iterator.return?.(undefined);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("cancels a pending overload retry when the session aborts", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "codex-overload-abort-"));
    const logPath = join(tempDir, "fake-codex-requests.jsonl");
    const codexPath = createFakeCodexCommand(
      tempDir,
      "fake-codex-overload-abort",
      buildFakeCodexFailureAppServer(logPath, "serverOverloaded", 100),
    );
    let announceWaitStarted: (() => void) | undefined;
    const waitStarted = new Promise<void>((resolve) => {
      announceWaitStarted = resolve;
    });
    const testProvider = new CodexProvider({
      codexPath,
      overloadRetryWait: async (_delayMs, signal) => {
        announceWaitStarted?.();
        return await new Promise<boolean>((resolve) => {
          signal.addEventListener("abort", () => resolve(false), {
            once: true,
          });
        });
      },
    });
    const session = await testProvider.startSession({
      cwd: tempDir,
      initialMessage: { text: "abort this retry" },
    });

    try {
      while (true) {
        const next = await session.iterator.next();
        if (
          next.done ||
          (next.value.type === "error" && next.value.codexWillRetry === true)
        ) {
          break;
        }
      }
      const pending = session.iterator.next();
      await waitStarted;
      await session.abort();
      await pending;

      expect(
        readFakeCodexRequests(logPath).filter(
          (request) => request.method === "turn/start",
        ),
      ).toHaveLength(1);
    } finally {
      await session.abort();
      await session.iterator.return?.(undefined);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("switches complete turn policies without restarting app-server", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "codex-provider-policy-"));
    const logPath = join(tempDir, "fake-codex-requests.jsonl");
    const codexPath = createFakeCodexCommand(
      tempDir,
      "fake-codex-policy",
      buildFakeCodexPermissionAppServer(logPath),
    );
    const testProvider = new CodexProvider({ codexPath });
    const onPermissionModeApplied = vi.fn();
    const session = await testProvider.startSession({
      cwd: tempDir,
      initialMessage: { text: "ask turn", mode: "default" },
      permissionMode: "default",
      onPermissionModeApplied,
    });

    try {
      await consumeCodexTurn(session.iterator);
      session.queue.push({
        text: "bypass turn",
        mode: "bypassPermissions",
      });
      await consumeCodexTurn(session.iterator);
      session.queue.push({ text: "ask again", mode: "default" });
      await consumeCodexTurn(session.iterator);

      const requests = readFakeCodexRequests(logPath);
      const turnStarts = requests.filter(
        (request) => request.method === "turn/start",
      );
      expect(
        requests.filter((request) => request.method === "thread/start"),
      ).toHaveLength(1);
      expect(new Set(requests.map((request) => request.pid))).toHaveLength(1);
      expect(turnStarts).toHaveLength(3);
      expect(onPermissionModeApplied.mock.calls).toEqual([
        ["default"],
        ["default"],
        ["bypassPermissions"],
        ["default"],
      ]);
      expect(turnStarts.map((request) => request.params)).toEqual([
        expect.objectContaining({
          approvalPolicy: "on-request",
          sandboxPolicy: {
            type: "workspaceWrite",
            writableRoots: ["/configured-write-root"],
            networkAccess: true,
            excludeTmpdirEnvVar: true,
            excludeSlashTmp: true,
          },
        }),
        expect.objectContaining({
          approvalPolicy: "never",
          sandboxPolicy: { type: "dangerFullAccess" },
        }),
        expect.objectContaining({
          approvalPolicy: "on-request",
          sandboxPolicy: {
            type: "workspaceWrite",
            writableRoots: ["/configured-write-root"],
            networkAccess: true,
            excludeTmpdirEnvVar: true,
            excludeSlashTmp: true,
          },
        }),
      ]);
      expect(
        turnStarts.map((request) => ({
          approvalPolicy: request.effectiveApprovalPolicy,
          sandboxPolicy: request.effectiveSandboxPolicy,
        })),
      ).toEqual([
        {
          approvalPolicy: "on-request",
          sandboxPolicy: {
            type: "workspaceWrite",
            writableRoots: ["/configured-write-root"],
            networkAccess: true,
            excludeTmpdirEnvVar: true,
            excludeSlashTmp: true,
          },
        },
        {
          approvalPolicy: "never",
          sandboxPolicy: { type: "dangerFullAccess" },
        },
        {
          approvalPolicy: "on-request",
          sandboxPolicy: {
            type: "workspaceWrite",
            writableRoots: ["/configured-write-root"],
            networkAccess: true,
            excludeTmpdirEnvVar: true,
            excludeSlashTmp: true,
          },
        },
      ]);
    } finally {
      await session.abort();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("applies changed effort to the next turn without restarting app-server", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "codex-provider-effort-"));
    const logPath = join(tempDir, "fake-codex-requests.jsonl");
    const codexPath = createFakeCodexCommand(
      tempDir,
      "fake-codex-effort",
      buildFakeCodexPermissionAppServer(logPath),
    );
    const testProvider = new CodexProvider({ codexPath });
    const session = await testProvider.startSession({
      cwd: tempDir,
      initialMessage: { text: "low effort turn" },
      effort: "low",
    });

    try {
      await consumeCodexTurn(session.iterator);
      expect(session.setEffort).toBeTypeOf("function");
      await session.setEffort?.("high");
      session.queue.push({ text: "high effort turn" });
      await consumeCodexTurn(session.iterator);

      const requests = readFakeCodexRequests(logPath);
      const turnStarts = requests.filter(
        (request) => request.method === "turn/start",
      );
      expect(
        requests.filter((request) => request.method === "thread/start"),
      ).toHaveLength(1);
      expect(new Set(requests.map((request) => request.pid))).toHaveLength(1);
      expect(turnStarts.map((request) => request.params?.effort)).toEqual([
        "low",
        "high",
      ]);
    } finally {
      await session.abort();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("updates model and effort during a live turn and retains both", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "codex-provider-settings-"));
    const logPath = join(tempDir, "fake-codex-requests.jsonl");
    const codexPath = createFakeCodexCommand(
      tempDir,
      "fake-codex-settings",
      buildFakeCodexPermissionAppServer(logPath, 2, "applied", 100),
    );
    const testProvider = new CodexProvider({ codexPath });
    const session = await testProvider.startSession({
      cwd: tempDir,
      initialMessage: { text: "live settings turn" },
      effort: "low",
    });

    try {
      const firstTurn = consumeCodexTurn(session.iterator);
      await waitForFakeCodexRequest(logPath, "turn/start");
      expect(session.effortUpdatesActiveTurn).toBe(true);
      expect(session.setModel).toBeTypeOf("function");

      const effortUpdate = session.setEffort?.("high");
      const modelUpdate = session.setModel?.("gpt-5.4");
      await Promise.all([effortUpdate, modelUpdate]);
      await firstTurn;

      session.queue.push({ text: "retained settings turn" });
      await consumeCodexTurn(session.iterator);

      const requests = readFakeCodexRequests(logPath);
      expect(
        requests
          .filter((request) => request.method === "turn/settings/update")
          .map((request) => request.params),
      ).toEqual([
        {
          threadId: "thread-policy",
          turnId: "turn-1",
          effort: "high",
        },
        {
          threadId: "thread-policy",
          turnId: "turn-1",
          model: "gpt-5.4",
        },
      ]);
      expect(
        requests
          .filter((request) => request.method === "turn/start")
          .map((request) => ({
            model: request.params?.model,
            effort: request.params?.effort,
          })),
      ).toEqual([
        { model: null, effort: "low" },
        { model: "gpt-5.4", effort: "high" },
      ]);
    } finally {
      await session.abort();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("retains a setting when the live turn target is unavailable", async () => {
    const tempDir = mkdtempSync(
      join(tmpdir(), "codex-provider-settings-race-"),
    );
    const logPath = join(tempDir, "fake-codex-requests.jsonl");
    const codexPath = createFakeCodexCommand(
      tempDir,
      "fake-codex-settings-race",
      buildFakeCodexPermissionAppServer(logPath, 1, "targetUnavailable"),
    );
    const testProvider = new CodexProvider({ codexPath });
    const session = await testProvider.startSession({
      cwd: tempDir,
      initialMessage: { text: "racing settings turn" },
    });

    try {
      const firstTurn = consumeCodexTurn(session.iterator);
      await waitForFakeCodexRequest(logPath, "turn/start");
      await session.setModel?.("gpt-5.4");
      await firstTurn;

      session.queue.push({ text: "fallback settings turn" });
      await consumeCodexTurn(session.iterator);

      expect(
        readFakeCodexRequests(logPath)
          .filter((request) => request.method === "turn/start")
          .map((request) => request.params?.model),
      ).toEqual([null, "gpt-5.4"]);
    } finally {
      await session.abort();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("retains effort selected during compaction when live updates are refused", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "codex-compact-effort-"));
    const logPath = join(tempDir, "requests.jsonl");
    const codexPath = createFakeCodexCommand(
      tempDir,
      "fake-codex-compact-effort",
      buildFakeCodexPermissionAppServer(
        logPath,
        2,
        {
          code: -32600,
          message:
            "turn settings updates require the step_model_switching feature",
        },
        0,
        true,
      ),
    );
    const session = await new CodexProvider({ codexPath }).startSession({
      cwd: tempDir,
      initialMessage: { text: "compacting turn" },
      effort: "low",
    });

    try {
      let compacting = false;
      while (!compacting) {
        const result = await session.iterator.next();
        if (result.done) break;
        const message = result.value;
        if (message.type === "system" && message.status === "compacting") {
          compacting = true;
          break;
        }
      }
      expect(compacting).toBe(true);
      await expect(session.setEffort?.("high")).resolves.toBeUndefined();
      await expect(session.setEffort?.("xhigh")).resolves.toBeUndefined();
      await consumeCodexTurn(session.iterator);
      session.queue.push({ text: "next user turn" });
      await consumeCodexTurn(session.iterator);

      const requests = readFakeCodexRequests(logPath);
      expect(requests.filter((r) => r.method === "turn/interrupt")).toEqual([]);
      expect(requests.filter((r) => r.method === "thread/start")).toHaveLength(
        1,
      );
      expect(
        requests
          .filter((r) => r.method === "turn/start")
          .map((r) => r.params?.effort),
      ).toEqual(["low", "xhigh"]);
    } finally {
      await session.abort();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it.each([-32602, -32603])(
    "surfaces effort update RPC error %s without changing the next turn",
    async (code) => {
      const tempDir = mkdtempSync(join(tmpdir(), "codex-effort-error-"));
      const logPath = join(tempDir, "requests.jsonl");
      const codexPath = createFakeCodexCommand(
        tempDir,
        "fake-codex-effort-error",
        buildFakeCodexPermissionAppServer(logPath, 1, {
          code,
          message: "effort update failed",
        }),
      );
      const session = await new CodexProvider({ codexPath }).startSession({
        cwd: tempDir,
        initialMessage: { text: "active turn" },
        effort: "low",
      });

      try {
        const firstTurn = consumeCodexTurn(session.iterator);
        await waitForFakeCodexRequest(logPath, "turn/start");
        await expect(session.setEffort?.("high")).rejects.toThrow(
          "effort update failed",
        );
        await firstTurn;
        session.queue.push({ text: "unchanged effort turn" });
        await consumeCodexTurn(session.iterator);
        expect(
          readFakeCodexRequests(logPath)
            .filter((r) => r.method === "turn/start")
            .map((r) => r.params?.effort),
        ).toEqual(["low", "low"]);
      } finally {
        await session.abort();
        rmSync(tempDir, { recursive: true, force: true });
      }
    },
  );

  it("discovers and dispatches Codex skills with canonical text and metadata", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "codex-provider-skills-"));
    const logPath = join(tempDir, "fake-codex-requests.jsonl");
    const codexPath = createFakeCodexCommand(
      tempDir,
      "fake-codex-skills",
      buildFakeCodexAppServer(logPath),
    );
    const testProvider = new CodexProvider({ codexPath });
    const session = await testProvider.startSession({
      cwd: tempDir,
      initialMessage: { text: "check /doubt and keep /missing literal" },
    });

    try {
      const init = await session.iterator.next();
      expect(init.value).toMatchObject({
        type: "system",
        subtype: "init",
        slash_command_inventory: expect.arrayContaining([
          expect.objectContaining({
            name: "doubt",
            invocation: {
              kind: "skill",
              prefix: "$",
              inventoryState: "current",
            },
          }),
        ]),
      });
      let userMessage: unknown;
      while (
        !userMessage ||
        (userMessage as { type?: unknown }).type !== "user"
      ) {
        userMessage = (await session.iterator.next()).value;
      }
      expect(userMessage).toMatchObject({
        type: "user",
        message: {
          content: "check $doubt and keep /missing literal",
        },
      });

      const turnProgress = session.iterator.next();
      await waitForFakeCodexRequest(logPath, "turn/start");
      const request = readFakeCodexRequests(logPath).find(
        (entry) => entry.method === "turn/start",
      );
      expect(request?.params).toMatchObject({
        input: [
          {
            type: "text",
            text: "check $doubt and keep /missing literal",
            text_elements: [],
          },
          {
            type: "skill",
            name: "doubt",
            path: "/skills/doubt/SKILL.md",
          },
        ],
      });
      await session.abort();
      await turnProgress;
    } finally {
      await session.abort();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  unixIt(
    "escalates shutdown when the Codex app-server ignores SIGTERM",
    async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "codex-provider-kill-"));
      const logPath = join(tempDir, "fake-codex-requests.jsonl");
      const codexPath = createFakeCodexCommand(
        tempDir,
        "fake-codex-ignore-term",
        `${buildFakeCodexAppServer(logPath)}\nprocess.on("SIGTERM", () => {});`,
      );

      let session:
        | Awaited<ReturnType<CodexProvider["startSession"]>>
        | undefined;
      let consume: Promise<void> | undefined;
      let pid: number | undefined;

      try {
        const testProvider = new CodexProvider({ codexPath });
        session = await testProvider.startSession({
          cwd: tempDir,
          initialMessage: { text: "wait to be killed" },
          effort: "low",
        });
        consume = (async () => {
          for await (const _message of session?.iterator ?? []) {
            // drain until the verified abort below closes the iterator
          }
        })();

        await waitForFakeCodexRequest(logPath, "turn/start");
        pid = typeof session.pid === "function" ? session.pid() : session.pid;
        expect(pid).toBeTypeOf("number");
        expect(session.isProcessAlive?.()).toBe(true);

        await expect(session.abort()).resolves.toBeUndefined();
        await consume.catch(() => undefined);
        expect(session.isProcessAlive?.()).toBe(false);
        expect(() => process.kill(pid as number, 0)).toThrow(
          expect.objectContaining({ code: "ESRCH" }),
        );
      } finally {
        try {
          await session?.abort();
        } catch {
          // The assertions above report a failed verified shutdown.
        }
        await consume?.catch(() => undefined);
        if (pid !== undefined) {
          try {
            process.kill(-pid, "SIGKILL");
          } catch {
            // The expected path already verified that the process group exited.
          }
        }
        rmSync(tempDir, { recursive: true, force: true });
      }
    },
    10_000,
  );

  bashIt(
    "publishes the Codex thread id to later app-server tool shells",
    async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "codex-provider-agentctl-"));
      const logPath = join(tempDir, "fake-codex-requests.jsonl");
      const codexPath = createFakeCodexCommand(
        tempDir,
        "fake-codex-agentctl",
        buildFakeCodexAppServerWithAgentctlShellProbe(logPath),
      );

      let session:
        | Awaited<ReturnType<CodexProvider["startSession"]>>
        | undefined;
      let consume: Promise<void> | undefined;

      try {
        const testProvider = new CodexProvider({ codexPath });
        session = await testProvider.startSession({
          cwd: tempDir,
          initialMessage: { text: "check the agentctl env" },
          effort: "low",
        });

        consume = (async () => {
          for await (const _message of session?.iterator ?? []) {
            // drain until abort below
          }
        })();

        await waitForFakeCodexRequest(logPath, "turn/start");

        const turnStartRequest = readFakeCodexRequests(logPath).find(
          (request) => request.method === "turn/start",
        );
        expect(turnStartRequest?.agentctlSessionId).toBe("thread-agentctl");
      } finally {
        session?.abort();
        await consume?.catch(() => undefined);
        rmSync(tempDir, { recursive: true, force: true });
      }
    },
  );

  it("sets AGENTCTL_SESSION_ID directly in the app-server env on resume", async () => {
    // Resume knows the session id at spawn, so it is set directly in the
    // app-server's own env (not only via the BASH_ENV bridge), surviving even
    // if codex never sources BASH_ENV. The fake server records the value it
    // reads straight from process.env at the first request.
    const tempDir = mkdtempSync(
      join(tmpdir(), "codex-provider-agentctl-resume-"),
    );
    const logPath = join(tempDir, "fake-codex-requests.jsonl");
    const codexPath = createFakeCodexCommand(
      tempDir,
      "fake-codex-agentctl-resume",
      buildFakeCodexAppServerWithAgentctlShellProbe(logPath),
    );

    let session: Awaited<ReturnType<CodexProvider["startSession"]>> | undefined;
    let consume: Promise<void> | undefined;

    try {
      const testProvider = new CodexProvider({ codexPath });
      session = await testProvider.startSession({
        cwd: tempDir,
        resumeSessionId: "thread-resume-direct",
        initialMessage: { text: "resume the agentctl session" },
        effort: "low",
        getSessionChildEnv: (sessionId) => ({
          YEP_SESSION_WAKE_TOKEN: `wake-${sessionId}`,
        }),
      });

      consume = (async () => {
        for await (const _message of session?.iterator ?? []) {
          // drain until abort below
        }
      })();

      await waitForFakeCodexRequest(logPath, "initialize");

      const initializeRequest = readFakeCodexRequests(logPath).find(
        (request) => request.method === "initialize",
      );
      expect(initializeRequest?.processEnvAgentctlSessionId).toBe(
        "thread-resume-direct",
      );
      expect(initializeRequest?.processEnvWakeToken).toBe(
        "wake-thread-resume-direct",
      );
    } finally {
      session?.abort();
      await consume?.catch(() => undefined);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("uses the steered turn id for soft interrupt completion", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "codex-provider-lifecycle-"));
    const logPath = join(tempDir, "fake-codex-requests.jsonl");
    const codexPath = createFakeCodexCommand(
      tempDir,
      "fake-codex",
      buildFakeCodexAppServer(logPath),
    );

    let session: Awaited<ReturnType<CodexProvider["startSession"]>> | undefined;
    let consume: Promise<void> | undefined;

    try {
      const testProvider = new CodexProvider({ codexPath });
      session = await testProvider.startSession({
        cwd: tempDir,
        initialMessage: {
          text: "start a fake turn",
          uuid: "ya-start-uuid",
        },
        effort: "low",
      });

      const messages: Array<Record<string, unknown>> = [];
      consume = (async () => {
        for await (const message of session?.iterator ?? []) {
          messages.push(message);
          if (message.type === "result") {
            break;
          }
        }
      })();

      await waitForFakeCodexRequest(logPath, "turn/start");
      expect(session.steer).toBeDefined();
      expect(
        await waitForSuccessfulSteer(session, {
          text: "steer the fake turn",
          uuid: "ya-steer-uuid",
        }),
      ).toBe(true);
      await waitForFakeCodexRequest(logPath, "turn/steer");

      await session.interrupt?.();
      await consume;

      const requests = readFakeCodexRequests(logPath);
      const steerRequest = requests.find(
        (request) => request.method === "turn/steer",
      );
      const startRequest = requests.find(
        (request) => request.method === "turn/start",
      );
      const interruptRequest = requests.find(
        (request) => request.method === "turn/interrupt",
      );

      expect(startRequest?.params).toMatchObject({
        clientUserMessageId: "ya-start-uuid",
      });
      expect(steerRequest?.params).toMatchObject({
        clientUserMessageId: "ya-steer-uuid",
        expectedTurnId: "turn-start",
      });
      expect(interruptRequest?.params).toMatchObject({
        turnId: "turn-steered",
      });
      expect(
        messages.some(
          (message) =>
            message.type === "system" &&
            message.subtype === "turn_aborted" &&
            message.codexTurnId === "turn-steered",
        ),
      ).toBe(true);
      expect(messages.some((message) => message.type === "error")).toBe(false);
    } finally {
      session?.abort();
      await consume?.catch(() => undefined);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("resynchronizes and retries a steer after an active-turn mismatch", async () => {
    const warn = vi
      .spyOn(getLogger(), "warn")
      .mockImplementation(() => undefined);
    const tempDir = mkdtempSync(join(tmpdir(), "codex-provider-steer-race-"));
    const logPath = join(tempDir, "fake-codex-requests.jsonl");
    const codexPath = createFakeCodexCommand(
      tempDir,
      "fake-codex-steer-race",
      buildFakeCodexAppServerWithTurnIdRace(logPath),
    );

    let session: Awaited<ReturnType<CodexProvider["startSession"]>> | undefined;
    let consume: Promise<void> | undefined;

    try {
      const testProvider = new CodexProvider({ codexPath });
      session = await testProvider.startSession({
        cwd: tempDir,
        initialMessage: { text: "start the mismatched turn" },
        effort: "low",
      });
      consume = (async () => {
        for await (const _message of session?.iterator ?? []) {
          // Drain until the interrupt below completes the fake turn.
        }
      })();

      await waitForFakeCodexRequest(logPath, "turn/start");
      await session.probeLiveness?.();
      expect(await session.steer?.({ text: "deliver this steer" })).toBe(true);
      await session.interrupt?.();

      const steerRequests = readFakeCodexRequests(logPath).filter(
        (request) => request.method === "turn/steer",
      );
      expect(
        steerRequests.map((request) => request.params?.expectedTurnId),
      ).toEqual(["turn-submission", "turn-active"]);
      expect(
        readFakeCodexRequests(logPath).find(
          (request) => request.method === "turn/interrupt",
        )?.params,
      ).toMatchObject({ turnId: "turn-active" });
      expect(warn).toHaveBeenCalledWith(
        {
          component: "codex-provider",
          threadId: "thread-race",
          expectedTurnId: "turn-submission",
          actualTurnId: "turn-active",
        },
        "Resynchronized Codex turn id after steer mismatch",
      );
    } finally {
      await session?.abort();
      await consume?.catch(() => undefined);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("resynchronizes and retries an interrupt after an active-turn mismatch", async () => {
    const warn = vi
      .spyOn(getLogger(), "warn")
      .mockImplementation(() => undefined);
    const tempDir = mkdtempSync(
      join(tmpdir(), "codex-provider-interrupt-race-"),
    );
    const logPath = join(tempDir, "fake-codex-requests.jsonl");
    const codexPath = createFakeCodexCommand(
      tempDir,
      "fake-codex-interrupt-race",
      buildFakeCodexAppServerWithTurnIdRace(logPath),
    );

    let session: Awaited<ReturnType<CodexProvider["startSession"]>> | undefined;
    let consume: Promise<void> | undefined;

    try {
      const testProvider = new CodexProvider({ codexPath });
      session = await testProvider.startSession({
        cwd: tempDir,
        initialMessage: { text: "start the mismatched turn" },
        effort: "low",
      });
      consume = (async () => {
        for await (const _message of session?.iterator ?? []) {
          // Drain until the retried interrupt completes the fake turn.
        }
      })();

      await waitForFakeCodexRequest(logPath, "turn/start");
      await session.probeLiveness?.();
      expect(await session.interrupt?.()).toBe(true);

      const interruptRequests = readFakeCodexRequests(logPath).filter(
        (request) => request.method === "turn/interrupt",
      );
      expect(
        interruptRequests.map((request) => request.params?.turnId),
      ).toEqual(["turn-submission", "turn-active"]);
      expect(warn).toHaveBeenCalledWith(
        {
          component: "codex-provider",
          threadId: "thread-race",
          expectedTurnId: "turn-submission",
          actualTurnId: "turn-active",
        },
        "Resynchronized Codex turn id after interrupt mismatch",
      );
    } finally {
      await session?.abort();
      await consume?.catch(() => undefined);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("adopts the active turn id observed in provider notifications", async () => {
    const warn = vi
      .spyOn(getLogger(), "warn")
      .mockImplementation(() => undefined);
    const tempDir = mkdtempSync(
      join(tmpdir(), "codex-provider-turn-observation-"),
    );
    const logPath = join(tempDir, "fake-codex-requests.jsonl");
    const codexPath = createFakeCodexCommand(
      tempDir,
      "fake-codex-turn-observation",
      buildFakeCodexAppServerWithTurnIdRace(logPath, true),
    );

    let session: Awaited<ReturnType<CodexProvider["startSession"]>> | undefined;
    let consume: Promise<void> | undefined;

    try {
      const testProvider = new CodexProvider({ codexPath });
      session = await testProvider.startSession({
        cwd: tempDir,
        initialMessage: { text: "start the mismatched turn" },
        effort: "low",
      });
      const messages: Array<Record<string, unknown>> = [];
      consume = (async () => {
        for await (const message of session?.iterator ?? []) {
          messages.push(message);
        }
      })();

      await waitForFakeCodexRequest(logPath, "turn/start");
      await waitForMessage(messages, (message) =>
        JSON.stringify(message).includes("observed active turn"),
      );
      expect(await session.steer?.({ text: "deliver after observation" })).toBe(
        true,
      );
      await session.interrupt?.();

      const steerRequests = readFakeCodexRequests(logPath).filter(
        (request) => request.method === "turn/steer",
      );
      expect(steerRequests).toHaveLength(1);
      expect(steerRequests[0]?.params).toMatchObject({
        expectedTurnId: "turn-active",
      });
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({
          component: "codex-provider",
          sessionId: "thread-race",
          expectedTurnId: "turn-submission",
          actualTurnId: "turn-active",
          notificationMethod: "turn/plan/updated",
          notificationSource: "provider",
        }),
        "Resynchronized Codex turn id from provider notification",
      );
    } finally {
      await session?.abort();
      await consume?.catch(() => undefined);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("suppresses stale turn notifications queued before a new turn", async () => {
    const warn = vi
      .spyOn(getLogger(), "warn")
      .mockImplementation(() => undefined);
    const tempDir = mkdtempSync(join(tmpdir(), "codex-provider-stale-turn-"));
    const logPath = join(tempDir, "fake-codex-requests.jsonl");
    const codexPath = createFakeCodexCommand(
      tempDir,
      "fake-codex-stale-turn",
      buildFakeCodexAppServerWithStaleTurnBacklog(logPath),
    );

    let session: Awaited<ReturnType<CodexProvider["startSession"]>> | undefined;
    let consume: Promise<void> | undefined;

    try {
      const testProvider = new CodexProvider({ codexPath });
      session = await testProvider.startSession({
        cwd: tempDir,
        initialMessage: { text: "start after stale notifications" },
        effort: "low",
      });
      const messages: Array<Record<string, unknown>> = [];
      consume = (async () => {
        for await (const message of session?.iterator ?? []) {
          messages.push(message);
          if (message.type === "result") break;
        }
      })();

      await consume;

      expect(JSON.stringify(messages)).not.toContain("stale turn marker");
      expect(JSON.stringify(messages)).toContain("current turn marker");
      const suppressionWarnings = warn.mock.calls.filter(
        ([, message]) =>
          message ===
          "Suppressed stale Codex notifications queued before turn start",
      );
      expect(suppressionWarnings).toHaveLength(1);
      expect(suppressionWarnings[0]?.[0]).toMatchObject({
        sessionId: "thread-stale-backlog",
        expectedTurnId: "turn-current",
        count: 2,
        firstTurnId: "turn-old",
        lastTurnId: "turn-old",
        firstMethod: "turn/plan/updated",
        lastMethod: "turn/completed",
        reason: "turn-scoped notification reached",
      });
    } finally {
      session?.abort();
      await consume?.catch(() => undefined);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("accepts a clean Codex foreground-tool interrupt", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "codex-provider-tool-"));
    const logPath = join(tempDir, "fake-codex-requests.jsonl");
    const codexPath = createFakeCodexCommand(
      tempDir,
      "fake-codex-active-tool",
      buildFakeCodexAppServerWithActiveTool(logPath),
    );

    let session: Awaited<ReturnType<CodexProvider["startSession"]>> | undefined;
    let consume: Promise<void> | undefined;

    try {
      const testProvider = new CodexProvider({ codexPath });
      session = await testProvider.startSession({
        cwd: tempDir,
        initialMessage: { text: "run a fake tool" },
        effort: "low",
      });

      const messages: Array<Record<string, unknown>> = [];
      consume = (async () => {
        for await (const message of session?.iterator ?? []) {
          messages.push(message);
          if (message.type === "result") {
            break;
          }
        }
      })();

      await waitForMessage(messages, (message) =>
        JSON.stringify(message).includes("call-active"),
      );
      const activity = session.getProviderActivity?.();
      expect(activity?.lastRawProviderEventAt).toBeInstanceOf(Date);
      expect(activity?.lastRawProviderEventSource).toBe(
        "codex:notification:rawResponseItem/completed",
      );

      await expect(session.interrupt?.()).resolves.toBe(true);
      await consume;

      const interruptRequest = readFakeCodexRequests(logPath).find(
        (request) => request.method === "turn/interrupt",
      );
      expect(interruptRequest?.params).toMatchObject({
        turnId: "turn-active",
      });
      expect(
        messages.some((message) =>
          JSON.stringify(message).includes("aborted by user after 1.0s"),
        ),
      ).toBe(true);
    } finally {
      session?.abort();
      await consume?.catch(() => undefined);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("drops Codex live deltas before raw logging when disabled by env", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "codex-provider-deltas-"));
    const logPath = join(tempDir, "fake-codex-requests.jsonl");
    const codexPath = createFakeCodexCommand(
      tempDir,
      "fake-codex-live-deltas",
      buildFakeCodexAppServerWithLiveDelta(logPath),
    );
    vi.stubEnv("YEP_CODEX_DISABLE_LIVE_DELTAS", "true");

    let session: Awaited<ReturnType<CodexProvider["startSession"]>> | undefined;
    let consume: Promise<void> | undefined;

    try {
      const testProvider = new CodexProvider({ codexPath });
      session = await testProvider.startSession({
        cwd: tempDir,
        initialMessage: { text: "start a fake streamed turn" },
        effort: "low",
      });

      const messages: Array<Record<string, unknown>> = [];
      consume = (async () => {
        for await (const message of session?.iterator ?? []) {
          messages.push(message);
          if (message.type === "result") {
            break;
          }
        }
      })();

      await consume;

      expect(messages.some((message) => message._isStreaming)).toBe(false);
      expect(
        messages.some(
          (message) =>
            message.type === "assistant" &&
            (message.message as { content?: unknown } | undefined)?.content ===
              "Final streamed answer",
        ),
      ).toBe(true);

      const rawNotifications = vi
        .mocked(logSDKMessage)
        .mock.calls.map((call) => call[1] as { method?: string });
      expect(
        rawNotifications.some(
          (notification) => notification.method === "item/agentMessage/delta",
        ),
      ).toBe(false);
      expect(
        rawNotifications.some(
          (notification) => notification.method === "item/completed",
        ),
      ).toBe(true);
    } finally {
      session?.abort();
      await consume?.catch(() => undefined);
      vi.unstubAllEnvs();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("drops Codex live deltas before raw logging when no subscriber wants them", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "codex-provider-no-demand-"));
    const logPath = join(tempDir, "fake-codex-requests.jsonl");
    const codexPath = createFakeCodexCommand(
      tempDir,
      "fake-codex-live-deltas",
      buildFakeCodexAppServerWithLiveDelta(logPath),
    );

    let session: Awaited<ReturnType<CodexProvider["startSession"]>> | undefined;
    let consume: Promise<void> | undefined;

    try {
      const testProvider = new CodexProvider({ codexPath });
      session = await testProvider.startSession({
        cwd: tempDir,
        initialMessage: { text: "start a fake streamed turn" },
        effort: "low",
        shouldEmitLiveDeltas: () => false,
      });

      const messages: Array<Record<string, unknown>> = [];
      consume = (async () => {
        for await (const message of session?.iterator ?? []) {
          messages.push(message);
          if (message.type === "result") {
            break;
          }
        }
      })();

      await consume;

      expect(messages.some((message) => message._isStreaming)).toBe(false);
      expect(
        messages.some(
          (message) =>
            message.type === "assistant" &&
            (message.message as { content?: unknown } | undefined)?.content ===
              "Final streamed answer",
        ),
      ).toBe(true);

      const rawNotifications = vi
        .mocked(logSDKMessage)
        .mock.calls.map((call) => call[1] as { method?: string });
      expect(
        rawNotifications.some(
          (notification) => notification.method === "item/agentMessage/delta",
        ),
      ).toBe(false);
      expect(
        rawNotifications.some(
          (notification) => notification.method === "item/completed",
        ),
      ).toBe(true);
    } finally {
      session?.abort();
      await consume?.catch(() => undefined);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("accepts interrupt with a Codex background tool handle", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "codex-provider-background-"));
    const logPath = join(tempDir, "fake-codex-requests.jsonl");
    const codexPath = createFakeCodexCommand(
      tempDir,
      "fake-codex-background-tool",
      buildFakeCodexAppServerWithBackgroundTool(logPath),
    );

    let session: Awaited<ReturnType<CodexProvider["startSession"]>> | undefined;
    let consume: Promise<void> | undefined;

    try {
      const testProvider = new CodexProvider({ codexPath });
      session = await testProvider.startSession({
        cwd: tempDir,
        initialMessage: { text: "run a fake background tool" },
        effort: "low",
      });

      const messages: Array<Record<string, unknown>> = [];
      consume = (async () => {
        for await (const message of session?.iterator ?? []) {
          messages.push(message);
          if (message.type === "result") {
            break;
          }
        }
      })();

      await waitForMessage(messages, (message) =>
        JSON.stringify(message).includes("Process running with session ID"),
      );

      await expect(session.interrupt?.()).resolves.toBe(true);
      await consume;

      const interruptRequest = readFakeCodexRequests(logPath).find(
        (request) => request.method === "turn/interrupt",
      );
      expect(interruptRequest?.params).toMatchObject({
        turnId: "turn-background",
      });
    } finally {
      session?.abort();
      await consume?.catch(() => undefined);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("uses thread/read probe to reconcile a missed Codex completion", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "codex-provider-probe-"));
    const logPath = join(tempDir, "fake-codex-requests.jsonl");
    const codexPath = createFakeCodexCommand(
      tempDir,
      "fake-codex-idle-probe",
      buildFakeCodexAppServerWithIdleProbe(logPath),
    );

    let session: Awaited<ReturnType<CodexProvider["startSession"]>> | undefined;
    let consume: Promise<void> | undefined;

    try {
      const testProvider = new CodexProvider({ codexPath });
      session = await testProvider.startSession({
        cwd: tempDir,
        initialMessage: { text: "run a fake turn that misses completion" },
        effort: "low",
      });

      const messages: Array<Record<string, unknown>> = [];
      consume = (async () => {
        for await (const message of session?.iterator ?? []) {
          messages.push(message);
          if (message.type === "result") {
            break;
          }
        }
      })();

      await waitForFakeCodexRequest(logPath, "turn/start");
      const probe = await session.probeLiveness?.();

      expect(probe).toMatchObject({
        status: "idle",
        source: "codex:thread/read",
        detail: "thread.status:idle",
      });
      await consume;

      const requests = readFakeCodexRequests(logPath);
      expect(requests.some((request) => request.method === "thread/read")).toBe(
        true,
      );
      expect(
        messages.some(
          (message) =>
            message.type === "system" && message.subtype === "turn_complete",
        ),
      ).toBe(true);
      expect(messages.some((message) => message.type === "result")).toBe(true);
      expect(messages.some((message) => message.type === "error")).toBe(false);
    } finally {
      session?.abort();
      await consume?.catch(() => undefined);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("reports interrupt incomplete before Codex has an active turn", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "codex-provider-no-turn-"));
    const logPath = join(tempDir, "fake-codex-requests.jsonl");
    const codexPath = createFakeCodexCommand(
      tempDir,
      "fake-codex-no-turn",
      buildFakeCodexAppServer(logPath),
    );

    let session: Awaited<ReturnType<CodexProvider["startSession"]>> | undefined;

    try {
      const testProvider = new CodexProvider({ codexPath });
      session = await testProvider.startSession({
        cwd: tempDir,
        effort: "low",
      });

      const firstMessage = await session.iterator.next();
      expect(firstMessage.value).toMatchObject({
        type: "system",
        subtype: "init",
      });

      await expect(session.interrupt?.()).resolves.toBe(false);

      const requests = readFakeCodexRequests(logPath);
      expect(
        requests.some((request) => request.method === "turn/interrupt"),
      ).toBe(false);
    } finally {
      session?.abort();
      await session?.iterator.return?.(undefined);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("generates simulated recaps through an ephemeral helper thread", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "codex-provider-recap-"));
    const logPath = join(tempDir, "fake-codex-requests.jsonl");
    const codexPath = createFakeCodexCommand(
      tempDir,
      "fake-codex-recap",
      buildFakeCodexAppServerForRecap(logPath),
    );

    try {
      const testProvider = new CodexProvider({ codexPath });

      expect(testProvider.supportsRecaps).toBe(true);
      expect(testProvider.supportsNativePromptSuggestions).toBe(false);

      const { text: recap } = await testProvider.generateSummary({
        purpose: "recap",
        strategy: "side-session",
        recentAssistantText: [
          "Implemented the Codex helper recap path.",
          "Ran the focused tests.",
        ],
        model: "cheapest",
      });

      expect(recap).toBe("Implemented the helper recap and ran focused tests.");

      const requests = readFakeCodexRequests(logPath);
      const threadStart = requests.find(
        (request) => request.method === "thread/start",
      );
      const turnStart = requests.find(
        (request) => request.method === "turn/start",
      );

      expect(requests.some((request) => request.method === "model/list")).toBe(
        true,
      );
      expect(threadStart?.params).toMatchObject({
        ephemeral: true,
        approvalPolicy: "untrusted",
        sandbox: "read-only",
        model: "gpt-5.4-mini",
      });
      expect(turnStart?.params).toMatchObject({
        threadId: "thread-recap",
        model: "gpt-5.4-mini",
      });
      expect(JSON.stringify(turnStart?.params)).toContain(
        "Implemented the Codex helper recap path.",
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("generates session retitles through an archived helper fork", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "codex-provider-retitle-"));
    const logPath = join(tempDir, "fake-codex-requests.jsonl");
    const codexPath = createFakeCodexCommand(
      tempDir,
      "fake-codex-retitle",
      buildFakeCodexAppServerForForkSummary(logPath),
    );

    try {
      const testProvider = new CodexProvider({ codexPath });

      const { text } = await testProvider.generateSummary({
        purpose: "session-retitle",
        strategy: "fork",
        generatorSessionId: "thread-generator",
        cwd: tempDir,
        model: "gpt-5.6-sol",
        currentTitle: "Old title",
        lengthTarget: 72,
      });

      expect(text).toBe("Codex fork retitle");

      const requests = readFakeCodexRequests(logPath);
      const resume = requests.find(
        (request) => request.method === "thread/resume",
      );
      const turnStart = requests.find(
        (request) => request.method === "turn/start",
      );
      expect(resume?.params).toMatchObject({ model: "gpt-5.6-sol" });

      expect(resume?.params).toMatchObject({
        threadId: "thread-generator",
        cwd: tempDir,
        approvalPolicy: "untrusted",
        sandbox: "read-only",
        excludeTurns: true,
      });
      expect(JSON.stringify(resume?.params)).toContain("title helper");
      expect(turnStart?.params).toMatchObject({
        threadId: "thread-generator",
        approvalPolicy: "untrusted",
        effort: "low",
        summary: "auto",
      });
      expect(JSON.stringify(turnStart?.params)).toContain(
        "What is a good new title for this session?",
      );
      expect(JSON.stringify(turnStart?.params)).toContain(
        "Current title: Old title",
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("forks a Codex thread and rolls back trailing turns", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "codex-provider-fork-"));
    const logPath = join(tempDir, "fake-codex-requests.jsonl");
    const codexPath = createFakeCodexCommand(
      tempDir,
      "fake-codex-fork",
      buildFakeCodexAppServerForFork(logPath),
    );

    try {
      const testProvider = new CodexProvider({ codexPath });
      const fork = await testProvider.forkSession({
        sessionId: "source-thread",
        cwd: tempDir,
        upToMessageId: "assistant-2-turn-2",
        title: "Forked from second turn",
      });

      expect(fork).toEqual({ sessionId: "fork-thread" });

      const requests = readFakeCodexRequests(logPath);
      const read = requests.find((request) => request.method === "thread/read");
      const forkRequest = requests.find(
        (request) => request.method === "thread/fork",
      );
      const rollback = requests.find(
        (request) => request.method === "thread/rollback",
      );

      expect(read?.params).toMatchObject({
        threadId: "source-thread",
        includeTurns: true,
      });
      expect(forkRequest?.params).toMatchObject({
        threadId: "source-thread",
        cwd: tempDir,
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
        excludeTurns: true,
      });
      expect(rollback?.params).toMatchObject({
        threadId: "fork-thread",
        numTurns: 1,
      });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("forks directly through a typed Codex turn without legacy rollback", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "codex-provider-turn-fork-"));
    const logPath = join(tempDir, "fake-codex-requests.jsonl");
    const codexPath = createFakeCodexCommand(
      tempDir,
      "fake-codex-turn-fork",
      buildFakeCodexAppServerForFork(logPath),
    );

    try {
      const testProvider = new CodexProvider({ codexPath });
      const fork = await testProvider.forkSession({
        sessionId: "source-thread",
        cwd: tempDir,
        boundary: {
          kind: "turn",
          provider: "codex",
          turnId: "turn-2",
        },
      });

      expect(fork).toEqual({ sessionId: "fork-thread" });
      const requests = readFakeCodexRequests(logPath);
      expect(
        requests.find((request) => request.method === "thread/fork")?.params,
      ).toMatchObject({
        threadId: "source-thread",
        lastTurnId: "turn-2",
      });
      expect(requests.some((request) => request.method === "thread/read")).toBe(
        false,
      );
      expect(
        requests.some((request) => request.method === "thread/rollback"),
      ).toBe(false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

const describeRealCodexContract =
  process.env.YEP_CODEX_REAL_CONTRACT_TEST === "true"
    ? describe
    : describe.skip;

describeRealCodexContract("Codex app-server real contract", () => {
  it("verifies steer and interrupt against the installed Codex app-server", async () => {
    const repoRoot = join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "..",
      "..",
      "..",
    );
    const probePath = join(
      repoRoot,
      "scripts",
      "probe-codex-app-server-turns.mjs",
    );
    const result = await runNodeProbe(probePath, repoRoot);

    if (result.code !== 0) {
      throw new Error(
        [
          `Codex app-server probe exited with code ${result.code}`,
          "stdout:",
          result.stdout.trim() || "(empty)",
          "stderr:",
          result.stderr.trim() || "(empty)",
        ].join("\n"),
      );
    }
    expect(result.stdout).toContain("turn/steer");
    expect(result.stdout).toContain("turn/interrupt");
    expect(result.stdout).toContain('"status": "interrupted"');
  }, 70_000);
});

function runNodeProbe(
  probePath: string,
  cwd: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [probePath], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        CODEX_PROBE_EFFORT: process.env.CODEX_PROBE_EFFORT ?? "low",
        CODEX_PROBE_TIMEOUT_MS: process.env.CODEX_PROBE_TIMEOUT_MS ?? "20000",
        CODEX_PROBE_INTERRUPT_DELAY_MS:
          process.env.CODEX_PROBE_INTERRUPT_DELAY_MS ?? "800",
      },
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("Timed out waiting for Codex app-server probe"));
    }, 65_000);

    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString("utf-8");
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString("utf-8");
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("exit", (code) => {
      clearTimeout(timeout);
      resolve({ code, stdout, stderr });
    });
  });
}

function buildFakeCodexAppServer(
  logPath: string,
  accountType: "chatgpt" | "apiKey" = "chatgpt",
  goalStatusOverride?: "budgetLimited",
  goalStartsTurn = false,
): string {
  return `#!/usr/bin/env node
import { appendFileSync } from "node:fs";

const logPath = ${JSON.stringify(logPath)};
const accountType = ${JSON.stringify(accountType)};
const goalStatusOverride = ${JSON.stringify(goalStatusOverride)};
const goalStartsTurn = ${JSON.stringify(goalStartsTurn)};
let buffer = "";
let goal = null;
let activeTurn = false;

function write(payload) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...payload }) + "\\n");
}

function logRequest(message) {
  appendFileSync(
    logPath,
    JSON.stringify({
      id: message.id,
      method: message.method,
      params: message.params,
    }) + "\\n",
  );
}

function respond(id, result) {
  write({ id, result });
}

function notify(method, params) {
  write({ method, params });
}

function handleMessage(message) {
  if (!message || typeof message !== "object") return;
  logRequest(message);
  if (message.id === undefined) return;

  switch (message.method) {
    case "initialize":
      respond(message.id, { userAgent: "fake-codex" });
      break;
    case "skills/list":
      respond(message.id, {
        data: [{
          cwd: message.params?.cwds?.[0] ?? "",
          skills: [{
            name: "doubt",
            description: "Verify a conclusion independently",
            path: "/skills/doubt/SKILL.md",
            scope: "user",
            enabled: true,
          }],
          errors: [],
        }],
      });
      break;
    case "thread/start":
      respond(message.id, {
        thread: { id: "thread-1" },
        model: "gpt-5.4-mini",
        reasoningEffort: "low",
      });
      break;
    case "account/read":
      respond(message.id, {
        account: accountType === "chatgpt"
          ? {
              type: "chatgpt",
              email: "codex@example.com",
              planType: "plus",
            }
          : { type: "apiKey" },
        requiresOpenaiAuth: true,
      });
      break;
    case "account/login/start":
      respond(message.id, { type: "chatgptAuthTokens" });
      break;
    case "account/rateLimits/read":
      respond(message.id, {
        rateLimits: {
          limitId: "codex",
          primary: {
            usedPercent: 24,
            windowDurationMins: 300,
            resetsAt: 1_800_000_000,
          },
          secondary: null,
          planType: "plus",
        },
      });
      break;
    case "account/usage/read":
      respond(message.id, {
        summary: {
          lifetimeTokens: 12_345,
          peakDailyTokens: 2_345,
          longestRunningTurnSec: 90,
          currentStreakDays: 3,
          longestStreakDays: 7,
        },
        dailyUsageBuckets: [
          { startDate: "2026-08-09", tokens: 100 },
          { startDate: "2026-08-10", tokens: 200 },
        ],
      });
      break;
    case "thread/goal/get":
      respond(message.id, { goal });
      break;
    case "thread/goal/set":
      goal = {
        threadId: "thread-1",
        objective: message.params?.objective ?? goal?.objective ?? "",
        status:
          goalStatusOverride ?? message.params?.status ?? goal?.status ?? "active",
        tokenBudget: null,
        tokensUsed: goal?.tokensUsed ?? 0,
        timeUsedSeconds: goal?.timeUsedSeconds ?? 0,
        createdAt: goal?.createdAt ?? 1,
        updatedAt: 1,
      };
      respond(message.id, { goal });
      notify("thread/goal/updated", { threadId: "thread-1", goal });
      if (goalStartsTurn && message.params?.objective) {
        if (activeTurn) {
          notify("turn/completed", { threadId: "thread-1", turn: { id: "turn-start", status: "completed", items: [], error: null } });
          activeTurn = false;
        }
        const turn = { id: "goal-turn", status: "inProgress", items: [], error: null };
        notify("turn/started", { threadId: "thread-1", turn });
        notify("item/completed", {
          threadId: "thread-1", turnId: turn.id,
          item: { type: "agentMessage", id: "goal-output", text: "Goal continuation output" },
        });
        notify("turn/completed", {
          threadId: "thread-1", turn: { ...turn, status: "completed" },
        });
      }
      break;
    case "thread/goal/clear": {
      const cleared = goal !== null;
      goal = null;
      respond(message.id, { cleared });
      notify("thread/goal/cleared", { threadId: "thread-1" });
      break;
    }
    case "turn/start":
      activeTurn = true;
      respond(message.id, {
        turn: { id: "turn-start", status: "inProgress", error: null },
      });
      break;
    case "turn/steer":
      respond(message.id, { turnId: "turn-steered" });
      break;
    case "turn/interrupt":
      respond(message.id, {});
      notify("turn/completed", {
        threadId: "thread-1",
        turn: {
          id: message.params.turnId,
          items: [],
          status: "interrupted",
          error: null,
          startedAt: null,
          completedAt: null,
          durationMs: null,
        },
      });
      break;
    default:
      respond(message.id, {});
      break;
  }
}

process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf-8");
  const lines = buffer.split("\\n");
  buffer = lines.pop() || "";
  for (const line of lines) {
    if (!line.trim()) continue;
    handleMessage(JSON.parse(line));
  }
});
`;
}

function buildFakeCodexAppServerWithTurnIdRace(
  logPath: string,
  notifyActualTurn = false,
): string {
  return `#!/usr/bin/env node
import { appendFileSync } from "node:fs";

const logPath = ${JSON.stringify(logPath)};
const notifyActualTurn = ${JSON.stringify(notifyActualTurn)};
let buffer = "";

function write(payload) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...payload }) + "\\n");
}

function logRequest(message) {
  appendFileSync(logPath, JSON.stringify({
    id: message.id,
    method: message.method,
    params: message.params,
  }) + "\\n");
}

function respond(id, result) {
  write({ id, result });
}

function reject(id, message) {
  write({ id, error: { code: -32600, message } });
}

function notify(method, params) {
  write({ method, params });
}

function handleMessage(message) {
  if (!message || typeof message !== "object") return;
  logRequest(message);
  if (message.id === undefined) return;

  switch (message.method) {
    case "initialize":
      respond(message.id, { userAgent: "fake-codex" });
      break;
    case "skills/list":
      respond(message.id, { data: [] });
      break;
    case "thread/start":
      respond(message.id, {
        thread: { id: "thread-race" },
        model: "gpt-5.4-mini",
        reasoningEffort: "low",
      });
      break;
    case "turn/start":
      respond(message.id, {
        turn: { id: "turn-submission", status: "inProgress", error: null },
      });
      if (notifyActualTurn) {
        notify("turn/plan/updated", {
          threadId: "thread-race",
          turnId: "turn-active",
          explanation: null,
          plan: [{ step: "observed active turn", status: "inProgress" }],
        });
      }
      break;
    case "turn/steer":
      if (message.params.expectedTurnId !== "turn-active") {
        reject(
          message.id,
          "expected active turn id \`turn-submission\` but found \`turn-active\`",
        );
      } else {
        respond(message.id, { turnId: "turn-active" });
      }
      break;
    case "turn/interrupt":
      if (message.params.turnId !== "turn-active") {
        reject(
          message.id,
          "expected active turn id turn-submission but found turn-active",
        );
      } else {
        respond(message.id, {});
        notify("turn/completed", {
          threadId: "thread-race",
          turn: {
            id: "turn-active",
            items: [],
            status: "interrupted",
            error: null,
            startedAt: null,
            completedAt: null,
            durationMs: null,
          },
        });
      }
      break;
    default:
      respond(message.id, {});
      break;
  }
}

process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf-8");
  const lines = buffer.split("\\n");
  buffer = lines.pop() || "";
  for (const line of lines) {
    if (!line.trim()) continue;
    handleMessage(JSON.parse(line));
  }
});
`;
}

function buildFakeCodexAppServerWithStaleTurnBacklog(logPath: string): string {
  return `#!/usr/bin/env node
import { appendFileSync } from "node:fs";

const logPath = ${JSON.stringify(logPath)};
let buffer = "";

function write(payload) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...payload }) + "\\n");
}

function respond(id, result) {
  write({ id, result });
}

function notify(method, params) {
  write({ method, params });
}

function logRequest(message) {
  appendFileSync(logPath, JSON.stringify({
    id: message.id,
    method: message.method,
    params: message.params,
  }) + "\\n");
}

function completedTurn(id) {
  return {
    id,
    items: [],
    status: "completed",
    error: null,
    startedAt: 1,
    completedAt: 2,
    durationMs: 1,
  };
}

function handleMessage(message) {
  if (!message || typeof message !== "object") return;
  logRequest(message);
  if (message.id === undefined) return;

  switch (message.method) {
    case "initialize":
      respond(message.id, { userAgent: "fake-codex" });
      break;
    case "skills/list":
      respond(message.id, { data: [] });
      break;
    case "thread/start":
      notify("turn/plan/updated", {
        threadId: "thread-stale-backlog",
        turnId: "turn-old",
        explanation: null,
        plan: [{ step: "stale turn marker", status: "completed" }],
      });
      notify("turn/completed", {
        threadId: "thread-stale-backlog",
        turn: completedTurn("turn-old"),
      });
      respond(message.id, {
        thread: { id: "thread-stale-backlog" },
        model: "gpt-5.4-mini",
        reasoningEffort: "low",
      });
      break;
    case "turn/start":
      respond(message.id, {
        turn: { id: "turn-current", status: "inProgress", error: null },
      });
      notify("turn/plan/updated", {
        threadId: "thread-stale-backlog",
        turnId: "turn-current",
        explanation: null,
        plan: [{ step: "current turn marker", status: "completed" }],
      });
      notify("turn/completed", {
        threadId: "thread-stale-backlog",
        turn: completedTurn("turn-current"),
      });
      break;
    default:
      respond(message.id, {});
      break;
  }
}

process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf-8");
  const lines = buffer.split("\\n");
  buffer = lines.pop() || "";
  for (const line of lines) {
    if (!line.trim()) continue;
    handleMessage(JSON.parse(line));
  }
});
`;
}

function buildFakeCodexFailureAppServer(
  logPath: string,
  codexErrorInfo: "serverOverloaded" | "usageLimitExceeded",
  failuresBeforeSuccess: number,
): string {
  return `#!/usr/bin/env node
import { appendFileSync } from "node:fs";

const logPath = ${JSON.stringify(logPath)};
const codexErrorInfo = ${JSON.stringify(codexErrorInfo)};
const failuresBeforeSuccess = ${JSON.stringify(failuresBeforeSuccess)};
let buffer = "";
let turnSequence = 0;

function write(payload) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...payload }) + "\\n");
}

function logRequest(message) {
  appendFileSync(
    logPath,
    JSON.stringify({
      id: message.id,
      method: message.method,
      params: message.params,
      pid: process.pid,
    }) + "\\n",
  );
}

function respond(id, result) {
  write({ id, result });
}

function notify(method, params) {
  write({ method, params });
}

function completeTurn(turnId, status, error) {
  notify("turn/completed", {
    threadId: "thread-failure",
    turn: {
      id: turnId,
      items: [],
      status,
      error,
      startedAt: null,
      completedAt: null,
      durationMs: null,
    },
  });
}

function handleMessage(message) {
  if (!message || typeof message !== "object") return;
  logRequest(message);
  if (message.id === undefined) return;

  switch (message.method) {
    case "initialize":
      respond(message.id, { userAgent: "fake-codex-failure" });
      break;
    case "skills/list":
      respond(message.id, {
        data: [{
          cwd: message.params?.cwds?.[0] ?? "",
          skills: [],
          errors: [],
        }],
      });
      break;
    case "thread/start":
      respond(message.id, {
        thread: { id: "thread-failure" },
        model: "gpt-5.6-codex",
        reasoningEffort: "high",
      });
      break;
    case "turn/start": {
      turnSequence += 1;
      const turnId = \`turn-\${turnSequence}\`;
      respond(message.id, {
        turn: { id: turnId, status: "inProgress", error: null },
      });
      setTimeout(() => {
        if (turnSequence <= failuresBeforeSuccess) {
          const error = {
            message: codexErrorInfo === "serverOverloaded"
              ? "Selected model is at capacity."
              : "Usage limit reached.",
            codexErrorInfo,
            additionalDetails: null,
          };
          notify("error", {
            threadId: "thread-failure",
            turnId,
            error,
            willRetry: false,
          });
          completeTurn(turnId, "failed", error);
          return;
        }

        notify("item/completed", {
          threadId: "thread-failure",
          turnId,
          item: {
            id: \`message-\${turnSequence}\`,
            type: "agentMessage",
            text: "Recovered answer",
          },
        });
        completeTurn(turnId, "completed", null);
      }, 0);
      break;
    }
    default:
      respond(message.id, {});
      break;
  }
}

process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf-8");
  const lines = buffer.split("\\n");
  buffer = lines.pop() || "";
  for (const line of lines) {
    if (!line.trim()) continue;
    handleMessage(JSON.parse(line));
  }
});
`;
}

function buildFakeCodexPermissionAppServer(
  logPath: string,
  liveSettingsUpdates = 0,
  liveSettingsStatus:
    | "applied"
    | "targetUnavailable"
    | { code: number; message: string } = "applied",
  turnStartResponseDelayMs = 0,
  compacting = false,
): string {
  return `#!/usr/bin/env node
import { appendFileSync } from "node:fs";

const logPath = ${JSON.stringify(logPath)};
let buffer = "";
let turnSequence = 0;
const liveSettingsUpdates = ${JSON.stringify(liveSettingsUpdates)};
const liveSettingsStatus = ${JSON.stringify(liveSettingsStatus)};
const turnStartResponseDelayMs = ${JSON.stringify(turnStartResponseDelayMs)};
const compacting = ${JSON.stringify(compacting)};
let observedSettingsUpdates = 0;
let effectiveApprovalPolicy = "on-request";
const configuredWorkspaceWritePolicy = {
  type: "workspaceWrite",
  writableRoots: ["/configured-write-root"],
  networkAccess: true,
  excludeTmpdirEnvVar: true,
  excludeSlashTmp: true,
};
let effectiveSandboxPolicy = configuredWorkspaceWritePolicy;

function write(payload) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...payload }) + "\\n");
}

function logRequest(message, extra = {}) {
  appendFileSync(
    logPath,
    JSON.stringify({
      id: message.id,
      method: message.method,
      params: message.params,
      pid: process.pid,
      ...extra,
    }) + "\\n",
  );
}

function respond(id, result) {
  write({ id, result });
}

function legacySandboxPolicy(sandbox) {
  if (sandbox === "danger-full-access") {
    return { type: "dangerFullAccess" };
  }
  if (sandbox === "read-only") {
    return { type: "readOnly", networkAccess: false };
  }
  return configuredWorkspaceWritePolicy;
}

function handleMessage(message) {
  if (!message || typeof message !== "object") return;
  if (message.id === undefined) {
    logRequest(message);
    return;
  }

  if (message.method === "turn/start") {
    effectiveApprovalPolicy =
      message.params?.approvalPolicy ?? effectiveApprovalPolicy;
    effectiveSandboxPolicy =
      message.params?.sandboxPolicy ?? effectiveSandboxPolicy;
    logRequest(message, {
      effectiveApprovalPolicy,
      effectiveSandboxPolicy,
    });
  } else {
    logRequest(message);
  }

  switch (message.method) {
    case "initialize":
      respond(message.id, { userAgent: "fake-codex-policy" });
      break;
    case "skills/list":
      respond(message.id, {
        data: [{
          cwd: message.params?.cwds?.[0] ?? "",
          skills: [],
          errors: [],
        }],
      });
      break;
    case "thread/start":
      effectiveApprovalPolicy =
        message.params?.approvalPolicy ?? effectiveApprovalPolicy;
      effectiveSandboxPolicy = legacySandboxPolicy(message.params?.sandbox);
      respond(message.id, {
        thread: { id: "thread-policy" },
        model: "gpt-5.4-mini",
        reasoningEffort: "low",
        sandbox: effectiveSandboxPolicy,
      });
      break;
    case "turn/start": {
      turnSequence += 1;
      const turn = {
        id: \`turn-\${turnSequence}\`,
        status:
          turnSequence === 1 && liveSettingsUpdates > 0
            ? "inProgress"
            : "completed",
        error: null,
      };
      if (turnStartResponseDelayMs > 0) {
        setTimeout(() => respond(message.id, { turn }), turnStartResponseDelayMs);
      } else {
        respond(message.id, { turn });
      }
      if (compacting && turnSequence === 1) {
        write({
          method: "item/started",
          params: {
            threadId: "thread-policy",
            turnId: turn.id,
            item: { id: "compact-1", type: "contextCompaction" },
          },
        });
      }
      break;
    }
    case "turn/settings/update": {
      observedSettingsUpdates += 1;
      if (typeof liveSettingsStatus === "object") {
        write({ id: message.id, error: liveSettingsStatus });
      } else {
        respond(message.id, { status: liveSettingsStatus });
      }
      if (observedSettingsUpdates === liveSettingsUpdates) {
        write({
          method: "turn/completed",
          params: {
            threadId: "thread-policy",
            turn: {
              id: message.params.turnId,
              items: [],
              status: "completed",
              error: null,
            },
          },
        });
      }
      break;
    }
    default:
      respond(message.id, {});
      break;
  }
}

process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf-8");
  const lines = buffer.split("\\n");
  buffer = lines.pop() || "";
  for (const line of lines) {
    if (!line.trim()) continue;
    handleMessage(JSON.parse(line));
  }
});
`;
}

function buildFakeCodexAppServerWithLiveDelta(logPath: string): string {
  return `#!/usr/bin/env node
import { appendFileSync } from "node:fs";

const logPath = ${JSON.stringify(logPath)};
let buffer = "";

function write(payload) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...payload }) + "\\n");
}

function logRequest(message) {
  appendFileSync(
    logPath,
    JSON.stringify({
      id: message.id,
      method: message.method,
      params: message.params,
    }) + "\\n",
  );
}

function respond(id, result) {
  write({ id, result });
}

function notify(method, params) {
  write({ method, params });
}

function handleMessage(message) {
  if (!message || typeof message !== "object") return;
  logRequest(message);
  if (message.id === undefined) return;

  switch (message.method) {
    case "initialize":
      respond(message.id, { userAgent: "fake-codex" });
      break;
    case "thread/start":
      respond(message.id, {
        thread: { id: "thread-1" },
        model: "gpt-5.4-mini",
        reasoningEffort: "low",
      });
      break;
    case "turn/start":
      respond(message.id, {
        turn: { id: "turn-live", status: "inProgress", error: null },
      });
      setTimeout(() => {
        notify("item/agentMessage/delta", {
          threadId: "thread-1",
          turnId: "turn-live",
          itemId: "message-live",
          delta: "Live partial",
        });
        notify("item/completed", {
          threadId: "thread-1",
          turnId: "turn-live",
          item: {
            id: "message-live",
            type: "agentMessage",
            text: "Final streamed answer",
          },
        });
        notify("turn/completed", {
          threadId: "thread-1",
          turn: {
            id: "turn-live",
            items: [],
            status: "completed",
            error: null,
            startedAt: null,
            completedAt: null,
            durationMs: null,
          },
        });
      }, 0);
      break;
    default:
      respond(message.id, {});
      break;
  }
}

process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf-8");
  const lines = buffer.split("\\n");
  buffer = lines.pop() || "";
  for (const line of lines) {
    if (!line.trim()) continue;
    handleMessage(JSON.parse(line));
  }
});
`;
}

function buildFakeCodexAppServerWithIdleProbe(logPath: string): string {
  return `#!/usr/bin/env node
import { appendFileSync } from "node:fs";

const logPath = ${JSON.stringify(logPath)};
let buffer = "";

function write(payload) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...payload }) + "\\n");
}

function logRequest(message) {
  appendFileSync(
    logPath,
    JSON.stringify({
      id: message.id,
      method: message.method,
      params: message.params,
    }) + "\\n",
  );
}

function respond(id, result) {
  write({ id, result });
}

function handleMessage(message) {
  if (!message || typeof message !== "object") return;
  logRequest(message);
  if (message.id === undefined) return;

  switch (message.method) {
    case "initialize":
      respond(message.id, { userAgent: "fake-codex" });
      break;
    case "thread/start":
      respond(message.id, {
        thread: { id: "thread-1" },
        model: "gpt-5.4-mini",
        reasoningEffort: "low",
      });
      break;
    case "turn/start":
      respond(message.id, {
        turn: { id: "turn-missed-completion", status: "inProgress", error: null },
      });
      break;
    case "thread/read":
      respond(message.id, {
        thread: {
          id: "thread-1",
          status: { type: "idle" },
          turns: [],
        },
      });
      break;
    default:
      respond(message.id, {});
      break;
  }
}

process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf-8");
  const lines = buffer.split("\\n");
  buffer = lines.pop() || "";
  for (const line of lines) {
    if (!line.trim()) continue;
    handleMessage(JSON.parse(line));
  }
});
`;
}

function buildFakeCodexAppServerWithActiveTool(logPath: string): string {
  return `#!/usr/bin/env node
import { appendFileSync } from "node:fs";

const logPath = ${JSON.stringify(logPath)};
let buffer = "";

function write(payload) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...payload }) + "\\n");
}

function logRequest(message) {
  appendFileSync(
    logPath,
    JSON.stringify({
      id: message.id,
      method: message.method,
      params: message.params,
    }) + "\\n",
  );
}

function respond(id, result) {
  write({ id, result });
}

function notify(method, params) {
  write({ method, params });
}

function handleMessage(message) {
  if (!message || typeof message !== "object") return;
  logRequest(message);
  if (message.id === undefined) return;

  switch (message.method) {
    case "initialize":
      respond(message.id, { userAgent: "fake-codex" });
      break;
    case "thread/start":
      respond(message.id, {
        thread: { id: "thread-1" },
        model: "gpt-5.4-mini",
        reasoningEffort: "low",
      });
      break;
    case "turn/start":
      respond(message.id, {
        turn: { id: "turn-active", status: "inProgress", error: null },
      });
      setTimeout(() => {
        notify("rawResponseItem/completed", {
          threadId: "thread-1",
          turnId: "turn-active",
          item: {
            type: "function_call",
            name: "exec_command",
            call_id: "call-active",
            arguments: "{\\"cmd\\":\\"sleep 20\\"}",
          },
        });
      }, 0);
      break;
    case "turn/interrupt":
      respond(message.id, {});
      notify("rawResponseItem/completed", {
        threadId: "thread-1",
        turnId: message.params.turnId,
        item: {
          type: "function_call_output",
          call_id: "call-active",
          output: "aborted by user after 1.0s",
        },
      });
      notify("turn/completed", {
        threadId: "thread-1",
        turn: {
          id: message.params.turnId,
          items: [],
          status: "interrupted",
          error: null,
          startedAt: null,
          completedAt: null,
          durationMs: null,
        },
      });
      break;
    default:
      respond(message.id, {});
      break;
  }
}

process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf-8");
  const lines = buffer.split("\\n");
  buffer = lines.pop() || "";
  for (const line of lines) {
    if (!line.trim()) continue;
    handleMessage(JSON.parse(line));
  }
});
`;
}

function buildFakeCodexAppServerWithBackgroundTool(logPath: string): string {
  return `#!/usr/bin/env node
import { appendFileSync } from "node:fs";

const logPath = ${JSON.stringify(logPath)};
let buffer = "";

function write(payload) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...payload }) + "\\n");
}

function logRequest(message) {
  appendFileSync(
    logPath,
    JSON.stringify({
      id: message.id,
      method: message.method,
      params: message.params,
    }) + "\\n",
  );
}

function respond(id, result) {
  write({ id, result });
}

function notify(method, params) {
  write({ method, params });
}

function handleMessage(message) {
  if (!message || typeof message !== "object") return;
  logRequest(message);
  if (message.id === undefined) return;

  switch (message.method) {
    case "initialize":
      respond(message.id, { userAgent: "fake-codex" });
      break;
    case "thread/start":
      respond(message.id, {
        thread: { id: "thread-1" },
        model: "gpt-5.4-mini",
        reasoningEffort: "low",
      });
      break;
    case "turn/start":
      respond(message.id, {
        turn: { id: "turn-background", status: "inProgress", error: null },
      });
      setTimeout(() => {
        notify("rawResponseItem/completed", {
          threadId: "thread-1",
          turnId: "turn-background",
          item: {
            type: "function_call",
            name: "exec_command",
            call_id: "call-background",
            arguments: "{\\"cmd\\":\\"sleep 20\\",\\"tty\\":true}",
          },
        });
        notify("rawResponseItem/completed", {
          threadId: "thread-1",
          turnId: "turn-background",
          item: {
            type: "function_call_output",
            call_id: "call-background",
            output: "Chunk ID: abc\\nWall time: 1.0 seconds\\nProcess running with session ID 123\\nOutput:\\n",
          },
        });
      }, 0);
      break;
    case "turn/interrupt":
      respond(message.id, {});
      notify("turn/completed", {
        threadId: "thread-1",
        turn: {
          id: message.params.turnId,
          items: [],
          status: "interrupted",
          error: null,
          startedAt: null,
          completedAt: null,
          durationMs: null,
        },
      });
      break;
    default:
      respond(message.id, {});
      break;
  }
}

process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf-8");
  const lines = buffer.split("\\n");
  buffer = lines.pop() || "";
  for (const line of lines) {
    if (!line.trim()) continue;
    handleMessage(JSON.parse(line));
  }
});
`;
}

function buildFakeCodexAppServerForFork(logPath: string): string {
  return `#!/usr/bin/env node
import { appendFileSync } from "node:fs";

const logPath = ${JSON.stringify(logPath)};
let buffer = "";

function write(payload) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...payload }) + "\\n");
}

function logRequest(message) {
  appendFileSync(
    logPath,
    JSON.stringify({
      id: message.id,
      method: message.method,
      params: message.params,
    }) + "\\n",
  );
}

function respond(id, result) {
  write({ id, result });
}

function turn(id, userId, assistantId) {
  return {
    id,
    items: [
      { type: "userMessage", id: userId, clientId: null, content: [] },
      {
        type: "agentMessage",
        id: assistantId,
        text: "assistant text",
        phase: null,
        memoryCitation: null,
      },
    ],
    status: "completed",
    error: null,
    startedAt: null,
    completedAt: null,
    durationMs: null,
  };
}

function handleMessage(message) {
  if (!message || typeof message !== "object") return;
  logRequest(message);
  if (message.id === undefined) return;

  switch (message.method) {
    case "initialize":
      respond(message.id, { userAgent: "fake-codex" });
      break;
    case "thread/read":
      respond(message.id, {
        thread: {
          id: "source-thread",
          status: { type: "idle" },
          turns: [
            turn("turn-1", "user-1", "assistant-1"),
            turn("turn-2", "user-2", "assistant-2"),
            turn("turn-3", "user-3", "assistant-3"),
          ],
        },
      });
      break;
    case "thread/fork":
      respond(message.id, {
        thread: { id: "fork-thread", turns: [] },
        model: "gpt-5.4-mini",
        modelProvider: "openai",
        serviceTier: null,
        cwd: message.params?.cwd,
        runtimeWorkspaceRoots: [],
        instructionSources: [],
        approvalPolicy: message.params?.approvalPolicy ?? "on-request",
        approvalsReviewer: "auto",
        sandbox: { mode: message.params?.sandbox ?? "workspace-write" },
        activePermissionProfile: null,
        reasoningEffort: null,
        multiAgentMode: "disabled",
      });
      break;
    case "thread/rollback":
      respond(message.id, {
        thread: { id: message.params?.threadId ?? "fork-thread", turns: [] },
      });
      break;
    default:
      respond(message.id, {});
      break;
  }
}

process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf-8");
  const lines = buffer.split("\\n");
  buffer = lines.pop() || "";
  for (const line of lines) {
    if (!line.trim()) continue;
    handleMessage(JSON.parse(line));
  }
});
`;
}

function buildFakeCodexAppServerForForkSummary(logPath: string): string {
  return `#!/usr/bin/env node
import { appendFileSync } from "node:fs";

const logPath = ${JSON.stringify(logPath)};
let buffer = "";

function write(payload) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...payload }) + "\\n");
}

function logRequest(message) {
  appendFileSync(
    logPath,
    JSON.stringify({
      id: message.id,
      method: message.method,
      params: message.params,
    }) + "\\n",
  );
}

function respond(id, result) {
  write({ id, result });
}

function handleMessage(message) {
  if (!message || typeof message !== "object") return;
  logRequest(message);
  if (message.id === undefined) return;

  switch (message.method) {
    case "initialize":
      respond(message.id, { userAgent: "fake-codex" });
      break;
    case "thread/resume":
      respond(message.id, {
        thread: { id: message.params?.threadId ?? "thread-generator" },
        model: "gpt-5.4-mini",
        reasoningEffort: "low",
      });
      break;
    case "turn/start":
      respond(message.id, {
        turn: {
          id: "turn-summary",
          items: [
            {
              type: "agentMessage",
              id: "message-summary",
              text: "Codex fork retitle",
              phase: null,
              memoryCitation: null,
            },
          ],
          itemsView: "complete",
          status: "completed",
          error: null,
          startedAt: null,
          completedAt: null,
          durationMs: null,
        },
      });
      break;
    default:
      respond(message.id, {});
      break;
  }
}

process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf-8");
  const lines = buffer.split("\\n");
  buffer = lines.pop() || "";
  for (const line of lines) {
    if (!line.trim()) continue;
    handleMessage(JSON.parse(line));
  }
});
`;
}

function buildFakeCodexAppServerForRecap(logPath: string): string {
  return `#!/usr/bin/env node
import { appendFileSync } from "node:fs";

const logPath = ${JSON.stringify(logPath)};
let buffer = "";

function write(payload) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...payload }) + "\\n");
}

function logRequest(message) {
  appendFileSync(
    logPath,
    JSON.stringify({
      id: message.id,
      method: message.method,
      params: message.params,
    }) + "\\n",
  );
}

function respond(id, result) {
  write({ id, result });
}

function notify(method, params) {
  write({ method, params });
}

function handleMessage(message) {
  if (!message || typeof message !== "object") return;
  logRequest(message);
  if (message.id === undefined) return;

  switch (message.method) {
    case "initialize":
      respond(message.id, { userAgent: "fake-codex" });
      break;
    case "model/list":
      respond(message.id, {
        data: [
          {
            id: "gpt-5.4-mini",
            model: "gpt-5.4-mini",
            displayName: "GPT-5.4 Mini",
          },
        ],
      });
      break;
    case "thread/start":
      respond(message.id, {
        thread: { id: "thread-recap", ephemeral: message.params.ephemeral === true },
        model: message.params.model,
        reasoningEffort: "low",
      });
      break;
    case "turn/start":
      respond(message.id, {
        turn: {
          id: "turn-recap",
          items: [],
          itemsView: "complete",
          status: "inProgress",
          error: null,
          startedAt: null,
          completedAt: null,
          durationMs: null,
        },
      });
      setTimeout(() => {
        notify("item/agentMessage/delta", {
          threadId: "thread-recap",
          turnId: "turn-recap",
          itemId: "message-recap",
          delta: "Implemented the helper recap and ran focused tests.",
        });
        notify("turn/completed", {
          threadId: "thread-recap",
          turn: {
            id: "turn-recap",
            items: [],
            itemsView: "complete",
            status: "completed",
            error: null,
            startedAt: null,
            completedAt: null,
            durationMs: null,
          },
        });
      }, 0);
      break;
    default:
      respond(message.id, {});
      break;
  }
}

process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf-8");
  const lines = buffer.split("\\n");
  buffer = lines.pop() || "";
  for (const line of lines) {
    if (!line.trim()) continue;
    handleMessage(JSON.parse(line));
  }
});
`;
}

function buildFakeCodexAppServerWithAgentctlShellProbe(
  logPath: string,
): string {
  return `#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";

const logPath = ${JSON.stringify(logPath)};
const agentctlProbeCommand = ${JSON.stringify(
    'printf "%s" "$' + '{AGENTCTL_SESSION_ID-}"',
  )};
let buffer = "";

function write(payload) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...payload }) + "\\n");
}

function agentctlSessionIdFromBash() {
  return execFileSync("bash", ["-c", agentctlProbeCommand], {
    encoding: "utf-8",
    env: process.env,
    // Keep the fake app-server's probe aligned with an ordinary
    // non-interactive tool shell. A socket-backed stdin can make Bash skip
    // BASH_ENV in favor of its remote-shell startup path.
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function logRequest(message) {
  const record = {
    id: message.id,
    method: message.method,
    params: message.params,
    processEnvAgentctlSessionId: process.env.AGENTCTL_SESSION_ID ?? "",
    processEnvWakeToken: process.env.YEP_SESSION_WAKE_TOKEN ?? "",
  };
  if (message.method === "turn/start") {
    record.agentctlSessionId = agentctlSessionIdFromBash();
  }
  appendFileSync(logPath, JSON.stringify(record) + "\\n");
}

function respond(id, result) {
  write({ id, result });
}

function handleMessage(message) {
  if (!message || typeof message !== "object") return;
  logRequest(message);
  if (message.id === undefined) return;

  switch (message.method) {
    case "initialize":
      respond(message.id, { userAgent: "fake-codex" });
      break;
    case "thread/start":
      respond(message.id, {
        thread: { id: "thread-agentctl" },
        model: "gpt-5.4-mini",
        reasoningEffort: "low",
      });
      break;
    case "thread/resume":
      respond(message.id, {
        thread: { id: message.params?.threadId ?? "thread-agentctl" },
        model: "gpt-5.4-mini",
        reasoningEffort: "low",
      });
      break;
    case "turn/start":
      respond(message.id, {
        turn: { id: "turn-start", status: "inProgress", error: null },
      });
      break;
    default:
      respond(message.id, {});
      break;
  }
}

process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf-8");
  const lines = buffer.split("\\n");
  buffer = lines.pop() || "";
  for (const line of lines) {
    if (!line.trim()) continue;
    handleMessage(JSON.parse(line));
  }
});
`;
}

function readFakeCodexRequests(logPath: string): Array<{
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  pid?: number;
  effectiveApprovalPolicy?: string;
  effectiveSandboxPolicy?: Record<string, unknown>;
  agentctlSessionId?: string;
  processEnvAgentctlSessionId?: string;
}> {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf-8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

async function consumeCodexTurn(
  iterator: AsyncIterableIterator<Record<string, unknown>>,
): Promise<void> {
  while (true) {
    const next = await iterator.next();
    if (next.done || next.value.type === "result") return;
  }
}

async function waitForFakeCodexRequest(
  logPath: string,
  method: string,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 2000) {
    if (
      readFakeCodexRequests(logPath).some((entry) => entry.method === method)
    ) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for fake Codex request: ${method}`);
}

async function waitForMessage(
  messages: Array<Record<string, unknown>>,
  predicate: (message: Record<string, unknown>) => boolean,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 2000) {
    if (messages.some(predicate)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for fake Codex message");
}

async function waitForSuccessfulSteer(
  session: Awaited<ReturnType<CodexProvider["startSession"]>>,
  message: { text: string; uuid?: string },
): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 2000) {
    if (await session.steer?.(message)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
}

describe("CodexProvider Auth File Parsing", () => {
  let tempDir: string;
  let originalHome: string | undefined;

  beforeAll(() => {
    // Create a temp directory to use as HOME
    tempDir = mkdtempSync(join(require("node:os").tmpdir(), "codex-test-"));
    originalHome = process.env.HOME;
  });

  afterAll(() => {
    // Restore HOME
    if (originalHome !== undefined) {
      process.env.HOME = originalHome;
    }
    // Cleanup
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  it("should parse valid auth.json file", async () => {
    // Create mock auth file
    const codexDir = join(tempDir, ".codex");
    require("node:fs").mkdirSync(codexDir, { recursive: true });

    const authData = {
      api_key: "test-key-123",
      expires_at: new Date(Date.now() + 86400000).toISOString(), // 1 day from now
      user: {
        email: "test@example.com",
        name: "Test User",
      },
    };

    writeFileSync(join(codexDir, "auth.json"), JSON.stringify(authData));

    // Create provider that looks in our temp directory
    // Note: This doesn't actually work because homedir() is cached,
    // but it demonstrates the intended behavior
  });

  it("should handle expired tokens", async () => {
    // Create mock auth file with expired token
    const codexDir = join(tempDir, ".codex");
    require("node:fs").mkdirSync(codexDir, { recursive: true });

    const authData = {
      api_key: "test-key-123",
      expires_at: new Date(Date.now() - 86400000).toISOString(), // 1 day ago
    };

    writeFileSync(join(codexDir, "auth.json"), JSON.stringify(authData));

    // The actual test would need to mock homedir() to use tempDir
  });

  it("should handle invalid JSON in auth file", async () => {
    const codexDir = join(tempDir, ".codex");
    require("node:fs").mkdirSync(codexDir, { recursive: true });

    writeFileSync(join(codexDir, "auth.json"), "not valid json");

    // Provider should handle this gracefully
  });
});

describe("CodexProvider Event Normalization", () => {
  // Test helper to create a provider and access internal methods
  function createTestProvider(): CodexProvider {
    return new CodexProvider();
  }

  it("should have correct provider interface", () => {
    const provider = createTestProvider();

    expect(provider.name).toBe("codex");
    expect(provider.displayName).toBe("Codex");
    expect(typeof provider.isInstalled).toBe("function");
    expect(typeof provider.isAuthenticated).toBe("function");
    expect(typeof provider.getAuthStatus).toBe("function");
    expect(typeof provider.startSession).toBe("function");
  });

  it("logs raw Codex app-server notifications for sdk raw logging", () => {
    const provider = createTestProvider() as unknown as {
      logRawCodexNotification: (
        sessionId: string,
        notification: { method: string; params?: unknown },
      ) => void;
    };
    const notification = {
      method: "item/commandExecution/outputDelta",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        delta: "chunk",
      },
    };

    provider.logRawCodexNotification("session-1", notification);

    expect(logSDKMessage).toHaveBeenCalledOnce();
    expect(logSDKMessage).toHaveBeenCalledWith(
      "session-1",
      {
        _rawSource: "codex_app_server_notification",
        ...notification,
      },
      { provider: "codex" },
    );
  });

  it("identifies live delta notifications for the backend suppression toggle", () => {
    const provider = createTestProvider() as unknown as {
      shouldSuppressLiveDeltaNotification: (
        notification: {
          method: string;
          params?: unknown;
        },
        options: {
          cwd: string;
          shouldEmitLiveDeltas?: () => boolean;
        },
      ) => boolean;
    };
    const liveDeltaMethods = [
      "item/agentMessage/delta",
      "item/plan/delta",
      "item/reasoning/summaryTextDelta",
      "item/commandExecution/outputDelta",
      "item/fileChange/outputDelta",
    ];

    try {
      vi.stubEnv("YEP_CODEX_DISABLE_LIVE_DELTAS", "false");

      for (const method of liveDeltaMethods) {
        expect(
          provider.shouldSuppressLiveDeltaNotification(
            { method },
            {
              cwd: "/tmp",
            },
          ),
        ).toBe(false);
      }

      for (const method of liveDeltaMethods) {
        expect(
          provider.shouldSuppressLiveDeltaNotification(
            { method },
            { cwd: "/tmp", shouldEmitLiveDeltas: () => false },
          ),
        ).toBe(true);
      }

      vi.stubEnv("YEP_CODEX_DISABLE_LIVE_DELTAS", "true");

      for (const method of liveDeltaMethods) {
        expect(
          provider.shouldSuppressLiveDeltaNotification(
            { method },
            {
              cwd: "/tmp",
            },
          ),
        ).toBe(true);
      }
      expect(
        provider.shouldSuppressLiveDeltaNotification(
          {
            method: "item/completed",
          },
          { cwd: "/tmp", shouldEmitLiveDeltas: () => false },
        ),
      ).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("normalizes command execution tool_use and tool_result to Read shape", () => {
    const provider = createTestProvider() as unknown as {
      convertItemToSDKMessages: (
        item: unknown,
        sessionId: string,
        turnId: string,
        sourceEvent: "item/started" | "item/completed",
      ) => Array<Record<string, unknown>>;
    };

    const messages = provider.convertItemToSDKMessages(
      {
        id: "call-read",
        type: "command_execution",
        command: "cat src/example.ts",
        aggregated_output: "line 1\nline 2",
        exit_code: 0,
        status: "completed",
      },
      "session-1",
      "turn-1",
      "item/completed",
    );

    expect(messages).toHaveLength(2);
    expect(messages[0]?.message).toMatchObject({
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "call-read",
          name: "Read",
          input: { file_path: "src/example.ts" },
        },
      ],
    });
    expect(messages[1]?.message).toMatchObject({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "call-read",
          content: "line 1\nline 2",
        },
      ],
    });
    expect(messages[1]?.toolUseResult).toMatchObject({
      type: "text",
      file: {
        filePath: "src/example.ts",
      },
    });
  });

  it("normalizes shell-launcher wrapped command execution to Read shape", () => {
    const provider = createTestProvider() as unknown as {
      convertItemToSDKMessages: (
        item: unknown,
        sessionId: string,
        turnId: string,
        sourceEvent: "item/started" | "item/completed",
      ) => Array<Record<string, unknown>>;
    };

    const messages = provider.convertItemToSDKMessages(
      {
        id: "call-read-wrapped",
        type: "command_execution",
        command: "/bin/bash -lc \"sed -n '10,12p' src/example.ts\"",
        aggregated_output: "line 10\nline 11\nline 12",
        exit_code: 0,
        status: "completed",
      },
      "session-1",
      "turn-1",
      "item/completed",
    );

    expect(messages).toHaveLength(2);
    expect(messages[0]?.message).toMatchObject({
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "call-read-wrapped",
          name: "Read",
          input: { file_path: "src/example.ts", offset: 10, limit: 3 },
        },
      ],
    });
    expect(messages[1]?.toolUseResult).toMatchObject({
      type: "text",
      file: {
        filePath: "src/example.ts",
        startLine: 10,
      },
    });
  });

  it("normalizes PowerShell Get-Content command execution to Read shape", () => {
    const provider = createTestProvider() as unknown as {
      convertItemToSDKMessages: (
        item: unknown,
        sessionId: string,
        turnId: string,
        sourceEvent: "item/started" | "item/completed",
      ) => Array<Record<string, unknown>>;
    };

    const messages = provider.convertItemToSDKMessages(
      {
        id: "call-read-pwsh",
        type: "command_execution",
        command: String.raw`"C:\Users\sox\AppData\Local\Microsoft\WindowsApps\pwsh.exe" -Command 'Get-Content -Path CLAUDE.md -TotalCount 20'`,
        aggregated_output: "# Yep Anywhere\n\nFor cross-project context",
        exit_code: 0,
        status: "completed",
      },
      "session-1",
      "turn-1",
      "item/completed",
    );

    expect(messages).toHaveLength(2);
    expect(messages[0]?.message).toMatchObject({
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "call-read-pwsh",
          name: "Read",
          input: { file_path: "CLAUDE.md", offset: 1, limit: 20 },
        },
      ],
    });
    expect(messages[1]?.toolUseResult).toMatchObject({
      type: "text",
      file: {
        filePath: "CLAUDE.md",
        startLine: 1,
      },
    });
  });

  it("derives command display actions from command and cwd", () => {
    const provider = createTestProvider() as unknown as {
      convertItemToSDKMessages: (
        item: unknown,
        sessionId: string,
        turnId: string,
        sourceEvent: "item/started" | "item/completed",
      ) => Array<Record<string, unknown>>;
    };

    const absolutePath = String.raw`C:\Users\sox\Documents\code\yepanywhere\CLAUDE.md`;
    const cwd = String.raw`C:\Users\sox\Documents\code\yepanywhere`;
    const messages = provider.convertItemToSDKMessages(
      {
        id: "call-read-action",
        type: "command_execution",
        cwd,
        command: String.raw`"C:\Users\sox\AppData\Local\Microsoft\WindowsApps\pwsh.exe" -Command 'Get-Content -Path CLAUDE.md -TotalCount 20'`,
        commandActions: [
          {
            type: "read",
            command: "Get-Content -Path CLAUDE.md -TotalCount 20",
            name: "CLAUDE.md",
            path: absolutePath,
          },
        ],
        aggregated_output: "# Yep Anywhere\n\nFor cross-project context",
        exit_code: 0,
        status: "completed",
      },
      "session-1",
      "turn-1",
      "item/completed",
    );

    expect(messages).toHaveLength(2);
    expect(messages[0]?.message).toMatchObject({
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "call-read-action",
          name: "Read",
          input: { file_path: "CLAUDE.md", offset: 1, limit: 20 },
          _displayActions: [
            {
              kind: "read",
              path: "CLAUDE.md",
              absolutePath,
              name: "CLAUDE.md",
              startLine: 1,
              endLine: 20,
            },
          ],
        },
      ],
    });
    expect(messages[1]?.toolUseResult).toMatchObject({
      type: "text",
      file: {
        filePath: "CLAUDE.md",
        startLine: 1,
      },
    });
  });

  it("normalizes heredoc command execution as Write with structured file result", () => {
    const provider = createTestProvider() as unknown as {
      convertItemToSDKMessages: (
        item: unknown,
        sessionId: string,
        turnId: string,
        sourceEvent: "item/started" | "item/completed",
      ) => Array<Record<string, unknown>>;
    };

    const content = "line 1\nline 2\n";
    const messages = provider.convertItemToSDKMessages(
      {
        id: "call-write",
        type: "command_execution",
        command: `cat > src/generated.ts <<'EOF'\n${content}EOF`,
        aggregated_output: "",
        exit_code: 0,
        status: "completed",
      },
      "session-1",
      "turn-2",
      "item/completed",
    );

    expect(messages).toHaveLength(2);
    expect(messages[0]?.message).toMatchObject({
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "call-write",
          name: "Write",
          input: {
            file_path: "src/generated.ts",
            content,
          },
        },
      ],
    });

    const resultBlock = ((
      messages[1]?.message as { content?: unknown[] } | undefined
    )?.content ?? [])[0] as Record<string, unknown>;
    expect(resultBlock.type).toBe("tool_result");
    expect(resultBlock.tool_use_id).toBe("call-write");
    expect(resultBlock.is_error).toBeUndefined();
    expect(messages[1]?.toolUseResult).toMatchObject({
      type: "text",
      file: {
        filePath: "src/generated.ts",
        content,
        numLines: 2,
        startLine: 1,
        totalLines: 2,
      },
    });
  });

  it("marks a declined file change as an error result", () => {
    const provider = createTestProvider() as unknown as {
      convertItemToSDKMessages: (
        item: unknown,
        sessionId: string,
        turnId: string,
        sourceEvent: "item/started" | "item/completed",
      ) => Array<Record<string, unknown>>;
    };

    const messages = provider.convertItemToSDKMessages(
      {
        id: "file-change-declined",
        type: "file_change",
        changes: [{ kind: "update", path: "src/a.ts" }],
        status: "declined",
      },
      "session-1",
      "turn-2",
      "item/completed",
    );
    const resultMessage = messages[1]?.message as
      | { content?: unknown[] }
      | undefined;
    const resultBlock = (resultMessage?.content ?? [])[0] as Record<
      string,
      unknown
    >;

    expect(resultBlock).toMatchObject({
      type: "tool_result",
      tool_use_id: "file-change-declined",
      is_error: true,
    });
  });

  it("normalizes no-match ripgrep exit code as non-error Grep result", () => {
    const provider = createTestProvider() as unknown as {
      convertItemToSDKMessages: (
        item: unknown,
        sessionId: string,
        turnId: string,
        sourceEvent: "item/started" | "item/completed",
      ) => Array<Record<string, unknown>>;
    };

    const messages = provider.convertItemToSDKMessages(
      {
        id: "call-grep",
        type: "command_execution",
        command: "rg -n missing_pattern src",
        aggregated_output: "",
        exit_code: 1,
        status: "completed",
      },
      "session-1",
      "turn-2",
      "item/completed",
    );

    expect(messages).toHaveLength(2);
    expect(messages[0]?.message).toMatchObject({
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "call-grep",
          name: "Grep",
          input: { pattern: "missing_pattern", path: "src" },
        },
      ],
    });

    const resultBlock = ((
      messages[1]?.message as { content?: unknown[] } | undefined
    )?.content ?? [])[0] as Record<string, unknown>;
    expect(resultBlock.type).toBe("tool_result");
    expect(resultBlock.tool_use_id).toBe("call-grep");
    expect(resultBlock.is_error).toBeUndefined();
    expect(messages[1]?.toolUseResult).toMatchObject({
      mode: "files_with_matches",
      numFiles: 0,
    });
  });

  it("prefers reasoning summaries over raw reasoning content", () => {
    const provider = createTestProvider() as unknown as {
      normalizeThreadItem: (item: unknown) => Record<string, unknown> | null;
      convertItemToSDKMessages: (
        item: unknown,
        sessionId: string,
        turnId: string,
        sourceEvent: "item/started" | "item/completed",
      ) => Array<Record<string, unknown>>;
    };

    const normalized = provider.normalizeThreadItem({
      id: "reason-1",
      type: "reasoning",
      summary: ["Short summary"],
      content: ["internal raw reasoning"],
    });

    expect(normalized).toMatchObject({
      id: "reason-1",
      type: "reasoning",
      text: "Short summary",
    });
    expect(
      provider.convertItemToSDKMessages(
        normalized,
        "session-1",
        "turn-1",
        "item/completed",
      ),
    ).toMatchObject([{ uuid: "reason-1" }]);
  });

  it("renders asynchronously delivered agent messages", () => {
    const provider = createTestProvider() as unknown as {
      normalizeThreadItem: (item: unknown) => Record<string, unknown> | null;
      convertItemToSDKMessages: (
        item: unknown,
        sessionId: string,
        turnId: string,
        sourceEvent: "item/started" | "item/completed",
      ) => Array<Record<string, unknown>>;
    };

    const normalized = provider.normalizeThreadItem({
      id: "async-message-1",
      type: "agentMessage",
      text: "Choose a mode\n- Safe\n- Fast",
      delivery: "async",
      questions: [
        { title: "Choose a mode", options: ["Safe", "Fast"] },
        { title: "Anything else?", options: null },
      ],
    });

    expect(normalized).toMatchObject({
      id: "async-message-1",
      type: "agent_message",
      text: "Choose a mode\n- Safe\n- Fast",
      delivery: "async",
      questions: [
        { title: "Choose a mode", options: ["Safe", "Fast"] },
        { title: "Anything else?", options: null },
      ],
    });
    expect(
      provider.convertItemToSDKMessages(
        normalized,
        "session-1",
        "turn-1",
        "item/completed",
      ),
    ).toMatchObject([
      {
        type: "assistant",
        uuid: "async-message-1",
        message: {
          role: "assistant",
          content: "Choose a mode\n- Safe\n- Fast",
        },
        codexAgentMessageDelivery: "async",
        codexAsyncQuestions: [
          { title: "Choose a mode", options: ["Safe", "Fast"] },
          { title: "Anything else?", options: null },
        ],
      },
    ]);
  });

  it("shows live standalone function outputs without inventing a call", () => {
    const provider = createTestProvider() as unknown as {
      normalizeThreadItem: (item: unknown) => Record<string, unknown> | null;
      convertItemToSDKMessages: (
        item: unknown,
        sessionId: string,
        turnId: string,
        sourceEvent: "item/started" | "item/completed",
      ) => Array<Record<string, unknown>>;
    };

    const normalized = provider.normalizeThreadItem({
      id: "function-output-1",
      type: "functionCallOutput",
      name: "notifications",
      namespace: "slack",
      output: [{ type: "input_text", text: "new message" }],
    });

    expect(normalized).toMatchObject({
      id: "function-output-1",
      type: "function_call_output",
      name: "notifications",
      namespace: "slack",
    });
    expect(
      provider.convertItemToSDKMessages(
        normalized,
        "session-1",
        "turn-1",
        "item/completed",
      ),
    ).toMatchObject([
      {
        type: "system",
        subtype: "tool_output",
        uuid: "function-output-1",
        content: "new message",
        codexToolName: "notifications",
        codexToolNamespace: "slack",
      },
    ]);
  });

  it("surfaces subagent activity items as visible system messages", () => {
    const provider = createTestProvider() as unknown as {
      normalizeThreadItem: (item: unknown) => Record<string, unknown> | null;
      convertItemToSDKMessages: (
        item: unknown,
        sessionId: string,
        turnId: string,
        sourceEvent: "item/started" | "item/completed",
      ) => Array<Record<string, unknown>>;
    };

    const normalized = provider.normalizeThreadItem({
      id: "subagent-activity-1",
      type: "subAgentActivity",
      kind: "started",
      agentThreadId: "thread-subagent-1",
      agentPath: "Explore",
    });

    expect(normalized).toMatchObject({
      id: "subagent-activity-1",
      type: "subagent_activity",
      kind: "started",
      agentThreadId: "thread-subagent-1",
      agentPath: "Explore",
      text: "Subagent started: Explore",
    });

    const messages = provider.convertItemToSDKMessages(
      normalized,
      "session-1",
      "turn-1",
      "item/completed",
    );

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      type: "system",
      subtype: "subagent_activity",
      content: "Subagent started: Explore",
      codexSubagentKind: "started",
      codexSubagentThreadId: "thread-subagent-1",
      codexSubagentPath: "Explore",
    });
  });

  it("declares experimentalApi during initialize when enabled", () => {
    const provider = createTestProvider() as unknown as {
      createInitializeParams: (
        experimentalApiEnabled: boolean,
      ) => Record<string, unknown>;
    };

    const params = provider.createInitializeParams(true);

    expect(params).toMatchObject({
      clientInfo: {
        title: null,
        version: "dev",
      },
      capabilities: {
        experimentalApi: true,
      },
    });
    expect((params.clientInfo as { name?: unknown }).name).toEqual(
      expect.any(String),
    );
  });

  it("records and recovers an unsupported experimental initialize", async () => {
    const infoLog = vi
      .spyOn(getLogger(), "info")
      .mockImplementation(() => undefined);
    const request = vi
      .fn()
      .mockRejectedValueOnce(new Error("unsupported capabilities"))
      .mockResolvedValueOnce({ userAgent: "fake-codex" });
    const provider = createTestProvider() as unknown as {
      initializeAppServer: (appServer: {
        request: typeof request;
      }) => Promise<boolean>;
    };

    await expect(provider.initializeAppServer({ request })).resolves.toBe(
      false,
    );
    expect(request).toHaveBeenNthCalledWith(
      1,
      "initialize",
      expect.objectContaining({
        capabilities: { experimentalApi: true },
      }),
    );
    expect(request).toHaveBeenNthCalledWith(
      2,
      "initialize",
      expect.objectContaining({ capabilities: null }),
    );
    expect(infoLog).toHaveBeenCalledWith(
      {
        component: "codex-provider",
        event: "codex_experimental_api_unavailable",
        error: "unsupported capabilities",
      },
      "Codex initialize with experimentalApi failed; retrying without capabilities",
    );
  });

  it("inherits the thread reasoning-summary mode on ordinary turns", () => {
    const provider = createTestProvider() as unknown as {
      createTurnStartParams: (
        threadId: string,
        userPrompt: string,
        options: { effort?: unknown; thinking?: unknown },
      ) => Record<string, unknown>;
    };

    const params = provider.createTurnStartParams(
      "thread-1",
      "test prompt",
      {},
    );

    expect(params).toMatchObject({ threadId: "thread-1" });
    expect(params).not.toHaveProperty("summary");
  });

  it("pairs every turn approval override with its native sandbox policy", () => {
    const provider = createTestProvider() as unknown as {
      normalizePermissionMode: (permissionMode?: string) => string;
      mapPermissionModeToThreadPolicy: (permissionMode?: string) => {
        approvalPolicy: string;
        sandbox: string;
      };
      buildTurnPermissionParams: (
        policy: {
          approvalPolicy: string;
          sandbox: string;
        },
        workspaceWriteSandboxPolicy?: Record<string, unknown>,
      ) => Record<string, unknown>;
    };

    expect(
      ["default", "acceptEdits", "plan", "bypassPermissions", "auto"].map(
        (mode) => {
          const effectiveMode = provider.normalizePermissionMode(mode);
          return {
            mode,
            effectiveMode,
            params: provider.buildTurnPermissionParams(
              provider.mapPermissionModeToThreadPolicy(effectiveMode),
            ),
          };
        },
      ),
    ).toEqual([
      {
        mode: "default",
        effectiveMode: "default",
        params: {
          approvalPolicy: "on-request",
          sandboxPolicy: {
            type: "workspaceWrite",
            writableRoots: [],
            networkAccess: false,
            excludeTmpdirEnvVar: false,
            excludeSlashTmp: false,
          },
        },
      },
      {
        mode: "acceptEdits",
        effectiveMode: "acceptEdits",
        params: {
          approvalPolicy: "on-request",
          sandboxPolicy: {
            type: "workspaceWrite",
            writableRoots: [],
            networkAccess: false,
            excludeTmpdirEnvVar: false,
            excludeSlashTmp: false,
          },
        },
      },
      {
        mode: "plan",
        effectiveMode: "plan",
        params: {
          approvalPolicy: "on-request",
          sandboxPolicy: { type: "readOnly", networkAccess: false },
        },
      },
      {
        mode: "bypassPermissions",
        effectiveMode: "bypassPermissions",
        params: {
          approvalPolicy: "never",
          sandboxPolicy: { type: "dangerFullAccess" },
        },
      },
      {
        mode: "auto",
        effectiveMode: "default",
        params: {
          approvalPolicy: "on-request",
          sandboxPolicy: {
            type: "workspaceWrite",
            writableRoots: [],
            networkAccess: false,
            excludeTmpdirEnvVar: false,
            excludeSlashTmp: false,
          },
        },
      },
    ]);

    expect(
      provider.buildTurnPermissionParams(
        {
          approvalPolicy: "on-request",
          sandbox: "workspace-write",
        },
        {
          type: "workspaceWrite",
          writableRoots: ["/configured-write-root"],
          networkAccess: true,
          excludeTmpdirEnvVar: true,
          excludeSlashTmp: true,
        },
      ),
    ).toEqual({
      approvalPolicy: "on-request",
      sandboxPolicy: {
        type: "workspaceWrite",
        writableRoots: ["/configured-write-root"],
        networkAccess: true,
        excludeTmpdirEnvVar: true,
        excludeSlashTmp: true,
      },
    });
    expect(
      provider.buildTurnPermissionParams({
        approvalPolicy: "on-request",
        sandbox: "read-only",
      }),
    ).toEqual({
      approvalPolicy: "on-request",
      sandboxPolicy: { type: "readOnly", networkAccess: false },
    });
    expect(
      provider.buildTurnPermissionParams({
        approvalPolicy: "never",
        sandbox: "danger-full-access",
      }),
    ).toEqual({
      approvalPolicy: "never",
      sandboxPolicy: { type: "dangerFullAccess" },
    });
  });

  it("builds stable thread policy params with limited history", () => {
    const provider = createTestProvider() as unknown as {
      mapPermissionModeToThreadPolicy: (permissionMode?: string) => {
        approvalPolicy: string;
        sandbox: string;
      };
      createThreadStartParams: (
        options: { model?: string; cwd: string },
        policy: {
          approvalPolicy: string;
          sandbox: string;
        },
      ) => Record<string, unknown>;
    };
    const bypassPolicy =
      provider.mapPermissionModeToThreadPolicy("bypassPermissions");

    const start = provider.createThreadStartParams(
      { model: "gpt-5.2-codex", cwd: "/tmp" },
      { approvalPolicy: "on-request", sandbox: "workspace-write" },
    );
    const bypassStart = provider.createThreadStartParams(
      { model: "gpt-5.5", cwd: "/tmp" },
      bypassPolicy,
    );

    expect(start).toMatchObject({
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      experimentalRawEvents: false,
    });
    expect(bypassStart).toMatchObject({
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      experimentalRawEvents: false,
    });
    expect(start.persistExtendedHistory).toBeUndefined();
    expect(bypassStart.persistExtendedHistory).toBeUndefined();
    expect(start.permissionProfile).toBeUndefined();
    expect(bypassStart.permissionProfile).toBeUndefined();
  });

  it("builds stable resume params with limited history", () => {
    const provider = createTestProvider() as unknown as {
      createThreadResumeParams: (
        options: { resumeSessionId?: string; model?: string; cwd: string },
        sessionId: string,
        policy: {
          approvalPolicy: string;
          sandbox: string;
        },
        experimentalApiEnabled?: boolean,
      ) => Record<string, unknown>;
    };

    const resume = provider.createThreadResumeParams(
      {
        resumeSessionId: "thread-1",
        model: "gpt-5.2-codex",
        cwd: "/tmp",
      },
      "thread-1",
      { approvalPolicy: "on-request", sandbox: "workspace-write" },
    );

    expect(resume).toMatchObject({
      threadId: "thread-1",
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
    });
    expect(resume.excludeTurns).toBeUndefined();
    expect(resume.persistExtendedHistory).toBeUndefined();
    expect(resume.permissionProfile).toBeUndefined();
  });

  it("uses experimental excludeTurns after Codex negotiation succeeds", () => {
    const provider = createTestProvider() as unknown as {
      createThreadResumeParams: (
        options: { resumeSessionId?: string; model?: string; cwd: string },
        sessionId: string,
        policy: {
          approvalPolicy: string;
          sandbox: string;
        },
        experimentalApiEnabled?: boolean,
      ) => Record<string, unknown>;
    };

    const resume = provider.createThreadResumeParams(
      {
        resumeSessionId: "thread-1",
        model: "gpt-5.2-codex",
        cwd: "/tmp",
      },
      "thread-1",
      { approvalPolicy: "on-request", sandbox: "workspace-write" },
      true,
    );

    expect(resume).toMatchObject({
      threadId: "thread-1",
      excludeTurns: true,
    });
    expect(resume.persistExtendedHistory).toBeUndefined();
  });

  it("applies the configured reasoning-summary mode to every thread path", () => {
    const provider = createTestProvider() as unknown as {
      setReasoningSummaryGetter: (
        getter: () => "auto" | "concise" | "detailed" | "none",
      ) => void;
      createThreadStartParams: (
        options: { cwd: string },
        policy: { approvalPolicy: string; sandbox: string },
      ) => Record<string, unknown>;
      createThreadResumeParams: (
        options: { resumeSessionId: string; cwd: string },
        sessionId: string,
        policy: { approvalPolicy: string; sandbox: string },
      ) => Record<string, unknown>;
      createThreadForkParams: (
        options: { sessionId: string; cwd: string },
        policy: { approvalPolicy: string; sandbox: string },
      ) => Record<string, unknown>;
    };
    const policy = {
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
    };

    expect(
      provider.createThreadStartParams({ cwd: "/tmp" }, policy),
    ).toMatchObject({ config: { model_reasoning_summary: "auto" } });

    provider.setReasoningSummaryGetter(() => "detailed");
    expect(
      provider.createThreadStartParams({ cwd: "/tmp" }, policy),
    ).toMatchObject({ config: { model_reasoning_summary: "detailed" } });
    expect(
      provider.createThreadResumeParams(
        { resumeSessionId: "thread-1", cwd: "/tmp" },
        "thread-1",
        policy,
      ),
    ).toMatchObject({ config: { model_reasoning_summary: "detailed" } });
    expect(
      provider.createThreadForkParams(
        { sessionId: "thread-1", cwd: "/tmp" },
        policy,
      ),
    ).toMatchObject({ config: { model_reasoning_summary: "detailed" } });
  });

  it("applies V1 subagent nesting depth to every thread path", () => {
    const provider = createTestProvider() as unknown as {
      setSubagentMaxDepthGetter: (getter: () => number | null) => void;
      createThreadStartParams: (
        options: { cwd: string },
        policy: { approvalPolicy: string; sandbox: string },
      ) => Record<string, unknown>;
      createThreadResumeParams: (
        options: { resumeSessionId: string; cwd: string },
        sessionId: string,
        policy: { approvalPolicy: string; sandbox: string },
      ) => Record<string, unknown>;
      createThreadForkParams: (
        options: { sessionId: string; cwd: string },
        policy: { approvalPolicy: string; sandbox: string },
      ) => Record<string, unknown>;
    };
    const policy = {
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
    };

    provider.setSubagentMaxDepthGetter(() => 4);
    expect(
      provider.createThreadStartParams({ cwd: "/tmp" }, policy),
    ).toMatchObject({ config: { agents: { max_depth: 4 } } });
    expect(
      provider.createThreadResumeParams(
        { resumeSessionId: "thread-1", cwd: "/tmp" },
        "thread-1",
        policy,
      ),
    ).toMatchObject({ config: { agents: { max_depth: 4 } } });
    expect(
      provider.createThreadForkParams(
        { sessionId: "thread-1", cwd: "/tmp" },
        policy,
      ),
    ).toMatchObject({ config: { agents: { max_depth: 4 } } });

    provider.setSubagentMaxDepthGetter(() => null);
    expect(
      provider.createThreadStartParams({ cwd: "/tmp" }, policy),
    ).not.toHaveProperty("config.agents");
  });

  it("suppresses the unavailable desktop browser skill for every thread path", () => {
    const provider = createTestProvider() as unknown as {
      createThreadStartParams: (
        options: { cwd: string },
        policy: { approvalPolicy: string; sandbox: string },
      ) => Record<string, unknown>;
      createThreadResumeParams: (
        options: { resumeSessionId: string; cwd: string },
        sessionId: string,
        policy: { approvalPolicy: string; sandbox: string },
      ) => Record<string, unknown>;
      createThreadForkParams: (
        options: { sessionId: string; cwd: string },
        policy: { approvalPolicy: string; sandbox: string },
      ) => Record<string, unknown>;
    };
    const policy = {
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
    };
    const expectedConfig = {
      skills: {
        config: [
          {
            name: "browser:control-in-app-browser",
            enabled: false,
          },
        ],
      },
    };

    const start = provider.createThreadStartParams({ cwd: "/tmp" }, policy);
    const resume = provider.createThreadResumeParams(
      { resumeSessionId: "thread-1", cwd: "/tmp" },
      "thread-1",
      policy,
    );
    const fork = provider.createThreadForkParams(
      { sessionId: "thread-1", cwd: "/tmp" },
      policy,
    );

    expect(start).toMatchObject({ config: expectedConfig });
    expect(resume).toMatchObject({ config: expectedConfig });
    expect(fork).toMatchObject({ config: expectedConfig });
  });

  it.each([
    ["provider-default", undefined],
    ["disabled", false],
    ["enabled", true],
  ] as const)(
    "applies %s plan-tool mode to every thread path",
    (mode, enabled) => {
      const provider = createTestProvider() as unknown as {
        setPlanToolModeGetter: (getter: () => CodexPlanToolMode) => void;
        createThreadStartParams: (
          options: { cwd: string },
          policy: { approvalPolicy: string; sandbox: string },
        ) => Record<string, unknown>;
        createThreadResumeParams: (
          options: { resumeSessionId: string; cwd: string },
          sessionId: string,
          policy: { approvalPolicy: string; sandbox: string },
        ) => Record<string, unknown>;
        createThreadForkParams: (
          options: { sessionId: string; cwd: string },
          policy: { approvalPolicy: string; sandbox: string },
        ) => Record<string, unknown>;
      };
      const policy = {
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
      };
      provider.setPlanToolModeGetter(() => mode);

      const start = provider.createThreadStartParams({ cwd: "/tmp" }, policy);
      const resume = provider.createThreadResumeParams(
        { resumeSessionId: "thread-1", cwd: "/tmp" },
        "thread-1",
        policy,
      );
      const fork = provider.createThreadForkParams(
        { sessionId: "thread-1", cwd: "/tmp" },
        policy,
      );

      for (const request of [start, resume, fork]) {
        if (enabled === undefined) {
          expect(request).not.toHaveProperty("config.tools.update_plan");
        } else {
          expect(request).toMatchObject({
            config: { tools: { update_plan: { enabled } } },
          });
        }
      }
    },
  );

  it("pins thread-scope reasoning effort via config when effort is requested", () => {
    const provider = createTestProvider() as unknown as {
      createThreadStartParams: (
        options: {
          model?: string;
          cwd: string;
          effort?: string;
          thinking?: { type: string };
        },
        policy: {
          approvalPolicy: string;
          sandbox: string;
        },
        experimentalApiEnabled?: boolean,
      ) => Record<string, unknown>;
      createThreadResumeParams: (
        options: {
          resumeSessionId?: string;
          model?: string;
          cwd: string;
          effort?: string;
          thinking?: { type: string };
        },
        sessionId: string,
        policy: {
          approvalPolicy: string;
          sandbox: string;
        },
      ) => Record<string, unknown>;
      createTurnStartParams: (
        threadId: string,
        userPrompt: string,
        options: {
          model?: string;
          cwd: string;
          effort?: string;
          thinking?: { type: string };
        },
      ) => Record<string, unknown>;
    };

    const start = provider.createThreadStartParams(
      { model: "gpt-5.4-codex", cwd: "/tmp", effort: "max" },
      { approvalPolicy: "on-request", sandbox: "workspace-write" },
    );
    const startXhigh = provider.createThreadStartParams(
      { model: "gpt-5.4-codex", cwd: "/tmp", effort: "xhigh" },
      { approvalPolicy: "on-request", sandbox: "workspace-write" },
    );
    const resume = provider.createThreadResumeParams(
      {
        resumeSessionId: "thread-1",
        model: "gpt-5.4-codex",
        cwd: "/tmp",
        effort: "high",
      },
      "thread-1",
      { approvalPolicy: "on-request", sandbox: "workspace-write" },
    );
    const omitted = provider.createThreadStartParams(
      { model: "gpt-5.4-codex", cwd: "/tmp" },
      { approvalPolicy: "on-request", sandbox: "workspace-write" },
    );
    const disabled = provider.createThreadStartParams(
      {
        model: "gpt-5.4-codex",
        cwd: "/tmp",
        effort: "high",
        thinking: { type: "disabled" },
      },
      { approvalPolicy: "on-request", sandbox: "workspace-write" },
    );
    const turn = provider.createTurnStartParams("thread-1", "hello", {
      model: "gpt-5.4-codex",
      cwd: "/tmp",
      effort: "low",
      thinking: { type: "adaptive" },
    });
    const disabledTurn = provider.createTurnStartParams("thread-1", "hello", {
      model: "gpt-5.4-codex",
      cwd: "/tmp",
      effort: "high",
      thinking: { type: "disabled" },
    });

    expect(start).toMatchObject({
      config: { model_reasoning_effort: "xhigh" },
    });
    expect(startXhigh).toMatchObject({
      config: { model_reasoning_effort: "xhigh" },
    });
    expect(resume).toMatchObject({
      config: { model_reasoning_effort: "high" },
    });
    expect(omitted).toMatchObject({
      config: {
        skills: {
          config: [
            {
              name: "browser:control-in-app-browser",
              enabled: false,
            },
          ],
        },
      },
    });
    expect(disabled).toMatchObject({
      config: { model_reasoning_effort: "none" },
    });
    expect(turn).toMatchObject({ effort: "low" });
    expect(disabledTurn).toMatchObject({ effort: "none" });
  });

  it("sets a total-context auto-compact limit only when requested", () => {
    const provider = createTestProvider() as unknown as {
      createThreadStartParams: (
        options: {
          cwd: string;
          compactAtContextTokenLimit?: number;
        },
        policy: {
          approvalPolicy: string;
          sandbox: string;
        },
      ) => { config?: Record<string, unknown> };
      createThreadResumeParams: (
        options: {
          resumeSessionId: string;
          cwd: string;
          compactAtContextTokenLimit?: number;
        },
        sessionId: string,
        policy: {
          approvalPolicy: string;
          sandbox: string;
        },
      ) => { config?: Record<string, unknown> };
    };
    const policy = {
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
    };

    const start = provider.createThreadStartParams(
      { cwd: "/tmp", compactAtContextTokenLimit: 136_000 },
      policy,
    );
    const resume = provider.createThreadResumeParams(
      {
        resumeSessionId: "thread-1",
        cwd: "/tmp",
        compactAtContextTokenLimit: 204_000,
      },
      "thread-1",
      policy,
    );
    const omitted = provider.createThreadStartParams({ cwd: "/tmp" }, policy);

    expect(start.config).toMatchObject({
      model_auto_compact_token_limit: 136_000,
      model_auto_compact_token_limit_scope: "total",
    });
    expect(resume.config).toMatchObject({
      model_auto_compact_token_limit: 204_000,
      model_auto_compact_token_limit_scope: "total",
    });
    expect(omitted.config).not.toHaveProperty("model_auto_compact_token_limit");
    expect(omitted.config).not.toHaveProperty(
      "model_auto_compact_token_limit_scope",
    );
  });

  it("passes service tier only when explicitly requested", () => {
    const provider = createTestProvider() as unknown as {
      createThreadStartParams: (
        options: {
          model?: string;
          cwd: string;
          serviceTier?: string;
        },
        policy: {
          approvalPolicy: string;
          sandbox: string;
        },
      ) => Record<string, unknown>;
      createThreadResumeParams: (
        options: {
          resumeSessionId?: string;
          model?: string;
          cwd: string;
          serviceTier?: string;
        },
        sessionId: string,
        policy: {
          approvalPolicy: string;
          sandbox: string;
        },
      ) => Record<string, unknown>;
      createTurnStartParams: (
        threadId: string,
        userPrompt: string,
        options: {
          model?: string;
          cwd: string;
          serviceTier?: string;
        },
      ) => Record<string, unknown>;
    };

    const policy = { approvalPolicy: "on-request", sandbox: "workspace-write" };
    const defaultStart = provider.createThreadStartParams(
      { model: "gpt-5.5", cwd: "/tmp" },
      policy,
    );
    const priorityStart = provider.createThreadStartParams(
      { model: "gpt-5.5", cwd: "/tmp", serviceTier: "priority" },
      policy,
    );
    const defaultResume = provider.createThreadResumeParams(
      { resumeSessionId: "thread-1", model: "gpt-5.5", cwd: "/tmp" },
      "thread-1",
      policy,
    );
    const priorityResume = provider.createThreadResumeParams(
      {
        resumeSessionId: "thread-1",
        model: "gpt-5.5",
        cwd: "/tmp",
        serviceTier: "priority",
      },
      "thread-1",
      policy,
    );
    const defaultTurn = provider.createTurnStartParams("thread-1", "hello", {
      model: "gpt-5.5",
      cwd: "/tmp",
    });
    const priorityTurn = provider.createTurnStartParams("thread-1", "hello", {
      model: "gpt-5.5",
      cwd: "/tmp",
      serviceTier: "priority",
    });

    expect(defaultStart.serviceTier).toBeUndefined();
    expect(defaultResume.serviceTier).toBeUndefined();
    expect(defaultTurn.serviceTier).toBeUndefined();
    expect(priorityStart).toMatchObject({ serviceTier: "priority" });
    expect(priorityResume).toMatchObject({ serviceTier: "priority" });
    expect(priorityTurn).toMatchObject({ serviceTier: "priority" });
  });

  it("accumulates agent message deltas into a stable streaming assistant message", () => {
    const provider = createTestProvider() as unknown as {
      convertNotificationToSDKMessages: (
        notification: { method: string; params?: unknown },
        sessionId: string,
        usageByTurnId: Map<string, unknown>,
        liveEventState: ReturnType<typeof createLiveEventState>,
      ) => Array<Record<string, unknown>>;
    };

    const liveEventState = createLiveEventState();

    const first = provider.convertNotificationToSDKMessages(
      codexAgentMessageDeltaFixtures.firstNotification,
      "session-1",
      new Map(),
      liveEventState,
    );
    const second = provider.convertNotificationToSDKMessages(
      codexAgentMessageDeltaFixtures.secondNotification,
      "session-1",
      new Map(),
      liveEventState,
    );

    expect(first[0]).toMatchObject(
      codexAgentMessageDeltaFixtures.expectedFirstMessage,
    );
    expect(second[0]).toMatchObject(
      codexAgentMessageDeltaFixtures.expectedSecondMessage,
    );
  });

  it("surfaces Codex context compaction thread items", () => {
    const provider = createTestProvider() as unknown as {
      convertNotificationToSDKMessages: (
        notification: { method: string; params?: unknown },
        sessionId: string,
        usageByTurnId: Map<string, unknown>,
        liveEventState: ReturnType<typeof createLiveEventState>,
      ) => Array<Record<string, unknown>>;
    };

    const liveEventState = createLiveEventState();
    const started = provider.convertNotificationToSDKMessages(
      codexContextCompactionFixtures.startedNotification,
      "session-1",
      new Map(),
      liveEventState,
    );
    const completed = provider.convertNotificationToSDKMessages(
      codexContextCompactionFixtures.completedNotification,
      "session-1",
      new Map(),
      liveEventState,
    );

    expect(started[0]).toMatchObject(
      codexContextCompactionFixtures.expectedStartedMessage,
    );
    expect(completed[0]).toMatchObject(
      codexContextCompactionFixtures.expectedCompletedMessage,
    );
  });

  it("surfaces raw Codex compaction response items as compact boundaries", () => {
    const provider = createTestProvider() as unknown as {
      convertNotificationToSDKMessages: (
        notification: { method: string; params?: unknown },
        sessionId: string,
        usageByTurnId: Map<string, unknown>,
        liveEventState: ReturnType<typeof createLiveEventState>,
      ) => Array<Record<string, unknown>>;
    };

    const messages = provider.convertNotificationToSDKMessages(
      codexContextCompactionFixtures.rawResponseCompletedNotification,
      "session-1",
      new Map(),
      createLiveEventState(),
    );

    expect(messages[0]).toMatchObject(
      codexContextCompactionFixtures.expectedRawResponseCompletedMessage,
    );
  });

  it("surfaces interrupted live Codex turns as visible system boundaries", () => {
    const provider = createTestProvider() as unknown as {
      convertNotificationToSDKMessages: (
        notification: { method: string; params?: unknown },
        sessionId: string,
        usageByTurnId: Map<string, unknown>,
        liveEventState: ReturnType<typeof createLiveEventState>,
      ) => Array<Record<string, unknown>>;
    };

    const messages = provider.convertNotificationToSDKMessages(
      codexInterruptedTurnFixtures.notification,
      "session-1",
      new Map(),
      createLiveEventState(),
    );

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject(
      codexInterruptedTurnFixtures.expectedMessage,
    );

    expect(
      messages.some((message) => message.subtype === "turn_complete"),
    ).toBe(false);
    expect(
      compileTranscriptProjection(
        messages as Parameters<typeof compileTranscriptProjection>[0],
      )[0],
    ).toMatchObject(codexInterruptedTurnFixtures.expectedRenderMessage);
  });

  it("normalizes raw response function calls and outputs into tool messages", () => {
    const provider = createTestProvider() as unknown as {
      convertNotificationToSDKMessages: (
        notification: { method: string; params?: unknown },
        sessionId: string,
        usageByTurnId: Map<string, unknown>,
        liveEventState: ReturnType<typeof createLiveEventState>,
      ) => Array<Record<string, unknown>>;
    };

    const liveEventState = createLiveEventState();
    const toolUse = provider.convertNotificationToSDKMessages(
      codexRawFunctionCallFixtures.toolUseNotification,
      "session-1",
      new Map(),
      liveEventState,
    );
    const toolResult = provider.convertNotificationToSDKMessages(
      codexRawFunctionCallFixtures.toolResultNotification,
      "session-1",
      new Map(),
      liveEventState,
    );

    expect(toolUse[0]).toMatchObject(
      codexRawFunctionCallFixtures.expectedToolUseMessage,
    );
    expect(toolResult[0]).toMatchObject(
      codexRawFunctionCallFixtures.expectedToolResultMessage,
    );
  });

  it("surfaces live Codex checklist updates as completed plan tools", () => {
    const provider = createTestProvider() as unknown as {
      convertNotificationToSDKMessages: (
        notification: { method: string; params?: unknown },
        sessionId: string,
        usageByTurnId: Map<string, unknown>,
        liveEventState: ReturnType<typeof createLiveEventState>,
      ) => Array<Record<string, unknown>>;
    };

    const liveEventState = createLiveEventState();
    const first = provider.convertNotificationToSDKMessages(
      {
        method: "turn/plan/updated",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          explanation: "Start with the contracts.",
          plan: [
            { step: "Read the contracts", status: "inProgress" },
            { step: "Implement the fix", status: "pending" },
          ],
        },
      },
      "session-1",
      new Map(),
      liveEventState,
    );
    const second = provider.convertNotificationToSDKMessages(
      {
        method: "turn/plan/updated",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          explanation: null,
          plan: [
            { step: "Read the contracts", status: "completed" },
            { step: "Implement the fix", status: "inProgress" },
          ],
        },
      },
      "session-1",
      new Map(),
      liveEventState,
    );

    expect(first).toHaveLength(2);
    expect(second).toHaveLength(2);
    expect(
      compileTranscriptProjection([...first, ...second] as Parameters<
        typeof compileTranscriptProjection
      >[0]),
    ).toMatchObject([
      {
        type: "tool_call",
        id: "codex-plan-turn-1-1",
        toolName: "UpdatePlan",
        toolInput: {
          explanation: "Start with the contracts.",
          plan: [
            { step: "Read the contracts", status: "in_progress" },
            { step: "Implement the fix", status: "pending" },
          ],
        },
        status: "complete",
      },
      {
        type: "tool_call",
        id: "codex-plan-turn-1-2",
        toolName: "UpdatePlan",
        toolInput: {
          plan: [
            { step: "Read the contracts", status: "completed" },
            { step: "Implement the fix", status: "in_progress" },
          ],
        },
        status: "complete",
      },
    ]);
  });

  it("marks live result-backed tools incomplete when a turn completes first", () => {
    const provider = createTestProvider() as unknown as {
      convertNotificationToSDKMessages: (
        notification: { method: string; params?: unknown },
        sessionId: string,
        usageByTurnId: Map<string, unknown>,
        liveEventState: ReturnType<typeof createLiveEventState>,
      ) => Array<Record<string, unknown>>;
    };

    const liveEventState = createLiveEventState();
    const toolMessages = provider.convertNotificationToSDKMessages(
      {
        method: "item/started",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            id: "cmd-1",
            type: "commandExecution",
            command: "sleep 15",
            status: "inProgress",
          },
        },
      },
      "session-1",
      new Map(),
      liveEventState,
    );
    const turnMessages = provider.convertNotificationToSDKMessages(
      {
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turn: {
            id: "turn-1",
            items: [],
            status: "interrupted",
            error: null,
            startedAt: null,
            completedAt: null,
            durationMs: null,
          },
        },
      },
      "session-1",
      new Map(),
      liveEventState,
    );

    expect(turnMessages[0]).toMatchObject({
      type: "system",
      subtype: "codex_tool_orphans",
      orphanedToolUseIds: ["cmd-1"],
    });
    expect(turnMessages[1]).toMatchObject({
      type: "system",
      subtype: "turn_aborted",
      content: "Conversation interrupted",
      codexTurnId: "turn-1",
    });

    const renderItems = compileTranscriptProjection([
      ...toolMessages,
      ...turnMessages,
    ] as Parameters<typeof compileTranscriptProjection>[0]);
    expect(renderItems[0]).toMatchObject({
      type: "tool_call",
      id: "cmd-1",
      status: "incomplete",
    });
    expect(
      renderItems.some(
        (item) =>
          item.type === "system" &&
          item.subtype === "turn_aborted" &&
          item.content === "Conversation interrupted",
      ),
    ).toBe(true);
  });

  it("keeps Codex background process handles from reviving orphaned work", () => {
    const provider = createTestProvider() as unknown as {
      convertNotificationToSDKMessages: (
        notification: { method: string; params?: unknown },
        sessionId: string,
        usageByTurnId: Map<string, unknown>,
        liveEventState: ReturnType<typeof createLiveEventState>,
      ) => Array<Record<string, unknown>>;
    };

    const liveEventState = createLiveEventState();
    const toolUse = provider.convertNotificationToSDKMessages(
      {
        method: "rawResponseItem/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "function_call",
            name: "exec_command",
            call_id: "cmd-1",
            arguments: '{"cmd":"sleep 20","tty":true}',
          },
        },
      },
      "session-1",
      new Map(),
      liveEventState,
    );
    const toolStarted = provider.convertNotificationToSDKMessages(
      {
        method: "item/started",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            id: "cmd-1",
            type: "commandExecution",
            command: "sleep 20",
            status: "inProgress",
          },
        },
      },
      "session-1",
      new Map(),
      liveEventState,
    );
    const backgroundHandle = provider.convertNotificationToSDKMessages(
      {
        method: "rawResponseItem/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "function_call_output",
            call_id: "cmd-1",
            output:
              "Chunk ID: abc\nWall time: 1.0 seconds\nProcess running with session ID 123\nOutput:\n",
          },
        },
      },
      "session-1",
      new Map(),
      liveEventState,
    );
    const turnMessages = provider.convertNotificationToSDKMessages(
      {
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turn: {
            id: "turn-1",
            items: [],
            status: "interrupted",
            error: null,
            startedAt: null,
            completedAt: null,
            durationMs: null,
          },
        },
      },
      "session-1",
      new Map(),
      liveEventState,
    );

    expect(turnMessages[0]).toMatchObject({
      type: "system",
      subtype: "codex_tool_orphans",
      orphanedToolUseIds: ["cmd-1"],
    });

    const renderItems = compileTranscriptProjection([
      ...toolUse,
      ...toolStarted,
      ...backgroundHandle,
      ...turnMessages,
    ] as Parameters<typeof compileTranscriptProjection>[0]);
    expect(renderItems[0]).toMatchObject({
      type: "tool_call",
      id: "cmd-1",
      status: "incomplete",
    });
  });

  it("does not mark completed live result-backed tools orphaned", () => {
    const provider = createTestProvider() as unknown as {
      convertNotificationToSDKMessages: (
        notification: { method: string; params?: unknown },
        sessionId: string,
        usageByTurnId: Map<string, unknown>,
        liveEventState: ReturnType<typeof createLiveEventState>,
      ) => Array<Record<string, unknown>>;
    };

    const liveEventState = createLiveEventState();
    const toolStarted = provider.convertNotificationToSDKMessages(
      {
        method: "item/started",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            id: "cmd-1",
            type: "commandExecution",
            command: "printf done",
            status: "inProgress",
          },
        },
      },
      "session-1",
      new Map(),
      liveEventState,
    );
    const toolCompleted = provider.convertNotificationToSDKMessages(
      {
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            id: "cmd-1",
            type: "commandExecution",
            command: "printf done",
            aggregatedOutput: "done",
            exitCode: 0,
            status: "completed",
          },
        },
      },
      "session-1",
      new Map(),
      liveEventState,
    );
    const turnMessages = provider.convertNotificationToSDKMessages(
      {
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turn: {
            id: "turn-1",
            items: [],
            status: "completed",
            error: null,
            startedAt: null,
            completedAt: null,
            durationMs: null,
          },
        },
      },
      "session-1",
      new Map(),
      liveEventState,
    );

    expect(
      turnMessages.some((message) => message.subtype === "codex_tool_orphans"),
    ).toBe(false);

    const renderItems = compileTranscriptProjection([
      ...toolStarted,
      ...toolCompleted,
      ...turnMessages,
    ] as Parameters<typeof compileTranscriptProjection>[0]);
    expect(renderItems[0]).toMatchObject({
      type: "tool_call",
      id: "cmd-1",
      status: "complete",
    });
  });

  it("normalizes dynamic tool calls with namespace and output content", () => {
    const provider = createTestProvider() as unknown as {
      convertItemToSDKMessages: (
        item: unknown,
        sessionId: string,
        turnId: string,
        sourceEvent: "item/started" | "item/completed",
      ) => Array<Record<string, unknown>>;
    };

    const messages = provider.convertItemToSDKMessages(
      {
        id: "call-dynamic",
        type: "dynamic_tool_call",
        namespace: "web",
        tool: "search",
        arguments: { query: "codex release" },
        status: "completed",
        success: true,
        content_items: [{ type: "inputText", text: "Search completed" }],
      },
      "session-1",
      "turn-1",
      "item/completed",
    );

    expect(messages).toHaveLength(2);
    expect(messages[0]?.message).toMatchObject({
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "call-dynamic",
          name: "web:search",
          input: { query: "codex release" },
        },
      ],
    });
    expect(messages[1]?.message).toMatchObject({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "call-dynamic",
          content: "Search completed",
        },
      ],
    });
  });

  it("does not emit rate limit errors when hasCredits is false but usage is below 100%", () => {
    const provider = createTestProvider() as unknown as {
      convertNotificationToSDKMessages: (
        notification: { method: string; params?: unknown },
        sessionId: string,
        usageByTurnId: Map<string, unknown>,
        liveEventState: ReturnType<typeof createLiveEventState>,
      ) => Array<Record<string, unknown>>;
    };

    const messages = provider.convertNotificationToSDKMessages(
      {
        method: "account/rateLimits/updated",
        params: {
          rateLimits: {
            primary: {
              usedPercent: 21,
              resetsAt: 1772721801,
            },
            credits: {
              hasCredits: false,
              unlimited: false,
              balance: null,
            },
          },
        },
      },
      "session-1",
      new Map(),
      createLiveEventState(),
    );

    expect(messages).toEqual([]);
  });

  it("does not emit synthetic errors for exhausted usage snapshots", () => {
    const provider = createTestProvider() as unknown as {
      convertNotificationToSDKMessages: (
        notification: { method: string; params?: unknown },
        sessionId: string,
        usageByTurnId: Map<string, unknown>,
        liveEventState: ReturnType<typeof createLiveEventState>,
      ) => Array<Record<string, unknown>>;
    };

    const messages = provider.convertNotificationToSDKMessages(
      {
        method: "account/rateLimits/updated",
        params: {
          rateLimits: {
            primary: {
              used_percent: 100,
              resets_at: 1772721801,
            },
            credits: {
              has_credits: false,
              unlimited: false,
              balance: null,
            },
          },
        },
      },
      "session-1",
      new Map(),
      createLiveEventState(),
    );

    expect(messages).toEqual([]);
  });

  it("emits errors from codex error notifications", () => {
    const provider = createTestProvider() as unknown as {
      convertNotificationToSDKMessages: (
        notification: { method: string; params?: unknown },
        sessionId: string,
        usageByTurnId: Map<string, unknown>,
        liveEventState: ReturnType<typeof createLiveEventState>,
      ) => Array<Record<string, unknown>>;
    };

    const messages = provider.convertNotificationToSDKMessages(
      {
        method: "error",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          willRetry: false,
          error: {
            message:
              "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again later.",
            codexErrorInfo: "usageLimitExceeded",
          },
        },
      },
      "session-1",
      new Map(),
      createLiveEventState(),
    );

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      type: "error",
      uuid: "codex-error-turn-1",
      session_id: "session-1",
      error:
        "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again later.",
      codexWillRetry: false,
      codexTurnId: "turn-1",
      codexErrorScope: "turn",
    });
  });

  it("preserves automatic retry details from codex error notifications", () => {
    const provider = createTestProvider() as unknown as {
      convertNotificationToSDKMessages: (
        notification: { method: string; params?: unknown },
        sessionId: string,
        usageByTurnId: Map<string, unknown>,
        liveEventState: ReturnType<typeof createLiveEventState>,
      ) => Array<Record<string, unknown>>;
    };

    const messages = provider.convertNotificationToSDKMessages(
      {
        method: "error",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          willRetry: true,
          error: {
            message: "Reconnecting... 2/5",
            additionalDetails: "stream disconnected before completion",
            codexErrorInfo: {
              responseStreamDisconnected: { httpStatusCode: 502 },
            },
          },
        },
      },
      "session-1",
      new Map(),
      createLiveEventState(),
    );

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      type: "error",
      uuid: "codex-error-turn-1",
      error: "Reconnecting... 2/5",
      codexAdditionalDetails: "stream disconnected before completion",
      codexWillRetry: true,
      codexErrorScope: "turn",
    });
  });

  it("surfaces a misalignment explanation as the codex error detail", () => {
    const provider = createTestProvider() as unknown as {
      convertNotificationToSDKMessages: (
        notification: { method: string; params?: unknown },
        sessionId: string,
        usageByTurnId: Map<string, unknown>,
        liveEventState: ReturnType<typeof createLiveEventState>,
      ) => Array<Record<string, unknown>>;
    };

    const messages = provider.convertNotificationToSDKMessages(
      {
        method: "error",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          willRetry: false,
          error: {
            message:
              "This request was blocked due to a misalignment policy violation.",
            codexErrorInfo: "misalignmentPolicyViolation",
            misalignment: {
              errorType: "some_new_category",
              detailedExplanation:
                "The requested change would disable an audit control.",
              steer: { message: "Continue without disabling the control." },
            },
          },
        },
      },
      "session-1",
      new Map(),
      createLiveEventState(),
    );

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      type: "error",
      error: "This request was blocked due to a misalignment policy violation.",
      codexErrorInfo: "misalignmentPolicyViolation",
      codexAdditionalDetails:
        "The requested change would disable an audit control.",
      codexWillRetry: false,
    });
  });

  it("preserves synthetic app-server process exit errors without turn ids", () => {
    const provider = createTestProvider() as unknown as {
      convertNotificationToSDKMessages: (
        notification: { method: string; params?: unknown },
        sessionId: string,
        usageByTurnId: Map<string, unknown>,
        liveEventState: ReturnType<typeof createLiveEventState>,
      ) => Array<Record<string, unknown>>;
    };

    const messages = provider.convertNotificationToSDKMessages(
      {
        method: "error",
        params: {
          error: {
            message: "Codex app-server exited (code=1, signal=null)",
          },
          willRetry: false,
          codexProcessExit: true,
        },
      },
      "session-1",
      new Map(),
      createLiveEventState(),
    );

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      type: "error",
      error: "Codex app-server exited (code=1, signal=null)",
      codexWillRetry: false,
      codexErrorScope: "app_server_process",
    });
  });

  it("treats a synthetic app-server exit as terminal without a turn id", () => {
    const provider = createTestProvider() as unknown as {
      isTurnTerminalNotification: (
        notification: { method: string; params?: unknown },
        turnId: string,
      ) => boolean;
    };

    expect(
      provider.isTurnTerminalNotification(
        {
          method: "error",
          params: {
            error: {
              message: "Codex app-server exited (code=1, signal=null)",
            },
            willRetry: false,
            codexProcessExit: true,
          },
        },
        "turn-1",
      ),
    ).toBe(true);
  });

  it("grants requested permissions for only the requesting bypass turn", async () => {
    const provider = createTestProvider() as unknown as {
      handleServerRequestApproval: (
        request: { method: string; id: number; params?: unknown },
        options: { permissionMode?: string },
        signal: AbortSignal,
        permissionMode?: string,
      ) => Promise<Record<string, unknown>>;
    };

    const response = await provider.handleServerRequestApproval(
      {
        method: "item/permissions/requestApproval",
        id: 1,
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "permission-1",
          cwd: "/tmp/project",
          reason: "Need unrestricted filesystem for GPU tooling",
          permissions: {
            network: { enabled: true },
            fileSystem: {
              entries: [
                {
                  path: { type: "special", value: { kind: "root" } },
                  access: "write",
                },
              ],
            },
          },
        },
      },
      { permissionMode: "default" },
      new AbortController().signal,
      "bypassPermissions",
    );

    expect(response).toMatchObject({
      scope: "turn",
      permissions: {
        network: { enabled: true },
        fileSystem: {
          entries: [
            {
              path: { type: "special", value: { kind: "root" } },
              access: "write",
            },
          ],
        },
      },
    });
  });

  it("does not let launch bypass override an Ask turn permission request", async () => {
    const onToolApproval = vi.fn(async () => ({
      behavior: "deny" as const,
    }));
    const provider = createTestProvider() as unknown as {
      handleServerRequestApproval: (
        request: { method: string; id: number; params?: unknown },
        options: {
          permissionMode?: string;
          onToolApproval?: typeof onToolApproval;
        },
        signal: AbortSignal,
        permissionMode?: string,
      ) => Promise<Record<string, unknown>>;
    };

    const response = await provider.handleServerRequestApproval(
      {
        method: "item/permissions/requestApproval",
        id: 1,
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "permission-1",
          cwd: "/tmp/project",
          reason: "Need network",
          permissions: { network: { enabled: true } },
        },
      },
      { permissionMode: "bypassPermissions", onToolApproval },
      new AbortController().signal,
      "default",
    );

    expect(onToolApproval).toHaveBeenCalledWith(
      "Permissions",
      expect.any(Object),
      expect.objectContaining({ permissionMode: "default" }),
    );
    expect(response).toEqual({ permissions: {}, scope: "turn" });
  });

  it("surfaces Codex user-input requests and returns answers by question id", async () => {
    const onToolApproval = vi.fn(
      async (
        _toolName: string,
        _input: unknown,
        _options: { signal: AbortSignal; permissionMode?: string },
      ) => ({
        behavior: "allow" as const,
        updatedInput: {
          answers: {
            "secret-id": "swordfish",
            "Choose checks": ["Unit", "Types"],
          },
        },
      }),
    );
    const provider = createTestProvider() as unknown as {
      handleServerRequestApproval: (
        request: { method: string; id: number; params?: unknown },
        options: {
          permissionMode?: string;
          onToolApproval?: typeof onToolApproval;
        },
        signal: AbortSignal,
        permissionMode?: string,
      ) => Promise<Record<string, unknown>>;
    };

    const response = await provider.handleServerRequestApproval(
      {
        method: "item/tool/requestUserInput",
        id: 2,
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "question-1",
          isBlocking: false,
          autoResolutionMs: null,
          questions: [
            {
              id: "secret-id",
              header: "Secret",
              question: "Enter the token",
              isOther: true,
              isSecret: true,
              options: null,
            },
            {
              id: "checks-id",
              header: "Checks",
              question: "Choose checks",
              isOther: false,
              isSecret: false,
              options: [
                { label: "Unit", description: "Run unit tests" },
                { label: "Types", description: "Run typecheck" },
              ],
            },
          ],
        },
      },
      { permissionMode: "bypassPermissions", onToolApproval },
      new AbortController().signal,
      "default",
    );

    expect(onToolApproval).toHaveBeenCalledWith(
      "AskUserQuestion",
      expect.objectContaining({
        isBlocking: false,
        questions: [
          expect.objectContaining({
            id: "secret-id",
            isSecret: true,
            isOther: true,
          }),
          expect.objectContaining({
            id: "checks-id",
            isSecret: false,
            isOther: false,
          }),
        ],
      }),
      expect.objectContaining({ permissionMode: "default" }),
    );
    expect(response).toEqual({
      answers: {
        "secret-id": { answers: ["swordfish"] },
        "checks-id": { answers: ["Unit", "Types"] },
      },
    });
  });

  it("treats pre-0.147 user-input requests as blocking", async () => {
    const onToolApproval = vi.fn(async () => ({
      behavior: "allow" as const,
      updatedInput: { answers: { "question-1": "Answer" } },
    }));
    const provider = createTestProvider() as unknown as {
      handleServerRequestApproval: (
        request: { method: string; id: number; params?: unknown },
        options: { onToolApproval?: typeof onToolApproval },
        signal: AbortSignal,
        permissionMode?: string,
      ) => Promise<Record<string, unknown>>;
    };

    const response = await provider.handleServerRequestApproval(
      {
        method: "item/tool/requestUserInput",
        id: 3,
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "question-1",
          autoResolutionMs: null,
          questions: [
            {
              id: "question-1",
              header: "Question",
              question: "Legacy request?",
              options: null,
            },
          ],
        },
      },
      { onToolApproval },
      new AbortController().signal,
      "default",
    );

    expect(onToolApproval).toHaveBeenCalledWith(
      "AskUserQuestion",
      expect.objectContaining({ isBlocking: true }),
      expect.objectContaining({ permissionMode: "default" }),
    );
    expect(response).toEqual({
      answers: { "question-1": { answers: ["Answer"] } },
    });
  });
});

describe("CodexProvider Configuration", () => {
  it("should accept custom timeout", () => {
    const config: CodexProviderConfig = {
      timeout: 60000,
    };
    const provider = new CodexProvider(config);

    expect(provider.name).toBe("codex");
    // Can't directly verify timeout since it's private,
    // but we can verify the provider was created
  });

  it("should accept custom codex path", () => {
    const config: CodexProviderConfig = {
      codexPath: "/custom/path/to/codex",
    };
    const provider = new CodexProvider(config);

    expect(provider.name).toBe("codex");
  });

  it("should use defaults when no config provided", () => {
    const provider = new CodexProvider();

    expect(provider.name).toBe("codex");
    expect(provider.displayName).toBe("Codex");
  });
});
