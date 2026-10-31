#!/usr/bin/env node

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PROVIDER_HOST_PROTOCOL_VERSION,
  acquireProviderHostLock,
  captureProcessIdentity,
  consumeProviderHostRecentRuntimes,
  createProviderHostSourceIdentity,
  createProviderHostToken,
  discoverProviderHost,
  ensurePrivateProviderHostDirectory,
  readProviderHostReceipts,
  recoverProviderHost,
  removeProviderHostArtifacts,
  resolveProviderHostPaths,
  writeProviderHostDescriptor,
  writeProviderHostRecentRuntimes,
  writeProviderHostReceipts,
} from "./provider-runtime-discovery.mjs";
import {
  assertProviderSocketPath,
  readProcessStartTime,
  processGroupAlive as isProcessGroupAlive,
  isOwnedProcessGroupAlive,
  providerHostCapability,
} from "./provider-process-identity.mjs";
import {
  ProviderRuntimeTurnLedger,
  normalizeProviderSessionOptions,
} from "./provider-runtime-turns.mjs";
import { ProviderProjectServices } from "./provider-project-services.mjs";
import { getProviderImageSizing } from "../packages/server/src/services/image-preparation.mjs";

const HOST_PROTOCOL_VERSION = PROVIDER_HOST_PROTOCOL_VERSION;
const WORKER_READY_TIMEOUT_MS = 30_000;
const MAX_CONTROL_REQUEST_BYTES = 1024 * 1024;
const COOPERATIVE_STOP_MS = 5_000;
const TERM_GRACE_MS = 1_500;
const KILL_VERIFY_MS = 1_000;
const DEFAULT_ATTACH_TIMEOUT_MS = 30_000;
const DEFAULT_AUXILIARY_IDLE_TIMEOUT_MS = 60 * 60_000;

const scriptDir = dirname(fileURLToPath(import.meta.url));
const rootDir = join(scriptDir, "..");
const devEntrypoint = join(scriptDir, "dev.js");
const workerEntrypoint = join(
  rootDir,
  "packages/server/src/sdk/providers/provider-runtime-worker.ts",
);

export function resolveProviderRuntimeWorkerPath(env = process.env) {
  const override = env.YEP_PROVIDER_RUNTIME_WORKER_PATH?.trim();
  return override ? resolve(override) : workerEntrypoint;
}

// Launch facts published for the agent itself to read. They carry no product
// prefix on purpose: `filterEnvForChildProcess` drops inherited `YEP_*` from a
// provider child, so a `YEP_`-named marker would reach the worker and vanish
// one process later. See topics/ya-env-vars.md.
const AGENT_LAUNCH_ENV_NAMES = [
  "AGENT_SERVER_URL",
  "AGENT_LAUNCHER",
  "AGENT_LAUNCH_HARNESS",
  "AGENT_LAUNCH_MODEL",
  "AGENT_LAUNCH_EFFORT",
];

// Names these markers used before 2026-08-17. A YA server running inside a
// session an older YA launched would otherwise pass the outer session's stale
// values down as if they described this launch.
const REPLACED_AGENT_LAUNCH_ENV_NAMES = [
  "YEP_AGENT_HARNESS",
  "YEP_AGENT_INITIAL_MODEL",
  "YEP_AGENT_INITIAL_EFFORT",
];

const AGENT_LAUNCHER_NAME = "yepanywhere";

// Copy of `agentHarness` in packages/shared/src/types.ts, which owns the
// mapping: this host runs under plain `node` and cannot import TypeScript.
// packages/server/test/sdk/providers/agent-harness.test.ts fails if they part.
export function agentHarness(providerName) {
  switch (providerName) {
    case "claude-gateway":
    case "claude-ollama":
      return "claude";
    case "codex-oss":
      return "codex";
    case "gemini-acp":
      return "gemini";
    default:
      return providerName;
  }
}

