import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CONFIG_ENV_VARS } from "./setup/config-env-vars.js";

interface ConfigEnvReadReport {
  names: string[];
  dynamicReads: string[];
}

function collectConfigEnvReads(): ConfigEnvReadReport {
  const configPath = fileURLToPath(
    new URL("../src/config.ts", import.meta.url),
  );
  const sourceText = fs.readFileSync(configPath, "utf8");
  const sourceFile = ts.createSourceFile(
    configPath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const names = new Set<string>();
  const dynamicReads: string[] = [];

  function isProcessEnv(node: ts.Expression): boolean {
    return (
      ts.isPropertyAccessExpression(node) &&
      node.name.text === "env" &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "process"
    );
  }

  function addDynamicRead(node: ts.Node): void {
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(
      node.getStart(sourceFile),
    );
    dynamicReads.push(
      `${line + 1}:${character + 1} ${node.getText(sourceFile)}`,
    );
  }

  function visit(node: ts.Node): void {
    if (ts.isPropertyAccessExpression(node) && isProcessEnv(node.expression)) {
      names.add(node.name.text);
    } else if (
      ts.isElementAccessExpression(node) &&
      isProcessEnv(node.expression)
    ) {
      const argument = node.argumentExpression;
      if (
        ts.isStringLiteral(argument) ||
        ts.isNoSubstitutionTemplateLiteral(argument)
      ) {
        names.add(argument.text);
      } else {
        addDynamicRead(node);
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return {
    names: Array.from(names).sort(),
    dynamicReads,
  };
}

describe("hermetic config env setup", () => {
  it("scrubs every direct config env read from unit tests", () => {
    const { names, dynamicReads } = collectConfigEnvReads();
    const scrubbed = new Set(CONFIG_ENV_VARS);

    expect(dynamicReads).toEqual([]);
    expect(names.filter((name) => !scrubbed.has(name))).toEqual([]);
  });
});

describe("optional SQLite configuration", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("defaults off and honors explicit startup mode", async () => {
    const { loadConfig } = await import("../src/config.js");
    expect(loadConfig().sqliteMode).toBe("off");
    vi.stubEnv("YEP_SQLITE", "auto");
    expect(loadConfig().sqliteMode).toBe("auto");
    vi.stubEnv("YEP_SQLITE", "off");
    vi.stubEnv("YEP_DESKTOP", "1");
    expect(loadConfig().sqliteMode).toBe("off");
  });

  it("rejects misspelled modes instead of silently enabling storage", async () => {
    vi.stubEnv("YEP_SQLITE", "yes");
    const { loadConfig } = await import("../src/config.js");
    expect(() => loadConfig()).toThrow("YEP_SQLITE must be one of: off, auto");
  });
});

describe("loadConfig codex paths", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("uses CODEX_HOME/sessions when CODEX_SESSIONS_DIR is unset", async () => {
    vi.stubEnv("CODEX_HOME", "/tmp/custom-codex-home");

    const { loadConfig } = await import("../src/config.js");
    const config = loadConfig();

    expect(config.codexSessionsDir).toBe(
      path.join("/tmp/custom-codex-home", "sessions"),
    );
  });

  it("prefers CODEX_SESSIONS_DIR over CODEX_HOME", async () => {
    vi.stubEnv("CODEX_HOME", "/tmp/custom-codex-home");
    vi.stubEnv("CODEX_SESSIONS_DIR", "/tmp/explicit-codex-sessions");

    const { loadConfig } = await import("../src/config.js");
    const config = loadConfig();

    expect(config.codexSessionsDir).toBe("/tmp/explicit-codex-sessions");
  });

  it("falls back to ~/.codex/sessions when neither env var is set", async () => {
    const { loadConfig } = await import("../src/config.js");
    const config = loadConfig();

    expect(config.codexSessionsDir).toBe(
      path.join(os.homedir(), ".codex", "sessions"),
    );
  });

  it("parses desktop runtime Codex CLI path", async () => {
    vi.stubEnv("YEP_DESKTOP", "1");
    vi.stubEnv("YEP_DESKTOP_CODEX_CLI_PATH", "/tmp/yep-desktop/bin/codex");

    const { loadConfig } = await import("../src/config.js");
    const config = loadConfig();

    expect(config.desktopRuntime).toBe(true);
    expect(config.codexCliPath).toBe("/tmp/yep-desktop/bin/codex");
  });

  it("ignores blank desktop Codex CLI path", async () => {
    vi.stubEnv("YEP_DESKTOP", "true");
    vi.stubEnv("YEP_DESKTOP_CODEX_CLI_PATH", "  ");

    const { loadConfig } = await import("../src/config.js");
    const config = loadConfig();

    expect(config.desktopRuntime).toBe(true);
    expect(config.codexCliPath).toBeUndefined();
  });

  it("defaults the Codex plan tool to provider behavior", async () => {
    const { loadConfig } = await import("../src/config.js");

    expect(loadConfig().codexPlanToolMode).toBe("provider-default");
  });

  it.each(["provider-default", "disabled", "enabled"] as const)(
    "parses the %s Codex plan-tool override",
    async (mode) => {
      vi.stubEnv("YEP_CODEX_UPDATE_PLAN", mode);
      const { loadConfig } = await import("../src/config.js");

      expect(loadConfig().codexPlanToolMode).toBe(mode);
    },
  );

  it("rejects an invalid Codex plan-tool override", async () => {
    vi.stubEnv("YEP_CODEX_UPDATE_PLAN", "sometimes");
    const { loadConfig } = await import("../src/config.js");

    expect(() => loadConfig()).toThrow(
      "YEP_CODEX_UPDATE_PLAN must be one of: provider-default, disabled, enabled",
    );
  });

  it("defaults Codex summary parser worker on when unset", async () => {
    const { loadConfig } = await import("../src/config.js");
    const config = loadConfig();

    expect(config.claudeSummaryParserWorkerMode).toBe("off");
    expect(config.codexSummaryParserWorkerMode).toBe("on");
  });

  it("preserves an explicit Codex summary parser worker off override", async () => {
    vi.stubEnv("CODEX_SUMMARY_PARSER_WORKER", "off");

    const { loadConfig } = await import("../src/config.js");
    const config = loadConfig();

    expect(config.codexSummaryParserWorkerMode).toBe("off");
  });

  it("treats blank or invalid Codex summary parser worker overrides as off", async () => {
    vi.stubEnv("CODEX_SUMMARY_PARSER_WORKER", "");

    const { loadConfig } = await import("../src/config.js");
    const blankConfig = loadConfig();

    expect(blankConfig.codexSummaryParserWorkerMode).toBe("off");

    vi.resetModules();
    vi.stubEnv("CODEX_SUMMARY_PARSER_WORKER", "invalid");

    const { loadConfig: loadConfigAgain } = await import("../src/config.js");
    const invalidConfig = loadConfigAgain();

    expect(invalidConfig.codexSummaryParserWorkerMode).toBe("off");
  });

  it("parses summary parser worker overrides", async () => {
    vi.stubEnv("CLAUDE_SUMMARY_PARSER_WORKER", "required");
    vi.stubEnv("CODEX_SUMMARY_PARSER_WORKER", "required");

    const { loadConfig } = await import("../src/config.js");
    const config = loadConfig();

    expect(config.claudeSummaryParserWorkerMode).toBe("required");
    expect(config.codexSummaryParserWorkerMode).toBe("required");
  });

  it("uses the real Windows temp directory for default local-image paths", async () => {
    const { getDefaultAllowedImagePaths } = await import("../src/config.js");

    // Windows has no `/tmp` and no implicit `C:\tmp`; only os.tmpdir().
    expect(getDefaultAllowedImagePaths("win32", "C:\\Users\\me\\Temp")).toEqual(
      ["C:\\Users\\me\\Temp"],
    );
    expect(getDefaultAllowedImagePaths("linux", "/var/tmp-ignored")).toEqual([
      "/tmp",
    ]);
  });

  it("always allows the managed uploads directory for local-image", async () => {
    vi.stubEnv("YEP_DATA_DIR", "/tmp/yep-data");
    vi.stubEnv("ALLOWED_IMAGE_PATHS", "");

    const { loadConfig } = await import("../src/config.js");
    const config = loadConfig();

    expect(config.allowedImagePaths).toEqual([
      path.join("/tmp/yep-data", "uploads"),
    ]);
  });

  it("merges managed uploads with configured local-image paths", async () => {
    vi.stubEnv("YEP_DATA_DIR", "/tmp/yep-data");
    vi.stubEnv("ALLOWED_IMAGE_PATHS", "/tmp, /var/tmp, /tmp");

    const { loadConfig } = await import("../src/config.js");
    const config = loadConfig();

    expect(config.allowedImagePaths).toEqual([
      path.join("/tmp/yep-data", "uploads"),
      "/tmp",
      "/var/tmp",
    ]);
  });

  it("defaults server-routed voice backends off", async () => {
    vi.stubEnv("YEP_VOICE_BACKENDS", "");

    const { loadConfig } = await import("../src/config.js");
    const config = loadConfig();

    expect(config.voiceBackends).toEqual([]);
  });

  it("parses explicitly enabled server-routed voice backends", async () => {
    vi.stubEnv(
      "YEP_VOICE_BACKENDS",
      "ya-dummy, local-whisper,ya-parakeet,ya-nemo,ya-dummy",
    );

    const { loadConfig } = await import("../src/config.js");
    const config = loadConfig();

    expect(config.voiceBackends).toEqual([
      "ya-dummy",
      "local-whisper",
      "ya-parakeet",
      "ya-nemo",
      "ya-dummy",
    ]);
  });

  it("parses local Parakeet tuning options", async () => {
    vi.stubEnv("PARAKEET_MODEL", "nvidia/parakeet-tdt-0.6b-v3");
    vi.stubEnv("PARAKEET_DEVICE", "cuda:0");

    const { loadConfig } = await import("../src/config.js");
    const config = loadConfig();

    expect(config.parakeetModel).toBe("nvidia/parakeet-tdt-0.6b-v3");
    expect(config.parakeetDevice).toBe("cuda:0");
  });

  it("parses local NeMo Parakeet tuning options", async () => {
    vi.stubEnv("NEMO_MODEL", "nvidia/parakeet-rnnt-1.1b");
    vi.stubEnv("NEMO_DEVICE", "cuda:1");

    const { loadConfig } = await import("../src/config.js");
    const config = loadConfig();

    expect(config.nemoModel).toBe("nvidia/parakeet-rnnt-1.1b");
    expect(config.nemoDevice).toBe("cuda:1");
  });

  it("defaults idle cleanup to 24 hours", async () => {
    vi.stubEnv("IDLE_TIMEOUT", "");

    const { loadConfig } = await import("../src/config.js");
    const config = loadConfig();

    expect(config.idleTimeoutMs).toBe(24 * 60 * 60 * 1000);
  });

  it("defaults session auto-archive off", async () => {
    vi.stubEnv("SESSION_AUTO_ARCHIVE_DAYS", "");

    const { loadConfig } = await import("../src/config.js");
    const config = loadConfig();

    expect(config.sessionAutoArchiveDays).toBe(0);
  });

  it("preserves an explicit session auto-archive override", async () => {
    vi.stubEnv("SESSION_AUTO_ARCHIVE_DAYS", "14");

    const { loadConfig } = await import("../src/config.js");
    const config = loadConfig();

    expect(config.sessionAutoArchiveDays).toBe(14);
  });

  it("preserves an explicit IDLE_TIMEOUT override", async () => {
    vi.stubEnv("IDLE_TIMEOUT", "45");

    const { loadConfig } = await import("../src/config.js");
    const config = loadConfig();

    expect(config.idleTimeoutMs).toBe(45 * 1000);
  });

  it("preserves a legacy idle timeout above Node's timer limit", async () => {
    const thirtyDaysInSeconds = 30 * 24 * 60 * 60;
    vi.stubEnv("IDLE_TIMEOUT", String(thirtyDaysInSeconds));

    const { loadConfig } = await import("../src/config.js");
    const config = loadConfig();

    expect(config.idleTimeoutMs).toBe(thirtyDaysInSeconds * 1000);
  });

  it("reads the xAI STT key from YA-private module env", async () => {
    vi.stubEnv("YEP_STT_XAI_API_KEY", "xai-key");
    vi.stubEnv("XAI_API_KEY", "ambient-xai-key");

    const { loadConfig } = await import("../src/config.js");
    const config = loadConfig();

    expect(config.xaiSttApiKey).toBe("xai-key");
    expect(config.ambientXaiApiKey).toBe("ambient-xai-key");
    expect(process.env.YEP_STT_XAI_API_KEY).toBeUndefined();
    expect(process.env.XAI_API_KEY).toBeUndefined();
  });

  it("uses and scrubs ambient XAI_API_KEY as an STT fallback", async () => {
    vi.stubEnv("XAI_API_KEY", "ambient-xai-key");

    const { loadConfig } = await import("../src/config.js");
    const config = loadConfig();

    expect(config.xaiSttApiKey).toBe("ambient-xai-key");
    expect(config.ambientXaiApiKey).toBe("ambient-xai-key");
    expect(process.env.XAI_API_KEY).toBeUndefined();
  });

  it("requires explicit opt-in before sharing xAI STT keys with clients", async () => {
    vi.stubEnv("YEP_STT_XAI_API_KEY", "xai-key");

    const { loadConfig } = await import("../src/config.js");
    const config = loadConfig();

    expect(config.xaiSttApiKey).toBe("xai-key");
    expect(config.shareXaiSttApiKeyWithClients).toBe(false);
  });

  it("parses the xAI STT client key sharing opt-in", async () => {
    vi.stubEnv("YEP_STT_SHARE_XAI_KEY_WITH_CLIENTS", "1");

    const { loadConfig } = await import("../src/config.js");
    const config = loadConfig();

    expect(config.shareXaiSttApiKeyWithClients).toBe(true);
  });
});

describe("loadConfig session wake base URL", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("normalizes an explicitly reachable HTTP(S) base", async () => {
    vi.stubEnv("YEP_SESSION_WAKE_BASE_URL", "https://ya.example/wake-root");
    const { loadConfig } = await import("../src/config.js");

    expect(loadConfig().sessionWakeBaseUrl).toBe(
      "https://ya.example/wake-root/",
    );
  });

  it("rejects a base URL containing credentials", async () => {
    vi.stubEnv("YEP_SESSION_WAKE_BASE_URL", "https://token@ya.example/");
    const { loadConfig } = await import("../src/config.js");

    expect(() => loadConfig()).toThrow("YEP_SESSION_WAKE_BASE_URL");
  });

  it("strips inherited parent-session wake capabilities", async () => {
    vi.stubEnv("YEP_SESSION_WAKE_URL", "http://parent.invalid/wake");
    vi.stubEnv("YEP_SESSION_WAKE_TOKEN", "parent-token");
    const { loadConfig } = await import("../src/config.js");

    loadConfig();

    expect(process.env.YEP_SESSION_WAKE_URL).toBeUndefined();
    expect(process.env.YEP_SESSION_WAKE_TOKEN).toBeUndefined();
  });
});

describe("loadConfig authentication credentials", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("consumes auth credentials before provider processes can inherit them", async () => {
    vi.stubEnv("AUTH_COOKIE_SECRET", "cookie-secret");
    vi.stubEnv("DESKTOP_AUTH_TOKEN", "desktop-token");
    const { loadConfig } = await import("../src/config.js");

    const config = loadConfig();

    expect(config.authCookieSecret).toBe("cookie-secret");
    expect(config.desktopAuthToken).toBe("desktop-token");
    expect(process.env.AUTH_COOKIE_SECRET).toBeUndefined();
    expect(process.env.DESKTOP_AUTH_TOKEN).toBeUndefined();
  });
});
