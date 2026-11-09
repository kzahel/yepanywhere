import { serve } from "@hono/node-server";
import { ScriptedClaudeProvider } from "../support/scripted-provider.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { toUrlProjectId } from "@yep-anywhere/shared";
import { AuthService } from "../../src/auth/AuthService.js";
import { LimitedUsersService } from "../../src/auth/LimitedUsersService.js";
import { SESSION_COOKIE_NAME } from "../../src/auth/routes.js";
import { ServerSettingsService } from "../../src/services/ServerSettingsService.js";
import { seedTestCatalog } from "../utils/session-catalog.js";
import { AUTHENTICATED_SRP_TRANSPORT } from "../../src/middleware/authenticated-transport.js";
import { WS_INTERNAL_AUTHENTICATED } from "../../src/middleware/internal-auth.js";
import { createApp } from "../setup/create-app.js";
import type { AppResult } from "../../src/app.js";
import { PeerAccessManager } from "../../src/peer-api/manager.js";
import { DiscoverySqliteService } from "../../src/storage/discovery-sqlite.js";
import { readServerIdentity } from "../../src/core-api/server-identity.js";
import { randomUUID } from "node:crypto";

it("uses the production authentication/principal boundary and retained catalog for direct and SRP-bound reads", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "ya-v0-app-"));
  let instance: AppResult | undefined;
  try {
    const auth = new AuthService({
      dataDir,
      cookieSecret: "fixture-only-cookie-secret",
    });
    const limited = new LimitedUsersService({ dataDir });
    const settings = new ServerSettingsService({ dataDir });
    await Promise.all([
      auth.initialize(),
      limited.initialize(),
      settings.initialize(),
    ]);
    await auth.enableAuth("fixture-only-password");
    await settings.updateSettings({ limitedUsersEnabled: true });
    const visible = toUrlProjectId(join(dataDir, "visible")),
      privateId = toUrlProjectId(join(dataDir, "private"));
    await limited.create({
      username: "reader",
      password: "fixture-only-password",
      viewProjects: [visible],
    });
    await seedTestCatalog(dataDir, [
      {
        catalogFamily: "claude",
        storeKey: "fixture",
        scan: async () => ({
          sourceVersion: "fixture",
          rows: [visible, privateId].map((projectId, index) => ({
            catalogFamily: "claude" as const,
            storeKey: "fixture",
            sessionId: `session-${index}`,
            projectId,
            projectPath: join(dataDir, index ? "private" : "visible"),
            projectIdentityKey: projectId,
            updatedAt: "2026-10-30T00:00:00Z",
            title: index ? "private title" : "visible title",
            fidelity: "head" as const,
            sourceVersion: "fixture",
            location: {
              kind: "file" as const,
              path: join(dataDir, `not-read-${index}.jsonl`),
            },
          })),
        }),
      },
    ]);
    instance = createApp({
      provider: new ScriptedClaudeProvider(),
      dataDir,
      projectsDir: join(dataDir, "empty-projects"),
      authService: auth,
      limitedUsersService: limited,
      serverSettingsService: settings,
      externalSessionsEnabled: false,
    });
    expect((await instance.app.request("/v0")).status).toBe(401);
    const cookie = `${SESSION_COOKIE_NAME}=${await auth.createSession("fixture", "reader")}`;
    const discovery = await instance.app.request("/v0", {
      headers: { Cookie: cookie },
    });
    expect(discovery.status).toBe(200);
    const { serverId } = await discovery.json();
    expect(serverId).toMatch(/^[0-9a-f-]{36}$/);
    const listener = serve({
      fetch: instance.app.fetch,
      hostname: "127.0.0.1",
      port: 0,
    });
    try {
      if (!listener.listening)
        await new Promise<void>((resolve, reject) => {
          listener.once("listening", resolve);
          listener.once("error", reject);
        });
      const address = listener.address();
      if (!address || typeof address === "string")
        throw new Error("Missing fixture port");
      const response = await fetch(`http://127.0.0.1:${address.port}/v0/me`, {
        headers: { Cookie: cookie },
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        principal: { kind: "limited", username: "reader" },
        session: null,
      });
    } finally {
      await new Promise<void>((resolve, reject) =>
        listener.close((error) => (error ? reject(error) : resolve())),
      );
    }

    for (const transport of ["direct", "srp"] as const) {
      const headers: Record<string, string> =
        transport === "direct" ? { Cookie: cookie } : {};
      const env =
        transport === "srp"
          ? {
              [WS_INTERNAL_AUTHENTICATED]: true,
              [AUTHENTICATED_SRP_TRANSPORT]: {
                kind: "srp" as const,
                username: "reader",
                sessionId: "fixture",
              },
            }
          : undefined;
      const response = await instance.app.request(
        `/v0/servers/${serverId}/sessions?limit=1`,
        { headers },
        env,
      );
      expect(response.status).toBe(200);
      expect((await response.json()).items).toMatchObject([
        { id: "session-0", title: "visible title" },
      ]);
      expect(
        (
          await instance.app.request(
            `/v0/servers/${serverId}/sessions/session-1`,
            { headers },
            env,
          )
        ).status,
      ).toBe(404);
      expect(
        (await instance.app.request("/v0/me", { headers }, env)).status,
      ).toBe(200);
    }
    expect(
      (
        await instance.app.request(`/v0/servers/${serverId}/sessions`, {
          method: "POST",
          headers: { Cookie: cookie, "X-Yep-Anywhere": "true" },
        })
      ).status,
    ).toBe(403);
  } finally {
    await instance?.disposeSessionReaders();
    await rm(dataDir, { recursive: true, force: true });
  }
});

