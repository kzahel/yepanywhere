import { expect, it } from "vitest";
import type { SessionSandboxRuntime } from "../../../src/session-sandbox.js";
import { codexConfigBuilders } from "./codex-config-source.js";

// Inspect the actual app-server request builders, without launching a paid turn.
const provider = codexConfigBuilders() as unknown as {
  createThreadStartParams: (
    options: object,
    policy: object,
  ) => Record<string, unknown>;
  createThreadResumeParams: (
    options: object,
    sessionId: string,
    policy: object,
  ) => Record<string, unknown>;
  createThreadForkParams: (
    options: object,
    policy: object,
  ) => Record<string, unknown>;
};
const policy = { approvalPolicy: "on-request", sandbox: "workspace-write" };

it.each([true, false])(
  "composes limited-user instructions with startFromDefault=%s",
  (startFromDefault) => {
    const sessionSandbox = {
      instructions: { startFromDefault, text: "Shared.\n\nPersonal." },
    } as SessionSandboxRuntime;
    const options = { cwd: "/project", sessionSandbox };
    const fresh = provider.createThreadStartParams(options, policy);
    expect(fresh.developerInstructions).toBe("Shared.\n\nPersonal.");
    expect(fresh.baseInstructions).toBe(startFromDefault ? undefined : "");
    const resumed = provider.createThreadResumeParams(
      { ...options, resumeSessionId: "thread" },
      "thread",
      policy,
    );
    const forked = provider.createThreadForkParams(
      { ...options, sessionId: "thread" },
      policy,
    );
    for (const request of [resumed, forked]) {
      expect(request.developerInstructions).toBe("Shared.\n\nPersonal.");
      expect(request).not.toHaveProperty("baseInstructions");
    }
  },
);

it("leaves the superuser's provider instructions alone", () => {
  const request = provider.createThreadStartParams({ cwd: "/project" }, policy);
  expect(request).not.toHaveProperty("developerInstructions");
  expect(request).not.toHaveProperty("baseInstructions");
});