export function withAgentLaunchEnvironment(
  providerName,
  options,
  baseEnvironment = {},
) {
  const environment = { ...baseEnvironment };
  for (const name of AGENT_LAUNCH_ENV_NAMES) delete environment[name];
  for (const name of REPLACED_AGENT_LAUNCH_ENV_NAMES) delete environment[name];

  environment.AGENT_LAUNCHER = AGENT_LAUNCHER_NAME;
  environment.AGENT_LAUNCH_HARNESS = agentHarness(providerName);
  const serverUrl = options?.staticAgentEnvironment?.AGENT_SERVER_URL;
  if (typeof serverUrl === "string" && serverUrl)
    environment.AGENT_SERVER_URL = serverUrl;
  // Prefer the concrete id the server resolved the selection to, so an alias
  // such as "opus" still tells the agent which model version it is.
  const launchModel = options?.launchModel || options?.model;
  const model =
    typeof launchModel === "string" ? launchModel.trim() : undefined;
  const effort =
    typeof options?.effort === "string" ? options.effort.trim() : undefined;
  if (model) environment.AGENT_LAUNCH_MODEL = model;
  if (effort) environment.AGENT_LAUNCH_EFFORT = effort;
  return environment;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function controlError(outcome, message) {
  const error = new Error(message);
  error.outcome = outcome;
  return error;
}

function errorOutcome(error, fallback = "rejected") {
  return error && typeof error === "object" && typeof error.outcome === "string"
    ? error.outcome
    : fallback;
}

function removePathIfPresent(path) {
  if (!existsSync(path)) return;
  try {
    rmSync(path);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function captureProcessGroup(processGroupId) {
  const leaderStartTime = readProcessStartTime(processGroupId);
  if (!leaderStartTime) {
    throw new Error(
      `Cannot capture provider process group ${processGroupId} identity`,
    );
  }
  return { processGroupId, leaderStartTime };
}

async function waitForProcessGroupExit(target, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (isOwnedProcessGroupAlive(target)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    await delay(Math.min(25, remaining));
  }
  return true;
}

function signalProcessGroup(target, signal) {
  if (!isOwnedProcessGroupAlive(target)) return;
  try {
    process.kill(-target.processGroupId, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

async function terminateProcessGroup(target) {
  if (!isOwnedProcessGroupAlive(target)) return;
  signalProcessGroup(target, "SIGTERM");
  if (await waitForProcessGroupExit(target, TERM_GRACE_MS)) return;
  signalProcessGroup(target, "SIGKILL");
  if (!(await waitForProcessGroupExit(target, KILL_VERIFY_MS))) {
    throw new Error(
      `Provider runtime process group ${target.processGroupId} survived SIGKILL`,
    );
  }
}

function publicRuntimeEntry(entry) {
  return {
    hostProtocolVersion: HOST_PROTOCOL_VERSION,
    runtimeId: entry.runtimeId,
    sessionId: entry.sessionId,
    harness: entry.harness,
    providerSessionId: entry.providerSessionId,
    yaSessionId: entry.yaSessionId,
    providerName: entry.providerName,
    projectPath: entry.projectPath,
    socketPath: entry.socketPath,
    pid: entry.pid,
    processGroupId: entry.processGroupId,
    providerProcessGroupIds: [...entry.providerProcessGroups.keys()],
    state: entry.state,
    attachedServerGeneration: entry.attachedServerGeneration,
    startedAt: entry.startedAt,
    unviewedSince: entry.unviewedSince,
    lifecycleCapabilities: { viewerPresence: true },
    detachedAt: entry.detachedAt,
    reattach: entry.reattach,
    worker: entry.workerMetadata,
    imagePreparationProfile: getProviderImageSizing(
      entry.providerName,
      entry.launchRecipe.options.launchModel ??
        entry.launchRecipe.options.model,
    ).profiles.sd,
    acceptsSessionTurns: entry.state !== "closing" && !entry.activeSubmissionId,
  };
}

export class ProviderRuntimeHost {
  constructor({
    runtimeDir,
    controlSocketPath,
    token,
    attachTimeoutMs = DEFAULT_ATTACH_TIMEOUT_MS,
    notifyWrapper = () => {},
    workerPath = workerEntrypoint,
    terminateGroup = terminateProcessGroup,
    publishDescriptor = () => {},
    initialTurnReceipts = [],
    publishTurnReceipts = () => {},
    initialRecentRuntimes = [],
    publishRecentRuntimes = () => {},
  }) {
    this.runtimeDir = runtimeDir;
    this.controlSocketPath = controlSocketPath;
    this.token = token;
    this.attachTimeoutMs = attachTimeoutMs;
    this.sendToWrapper = notifyWrapper;
    this.workerPath = workerPath;
    this.terminateGroup = terminateGroup;
    this.publishDescriptor = publishDescriptor;
    this.runtimes = new Map();
    this.runtimeIdsBySessionId = new Map();
    this.retainedProcessGroups = new Map();
    this.registeredServers = new Map();
    this.appAuthorizations = new Map();
    this.projectServices = new ProviderProjectServices(
      (pid, target) => this.retainOwnedGroup(pid, target),
      (pid) => {
        const target = this.retainedProcessGroups.get(pid);
        if (!target) return true;
        if (isOwnedProcessGroupAlive(target)) return false;
        this.retainedProcessGroups.delete(pid);
        this.refreshDescriptor();
        this.notifyWrapper({
          type: "runtimeExited",
          runtimeId: `provider-resource-${pid}`,
          processGroupIds: [pid],
          processGroups: [target],
          reason: "app exited",
        });
        return true;
      },
      this.terminateGroup,
    );
    this.connections = new Set();
    this.recentRuntimeCandidates = initialRecentRuntimes;
    this.publishRecentRuntimes = publishRecentRuntimes;
    this.server = null;
    this.shuttingDown = null;
    this.turnLedger = new ProviderRuntimeTurnLedger({
      resolveRuntime: (request) => this.resolveTurnRuntime(request),
      initialReceipts: initialTurnReceipts,
      writeReceipts: publishTurnReceipts,
      onTerminal: (runtime, outcome) => {
        if (!runtime?.auxiliaryOwned || runtime.state === "closing") return;
        if (outcome === "uncertain-after-acceptance") {
          void this.terminateRuntime(
            runtime.runtimeId,
            "headless session turn ended without a terminal provider receipt",
          ).catch((error) => {
            process.stderr.write(
              `[ProviderRuntimeHost] Failed to reap uncertain runtime ${runtime.runtimeId}: ${errorMessage(error)}\n`,
            );
          });
          return;
        }
        if (runtime.activeSubmissionId) return;
        this.armAttachDeadline(
          runtime,
          "headless provider runtime stayed idle",
          runtime.auxiliaryIdleTimeoutMs,
        );
      },
    });
  }

  notifyWrapper(message) {
    try {
      this.sendToWrapper(message);
    } catch {
      // Wrapper loss is handled by the inherited IPC disconnect.
    }
  }

  async start() {
    removePathIfPresent(this.controlSocketPath);
    this.server = createServer((socket) => this.handleConnection(socket));
    await new Promise((resolve, reject) => {
      const onError = (error) => {
        this.server?.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        this.server?.off("error", onError);
        resolve();
      };
      this.server.once("error", onError);
      this.server.once("listening", onListening);
      this.server.listen(this.controlSocketPath);
    });
    chmodSync(this.controlSocketPath, 0o600);
    this.refreshDescriptor();
    this.notifyWrapper({
      type: "ready",
      protocolVersion: HOST_PROTOCOL_VERSION,
      controlSocketPath: this.controlSocketPath,
    });
  }

  refreshDescriptor() {
    const processGroups = new Map(this.retainedProcessGroups);
    for (const entry of this.runtimes.values()) {
      processGroups.set(entry.processGroupId, entry.processGroup);
      for (const [processGroupId, target] of entry.providerProcessGroups) {
        processGroups.set(processGroupId, target);
      }
    }
    this.publishDescriptor({ processGroups: [...processGroups.values()] });
  }

  handleConnection(socket) {
    this.connections.add(socket);
    socket.setEncoding("utf8");
    let buffer = "";
    let registeredGeneration = null;

    socket.on("data", (chunk) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > MAX_CONTROL_REQUEST_BYTES) {
        buffer = "";
        socket.end(
          `${JSON.stringify({
            ok: false,
            outcome: "rejected",
            error: "Provider runtime host request exceeds 1 MiB",
          })}\n`,
        );
        return;
      }
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;
        let request;
        try {
          request = JSON.parse(line);
        } catch {
          socket.write(
            `${JSON.stringify({ ok: false, error: "Invalid JSON request" })}\n`,
          );
          continue;
        }
        if (request.op === "projectServiceAuthorization") {
          const pending = this.appAuthorizations.get(request.authorizationId);
          if (pending?.socket === socket) {
            if (request.error) pending.reject(new Error(String(request.error)));
            else pending.resolve();
          }
          continue;
        }
        if (request.op === "sessionTurn") {
          try {
            this.validateRequest(request);
            request.sessionOptions = normalizeProviderSessionOptions(
              request.sessionOptions,
            );
            void this.turnLedger.open(request, socket).catch((error) => {
              socket.end(
                `${JSON.stringify({
                  id: request.id,
                  type: "error",
                  outcome: errorOutcome(error),
                  accepted: false,
                  error: errorMessage(error),
                })}\n`,
              );
            });
          } catch (error) {
            socket.end(
              `${JSON.stringify({
                id: request.id,
                type: "error",
                outcome: errorOutcome(error),
                accepted: false,
                error: errorMessage(error),
              })}\n`,
            );
          }
          continue;
        }
        if (request.op === "awaitSessionTurn") {
          try {
            this.validateRequest(request);
            this.turnLedger.observe(request, socket);
          } catch (error) {
            socket.end(
              `${JSON.stringify({
                id: request.id,
                type: "error",
                outcome: errorOutcome(error),
                accepted: false,
                error: errorMessage(error),
              })}\n`,
            );
          }
          continue;
        }
        void this.handleRequest(request, socket)
          .then((result) => {
            if (request.op === "registerServer" && result?.generation) {
              registeredGeneration = result.generation;
              this.registeredServers.set(result.generation, socket);
            }
            socket.write(
              `${JSON.stringify({ id: request.id, ok: true, result })}\n`,
            );
          })
          .catch((error) => {
            socket.write(
              `${JSON.stringify({
                id: request.id,
                ok: false,
                outcome: errorOutcome(error),
                error: errorMessage(error),
              })}\n`,
            );
          });
      }
    });

    socket.on("close", () => {
      this.connections.delete(socket);
      for (const pending of this.appAuthorizations.values())
        if (pending.socket === socket)
          pending.reject(new Error("App controller disconnected"));
      if (!registeredGeneration) return;
      if (this.registeredServers.get(registeredGeneration) === socket) {
        this.registeredServers.delete(registeredGeneration);
      }
      this.detachGeneration(registeredGeneration);
    });
    socket.on("error", () => {});
  }

  async handleRequest(request, socket) {
    this.validateRequest(request);

    switch (request.op) {
      case "status":
        return {
          protocolVersion: HOST_PROTOCOL_VERSION,
          runtimeCount: this.runtimes.size,
          retainedProcessGroupCount: this.retainedProcessGroups.size,
          shuttingDown: this.shuttingDown !== null,
          features: [
            "runtime-control",
            "session-turn",
            "session-turn-await",
            "session-turn-eventual",
            "session-turn-live-only",
            "session-turn-idle-timeout",
            "recent-runtime-recovery",
            "provider-session-options",
            "project-services",
            "agent-api-revocation",
            "agent-api-management",
            "agent-api-peers",
          ],
        };
      case "registerServer": {
        const generation = this.requireString(request.generation, "generation");
        const current = this.registeredServers.get(generation);
        if (current && current !== socket) {
          throw new Error(
            `Server generation ${generation} is already registered`,
          );
        }
        return { generation, protocolVersion: HOST_PROTOCOL_VERSION };
      }
      case "projectService": {
        const generation = this.requireString(request.generation, "generation");
        if (!this.registeredServers.has(generation) || this.shuttingDown)
          throw new Error(
            "App controller is not registered or host is closing",
          );
        return this.projectServices.request(
          { ...request.service, op: "service" },
          async () => {
            if (!this.registeredServers.has(generation) || socket.destroyed)
              throw new Error("App controller disconnected");
            await this.authorizeProjectService(request.id, socket);
          },
        );
      }
      case "launch":
        return await this.launch(request);
      case "launchOrClaim":
        return await this.launchOrClaim(request);
      case "bind":
        return await this.bind(request);
      case "list":
      case "inventory":
        return [...this.runtimes.values()]
          .filter(
            (entry) =>
              entry.providerSessionId && this.isRuntimeClaimable(entry),
          )
          .map(publicRuntimeEntry);
      case "sessionTurnStatus":
        return this.turnLedger.status(
          this.requireString(request.submissionId, "submissionId"),
        );
      case "revokePeerAgentApi":
      case "revokeAgentApi": {
        const generation = this.requireString(request.generation, "generation");
        if (!this.registeredServers.has(generation))
          throw new Error("App controller is not registered");
        const serverId = this.requireString(request.serverId, "serverId");
        for (const entry of this.runtimes.values()) {
          if (entry.launchRecipe.options.agentApi?.serverId !== serverId)
            continue;
          const peerOnly = request.op === "revokePeerAgentApi";
          if (
            peerOnly &&
            (!entry.launchRecipe.options.agentApi?.management ||
              !entry.launchRecipe.options.agentApi?.peerAccess ||
              entry.launchRecipe.options.agentApi?.peerGrantId !==
                request.grantId)
          )
            continue;
          if (peerOnly) entry.peerAgentApiRevoked = true;
          else entry.agentApiRevoked = true;
          if (entry.child.connected)
            entry.child.send(
              { type: peerOnly ? "revokePeerAgentApi" : "revokeAgentApi" },
              () => {},
            );
        }
        return {};
      }
      case "interruptSessionTurn":
        return this.turnLedger.interrupt(
          this.requireString(request.submissionId, "submissionId"),
        );
      case "claim":
        return this.claim(request);
      case "confirmAttach":
        return this.confirmAttach(request);
      case "setViewerPresence":
        return this.setViewerPresence(request);
      case "release":
        return this.release(request);
      case "retainProcessGroup":
        return this.retainProcessGroup(request);
      case "terminate":
        await this.terminateRuntime(
          this.requireString(request.runtimeId, "runtimeId"),
          "server request",
        );
        return {};
      default:
        throw new Error(
          `Unknown provider runtime host operation: ${request.op}`,
        );
    }
  }

  authorizeProjectService(id, socket) {
    const authorizationId = randomUUID();
    return new Promise((resolve, reject) => {
      const finish = (callback, value) => {
        clearTimeout(timer);
        this.appAuthorizations.delete(authorizationId);
        callback(value);
      };
      const timer = setTimeout(
        () => finish(reject, new Error("App authorization timed out")),
        15_000,
      );
      this.appAuthorizations.set(authorizationId, {
        socket,
        resolve: () => finish(resolve),
        reject: (error) => finish(reject, error),
      });
      socket.write(
        `${JSON.stringify({ id, type: "authorize", authorizationId })}\n`,
      );
    });
  }

  validateRequest(request) {
    if (request?.token !== this.token) {
      throw new Error("Unauthorized provider runtime host request");
    }
    if (typeof request?.op !== "string") {
      throw new Error("Missing provider runtime host operation");
    }
    if (request.protocolVersion !== HOST_PROTOCOL_VERSION) {
      throw controlError(
        "incompatible",
        "Incompatible provider runtime host protocol",
      );
    }
  }

  requireString(value, name) {
    if (typeof value !== "string" || !value.trim()) {
      throw new Error(`Missing ${name}`);
    }
    return value;
  }

  isRuntimeAlive(entry) {
    return isOwnedProcessGroupAlive(entry.processGroup);
  }

  isRuntimeClaimable(entry) {
    return entry.state !== "closing" && this.isRuntimeAlive(entry);
  }

  runtimeForSession(sessionId) {
    const runtimeId = this.runtimeIdsBySessionId.get(sessionId);
    if (!runtimeId) return undefined;
    const entry = this.runtimes.get(runtimeId);
    if (!entry) this.runtimeIdsBySessionId.delete(sessionId);
    return entry;
  }

  matchingTurnRuntimes(target) {
    if (!target || typeof target !== "object") {
      throw new Error("Missing session-turn target");
    }
    const harness = this.requireString(target.harness, "target.harness");
    const providerSessionId = this.requireString(
      target.providerSessionId,
      "target.providerSessionId",
    );
    const yaSessionId =
      typeof target.yaSessionId === "string" && target.yaSessionId
        ? target.yaSessionId
        : undefined;
    const providerMatches = [...this.runtimes.values()].filter(
      (entry) =>
        this.isRuntimeClaimable(entry) &&
        entry.harness === harness &&
        entry.providerSessionId === providerSessionId,
    );
    if (
      yaSessionId &&
      providerMatches.some((entry) => entry.yaSessionId !== yaSessionId)
    ) {
      throw controlError(
        "ownership-unknown",
        "target.yaSessionId does not own the requested provider session",
      );
    }
    return providerMatches;
  }

  matchingRecentRuntimes(target) {
    if (!target || typeof target !== "object") {
      throw new Error("Missing session-turn target");
    }
    const harness = this.requireString(target.harness, "target.harness");
    const providerSessionId = this.requireString(
      target.providerSessionId,
      "target.providerSessionId",
    );
    const yaSessionId =
      typeof target.yaSessionId === "string" && target.yaSessionId
        ? target.yaSessionId
        : undefined;
    const now = Date.now();
    this.recentRuntimeCandidates = this.recentRuntimeCandidates.filter(
      (candidate) => Date.parse(candidate.expiresAt) >= now,
    );
    const providerMatches = this.recentRuntimeCandidates.filter(
      (candidate) =>
        candidate.target.harness === harness &&
        candidate.target.providerSessionId === providerSessionId,
    );
    if (
      yaSessionId &&
      providerMatches.some(
        (candidate) => candidate.target.yaSessionId !== yaSessionId,
      )
    ) {
      throw controlError(
        "ownership-unknown",
        "target.yaSessionId does not own the recent provider runtime",
      );
    }
    return providerMatches;
  }

  forgetRecentRuntime(target) {
    this.recentRuntimeCandidates = this.recentRuntimeCandidates.filter(
      (candidate) =>
        candidate.target.harness !== target.harness ||
        candidate.target.providerSessionId !== target.providerSessionId,
    );
  }

  async resolveTurnRuntime(request) {
    if (
      request.idleTimeoutMs !== undefined &&
      (!Number.isFinite(request.idleTimeoutMs) ||
        request.idleTimeoutMs < 1000 ||
        request.idleTimeoutMs > 86_400_000)
    ) {
      throw new Error("idleTimeoutMs must be between 1000 and 86400000");
    }
    const matches = this.matchingTurnRuntimes(request.target);
    if (matches.length > 1) {
      throw controlError(
        "ownership-unknown",
        "Session-turn target matches multiple provider runtimes",
      );
    }
    if (matches.length === 1) {
      this.forgetRecentRuntime(request.target);
      return matches[0];
    }
    if (request.liveOnly === true) {
      throw controlError(
        "not-alive",
        "No live provider worker matches the requested target",
      );
    }
    if (request.resumeRecentRuntime === true) {
      const recentMatches = this.matchingRecentRuntimes(request.target);
      if (recentMatches.length > 1) {
        throw controlError(
          "ownership-unknown",
          "Session-turn target matches multiple recent provider runtimes",
        );
      }
      if (recentMatches.length === 1) {
        const runtime = await this.launchOrClaim(
          {
            target: recentMatches[0].target,
            launch: {
              ...recentMatches[0].launch,
              idleTimeoutMs: request.idleTimeoutMs,
            },
          },
          true,
        );
        this.forgetRecentRuntime(request.target);
        return runtime;
      }
    }
    if (!request.launch) return null;
    return await this.launchOrClaim(
      {
        target: request.target,
        launch: { ...request.launch, idleTimeoutMs: request.idleTimeoutMs },
      },
      true,
    );
  }

  async launchOrClaim(request, returnEntry = false) {
    const matches = this.matchingTurnRuntimes(request.target);
    if (matches.length > 1) {
      throw controlError(
        "ownership-unknown",
        "Provider target matches multiple runtimes",
      );
    }
    if (matches.length === 1) {
      this.forgetRecentRuntime(request.target);
      return returnEntry ? matches[0] : publicRuntimeEntry(matches[0]);
    }
    const launch = request.launch;
    if (!launch || typeof launch !== "object") return null;
    const providerName = this.requireString(
      launch.providerName,
      "launch.providerName",
    );
    if (agentHarness(providerName) !== request.target.harness) {
      throw new Error("Launch provider does not match the target harness");
    }
    const entry = await this.launch(
      {
        auxiliaryOwned: true,
        auxiliaryIdleTimeoutMs: launch.idleTimeoutMs,
        providerName,
        projectPath: launch.projectPath,
        providerSessionId: request.target.providerSessionId,
        yaSessionId: request.target.yaSessionId,
        sessionId:
          request.target.yaSessionId ?? request.target.providerSessionId,
        options: {
          ...launch.options,
          cwd: launch.projectPath,
          resumeSessionId: request.target.providerSessionId,
        },
        runtimeConfig: launch.runtimeConfig ?? {},
        reattach: launch.reattach ?? {},
      },
      true,
    );
    return returnEntry ? entry : publicRuntimeEntry(entry);
  }

  async launch(request, returnEntry = false) {
    if (this.shuttingDown) {
      throw new Error("Provider runtime host is shutting down");
    }
    const auxiliaryOwned = request.auxiliaryOwned === true;
    const generation = auxiliaryOwned
      ? undefined
      : this.requireString(request.generation, "generation");
    if (generation && !this.registeredServers.has(generation)) {
      throw new Error(`Server generation ${generation} is not registered`);
    }
    const providerName = this.requireString(
      request.providerName,
      "providerName",
    );
    const projectPath = this.requireString(request.projectPath, "projectPath");
    const sessionId =
      typeof request.sessionId === "string" && request.sessionId
        ? request.sessionId
        : undefined;
    const providerSessionId =
      typeof request.providerSessionId === "string" && request.providerSessionId
        ? request.providerSessionId
        : sessionId;
    const yaSessionId =
      typeof request.yaSessionId === "string" && request.yaSessionId
        ? request.yaSessionId
        : sessionId;
    if (sessionId) {
      const existing = this.runtimeForSession(sessionId);
      if (existing) {
        if (this.isRuntimeClaimable(existing)) {
          throw new Error(
            `Provider session ${sessionId} already has a runtime`,
          );
        }
        await this.terminateRuntime(
          existing.runtimeId,
          "replace stale provider session runtime",
        );
        if (this.runtimeForSession(sessionId)) {
          throw new Error(
            `Provider session ${sessionId} already has a runtime`,
          );
        }
      }
    }
    const runtimeId = randomUUID();
    const socketPath = join(
      this.runtimeDir,
      `provider-${runtimeId.replaceAll("-", "").slice(0, 16)}.sock`,
    );
    assertProviderSocketPath(socketPath);
    removePathIfPresent(socketPath);

    const options = request.options ?? {};
    const staticAgentEnvironment =
      options.staticAgentEnvironment &&
      typeof options.staticAgentEnvironment === "object" &&
      !Array.isArray(options.staticAgentEnvironment)
        ? options.staticAgentEnvironment
        : {};
    const agentLaunchEnvironment = withAgentLaunchEnvironment(
      providerName,
      options,
      { ...process.env, ...staticAgentEnvironment },
    );
    const { staticAgentEnvironment: _staticAgentEnvironment, ...workerBase } =
      options;
    const workerOptions = {
      ...workerBase,
      browserDebugEnvironment: staticAgentEnvironment,
      remoteEnv: withAgentLaunchEnvironment(providerName, options, {
        ...options.remoteEnv,
        ...staticAgentEnvironment,
      }),
    };

    const child = spawn(
      process.execPath,
      ["--import", "tsx", "--conditions", "source", this.workerPath],
      {
        cwd: rootDir,
        detached: true,
        stdio: ["pipe", "inherit", "inherit", "ipc"],
        env: {
          ...agentLaunchEnvironment,
          YEP_PROVIDER_WORKER_SOCKET: socketPath,
          YEP_PROVIDER_WORKER_TOKEN: this.token,
          YEP_PROVIDER_WORKER_RUNTIME_ID: runtimeId,
        },
        shell: false,
      },
    );
    if (!child.pid || !child.stdin) {
      child.once("error", () => {});
      throw new Error("Provider worker launch returned no PID or input pipe");
    }

    const startedAt = new Date().toISOString();
    const entry = {
      runtimeId,
      sessionId,
      harness: agentHarness(providerName),
      providerSessionId,
      yaSessionId,
      providerName,
      projectPath,
      socketPath,
      pid: child.pid,
      processGroupId: child.pid,
      processGroup: captureProcessGroup(child.pid),
      providerProcessGroups: new Map(),
      child,
      state: "starting",
      attachedServerGeneration: generation,
      auxiliaryOwned,
      controllerAttached: false,
      startedAt,
      unviewedSince: startedAt,
      viewerAttached: false,
      detachedAt: undefined,
      reattach:
        request.reattach && typeof request.reattach === "object"
          ? request.reattach
          : {},
      workerMetadata: undefined,
      attachTimer: null,
      terminationPromise: null,
      activeSubmissionId: undefined,
      auxiliaryIdleTimeoutMs:
        request.auxiliaryIdleTimeoutMs ?? DEFAULT_AUXILIARY_IDLE_TIMEOUT_MS,
      launchRecipe: {
        providerName,
        projectPath,
        options: structuredClone(options),
        runtimeConfig: structuredClone(request.runtimeConfig ?? {}),
        reattach: structuredClone(request.reattach ?? {}),
      },
    };
    this.runtimes.set(runtimeId, entry);
    if (sessionId) this.runtimeIdsBySessionId.set(sessionId, runtimeId);
    this.notifyWrapper({
      type: "runtimeLaunched",
      runtimeId,
      pid: entry.pid,
      processGroupId: entry.processGroupId,
      processGroups: [entry.processGroup],
      providerName,
    });

    child.on("message", (message) => {
      void this.handleWorkerMessage(entry, message).catch((error) => {
        process.stderr.write(
          `[ProviderRuntimeHost] Worker ${runtimeId} sent an invalid lifecycle update: ${errorMessage(error)}\n`,
        );
        void this.terminateRuntime(
          runtimeId,
          "invalid worker lifecycle update",
        ).catch((terminationError) => {
          process.stderr.write(
            `[ProviderRuntimeHost] Failed to reap ${runtimeId}: ${errorMessage(terminationError)}\n`,
          );
        });
      });
    });
    child.on("error", (error) => {
      process.stderr.write(
        `[ProviderRuntime ${runtimeId.slice(0, 8)}] ${errorMessage(error)}\n`,
      );
    });
    child.on("exit", () => {
      void this.handleRuntimeExit(runtimeId);
    });

    try {
      this.refreshDescriptor();
    } catch (error) {
      await this.terminateRuntime(
        runtimeId,
        "provider host descriptor publication failed",
      ).catch(() => {});
      throw error;
    }

    const ready = new Promise((resolve, reject) => {
      const finish = (fn) => {
        clearTimeout(timeout);
        child.off("message", onMessage);
        child.off("exit", onExit);
        fn();
      };
      const onMessage = (message) => {
        if (message?.type === "ready") {
          if (entry.peerAgentApiRevoked && child.connected)
            child.send({ type: "revokePeerAgentApi" }, () => {});
          if (entry.agentApiRevoked && child.connected)
            child.send({ type: "revokeAgentApi" }, () => {});
          finish(() => resolve(message));
        }
        if (message?.type === "startupError") {
          finish(() => reject(new Error(message.error)));
        }
      };
      const onExit = (code, signal) =>
        finish(() =>
          reject(
            new Error(
              `Provider worker exited before ready (code=${code}, signal=${signal})`,
            ),
          ),
        );
      const timeout = setTimeout(
        () =>
          finish(() => reject(new Error("Provider worker startup timed out"))),
        WORKER_READY_TIMEOUT_MS,
      );
      child.on("message", onMessage);
      child.once("exit", onExit);
    });

    child.stdin.end(
      JSON.stringify({
        providerName,
        options: workerOptions,
        runtimeConfig: request.runtimeConfig ?? {},
      }),
    );

    try {
      const readyMessage = await ready;
      entry.workerMetadata = readyMessage.metadata;
      if (
        typeof readyMessage.metadata?.sessionId === "string" &&
        readyMessage.metadata.sessionId
      ) {
        if (
          entry.providerSessionId &&
          entry.providerSessionId !== readyMessage.metadata.sessionId
        ) {
          throw controlError(
            "ownership-unknown",
            "Provider worker resumed a different durable session identity",
          );
        }
        entry.providerSessionId = readyMessage.metadata.sessionId;
      }
      if (
        Number.isInteger(readyMessage.providerPid) &&
        readyMessage.providerPid > 1
      ) {
        this.rememberProviderProcessGroup(entry, readyMessage.providerPid);
      }
      if (entry.auxiliaryOwned) {
        entry.state = "detached";
        entry.detachedAt = new Date().toISOString();
        this.armAttachDeadline(
          entry,
          "headless provider runtime stayed idle",
          entry.auxiliaryIdleTimeoutMs,
        );
      } else {
        this.armAttachDeadline(
          entry,
          entry.sessionId
            ? "provider runtime controller did not attach"
            : "provider runtime identity was not bound",
        );
      }
      if (entry.providerSessionId) {
        this.forgetRecentRuntime({
          harness: entry.harness,
          providerSessionId: entry.providerSessionId,
        });
      }
      return returnEntry ? entry : publicRuntimeEntry(entry);
    } catch (error) {
      await this.terminateRuntime(runtimeId, "launch failure").catch(() => {});
      throw error;
    }
  }

  async handleWorkerMessage(entry, message) {
    if (this.turnLedger.handleWorkerMessage(entry, message)) {
      if (message.type === "sessionTurnAccepted") {
        this.clearAttachDeadline(entry);
      }
      return;
    }
    if (
      message?.type === "retainedProcessGroup" &&
      Number.isInteger(message.processGroupId) &&
      message.processGroupId > 1 &&
      isProcessGroupAlive(message.processGroupId)
    ) {
      const target = captureProcessGroup(message.processGroupId);
      this.retainedProcessGroups.set(message.processGroupId, target);
      this.refreshDescriptor();
      this.notifyWrapper({
        type: "runtimeTargets",
        runtimeId: `provider-resource-${message.processGroupId}`,
        processGroupIds: [message.processGroupId],
        processGroups: [target],
      });
      return;
    }
    if (message?.type === "bound" && typeof message.sessionId === "string") {
      await this.bind({
        runtimeId: entry.runtimeId,
        sessionId: message.sessionId,
        providerSessionId: message.sessionId,
        yaSessionId: message.sessionId,
      });
      return;
    }
    if (
      message?.type === "controllerDetached" &&
      typeof message.generation === "string" &&
      entry.attachedServerGeneration === message.generation
    ) {
      this.release({
        runtimeId: entry.runtimeId,
        generation: message.generation,
      });
      return;
    }
    if (
      message?.type === "providerPid" &&
      Number.isInteger(message.pid) &&
      message.pid > 1
    ) {
      this.rememberProviderProcessGroup(entry, message.pid);
    }
  }

  rememberProviderProcessGroup(entry, processGroupId) {
    try {
      entry.providerProcessGroups.set(
        processGroupId,
        captureProcessGroup(processGroupId),
      );
      this.refreshDescriptor();
      this.notifyRuntimeTargets(entry);
    } catch (error) {
      if (isProcessGroupAlive(processGroupId)) throw error;
    }
  }

  notifyRuntimeTargets(entry) {
    this.notifyWrapper({
      type: "runtimeTargets",
      runtimeId: entry.runtimeId,
      processGroupIds: [
        entry.processGroupId,
        ...entry.providerProcessGroups.keys(),
      ],
      processGroups: [
        entry.processGroup,
        ...entry.providerProcessGroups.values(),
      ],
    });
  }

  async bind(request) {
    const runtimeId = this.requireString(request.runtimeId, "runtimeId");
    const sessionId = this.requireString(request.sessionId, "sessionId");
    const providerSessionId =
      typeof request.providerSessionId === "string" && request.providerSessionId
        ? request.providerSessionId
        : sessionId;
    const yaSessionId =
      typeof request.yaSessionId === "string" && request.yaSessionId
        ? request.yaSessionId
        : sessionId;
    const entry = this.runtimes.get(runtimeId);
    if (!entry || !this.isRuntimeClaimable(entry)) {
      throw new Error(`Unknown or dead provider runtime ${runtimeId}`);
    }
    if (entry.sessionId && entry.sessionId !== sessionId) {
      throw new Error(`Provider runtime ${runtimeId} is already bound`);
    }
    if (
      entry.providerSessionId &&
      entry.providerSessionId !== providerSessionId
    ) {
      throw new Error(`Provider runtime ${runtimeId} has a different identity`);
    }
    const duplicate = this.runtimeForSession(sessionId);
    if (duplicate && duplicate.runtimeId !== runtimeId) {
      if (this.isRuntimeClaimable(duplicate)) {
        throw new Error(`Provider session ${sessionId} already has a runtime`);
      }
      await this.terminateRuntime(
        duplicate.runtimeId,
        "replace stale provider session binding",
      );
    }
    if (!this.isRuntimeClaimable(entry)) {
      throw new Error(`Provider runtime ${runtimeId} ended while binding`);
    }
    const replacement = this.runtimeForSession(sessionId);
    if (replacement && replacement.runtimeId !== runtimeId) {
      throw new Error(`Provider session ${sessionId} already has a runtime`);
    }
    entry.sessionId = sessionId;
    entry.providerSessionId = providerSessionId;
    entry.yaSessionId = yaSessionId;
    this.runtimeIdsBySessionId.set(sessionId, runtimeId);
    if (entry.controllerAttached) {
      entry.state = "attached";
      this.clearAttachDeadline(entry);
    } else if (entry.auxiliaryOwned) {
      entry.state = "detached";
      this.armAttachDeadline(
        entry,
        "headless provider runtime stayed idle",
        entry.auxiliaryIdleTimeoutMs,
      );
    } else {
      entry.state = "starting";
      this.armAttachDeadline(
        entry,
        "provider runtime controller did not attach",
      );
    }
    return publicRuntimeEntry(entry);
  }

  claim(request) {
    const generation = this.requireString(request.generation, "generation");
    const sessionId = this.requireString(request.sessionId, "sessionId");
    if (!this.registeredServers.has(generation)) {
      throw new Error(`Server generation ${generation} is not registered`);
    }
    const entry = this.runtimeForSession(sessionId);
    if (!entry || !this.isRuntimeClaimable(entry)) return null;
    const currentGeneration = entry.attachedServerGeneration;
    if (
      currentGeneration &&
      currentGeneration !== generation &&
      this.registeredServers.has(currentGeneration)
    ) {
      throw new Error(
        `Provider runtime ${entry.runtimeId} is controlled by ${currentGeneration}`,
      );
    }
    this.markViewerDetached(entry);
    entry.auxiliaryOwned = false;
    entry.attachedServerGeneration = generation;
    entry.controllerAttached = false;
    entry.state = "starting";
    entry.detachedAt = undefined;
    this.armAttachDeadline(entry, "claimed provider runtime did not attach");
    return publicRuntimeEntry(entry);
  }

  confirmAttach(request) {
    const runtimeId = this.requireString(request.runtimeId, "runtimeId");
    const generation = this.requireString(request.generation, "generation");
    const entry = this.runtimes.get(runtimeId);
    if (
      !entry ||
      !this.isRuntimeAlive(entry) ||
      entry.attachedServerGeneration !== generation
    ) {
      throw new Error(
        `Provider runtime ${runtimeId} is not claimed by ${generation}`,
      );
    }
    entry.controllerAttached = true;
    if (entry.sessionId) {
      entry.state = "attached";
      this.clearAttachDeadline(entry);
    } else {
      entry.state = "starting";
      this.armAttachDeadline(entry, "provider runtime identity was not bound");
    }
    return publicRuntimeEntry(entry);
  }

  setViewerPresence(request) {
    const runtimeId = this.requireString(request.runtimeId, "runtimeId");
    const generation = this.requireString(request.generation, "generation");
    if (typeof request.hasViewers !== "boolean") {
      throw new Error("Invalid hasViewers");
    }
    const entry = this.runtimes.get(runtimeId);
    if (
      !entry ||
      !this.isRuntimeClaimable(entry) ||
      entry.attachedServerGeneration !== generation
    ) {
      throw new Error(
        `Provider runtime ${runtimeId} is not controlled by ${generation}`,
      );
    }
    if (request.hasViewers) {
      entry.viewerAttached = true;
      entry.unviewedSince = undefined;
    } else {
      entry.viewerAttached = false;
      entry.unviewedSince = new Date().toISOString();
    }
    return publicRuntimeEntry(entry);
  }

  markViewerDetached(entry) {
    if (entry.viewerAttached || !entry.unviewedSince) {
      entry.unviewedSince = new Date().toISOString();
    }
    entry.viewerAttached = false;
  }

  release(request) {
    const runtimeId = this.requireString(request.runtimeId, "runtimeId");
    const generation = this.requireString(request.generation, "generation");
    const entry = this.runtimes.get(runtimeId);
    if (!entry || entry.attachedServerGeneration !== generation) return {};
    if (entry.state === "closing") return {};
    this.markViewerDetached(entry);
    entry.attachedServerGeneration = undefined;
    entry.controllerAttached = false;
    entry.state = "detached";
    entry.detachedAt = new Date().toISOString();
    this.armAttachDeadline(entry, "replacement server did not attach");
    return {};
  }

  retainProcessGroup(request) {
    const generation = this.requireString(request.generation, "generation");
    if (!this.registeredServers.has(generation)) {
      throw new Error(`Server generation ${generation} is not registered`);
    }
    return this.retainOwnedGroup(Number(request.processGroupId));
  }

  retainOwnedGroup(processGroupId, identity) {
    if (!Number.isInteger(processGroupId) || processGroupId <= 1) {
      throw new Error("Invalid retained process group");
    }
    if (identity && !isOwnedProcessGroupAlive(identity))
      return { processGroupId };
    if (!isProcessGroupAlive(processGroupId)) {
      throw new Error(`Process group ${processGroupId} is not alive`);
    }
    const target = identity ?? captureProcessGroup(processGroupId);
    this.retainedProcessGroups.set(processGroupId, target);
    this.refreshDescriptor();
    this.notifyWrapper({
      type: "runtimeTargets",
      runtimeId: `provider-resource-${processGroupId}`,
      processGroupIds: [processGroupId],
      processGroups: [target],
    });
    return { processGroupId };
  }

  detachGeneration(generation) {
    for (const entry of this.runtimes.values()) {
      if (entry.attachedServerGeneration !== generation) continue;
      this.markViewerDetached(entry);
      entry.attachedServerGeneration = undefined;
      entry.controllerAttached = false;
      entry.state = "detached";
      entry.detachedAt = new Date().toISOString();
      this.armAttachDeadline(entry, "server owner disconnected");
    }
  }

  clearAttachDeadline(entry) {
    if (entry.attachTimer) clearTimeout(entry.attachTimer);
    entry.attachTimer = null;
  }

  armAttachDeadline(entry, reason, timeoutMs = this.attachTimeoutMs) {
    this.clearAttachDeadline(entry);
    entry.attachTimer = setTimeout(() => {
      void this.terminateRuntime(entry.runtimeId, reason).catch((error) => {
        process.stderr.write(
          `[ProviderRuntimeHost] Failed to reap ${entry.runtimeId}: ${errorMessage(error)}\n`,
        );
      });
    }, timeoutMs);
  }

  async handleRuntimeExit(runtimeId) {
    try {
      await this.terminateRuntime(runtimeId, "provider worker exited");
    } catch (error) {
      process.stderr.write(
        `[ProviderRuntimeHost] Exit cleanup failed for ${runtimeId}: ${errorMessage(error)}\n`,
      );
    }
  }

  async terminateRuntime(runtimeId, reason) {
    const entry = this.runtimes.get(runtimeId);
    if (!entry) return;
    if (entry.terminationPromise) return await entry.terminationPromise;
    entry.state = "closing";
    this.clearAttachDeadline(entry);
    this.turnLedger.runtimeEnded(entry);
    entry.terminationPromise = (async () => {
      if (entry.child.connected) {
        try {
          entry.child.send({ type: "shutdown", reason });
        } catch {}
      }
      const cooperativeDeadline = Date.now() + COOPERATIVE_STOP_MS;
      while (
        entry.child.exitCode === null &&
        entry.child.signalCode === null &&
        Date.now() < cooperativeDeadline
      ) {
        await delay(25);
      }
      const targets = new Map(entry.providerProcessGroups);
      targets.set(entry.processGroupId, entry.processGroup);
      const results = await Promise.allSettled(
        [...targets.values()].map(this.terminateGroup),
      );
      const failures = results.filter((result) => result.status === "rejected");
      if (failures.length > 0) {
        throw new Error(
          `${failures.length} provider runtime process group(s) survived cleanup`,
        );
      }
      this.finishRuntimeRemoval(entry, reason);
    })();
    const attempt = entry.terminationPromise;
    try {
      return await attempt;
    } finally {
      if (entry.terminationPromise === attempt) entry.terminationPromise = null;
    }
  }

  finishRuntimeRemoval(entry, reason) {
    this.clearAttachDeadline(entry);
    this.runtimes.delete(entry.runtimeId);
    if (
      entry.sessionId &&
      this.runtimeIdsBySessionId.get(entry.sessionId) === entry.runtimeId
    ) {
      this.runtimeIdsBySessionId.delete(entry.sessionId);
    }
    removePathIfPresent(entry.socketPath);
    this.refreshDescriptor();
    this.notifyWrapper({
      type: "runtimeExited",
      runtimeId: entry.runtimeId,
      processGroupIds: [
        entry.processGroupId,
        ...entry.providerProcessGroups.keys(),
      ],
      processGroups: [
        entry.processGroup,
        ...entry.providerProcessGroups.values(),
      ],
      reason,
    });
  }

  async shutdown(reason = "wrapper shutdown") {
    if (this.shuttingDown) return await this.shuttingDown;
    this.shuttingDown = (async () => {
      const recentRuntimeCandidates = [...this.runtimes.values()]
        .filter((entry) => {
          try {
            return entry.providerSessionId && this.isRuntimeClaimable(entry);
          } catch {
            return false;
          } // Cleanup below retains each failed identity.
        })
        .map((entry) => ({
          target: {
            harness: entry.harness,
            providerSessionId: entry.providerSessionId,
            ...(entry.yaSessionId ? { yaSessionId: entry.yaSessionId } : {}),
          },
          launch: entry.launchRecipe,
        }));
      this.turnLedger.shutdown("interrupted");
      const appResults = await Promise.allSettled([
        this.projectServices.close(),
      ]);
      for (const socket of this.registeredServers.values()) socket.destroy();
      this.registeredServers.clear();
      const results = await Promise.allSettled(
        [...this.runtimes.keys()].map((runtimeId) =>
          this.terminateRuntime(runtimeId, reason),
        ),
      );
      const failures = results.filter((result) => result.status === "rejected");
      failures.push(
        ...appResults.filter((result) => result.status === "rejected"),
      );
      const retainedResults = await Promise.allSettled(
        [...this.retainedProcessGroups.values()].map(async (target) => {
          await this.terminateGroup(target);
          this.retainedProcessGroups.delete(target.processGroupId);
        }),
      );
      this.refreshDescriptor();
      failures.push(
        ...retainedResults.filter((result) => result.status === "rejected"),
      );
      for (const socket of this.connections) socket.destroy();
      this.connections.clear();
      if (this.server) {
        await new Promise((resolve) => this.server.close(() => resolve()));
        this.server = null;
      }
      removePathIfPresent(this.controlSocketPath);
      if (failures.length === 0) {
        try {
          this.publishRecentRuntimes(recentRuntimeCandidates);
        } catch (error) {
          process.stderr.write(
            `[ProviderRuntimeHost] Could not preserve recent runtime recipes: ${errorMessage(error)}\n`,
          );
        }
      }
      this.notifyWrapper({
        type: "shutdownComplete",
        ok: failures.length === 0,
        failures: failures.map((failure) => errorMessage(failure.reason)),
      });
      if (failures.length > 0) {
        throw new Error(
          `${failures.length} provider runtime(s) survived shutdown`,
        );
      }
    })();
    return await this.shuttingDown;
  }
}

async function main() {
  const headless = process.argv.includes("--headless");
  const unexpectedArguments = process.argv
    .slice(2)
    .filter((argument) => argument !== "--headless" && argument !== "--help");
  if (unexpectedArguments.length > 0) {
    throw new Error(`Unknown option: ${unexpectedArguments[0]}`);
  }
  if (process.argv.includes("--help")) {
    process.stdout.write(
      "Usage: node scripts/provider-runtime-host.mjs --headless\n\n" +
        "Start the Linux/macOS Node source provider host in the foreground. The stable local\n" +
        "descriptor and private capability token are created automatically.\n",
    );
    return;
  }
  if (!headless && typeof process.send !== "function") {
    throw new Error("Use --headless when starting the provider host directly");
  }
  const capability = providerHostCapability();
  if (!capability.supported) throw new Error(capability.reason);
  const stablePaths = resolveProviderHostPaths();
  if (!stablePaths) {
    throw new Error(
      "The provider runtime host is unavailable on this platform/runtime",
    );
  }
  const runtimeDir =
    process.env.YEP_PROVIDER_RUNTIME_DIR ?? stablePaths.runtimeDir;
  const paths = {
    runtimeDir,
    controlSocketPath:
      process.env.YEP_PROVIDER_RUNTIME_SOCKET ??
      join(runtimeDir, basename(stablePaths.controlSocketPath)),
    descriptorPath:
      process.env.YEP_PROVIDER_RUNTIME_DESCRIPTOR ??
      join(runtimeDir, basename(stablePaths.descriptorPath)),
    tokenPath:
      process.env.YEP_PROVIDER_RUNTIME_TOKEN_FILE ??
      join(runtimeDir, basename(stablePaths.tokenPath)),
    lockPath:
      process.env.YEP_PROVIDER_RUNTIME_LOCK ??
      join(runtimeDir, basename(stablePaths.lockPath)),
    recoveryLockPath:
      process.env.YEP_PROVIDER_RUNTIME_RECOVERY_LOCK ??
      join(runtimeDir, basename(stablePaths.recoveryLockPath)),
    receiptPath:
      process.env.YEP_PROVIDER_RUNTIME_RECEIPTS ??
      join(runtimeDir, basename(stablePaths.receiptPath)),
    recentRuntimePath:
      process.env.YEP_PROVIDER_RUNTIME_RECENT_RUNTIMES ??
      join(runtimeDir, basename(stablePaths.recentRuntimePath)),
  };
  assertProviderSocketPath(paths.controlSocketPath);
  ensurePrivateProviderHostDirectory(paths.runtimeDir);
  const workerPath = resolveProviderRuntimeWorkerPath();
  const identities = createProviderHostSourceIdentity({
    projectRoot: rootDir,
    launcherPath: devEntrypoint,
    hostPath: fileURLToPath(import.meta.url),
    workerPath,
  });
  let discovery = await discoverProviderHost(paths, {
    expectedIdentity: identities,
  });
  if (discovery.state === "available") {
    throw new Error("A provider host is already starting or running");
  }
  if (discovery.state === "unresponsive") {
    const recovery = await recoverProviderHost(paths, discovery.descriptor);
    process.stderr.write(
      `[ProviderRuntimeHost] ${recovery.outcome}: replaced ${recovery.descriptorId}; interrupted submissions=${recovery.interruptedSubmissionIds.length}\n`,
    );
    discovery = await discoverProviderHost(paths, {
      expectedIdentity: identities,
    });
  }
  if (discovery.state !== "absent") {
    throw new Error(
      `Provider host startup stopped at ${discovery.state}${discovery.error ? `: ${discovery.error}` : ""}`,
    );
  }
  const owner = captureProcessIdentity();
  const releaseHostLock = acquireProviderHostLock(paths, owner);
  const descriptorId = randomUUID();
  const startedAt = new Date().toISOString();
  const cleanupStableState = () => {
    removeProviderHostArtifacts(paths);
    releaseHostLock();
  };
  let token;
  let initialTurnReceipts;
  let initialRecentRuntimes = [];
  try {
    token = createProviderHostToken(paths.tokenPath);
    initialTurnReceipts = readProviderHostReceipts(paths);
    try {
      initialRecentRuntimes = consumeProviderHostRecentRuntimes(paths);
    } catch (error) {
      process.stderr.write(
        `[ProviderRuntimeHost] Discarded recent runtime recovery state: ${errorMessage(error)}\n`,
      );
    }
  } catch (error) {
    cleanupStableState();
    throw error;
  }
  const host = new ProviderRuntimeHost({
    runtimeDir: paths.runtimeDir,
    controlSocketPath: paths.controlSocketPath,
    token,
    workerPath,
    initialTurnReceipts,
    initialRecentRuntimes,
    publishTurnReceipts(receipts) {
      writeProviderHostReceipts(paths, receipts);
    },
    publishRecentRuntimes(candidates) {
      writeProviderHostRecentRuntimes(paths, candidates);
    },
    publishDescriptor({ processGroups }) {
      writeProviderHostDescriptor(paths, {
        descriptorId,
        hostProtocolVersion: HOST_PROTOCOL_VERSION,
        features: [
          "runtime-control",
          "session-turn",
          "session-turn-await",
          "session-turn-eventual",
          "session-turn-live-only",
          "session-turn-idle-timeout",
          "recent-runtime-recovery",
          "provider-session-options",
          "agent-api-revocation",
          "agent-api-management",
          "agent-api-peers",
        ],
        controlSocketPath: paths.controlSocketPath,
        tokenFilePath: paths.tokenPath,
        owner,
        startedAt,
        ...identities,
        processGroups,
      });
    },
    notifyWrapper(message) {
      if (typeof process.send === "function" && process.connected) {
        process.send(message);
      }
    },
  });
  let shutdownPromise;
  const shutdown = (reason) => {
    shutdownPromise ??= host
      .shutdown(reason)
      .then(() => {
        cleanupStableState();
        process.exit(0);
      })
      .catch((error) => {
        process.stderr.write(`[ProviderRuntimeHost] ${errorMessage(error)}\n`);
        process.exit(1);
      });
    void shutdownPromise;
  };
  process.on("message", (message) => {
    if (message?.type === "shutdown") shutdown(message.reason);
  });
  if (!headless && typeof process.send === "function") {
    process.on("disconnect", () => shutdown("wrapper IPC closed"));
  }
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGHUP", () => shutdown("terminal SIGHUP"));
  try {
    await host.start();
  } catch (error) {
    cleanupStableState();
    throw error;
  }
  const mode = headless ? "headless" : "wrapper";
  process.stdout.write(
    `[ProviderRuntimeHost] ${mode} host listening at ${basename(paths.controlSocketPath)}\n`,
  );
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    process.stderr.write(`[ProviderRuntimeHost] ${errorMessage(error)}\n`);
    process.exit(1);
  });
}
