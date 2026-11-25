#!/usr/bin/env node

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createProviderHostSourceIdentity,
  discoverProviderHost,
  finishLegacyProviderHostMigration,
  recoverProviderHost,
  resolveProviderHostPaths,
} from "./provider-runtime-discovery.mjs";
import { providerHostCapability } from "./provider-process-identity.mjs";
import { resolveProviderRuntimeWorkerPath } from "./provider-runtime-host.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const rootDir = join(scriptDir, "..");
const hostEntrypoint = join(scriptDir, "provider-runtime-host.mjs");
const devEntrypoint = join(scriptDir, "dev.js");

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function expectedIdentity(projectRoot, env) {
  return createProviderHostSourceIdentity({
    projectRoot,
    launcherPath: devEntrypoint,
    hostPath: hostEntrypoint,
    workerPath: resolveProviderRuntimeWorkerPath(env),
    env,
  });
}

async function waitForAvailable(paths, identity, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  let discovery = await discoverProviderHost(paths, {
    expectedIdentity: identity,
  });
  while (
    (discovery.state === "absent" || discovery.state === "unresponsive") &&
    Date.now() < deadline
  ) {
    await delay(50);
    discovery = await discoverProviderHost(paths, {
      expectedIdentity: identity,
    });
  }
  return discovery;
}

/**
 * Attach to a compatible same-host provider host, or start one when absent.
 */
export async function attachOrStartProviderHost({
  env = process.env,
  projectRoot = rootDir,
} = {}) {
  const capability = providerHostCapability();
  if (!capability.supported)
    return { state: "unsupported", error: capability.reason };
  const paths = resolveProviderHostPaths({
    ...env,
    YEP_PROVIDER_HOST_RUNTIME_DIR:
      env.YEP_PROVIDER_HOST_RUNTIME_DIR?.trim() || env.YEP_PROVIDER_RUNTIME_DIR,
  });
  if (!paths) return { state: "unsupported" };

  const identity = expectedIdentity(projectRoot, env);
  let discovery = await discoverProviderHost(paths, {
    expectedIdentity: identity,
  });
  if (discovery.state === "available") {
    return { state: "attached", paths, discovery };
  }
  if (discovery.state === "unresponsive") {
    const recovery = await recoverProviderHost(paths, discovery.descriptor);
    discovery = await discoverProviderHost(paths, {
      expectedIdentity: identity,
    });
    if (discovery.state === "available") {
      return { state: "attached", paths, discovery, recovery };
    }
  }
  if (discovery.state !== "absent") {
    return {
      state: "failed",
      paths,
      discovery,
      error: `Provider runtime host is ${discovery.state}${
        discovery.error ? `: ${discovery.error}` : ""
      }`,
    };
  }
  await finishLegacyProviderHostMigration(paths.legacyPaths);

  const hostEnvironment = {
    ...env,
    YEP_PROVIDER_HOST_RUNTIME_DIR: paths.runtimeDir,
    YEP_PROVIDER_RUNTIME_DIR: paths.runtimeDir,
    YEP_PROVIDER_RUNTIME_SOCKET: paths.controlSocketPath,
    YEP_PROVIDER_RUNTIME_DESCRIPTOR: paths.descriptorPath,
    YEP_PROVIDER_RUNTIME_TOKEN_FILE: paths.tokenPath,
    YEP_PROVIDER_RUNTIME_LOCK: paths.lockPath,
    YEP_PROVIDER_RUNTIME_RECOVERY_LOCK: paths.recoveryLockPath,
    YEP_PROVIDER_RUNTIME_RECEIPTS: paths.receiptPath,
  };
  delete hostEnvironment.YEP_PROVIDER_RUNTIME_TOKEN;

  const launcherOwned = process.platform === "darwin";
  const host = spawn(
    process.execPath,
    [hostEntrypoint, ...(launcherOwned ? [] : ["--headless"])],
    {
      cwd: projectRoot,
      env: hostEnvironment,
      detached: true,
      stdio: launcherOwned
        ? ["ignore", "inherit", "inherit", "ipc"]
        : ["ignore", "inherit", "inherit"],
      shell: false,
    },
  );
  host.on("error", () => {}); // Report bounded discovery failure below.
  host.unref();
  host.channel?.unref();

  discovery = await waitForAvailable(paths, identity);
  if (discovery.state === "available") {
    return {
      state:
        discovery.descriptor.owner.pid === host.pid ? "started" : "attached",
      paths,
      discovery,
    };
  }

  const concurrent = await waitForAvailable(paths, identity);
  if (concurrent.state === "available") {
    return {
      // The first discovery window can expire while our own macOS host is
      // still booting. Its later arrival keeps this launcher's IPC lease.
      state:
        concurrent.descriptor.owner.pid === host.pid ? "started" : "attached",
      paths,
      discovery: concurrent,
    };
  }

  return {
    state: "failed",
    paths,
    discovery,
    error: `Provider runtime host did not become usable (${discovery.state}${
      discovery.error ? `: ${discovery.error}` : ""
    })`,
  };
}