it("requires actual owner proof for peer administration even on an auth-disabled production app", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "ya-peer-owner-app-"));
  const database = new DiscoverySqliteService({ dataDir });
  const manager = new PeerAccessManager(
    readServerIdentity(database.getDatabase()),
    dataDir,
  );
  let instance: AppResult | undefined;
  try {
    await manager.initialize();
    const auth = new AuthService({ dataDir });
    await auth.initialize();
    instance = createApp({
      provider: new ScriptedClaudeProvider(),
      dataDir,
      discoverySqlite: database,
      peerAccess: manager,
      authService: auth,
      authDisabled: true,
      projectsDir: join(dataDir, "empty-projects"),
      externalSessionsEnabled: false,
    });
    expect((await instance.app.request("/v0/me")).status).toBe(200);
    expect((await instance.app.request("/api/peers")).status).toBe(403);
    const path = "/api/peers/incoming",
      body = {
        sourceServerId: randomUUID(),
        projects: [],
        operations: ["server"],
        expiresAt: Date.now() + 60_000,
      };
    const headers = {
      "X-Yep-Anywhere": "true",
      "Content-Type": "application/json",
    };
    expect(
      (
        await instance.app.request(path, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        })
      ).status,
    ).toBe(403);
    const ownerHeaders = {
      ...headers,
      Cookie: `${SESSION_COOKIE_NAME}=${await auth.createSession("fixture")}`,
    };
    const issued = await instance.app.request(path, {
      method: "POST",
      headers: ownerHeaders,
      body: JSON.stringify(body),
    });
    expect(issued.status).toBe(201);
    const invitation = await issued.json();
    expect(invitation.secret).toBeTruthy();
    const listed = await instance.app.request("/api/peers", {
      headers: ownerHeaders,
    });
    expect(listed.status).toBe(200);
    const text = await listed.text();
    expect(text).not.toContain(invitation.secret);
    expect(JSON.parse(text).incoming).toMatchObject([
      { sourceServerId: body.sourceServerId, generation: 1 },
    ]);
    expect(
      (
        await instance.app.request(path, {
          method: "POST",
          headers: ownerHeaders,
          body: JSON.stringify(body),
        })
      ).status,
    ).toBe(409);
    const rotation = {
      projects: [],
      operations: ["server"],
      expiresAt: Date.now() + 60_000,
    };
    const rotated = await instance.app.request(
      `${path}/${invitation.credentialId}/rotate`,
      { method: "POST", headers: ownerHeaders, body: JSON.stringify(rotation) },
    );
    expect(rotated.status).toBe(201);
    expect((await rotated.json()).generation).toBe(2);
    expect(
      (
        await instance.app.request(`${path}/${invitation.credentialId}`, {
          method: "DELETE",
          headers: ownerHeaders,
        })
      ).status,
    ).toBe(204);
    expect(manager.publicState().incoming).toEqual([]);
  } finally {
    await instance?.disposeSessionReaders();
    await manager.close();
    database.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
