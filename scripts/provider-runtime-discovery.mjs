import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import ts from "typescript";
import { parseBoundRuntimeIdentity } from "../packages/server/src/sdk/providers/bound-runtime-identity.mjs";

import {
  assertProviderSocketPath,
  captureProcessIdentity,
  processIdentityState,
  processGroupIdentityState,
  providerHostCapability,
} from "./provider-process-identity.mjs";
export {
  captureProcessIdentity,
  readLinuxProcessStartTime,
  readProcessStartTime,
} from "./provider-process-identity.mjs";

export const PROVIDER_HOST_PROTOCOL_VERSION = 3;
export const PROVIDER_HOST_DESCRIPTOR_VERSION = 1;

const DEFAULT_STATUS_TIMEOUT_MS = 1_000;
const MAX_STATUS_RESPONSE_BYTES = 64 * 1024;
const TERM_GRACE_MS = 1_500;
const KILL_VERIFY_MS = 1_000;
const RECENT_RUNTIME_SCHEMA_VERSION = 1;
const RECENT_RUNTIME_MAX_AGE_MS = 5 * 60_000;
const MAX_RECENT_RUNTIME_BYTES = 1024 * 1024;
const MAX_RECENT_RUNTIMES = 1_000;
const PROVIDER_HOST_SOURCE_IDENTITY_VERSION = 1;
const SOURCE_RESOLUTION_PATHS = [
  "package.json",
  "pnpm-lock.yaml",
  "tsconfig.base.json",
  "packages/server/package.json",
  "packages/server/tsconfig.json",
  "packages/shared/package.json",
  "packages/shared/tsconfig.json",
  "packages/server/src/projects/project-service-worker.ts",
];

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function currentUid() {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

function assertPrivateOwnedPath(path, expectedType) {
  const stat = lstatSync(path);
  const uid = currentUid();
  if (uid !== undefined && stat.uid !== uid) {
    throw new Error(`Provider host path is not owned by uid ${uid}: ${path}`);
  }
  if (expectedType === "directory" ? !stat.isDirectory() : !stat.isFile()) {
    throw new Error(`Provider host path is not a ${expectedType}: ${path}`);
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new Error(`Provider host path is not private: ${path}`);
  }
  return stat;
}

export function resolveProviderHostPaths(
  env = process.env,
  { platform = process.platform, uid = currentUid() } = {},
) {
  if (!providerHostCapability({ platform, probe: false }).supported)
    return null;
  const explicit = env.YEP_PROVIDER_HOST_RUNTIME_DIR?.trim();
  const xdgRuntimeDir = env.XDG_RUNTIME_DIR?.trim();
  const runtimeDir = explicit
    ? resolve(explicit)
    : platform === "darwin"
      ? join("/tmp", `yep-anywhere-${uid ?? "user"}`, "provider-host")
      : xdgRuntimeDir
        ? join(resolve(xdgRuntimeDir), "yep-anywhere", "provider-host")
        : join(tmpdir(), `yep-anywhere-${uid ?? "user"}`, "provider-host");
  assertProviderSocketPath(
    join(runtimeDir, "provider-0000000000000000.sock"),
    platform,
  );
  return {
    runtimeDir,
    controlSocketPath: join(runtimeDir, "control.sock"),
    descriptorPath: join(runtimeDir, "host.json"),
    tokenPath: join(runtimeDir, "token"),
    lockPath: join(runtimeDir, "host.lock"),
    recoveryLockPath: join(runtimeDir, "recovery.lock"),
    receiptPath: join(runtimeDir, "turn-receipts.json"),
    recentRuntimePath: join(runtimeDir, "recent-runtimes.json"),
  };
}

export function ensurePrivateProviderHostDirectory(runtimeDir) {
  mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  assertPrivateOwnedPath(runtimeDir, "directory");
  chmodSync(runtimeDir, 0o700);
}

function writePrivateFileAtomic(path, value) {
  ensurePrivateProviderHostDirectory(dirname(path));
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const descriptor = openSync(temporaryPath, "wx", 0o600);
    try {
      writeSync(descriptor, value);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    renameSync(temporaryPath, path);
    chmodSync(path, 0o600);
  } catch (error) {
    removePathIfPresent(temporaryPath);
    throw error;
  }
}

export function createProviderHostToken(tokenPath) {
  const token = randomBytes(32).toString("base64url");
  writePrivateFileAtomic(tokenPath, `${token}\n`);
  return token;
}

export function readProviderHostToken(tokenPath) {
  assertPrivateOwnedPath(tokenPath, "file");
  const token = readFileSync(tokenPath, "utf8").trim();
  if (!token) throw new Error("Provider host token file is empty");
  return token;
}

function parseIdentity(value, label) {
  if (
    !value ||
    typeof value !== "object" ||
    !Number.isInteger(value.pid) ||
    value.pid <= 1 ||
    typeof value.startTime !== "string" ||
    !value.startTime
  ) {
    throw new Error(`Invalid provider host ${label} identity`);
  }
  return { pid: value.pid, startTime: value.startTime };
}

function parseProcessGroup(value) {
  if (
    !value ||
    typeof value !== "object" ||
    !Number.isInteger(value.processGroupId) ||
    value.processGroupId <= 1 ||
    typeof value.leaderStartTime !== "string" ||
    !value.leaderStartTime
  ) {
    throw new Error("Invalid provider host process-group identity");
  }
  return {
    processGroupId: value.processGroupId,
    leaderStartTime: value.leaderStartTime,
  };
}

function parseProviderHostDescriptor(raw, paths) {
  const descriptor = JSON.parse(raw);
  if (
    !descriptor ||
    typeof descriptor !== "object" ||
    descriptor.descriptorVersion !== PROVIDER_HOST_DESCRIPTOR_VERSION ||
    typeof descriptor.descriptorId !== "string" ||
    !descriptor.descriptorId ||
    !Number.isInteger(descriptor.hostProtocolVersion) ||
    !Array.isArray(descriptor.features) ||
    !descriptor.features.every((feature) => typeof feature === "string") ||
    typeof descriptor.controlSocketPath !== "string" ||
    typeof descriptor.tokenFilePath !== "string" ||
    typeof descriptor.startedAt !== "string" ||
    !descriptor.sourceIdentity ||
    typeof descriptor.sourceIdentity !== "object" ||
    typeof descriptor.buildIdentity !== "string"
  ) {
    throw new Error("Invalid provider host descriptor");
  }
  if (
    descriptor.controlSocketPath !== paths.controlSocketPath ||
    descriptor.tokenFilePath !== paths.tokenPath
  ) {
    throw new Error("Provider host descriptor points outside its stable path");
  }
  return {
    ...descriptor,
    owner: parseIdentity(descriptor.owner, "owner"),
    processGroups: Array.isArray(descriptor.processGroups)
      ? descriptor.processGroups.map(parseProcessGroup)
      : [],
  };
}

export function readProviderHostDescriptor(paths) {
  assertPrivateOwnedPath(paths.descriptorPath, "file");
  return parseProviderHostDescriptor(
    readFileSync(paths.descriptorPath, "utf8"),
    paths,
  );
}

export function writeProviderHostDescriptor(paths, descriptor) {
  writePrivateFileAtomic(
    paths.descriptorPath,
    `${JSON.stringify({
      descriptorVersion: PROVIDER_HOST_DESCRIPTOR_VERSION,
      ...descriptor,
    })}\n`,
  );
}

export function readProviderHostReceipts(paths) {
  if (!existsSync(paths.receiptPath)) return [];
  assertPrivateOwnedPath(paths.receiptPath, "file");
  const value = JSON.parse(readFileSync(paths.receiptPath, "utf8"));
  if (!Array.isArray(value)) {
    throw new Error("Invalid provider host receipt store");
  }
  if (
    value.some(
      (receipt) =>
        !receipt ||
        typeof receipt !== "object" ||
        typeof receipt.submissionId !== "string" ||
        typeof receipt.state !== "string",
    )
  ) {
    throw new Error("Invalid provider host receipt record");
  }
  return value;
}

export function writeProviderHostReceipts(paths, receipts) {
  writePrivateFileAtomic(paths.receiptPath, `${JSON.stringify(receipts)}\n`);
}

function requireRecord(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid provider host ${label}`);
  }
  return value;
}

function requireNonemptyString(value, label) {
  if (typeof value !== "string" || !value) {
    throw new Error(`Invalid provider host ${label}`);
  }
  return value;
}

function parseRecentRuntimeCandidate(value) {
  const candidate = requireRecord(value, "recent runtime candidate");
  const target = requireRecord(candidate.target, "recent runtime target");
  const launch = requireRecord(candidate.launch, "recent runtime launch");
  const harness = requireNonemptyString(
    target.harness,
    "recent runtime harness",
  );
  const providerSessionId = requireNonemptyString(
    target.providerSessionId,
    "recent runtime provider session id",
  );
  const yaSessionId =
    target.yaSessionId === undefined
      ? undefined
      : requireNonemptyString(
          target.yaSessionId,
          "recent runtime YA session id",
        );
  const providerName = requireNonemptyString(
    launch.providerName,
    "recent runtime provider name",
  );
  const projectPath = requireNonemptyString(
    launch.projectPath,
    "recent runtime project path",
  );
  const options = requireRecord(
    launch.options ?? {},
    "recent runtime launch options",
  );
  const runtimeConfig = requireRecord(
    launch.runtimeConfig ?? {},
    "recent runtime configuration",
  );
  const reattach = requireRecord(
    launch.reattach ?? {},
    "recent runtime reattach settings",
  );
  const binding =
    launch.binding === undefined
      ? undefined
      : parseBoundRuntimeIdentity(launch.binding);
  if (
    binding &&
    (binding.sessionId !== yaSessionId ||
      binding.native.id !== providerSessionId ||
      binding.native.family !== harness ||
      options.initialMessage !== undefined)
  )
    throw new Error("Invalid provider host recent native continuation");
  return {
    target: {
      harness,
      providerSessionId,
      ...(yaSessionId ? { yaSessionId } : {}),
    },
    launch: {
      providerName,
      projectPath,
      options,
      runtimeConfig,
      reattach,
      ...(binding ? { binding } : {}),
    },
  };
}

export function consumeProviderHostRecentRuntimes(paths, now = Date.now()) {
  if (!existsSync(paths.recentRuntimePath)) return [];
  const consumedPath = `${paths.recentRuntimePath}.${process.pid}.${randomUUID()}.consumed`;
  renameSync(paths.recentRuntimePath, consumedPath);
  try {
    const fileStat = assertPrivateOwnedPath(consumedPath, "file");
    if (fileStat.size > MAX_RECENT_RUNTIME_BYTES) {
      throw new Error("Provider host recent runtime store is too large");
    }
    const raw = readFileSync(consumedPath, "utf8");
    const value = requireRecord(JSON.parse(raw), "recent runtime store");
    if (
      value.version !== RECENT_RUNTIME_SCHEMA_VERSION &&
      value.version !== 2
    ) {
      throw new Error("Invalid provider host recent runtime store version");
    }
    const stoppedAt = Date.parse(value.stoppedAt);
    if (!Number.isFinite(stoppedAt)) {
      throw new Error("Invalid provider host recent runtime stop time");
    }
    const age = now - stoppedAt;
    if (age < 0 || age > RECENT_RUNTIME_MAX_AGE_MS) return [];
    if (
      !Array.isArray(value.candidates) ||
      value.candidates.length > MAX_RECENT_RUNTIMES
    ) {
      throw new Error("Invalid provider host recent runtime candidates");
    }
    const expiresAt = new Date(
      stoppedAt + RECENT_RUNTIME_MAX_AGE_MS,
    ).toISOString();
    return value.candidates.map((candidate) => ({
      ...parseRecentRuntimeCandidate(candidate),
      expiresAt,
    }));
  } finally {
    removePathIfPresent(consumedPath);
  }
}

export function writeProviderHostRecentRuntimes(paths, candidates) {
  if (candidates.length === 0) {
    removePathIfPresent(paths.recentRuntimePath);
    return;
  }
  if (candidates.length > MAX_RECENT_RUNTIMES) {
    throw new Error("Provider host recent runtime store exceeds its bound");
  }
  const value = `${JSON.stringify({
    // Older readers discard unknown launch fields. Mark a scoped recipe so
    // they refuse it instead of silently relaunching it as a legacy worker.
    version: candidates.some((candidate) => candidate.launch?.binding)
      ? 2
      : RECENT_RUNTIME_SCHEMA_VERSION,
    stoppedAt: new Date().toISOString(),
    candidates: candidates.map(parseRecentRuntimeCandidate),
  })}\n`;
  if (Buffer.byteLength(value) > MAX_RECENT_RUNTIME_BYTES) {
    throw new Error(
      "Provider host recent runtime store exceeds its byte bound",
    );
  }
  writePrivateFileAtomic(paths.recentRuntimePath, value);
}

async function waitForIdentityState(readState, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const state = readState();
    if (state !== "same") return state;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return state;
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(25, remaining)),
    );
  }
}

async function terminateOwnedProcess(target, label) {
  const initialState = processIdentityState(target);
  if (initialState === "absent") return;
  if (initialState === "different") {
    throw new Error(`${label} PID identity is ambiguous`);
  }
  try {
    process.kill(target.pid, "SIGTERM");
  } catch (error) {
    if (error?.code === "ESRCH") return;
    throw error;
  }
  const termState = await waitForIdentityState(
    () => processIdentityState(target),
    TERM_GRACE_MS,
  );
  if (termState === "absent") return;
  if (termState === "different") {
    throw new Error(`${label} PID was reused during recovery`);
  }
  try {
    process.kill(target.pid, "SIGKILL");
  } catch (error) {
    if (error?.code === "ESRCH") return;
    throw error;
  }
  const killState = await waitForIdentityState(
    () => processIdentityState(target),
    KILL_VERIFY_MS,
  );
  if (killState !== "absent") {
    throw new Error(`${label} survived verified recovery`);
  }
}

async function terminateOwnedProcessGroup(target) {
  const initialState = processGroupIdentityState(target);
  if (initialState === "absent") return;
  if (initialState === "different") {
    throw new Error(
      `Provider process group ${target.processGroupId} identity is ambiguous`,
    );
  }
  try {
    process.kill(-target.processGroupId, "SIGTERM");
  } catch (error) {
    if (error?.code === "ESRCH") return;
    throw error;
  }
  const termState = await waitForIdentityState(
    () => processGroupIdentityState(target),
    TERM_GRACE_MS,
  );
  if (termState === "absent") return;
  if (termState === "different") {
    throw new Error(
      `Provider process group ${target.processGroupId} was reused during recovery`,
    );
  }
  try {
    process.kill(-target.processGroupId, "SIGKILL");
  } catch (error) {
    if (error?.code === "ESRCH") return;
    throw error;
  }
  const killState = await waitForIdentityState(
    () => processGroupIdentityState(target),
    KILL_VERIFY_MS,
  );
  if (killState !== "absent") {
    throw new Error(
      `Provider process group ${target.processGroupId} survived verified recovery`,
    );
  }
}

function removePathIfPresent(path) {
  try {
    rmSync(path);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function acquireExclusiveRecord(path, record, occupiedMessage) {
  ensurePrivateProviderHostDirectory(dirname(path));
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const descriptor = openSync(path, "wx", 0o600);
      try {
        writeSync(descriptor, `${JSON.stringify(record)}\n`);
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
      const expected = JSON.stringify(record);
      return () => {
        try {
          const current = JSON.stringify(
            JSON.parse(readFileSync(path, "utf8")),
          );
          if (current === expected) removePathIfPresent(path);
        } catch (error) {
          if (error?.code !== "ENOENT") throw error;
        }
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      let existing;
      try {
        assertPrivateOwnedPath(path, "file");
        existing = JSON.parse(readFileSync(path, "utf8"));
      } catch (readError) {
        throw new Error(`${occupiedMessage}: ${errorMessage(readError)}`);
      }
      const identity = parseIdentity(existing, "lock");
      const state = processIdentityState(identity);
      if (state !== "absent") {
        throw new Error(
          state === "same"
            ? occupiedMessage
            : `${occupiedMessage}: lock PID identity is ambiguous`,
        );
      }
      const unchanged =
        readFileSync(path, "utf8") === `${JSON.stringify(existing)}\n`;
      if (!unchanged) throw new Error(`${occupiedMessage}: lock changed`);
      removePathIfPresent(path);
    }
  }
  throw new Error(occupiedMessage);
}

export function acquireProviderHostLock(paths, owner) {
  return acquireExclusiveRecord(
    paths.lockPath,
    owner,
    "A provider host is already starting or running",
  );
}

function acquireProviderHostRecoveryLock(paths) {
  return acquireExclusiveRecord(
    paths.recoveryLockPath,
    captureProcessIdentity(),
    "Provider host recovery is already in progress",
  );
}

function sourceCompilerOptions(projectRoot) {
  const configPath = join(projectRoot, "packages/server/tsconfig.json");
  if (existsSync(configPath)) {
    const config = ts.readConfigFile(configPath, ts.sys.readFile);
    if (config.error) {
      throw new Error(
        `Cannot read provider source TypeScript config: ${ts.flattenDiagnosticMessageText(config.error.messageText, "\n")}`,
      );
    }
    const parsed = ts.parseJsonConfigFileContent(
      config.config,
      ts.sys,
      dirname(configPath),
    );
    if (parsed.errors.length > 0) {
      throw new Error(
        `Cannot parse provider source TypeScript config: ${ts.flattenDiagnosticMessageText(parsed.errors[0].messageText, "\n")}`,
      );
    }
    return {
      ...parsed.options,
      allowJs: true,
      customConditions: [
        ...new Set([...(parsed.options.customConditions ?? []), "source"]),
      ],
      resolveJsonModule: true,
    };
  }
  return {
    allowJs: true,
    customConditions: ["source"],
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    resolveJsonModule: true,
  };
}

function pathWithin(root, candidate) {
  const relativePath = relative(root, candidate);
  return (
    relativePath === "" ||
    (!isAbsolute(relativePath) &&
      relativePath !== ".." &&
      !relativePath.startsWith(`..${sep}`))
  );
}

function resolveLocalSourceImport(
  specifier,
  containingFile,
  projectRoot,
  compilerOptions,
) {
  if (specifier.startsWith("node:")) return null;
  const mustResolveLocally =
    specifier.startsWith(".") ||
    isAbsolute(specifier) ||
    specifier.startsWith("@yep-anywhere/");
  const resolvedModule = ts.resolveModuleName(
    specifier,
    containingFile,
    compilerOptions,
    ts.sys,
  ).resolvedModule;
  if (!resolvedModule) {
    if (mustResolveLocally) {
      throw new Error(
        `Cannot resolve provider source import ${specifier} from ${containingFile}`,
      );
    }
    return null;
  }
  const resolvedPath = realpathSync(resolvedModule.resolvedFileName);
  const projectSource =
    pathWithin(projectRoot, resolvedPath) &&
    !resolvedPath.split(sep).includes("node_modules");
  const relativeSource =
    (specifier.startsWith(".") || isAbsolute(specifier)) &&
    !resolvedPath.split(sep).includes("node_modules");
  return projectSource || relativeSource ? resolvedPath : null;
}

function providerSourceFiles(projectRoot, entryPaths) {
  const compilerOptions = sourceCompilerOptions(projectRoot);
  const pending = entryPaths.map((path) => realpathSync(path));
  for (const relativePath of SOURCE_RESOLUTION_PATHS) {
    const path = join(projectRoot, relativePath);
    if (existsSync(path)) pending.push(realpathSync(path));
  }
  const visited = new Set();
  while (pending.length > 0) {
    const path = pending.pop();
    if (visited.has(path)) continue;
    visited.add(path);
    const source = readFileSync(path);
    for (const imported of ts.preProcessFile(
      source.toString("utf8"),
      true,
      true,
    ).importedFiles) {
      const dependency = resolveLocalSourceImport(
        imported.fileName,
        path,
        projectRoot,
        compilerOptions,
      );
      if (dependency && !visited.has(dependency)) pending.push(dependency);
    }
  }
  return [...visited].sort((left, right) =>
    sourceIdentityPath(projectRoot, left).localeCompare(
      sourceIdentityPath(projectRoot, right),
    ),
  );
}

function sourceIdentityPath(projectRoot, path) {
  if (pathWithin(projectRoot, path)) {
    return relative(projectRoot, path).split(sep).join("/");
  }
  return `external:${path.split(sep).join("/")}`;
}

function sourceDependencyHash(projectRoot, paths) {
  const hash = createHash("sha256");
  for (const path of paths) {
    const label = sourceIdentityPath(projectRoot, path);
    const contents = readFileSync(path);
    hash.update(`${Buffer.byteLength(label)}:${label}:${contents.length}:`);
    hash.update(contents);
  }
  return hash.digest("hex");
}

function hashFile(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function createProviderHostSourceIdentity({
  projectRoot,
  launcherPath,
  hostPath,
  workerPath,
  env = process.env,
}) {
  const canonicalProjectRoot = realpathSync(projectRoot);
  const canonicalLauncherPath = realpathSync(launcherPath);
  const canonicalHostPath = realpathSync(hostPath);
  const canonicalWorkerPath = realpathSync(workerPath);
  const packageJson = JSON.parse(
    readFileSync(join(canonicalProjectRoot, "package.json"), "utf8"),
  );
  const dependencies = providerSourceFiles(canonicalProjectRoot, [
    canonicalLauncherPath,
    canonicalHostPath,
    canonicalWorkerPath,
  ]);
  return {
    sourceIdentity: {
      version: PROVIDER_HOST_SOURCE_IDENTITY_VERSION,
      projectRoot: canonicalProjectRoot,
      launcherSha256: hashFile(canonicalLauncherPath),
      hostSha256: hashFile(canonicalHostPath),
      workerSha256: hashFile(canonicalWorkerPath),
      dependencySha256: sourceDependencyHash(
        canonicalProjectRoot,
        dependencies,
      ),
      dependencyCount: dependencies.length,
    },
    buildIdentity:
      env.YEP_BUILD_ID?.trim() || `${packageJson.version ?? "unknown"}:source`,
  };
}

function stableIdentityJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableIdentityJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableIdentityJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function providerHostIdentityMismatch(descriptor, expectedIdentity) {
  if (
    !expectedIdentity?.sourceIdentity ||
    typeof expectedIdentity.buildIdentity !== "string"
  ) {
    throw new Error(
      "Provider host discovery requires expected source identity",
    );
  }
  if (
    stableIdentityJson(descriptor.sourceIdentity) !==
    stableIdentityJson(expectedIdentity.sourceIdentity)
  ) {
    return "source-identity";
  }
  if (descriptor.buildIdentity !== expectedIdentity.buildIdentity) {
    return "build-identity";
  }
  return null;
}

export function requestProviderHost(
  { controlSocketPath, token, protocolVersion },
  request,
  timeoutMs = DEFAULT_STATUS_TIMEOUT_MS,
) {
  return new Promise((resolveRequest, rejectRequest) => {
    const socket = createConnection(controlSocketPath);
    const requestId = randomUUID();
    socket.setEncoding("utf8");
    let buffer = "";
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      if (error) rejectRequest(error);
      else resolveRequest(value);
    };
    const timeout = setTimeout(
      () => finish(new Error("Provider host status handshake timed out")),
      timeoutMs,
    );
    socket.on("connect", () => {
      socket.write(
        `${JSON.stringify({
          ...request,
          id: requestId,
          token,
          protocolVersion,
        })}\n`,
      );
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (buffer.length > MAX_STATUS_RESPONSE_BYTES) {
        finish(new Error("Provider host status response is too large"));
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      try {
        const response = JSON.parse(buffer.slice(0, newline));
        if (response.id !== requestId) {
          finish(new Error("Provider host status response id does not match"));
          return;
        }
        if (!response.ok) {
          finish(new Error(response.error || "Provider host request failed"));
          return;
        }
        finish(undefined, response.result);
      } catch (error) {
        finish(error);
      }
    });
    socket.on("error", (error) => finish(error));
    socket.on("close", () => {
      if (!settled) finish(new Error("Provider host closed before response"));
    });
  });
}

export async function discoverProviderHost(
  paths,
  { expectedIdentity, timeoutMs = DEFAULT_STATUS_TIMEOUT_MS } = {},
) {
  if (!expectedIdentity) {
    throw new Error(
      "Provider host discovery requires expected source identity",
    );
  }
  let descriptor;
  try {
    if (existsSync(paths.runtimeDir))
      assertPrivateOwnedPath(paths.runtimeDir, "directory");
    if (!existsSync(paths.descriptorPath)) return { state: "absent" };
    descriptor = readProviderHostDescriptor(paths);
  } catch (error) {
    return { state: "ownership-unknown", error: errorMessage(error) };
  }
  if (descriptor.hostProtocolVersion !== PROVIDER_HOST_PROTOCOL_VERSION) {
    return { state: "incompatible", descriptor, incompatibility: "protocol" };
  }
  const identityMismatch = providerHostIdentityMismatch(
    descriptor,
    expectedIdentity,
  );
  if (identityMismatch) {
    return {
      state: "incompatible",
      descriptor,
      incompatibility: identityMismatch,
    };
  }
  try {
    const token = readProviderHostToken(paths.tokenPath);
    const status = await requestProviderHost(
      {
        controlSocketPath: descriptor.controlSocketPath,
        token,
        protocolVersion: descriptor.hostProtocolVersion,
      },
      { op: "status" },
      timeoutMs,
    );
    if (status?.protocolVersion !== PROVIDER_HOST_PROTOCOL_VERSION) {
      return {
        state: "incompatible",
        descriptor,
        status,
        incompatibility: "protocol",
      };
    }
    return { state: "available", descriptor, token, status };
  } catch (error) {
    return {
      state: "unresponsive",
      descriptor,
      error: errorMessage(error),
    };
  }
}

export async function recoverProviderHost(paths, expectedDescriptor) {
  const releaseRecoveryLock = acquireProviderHostRecoveryLock(paths);
  try {
    const current = readProviderHostDescriptor(paths);
    if (current.descriptorId !== expectedDescriptor.descriptorId) {
      throw new Error("Provider host changed before recovery");
    }
    const ownerState = processIdentityState(current.owner);
    if (ownerState === "different") {
      throw new Error("Provider host owner PID identity is ambiguous");
    }
    if (ownerState === "same") {
      await terminateOwnedProcess(current.owner, "Provider host owner");
    }
    for (const target of current.processGroups) {
      await terminateOwnedProcessGroup(target);
    }
    const recoveredAt = new Date().toISOString();
    const receipts = readProviderHostReceipts(paths);
    const interruptedSubmissionIds = [];
    const recoveredReceipts = receipts.map((receipt) => {
      if (receipt.state !== "accepted") return receipt;
      interruptedSubmissionIds.push(receipt.submissionId);
      return {
        ...receipt,
        state: "terminal",
        terminalAt: recoveredAt,
        outcome: "interrupted-by-host-recovery",
        receipt: {
          ...receipt.receipt,
          acceptedAt: receipt.acceptedAt,
          terminalAt: recoveredAt,
        },
      };
    });
    if (interruptedSubmissionIds.length > 0) {
      writeProviderHostReceipts(paths, recoveredReceipts);
    }
    if (existsSync(paths.descriptorPath)) {
      const finalDescriptor = readProviderHostDescriptor(paths);
      if (finalDescriptor.descriptorId !== current.descriptorId) {
        throw new Error("A new provider host appeared during recovery");
      }
    }
    for (const path of [
      paths.controlSocketPath,
      paths.tokenPath,
      paths.descriptorPath,
      paths.lockPath,
      paths.recentRuntimePath,
    ]) {
      removePathIfPresent(path);
    }
    return {
      outcome: "interrupted-by-host-recovery",
      descriptorId: current.descriptorId,
      processGroupCount: current.processGroups.length,
      interruptedSubmissionIds,
    };
  } finally {
    releaseRecoveryLock();
  }
}

export function removeProviderHostArtifacts(paths) {
  for (const path of [
    paths.controlSocketPath,
    paths.tokenPath,
    paths.descriptorPath,
  ]) {
    removePathIfPresent(path);
  }
}
