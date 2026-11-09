import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import {
  parseClaudeAdditionalModelSelections,
  type ProviderInfo,
} from "@yep-anywhere/shared";
import { loadConfig } from "../src/config.js";
import { readStoredMetadata } from "../src/metadata/session-metadata-rows.js";
import { initLogger } from "../src/logging/logger.js";
import { createProvidersRoutes } from "../src/routes/providers.js";
import { ClaudeGatewayProvider } from "../src/sdk/providers/claude-gateway.js";
import { ClaudeOllamaProvider } from "../src/sdk/providers/claude-ollama.js";
import { grokACPProvider } from "../src/sdk/providers/grok-acp.js";
import {
  configureProviderRuntime,
  getAllProviders,
} from "../src/sdk/providers/index.js";
import type { AgentProvider } from "../src/sdk/providers/types.js";
import type { ServerSettings } from "../src/services/ServerSettingsService.js";
import {
  loadSqliteDriver,
  type SqliteDatabase,
} from "../src/storage/sqlite.js";

const DEFAULT_SAMPLES = 5;
const MAX_SUPPORTED_SERVER_SETTINGS_VERSION = 2;

const benchmarkConsole = {
  log: console.log.bind(console),
  error: console.error.bind(console),
  warn: console.warn.bind(console),
  info: console.info.bind(console),
  debug: console.debug.bind(console),
};
let suppressedDiagnostics = 0;

function suppressProviderDiagnostics(): void {
  initLogger({
    consoleLevel: "silent",
    fileLevel: "silent",
    logToFile: false,
    prettyPrint: false,
  });
  const suppress = (..._args: unknown[]) => {
    suppressedDiagnostics += 1;
  };
  console.log = suppress;
  console.error = suppress;
  console.warn = suppress;
  console.info = suppress;
  console.debug = suppress;
}

function restoreConsole(): void {
  console.log = benchmarkConsole.log;
  console.error = benchmarkConsole.error;
  console.warn = benchmarkConsole.warn;
  console.info = benchmarkConsole.info;
  console.debug = benchmarkConsole.debug;
}

interface ProbeCounts {
  auth: number;
  models: number;
}

interface Measurement {
  durationMs: number;
  models: number;
  probes: ProbeCounts;
}

function readSampleCount(): number {
  const configured = process.env.YA_PROVIDER_BENCHMARK_SAMPLES;
  if (!configured) return DEFAULT_SAMPLES;
  const parsed = Number.parseInt(configured, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error("YA_PROVIDER_BENCHMARK_SAMPLES must be a positive integer");
  }
  return parsed;
}

function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

export async function readPersistedServerSettings(
  dataDir: string,
): Promise<Partial<ServerSettings>> {
  try {
    const parsed = JSON.parse(
      await readFile(join(dataDir, "server-settings.json"), "utf8"),
    ) as { version?: unknown; settings?: unknown };
    if (
      typeof parsed.version !== "number" ||
      !Number.isInteger(parsed.version) ||
      parsed.version < 1 ||
      parsed.version > MAX_SUPPORTED_SERVER_SETTINGS_VERSION ||
      !parsed.settings ||
      typeof parsed.settings !== "object" ||
      Array.isArray(parsed.settings)
    ) {
      throw new Error("invalid settings state");
    }
    return parsed.settings as Partial<ServerSettings>;
  } catch (error) {
    if (isMissingFile(error)) return {};
    throw new Error("Provider benchmark settings are unreadable");
  }
}

export function readOptionalStringSetting(
  settings: Partial<ServerSettings>,
  key: keyof ServerSettings,
): string | undefined {
  const value = settings[key] as unknown;
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new Error("Provider benchmark settings are invalid");
  }
  return value;
}

export function readOptionalBooleanSetting(
  settings: Partial<ServerSettings>,
  key: keyof ServerSettings,
): boolean | undefined {
  const value = settings[key] as unknown;
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw new Error("Provider benchmark settings are invalid");
  }
  return value;
}

