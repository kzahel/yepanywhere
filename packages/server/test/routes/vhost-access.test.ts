import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { AuthService } from "../../src/auth/AuthService.js";
import { SESSION_COOKIE_NAME } from "../../src/auth/routes.js";
import { ScriptedClaudeProvider } from "../support/scripted-provider.js";
import { createApp } from "../setup/create-app.js";

it("keeps app-link issuance and revocation behind YA authentication", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ya-app-management-"));
  const auth = new AuthService({ dataDir: directory });
  await auth.initialize();
  await auth.enableAuth("app-management-test-password");
  const session = await auth.createSession("test");
  const instance = createApp({
    dataDir: directory,
    projectsDir: join(directory, "projects"),
    provider: new ScriptedClaudeProvider(),
    authService: auth,
    authDisabled: false,
    artifacts: {
      port: 4402,
      localOrigin: "http://artifacts.localhost",
      vhosts: [{ name: "plan", port: 19432 }],
    },
  });
  const headers = { Host: "localhost", "X-Yep-Anywhere": "true" };
  try {
    for (const [path, method] of [
      ["links", "GET"],
      ["plan/revoke", "POST"],
      ["oauth", "GET"],
      ["oauth", "PUT"],
      ["oauth/enabled", "PUT"],
      ["oauth/log", "GET"],
      ["plan/oauth", "PUT"],
    ]) {
      const response = await instance.app.request(
        `http://localhost/api/artifacts/vhosts/${path}`,
        { method, headers },
      );
      expect(response.status).toBe(401);
    }
    const authenticated = {
      ...headers,
      cookie: `${SESSION_COOKIE_NAME}=${session}`,
    };
    const issued = await instance.app.request(
      "http://localhost/api/artifacts/vhosts/links",
      { headers: authenticated },
    );
    expect(issued.status).toBe(200);
    const { tokens } = await issued.json();
    expect(tokens.plan).toHaveLength(43);
    const revoked = await instance.app.request(
      "http://localhost/api/artifacts/vhosts/plan/revoke",
      { method: "POST", headers: authenticated },
    );
    expect(revoked.status).toBe(200);
    expect(
      instance.artifactServer.vhostAccess.token({ name: "plan", port: 19432 }),
    ).not.toBe(tokens.plan);
    for (const host of ["plan.localhost", "plan.localhost:4402"]) {
      expect(
        (
          await instance.app.request(
            `http://${host}/api/artifacts/vhosts/links`,
          )
        ).status,
      ).toBe(401);
    }
  } finally {
    await instance.disposeSessionReaders();
    await rm(directory, { recursive: true });
  }
});
