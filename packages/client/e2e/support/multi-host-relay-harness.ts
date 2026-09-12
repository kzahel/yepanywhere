import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { configureRemoteAccess, waitForRelayStatus } from "../fixtures.js";
import {
  startYaServerProcess,
  stopYaServerProcess,
  type YaServerProcess,
  type StartYaServerProcessOptions,
} from "./ya-server-process.js";

export interface MultiHostRelayTarget {
  displayName: string;
  expectedFixtureText: string;
  password: string;
  server: YaServerProcess;
  username: string;
}

export interface MultiHostRelayHarness {
  hosts: MultiHostRelayTarget[];
  projectId: string;
  projectPath: string;
  relayUrl: string;
  sessionId: string;
  formatOutput(): string;
  stop(): void;
  waitForWaitingHosts(): Promise<void>;
}

export interface StartMultiHostRelayHarnessOptions {
  setupProfile?: StartYaServerProcessOptions["setupProfile"];
  relayUrl: string;
  testRoot: string;
}

const PROFILE_NAMES = ["alpha", "beta", "gamma"] as const;

function formatServerOutput(host: MultiHostRelayTarget): string {
  const output = [...host.server.output.stderr, ...host.server.output.stdout]
    .join("")
    .trim();
  return output ? `[${host.displayName}]\n${output}` : "";
}

export async function startMultiHostRelayHarness(
  options: StartMultiHostRelayHarnessOptions,
): Promise<MultiHostRelayHarness> {
  const runId = randomUUID().slice(0, 8);
  const projectPath = join(options.testRoot, "multi-host-collision-project");
  const projectId = Buffer.from(projectPath).toString("base64url");
  const sessionId = "multi-host-shared-session";
  const password = `multi-host-${runId}-password`;

  const starts = await Promise.allSettled(
    PROFILE_NAMES.map((profile) =>
      startYaServerProcess({
        label: `multi-host ${profile}`,
        setupProfile: options.setupProfile,
        tempPrefix: `ya-multi-host-${profile}-`,
        mockClaudeSession: {
          content: `${profile[0]?.toUpperCase()}${profile.slice(1)} previous message`,
          projectPath,
          sessionId,
        },
      }),
    ),
  );
  const startedServers = starts.flatMap((result) =>
    result.status === "fulfilled" ? [result.value] : [],
  );
  const failedStart = starts.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (failedStart) {
    for (const server of startedServers) stopYaServerProcess(server);
    throw failedStart.reason;
  }

  const hosts = startedServers.map((server, index) => {
    const profile = PROFILE_NAMES[index];
    if (!profile) {
      throw new Error(`Missing profile name for server ${index}`);
    }
    return {
      displayName: profile[0].toUpperCase() + profile.slice(1),
      expectedFixtureText: `${profile[0].toUpperCase()}${profile.slice(1)} previous message`,
      password,
      server,
      username: `e2e-${profile}-${runId}`,
    };
  });

  try {
    await Promise.all(
      hosts.map((host) =>
        configureRemoteAccess(host.server.baseUrl, {
          username: host.username,
          password: host.password,
          relayUrl: options.relayUrl,
        }),
      ),
    );
    await Promise.all(
      hosts.map((host) =>
        waitForRelayStatus(host.server.baseUrl, "waiting", 15_000),
      ),
    );
  } catch (error) {
    for (const host of hosts) stopYaServerProcess(host.server);
    throw error;
  }

  let stopped = false;
  return {
    hosts,
    projectId,
    projectPath,
    relayUrl: options.relayUrl,
    sessionId,
    formatOutput: () =>
      hosts.map(formatServerOutput).filter(Boolean).join("\n"),
    stop: () => {
      if (stopped) return;
      stopped = true;
      for (const host of hosts) stopYaServerProcess(host.server);
    },
    waitForWaitingHosts: () =>
      Promise.all(
        hosts.map((host) =>
          waitForRelayStatus(host.server.baseUrl, "waiting", 15_000),
        ),
      ).then(() => undefined),
  };
}
