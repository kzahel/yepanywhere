import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentctlSessionEnvBridge } from "../../../src/sdk/providers/agentctl-session-env.js";
import { ProviderSessionOwner } from "../../../src/sdk/providers/provider-session-owner.js";
import { startFakeProviderSession } from "./provider-runtime-fake.js";

function isBashAvailable(): boolean {
  try {
    execFileSync("bash", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function readAgentctlSessionId(bashEnvPath: string): string {
  const env: NodeJS.ProcessEnv = { ...process.env, BASH_ENV: bashEnvPath };
  delete env.AGENTCTL_SESSION_ID;
  return execFileSync(
    "bash",
    ["-c", 'printf "%s" "$' + '{AGENTCTL_SESSION_ID-}"'],
    {
      encoding: "utf-8",
      env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const bashIt = process.platform !== "win32" && isBashAvailable() ? it : it.skip;

describe("ProviderSessionOwner agentctl session env", () => {
  const owners: ProviderSessionOwner[] = [];

  afterEach(async () => {
    await Promise.all(
      owners.splice(0).map((owner) => owner.shutdown("test complete")),
    );
  });

  bashIt(
    "publishes AGENTCTL_SESSION_ID for hosted sessions without a provider method",
    async () => {
      const bridge = createAgentctlSessionEnvBridge();
      const owner = new ProviderSessionOwner({ runtimeId: "agentctl-env" });
      owners.push(owner);
      const ready = await owner.start(async (hooks) => ({
        session: await startFakeProviderSession(
          { sessionId: "hosted-provider-id" },
          hooks,
        ),
        agentctlSessionEnvBridge: bridge,
      }));
      expect(ready.capabilities.publishAgentctlSessionId).toBe(true);
      expect(readAgentctlSessionId(bridge.bashEnvPath)).toBe("");

      const events: Record<string, unknown>[] = [];
      owner.attach("controller", "generation-one", (message) => {
        events.push(message as Record<string, unknown>);
      });
      owner.begin();
      await waitFor(() =>
        events.some(
          (message) =>
            message.type === "event" &&
            (message.message as { subtype?: string } | undefined)?.subtype ===
              "init",
        ),
      );
      expect(readAgentctlSessionId(bridge.bashEnvPath)).toBe(
        "hosted-provider-id",
      );

      await owner.handleControllerRequest("controller", {
        type: "rpc",
        id: 1,
        method: "publishAgentctlSessionId",
        args: ["canonical-ya-id"],
      });
      expect(readAgentctlSessionId(bridge.bashEnvPath)).toBe("canonical-ya-id");
    },
  );
});