export async function persistedMetadataIncludesProvider(
  dataDir: string,
  providerName: string,
): Promise<boolean> {
  // Read without opening through the server's startup path, so a benchmark
  // never migrates or imports into the data directory it inspects.
  const file = join(dataDir, "discovery.sqlite");
  if (!existsSync(file)) return false;
  const driver = loadSqliteDriver();
  if (!driver) throw new Error("Provider benchmark metadata is unreadable");
  let database: SqliteDatabase | undefined;
  try {
    database = driver.open(file);
    database.exec("PRAGMA busy_timeout = 250");
    if (
      !database
        .prepare("SELECT 1 AS imported FROM session_metadata_import")
        .get()
    ) {
      throw new Error("session metadata not imported yet");
    }
    return [...readStoredMetadata(database).values()].some((record) => {
      const metadata = record as unknown;
      if (
        !metadata ||
        typeof metadata !== "object" ||
        Array.isArray(metadata)
      ) {
        throw new Error("invalid metadata record");
      }
      const provider = (metadata as { provider?: unknown }).provider;
      if (provider !== undefined && typeof provider !== "string") {
        throw new Error("invalid metadata provider");
      }
      return provider === providerName;
    });
  } catch {
    throw new Error(
      "Provider benchmark metadata is unreadable; start the server once to migrate it",
    );
  } finally {
    database?.close();
  }
}

async function initializeProductionProviders(): Promise<string[] | undefined> {
  const config = loadConfig();
  const [settings, hasClaudeOllamaMetadata] = await Promise.all([
    readPersistedServerSettings(config.dataDir),
    persistedMetadataIncludesProvider(config.dataDir, "claude-ollama"),
  ]);

  const claudeGatewayUrl = readOptionalStringSetting(
    settings,
    "claudeGatewayUrl",
  );
  // Validate configured provider state even though autostart is deliberately off.
  readOptionalStringSetting(settings, "claudeGatewayStartCommand");
  const ollamaUrl = readOptionalStringSetting(settings, "ollamaUrl");
  const ollamaSystemPrompt = readOptionalStringSetting(
    settings,
    "ollamaSystemPrompt",
  );
  const ollamaUseFullSystemPrompt =
    readOptionalBooleanSetting(settings, "ollamaUseFullSystemPrompt") ?? false;
  const grokBuildUseXaiApiKey =
    readOptionalBooleanSetting(settings, "grokBuildUseXaiApiKey") ?? false;
  const claudeAdditionalModels =
    settings.claudeAdditionalModels === undefined
      ? undefined
      : parseClaudeAdditionalModelSelections(settings.claudeAdditionalModels);
  if (claudeAdditionalModels === null) {
    throw new Error("Provider benchmark settings are invalid");
  }

  // The benchmark may probe an already-running Gateway, but must never start
  // the operator's configured command or inherit its stdout/stderr.
  await ClaudeGatewayProvider.configureGateway({
    url: claudeGatewayUrl,
  });
  if (ollamaUrl) ClaudeOllamaProvider.setOllamaUrl(ollamaUrl);
  ClaudeOllamaProvider.setSystemPrompt(ollamaSystemPrompt);
  ClaudeOllamaProvider.setUseFullSystemPrompt(ollamaUseFullSystemPrompt);
  grokACPProvider.setAmbientXaiApiKey(config.ambientXaiApiKey);
  grokACPProvider.setUseAmbientXaiApiKey(grokBuildUseXaiApiKey);

  configureProviderRuntime({
    codexCliPath: config.codexCliPath,
    getClaudeAdditionalModels: () => claudeAdditionalModels,
    isClaudeOllamaVisible: () =>
      ClaudeOllamaProvider.isExplicitlyConfigured() ||
      Boolean(ollamaSystemPrompt || ollamaUseFullSystemPrompt) ||
      hasClaudeOllamaMetadata,
    getProviderRuntimeSnapshot: () => ({
      codexCliPath: config.codexCliPath,
      claudeAdditionalModels,
      claudeGatewayUrl,
      // Never pass the configured start command into a benchmark worker.
      claudeGatewayStartCommand: undefined,
      ollamaUrl,
      ollamaSystemPrompt,
      ollamaUseFullSystemPrompt,
      ambientXaiApiKey: config.ambientXaiApiKey,
      grokBuildUseXaiApiKey,
    }),
  });

  return config.enabledProviders.length > 0
    ? config.enabledProviders
    : undefined;
}

