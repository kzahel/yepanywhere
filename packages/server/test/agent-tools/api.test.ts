import { spawn } from "node:child_process";
import { get } from "node:http";
import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { agentApiBootstrapInstructions } from "@yep-anywhere/shared";
import { startAgentSelfSession } from "../../src/sdk/providers/agent-self.js";
import { createAgentctlSessionEnvBridge } from "../../src/sdk/providers/agentctl-session-env.js";
import { filterEnvForChildProcess } from "../../src/sdk/providers/env-filter.js";
import { ProviderSessionOwner } from "../../src/sdk/providers/provider-session-owner.js";
import { CoreApi } from "../../src/core-api/service.js";
import { MessageQueue } from "../../src/sdk/messageQueue.js";
import type {
  AgentSession,
  StartSessionOptions,
} from "../../src/sdk/providers/types.js";
import { createControllableIterator } from "../process.test-support.js";

function api(env: Record<string, string>, path: string) {
  return new Promise<{
    status: number;
    body: string;
    json: () => ReturnType<typeof JSON.parse>;
  }>((resolve, reject) => {
    const req = get(
      new URL(path, env.AGENT_YA_V0_URL),
      {
        socketPath: env.AGENT_YA_V0_SOCKET,
        headers: { Authorization: env.AGENT_YA_V0_AUTHORIZATION },
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () =>
          resolve({
            status: response.statusCode!,
            body,
            json: () => JSON.parse(body),
          }),
        );
      },
    );
    req.on("error", reject);
    req.setTimeout(5000, () => req.destroy(new Error("API fixture timed out")));
  });
}
function shell(command: string, env: NodeJS.ProcessEnv) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(
      process.platform === "win32" ? "powershell.exe" : "/bin/sh",
      process.platform === "win32"
        ? ["-NoProfile", "-NonInteractive", "-Command", command]
        : ["-c", command],
      { env, stdio: ["ignore", "pipe", "ignore"], timeout: 10000 },
    );
    let output = "";
    child.stdout.on("data", (data) => {
      output += data;
    });
    child.on("error", () =>
      reject(new Error("Agent shell bootstrap could not start")),
    );
    child.on("exit", (code) =>
      code === 0
        ? resolve(output)
        : reject(new Error(`Agent shell bootstrap exited ${code}`)),
    );
  });
}

// Windows CI 41286192672 exceeded 5,000 ms across two real PowerShell/curl
// launches. Allow 4x that observed lower bound for the bootstrap workflow.
it("runs the exact injected curl request and keeps legacy self authority separate", async () => {
  const native = createControllableIterator();
  let delivered!: StartSessionOptions;
  const core = new CoreApi("curl-profile", {
    projects: async () => ({ items: [] }),
    sessions: async () => ({ items: [] }),
    providers: async () => [],
  });
  const session = await startAgentSelfSession(
    "claude",
    {
      cwd: ".",
      agentSelf: true,
      agentApi: { serverId: "curl-profile" },
      onAgentApiRead: core.read.bind(core),
    },
    async (options) => {
      delivered = options;
      return {
        queue: new MessageQueue(),
        iterator: {
          ...native.iterator,
          [Symbol.asyncIterator]() {
            return this;
          },
        },
        abort() {
          native.finish();
        },
      };
    },
  );
  const env = delivered.agentApiEnvironment!;
  const bridge = createAgentctlSessionEnvBridge(
    undefined,
    delivered.getSessionChildEnv,
  );
  try {
    const command = agentApiBootstrapInstructions(
      process.platform === "win32",
    ).split("\n")[2]!;
    expect(delivered.globalInstructions).toContain(command);
    const pending = JSON.parse(
      await shell(command, {
        ...process.env,
        ...delivered.agentEnvironment,
        ...env,
      }),
    );
    expect(pending.session.id).toBeNull();
    native.push({
      type: "system",
      subtype: "init",
      session_id: "canonical-curl",
    });
    await session.iterator.next();
    const bound = JSON.parse(
      await shell(command, {
        ...process.env,
        ...delivered.agentEnvironment,
        ...env,
      }),
    );
    expect(bound.session.id).toBe("canonical-curl");
    expect((await api(env, "/v0/help")).body).toContain("Operation reference");
    expect((await api(env, "/v0/servers/curl-profile/projects")).status).toBe(
      200,
    );
    const legacy = delivered.agentEnvironment!;
    const legacyResponse = await fetch(`${legacy.AGENT_YA_API_URL}/v1/self`, {
      headers: { Authorization: `Bearer ${legacy.AGENT_YA_API_TOKEN}` },
    });
    expect(legacyResponse.status).toBe(200);
    const widerAttempt = await api(
      {
        ...env,
        AGENT_YA_V0_AUTHORIZATION: `Bearer ${legacy.AGENT_YA_API_TOKEN}`,
      },
      "/v0/servers/curl-profile/projects",
    );
    expect(widerAttempt.status).toBe(401);
    const script = await readFile(
      bridge.extendEnv(process.env).BASH_ENV!,
      "utf8",
    );
    expect(script).not.toContain(env.AGENT_YA_V0_AUTHORIZATION!.split(" ")[1]);
    expect(delivered.globalInstructions).not.toContain(
      env.AGENT_YA_V0_AUTHORIZATION,
    );
    expect(filterEnvForChildProcess(env)).not.toHaveProperty(
      "AGENT_YA_V0_AUTHORIZATION",
    );
    await session.revokeAgentApiAccess?.();
    expect(
      (
        await fetch(`${legacy.AGENT_YA_API_URL}/v1/self`, {
          headers: { Authorization: `Bearer ${legacy.AGENT_YA_API_TOKEN}` },
        })
      ).status,
    ).toBe(200);
  } finally {
    bridge.cleanup();
    native.finish();
    await session.abort();
    await session.iterator.return?.();
  }
}, 20_000);