function percentile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(sorted.length * fraction) - 1);
  return sorted[index] ?? 0;
}

function instrumentProvider(
  provider: AgentProvider,
  counts: Map<string, ProbeCounts>,
): AgentProvider {
  return new Proxy(provider, {
    get(target, property) {
      if (property === "getAuthStatus") {
        return async () => {
          const providerCounts = counts.get(target.name) ?? {
            auth: 0,
            models: 0,
          };
          providerCounts.auth += 1;
          counts.set(target.name, providerCounts);
          return target.getAuthStatus();
        };
      }
      if (property === "getAvailableModels") {
        return async () => {
          const providerCounts = counts.get(target.name) ?? {
            auth: 0,
            models: 0,
          };
          providerCounts.models += 1;
          counts.set(target.name, providerCounts);
          return target.getAvailableModels();
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function sumProbes(counts: ReadonlyMap<string, ProbeCounts>): ProbeCounts {
  let auth = 0;
  let models = 0;
  for (const value of counts.values()) {
    auth += value.auth;
    models += value.models;
  }
  return { auth, models };
}

async function measure(
  path: string,
  enabledProviders: string[] | undefined,
): Promise<Measurement> {
  const counts = new Map<string, ProbeCounts>();
  const providers = getAllProviders().map((provider) =>
    instrumentProvider(provider, counts),
  );
  const routes = createProvidersRoutes({
    providers,
    enabledProviders,
  });
  const startedAt = performance.now();
  const response = await routes.request(path);
  const durationMs = performance.now() - startedAt;
  if (!response.ok) {
    throw new Error(`${path} returned ${response.status}`);
  }
  const body = (await response.json()) as
    | { providers: ProviderInfo[] }
    | { provider: ProviderInfo };
  const rows = "providers" in body ? body.providers : [body.provider];
  return {
    durationMs,
    models: rows.reduce((total, row) => total + (row.models?.length ?? 0), 0),
    probes: sumProbes(counts),
  };
}

function report(
  label: string,
  samples: readonly Measurement[],
  extra: readonly string[] = [],
): void {
  const durations = samples.map((sample) => sample.durationMs);
  benchmarkConsole.log(
    [
      label,
      `samples=${samples.length}`,
      `median_ms=${percentile(durations, 0.5).toFixed(2)}`,
      `p90_ms=${percentile(durations, 0.9).toFixed(2)}`,
      `models_last=${samples.at(-1)?.models ?? 0}`,
      `auth_probes_total=${samples.reduce((sum, sample) => sum + sample.probes.auth, 0)}`,
      `model_probes_total=${samples.reduce((sum, sample) => sum + sample.probes.models, 0)}`,
      ...extra,
    ].join(" "),
  );
}

async function main(): Promise<void> {
  suppressProviderDiagnostics();
  const sampleCount = readSampleCount();
  const enabledProviders = await initializeProductionProviders();
  const providerNames = getAllProviders()
    .filter(
      (provider) =>
        !enabledProviders || enabledProviders.includes(provider.name),
    )
    .map((provider) => provider.name);

  const aggregateSamples: Measurement[] = [];
  for (let sample = 0; sample < sampleCount; sample += 1) {
    aggregateSamples.push(await measure("/?refresh=1", enabledProviders));
  }
  report("PROVIDER_MODEL_ROUTE:", aggregateSamples, [
    `providers=${providerNames.length}`,
  ]);

  for (const providerName of providerNames) {
    const samples: Measurement[] = [];
    for (let sample = 0; sample < sampleCount; sample += 1) {
      samples.push(
        await measure(`/${providerName}?refresh=1`, enabledProviders),
      );
    }
    report("PROVIDER_MODEL_ROUTE_PROVIDER:", samples, [
      `provider=${providerName}`,
    ]);
  }
  benchmarkConsole.log(
    `PROVIDER_MODEL_ROUTE_DIAGNOSTICS: suppressed=${suppressedDiagnostics}`,
  );
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  void main().then(
    () => restoreConsole(),
    () => {
      restoreConsole();
      benchmarkConsole.error("PROVIDER_MODEL_ROUTE_ERROR: benchmark_failed");
      process.exitCode = 1;
    },
  );
}