it("keeps a real owner API alive across controller detach/reattach and honors detached revocation", async () => {
  const native = createControllableIterator();
  const owner = new ProviderSessionOwner({ runtimeId: "api-owner" });
  let env!: Record<string, string>;
  const core = new CoreApi("owner-profile", {
    projects: async () => ({
      items: [{ id: "owned", name: "owned", path: "/fixture" }],
    }),
    sessions: async () => ({ items: [] }),
    providers: async () => [],
  });
  await owner.start(async (hooks) => ({
    session: await startAgentSelfSession(
      "claude",
      {
        cwd: ".",
        agentSelf: false,
        agentApi: { serverId: "owner-profile" },
        onAgentApiRead: hooks.onAgentApiRead,
        resumeSessionId: "canonical-owner",
      },
      async (options) => {
        env = options.agentApiEnvironment!;
        return {
          queue: new MessageQueue(),
          iterator: {
            ...native.iterator,
            [Symbol.asyncIterator]() {
              return this;
            },
          },
          abort() {
            native.finish();
          },
        };
      },
    ),
  }));
  const attach = (id: string) =>
    owner.attach(
      id,
      id,
      (message) => {
        const request = message as {
          type: string;
          requestId: string;
          operation: Parameters<CoreApi["read"]>[0];
          input: Parameters<CoreApi["read"]>[2];
        };
        if (request.type === "agentApiRead")
          void core
            .read(request.operation, { kind: "superuser" }, request.input)
            .then((result) =>
              owner.handleControllerRequest(id, {
                type: "agentApiResult",
                requestId: request.requestId,
                ok: true,
                result,
              }),
            );
      },
      { agentApiAllowed: true },
    );
  try {
    attach("first");
    expect(
      (await api(env, "/v0/servers/owner-profile/projects")).json().items[0].id,
    ).toBe("owned");
    owner.detach("first");
    expect((await api(env, "/v0/me")).json().session.id).toBe(
      "canonical-owner",
    );
    expect((await api(env, "/v0/servers/owner-profile/projects")).status).toBe(
      503,
    );
    attach("second");
    expect((await api(env, "/v0/servers/owner-profile/projects")).status).toBe(
      200,
    );
    owner.detach("second");
    owner.handleSupervisorMessage({ type: "revokeAgentApi" });
    const revokedStatus = await api(env, "/v0/me").then(
      (response) => response.status,
      () => 0,
    );
    expect([0, 401]).toContain(revokedStatus);
  } finally {
    native.finish();
    await owner.shutdown("test complete");
  }
});

it.each(["remote", "sandbox", "codex-default"])(
  "does not advertise API access for %s launches",
  async (mode) => {
    let delivered!: StartSessionOptions;
    const options: StartSessionOptions = {
      cwd: ".",
      agentSelf: false,
      agentApi: { serverId: "ineligible" },
      ...(mode === "remote"
        ? { executor: "remote" }
        : mode === "sandbox"
          ? {
              sessionSandboxOptions: {
                provider: "claude",
                level: "project-write",
                projectPath: "/fixture",
              },
            }
          : { permissionMode: "default" }),
    };
    const session = await startAgentSelfSession(
      mode === "codex-default" ? "codex" : "claude",
      options,
      async (resolved) => {
        delivered = resolved;
        return {
          queue: new MessageQueue(),
          iterator: (async function* () {})(),
          abort() {},
        } as AgentSession;
      },
    );
    expect(delivered.agentApiEnvironment).toBeUndefined();
    expect(delivered.globalInstructions ?? "").not.toContain(
      "[Yep Anywhere API]",
    );
    await session.abort();
  },
);

it("bootstraps public API and self identity before native start and keeps it across native init", async () => {
  const { parseYaSessionId } = await import("@yep-anywhere/shared");
  const native = createControllableIterator();
  let delivered!: StartSessionOptions;
  const publicId = parseYaSessionId("public-creation-session");
  const session = await startAgentSelfSession(
    "claude",
    {
      cwd: ".",
      publicSessionId: publicId,
      newSessionId: "native-creation-session",
      agentSelf: true,
      agentApi: { serverId: "public-creation-profile" },
    },
    async (options) => {
      delivered = options;
      expect(
        (await api(options.agentApiEnvironment!, "/v0/me")).json().session.id,
      ).toBe(publicId);
      return {
        queue: new MessageQueue(),
        iterator: {
          ...native.iterator,
          [Symbol.asyncIterator]() {
            return this;
          },
        },
        abort: () => native.finish(),
      };
    },
  );
  try {
    native.push({
      type: "system",
      subtype: "init",
      session_id: "native-creation-session",
    });
    await session.iterator.next();
    expect(
      (await api(delivered.agentApiEnvironment!, "/v0/me")).json().session.id,
    ).toBe(publicId);
    const response = await fetch(
      delivered.agentEnvironment!.AGENT_YA_API_URL + "/v1/self",
      {
        headers: {
          Authorization:
            "Bearer " + delivered.agentEnvironment!.AGENT_YA_API_TOKEN,
        },
      },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ sessionId: publicId });
  } finally {
    await session.abort();
  }
});
