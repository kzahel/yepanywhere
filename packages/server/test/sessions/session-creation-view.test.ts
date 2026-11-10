import { mkdtemp, mkdir, rm, access, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import {
  toUrlProjectId,
  nativeSessionRef,
  parseNativeSessionId,
} from "@yep-anywhere/shared";
import { AuthService } from "../../src/auth/AuthService.js";
import { LimitedUsersService } from "../../src/auth/LimitedUsersService.js";
import { SESSION_COOKIE_NAME } from "../../src/auth/routes.js";
import { SessionAccessResolver } from "../../src/auth/sessionAccess.js";
import { SessionMetadataService } from "../../src/metadata/SessionMetadataService.js";
import { ServerSettingsService } from "../../src/services/ServerSettingsService.js";
import { DiscoverySqliteService } from "../../src/storage/discovery-sqlite.js";
import { ScriptedClaudeProvider } from "../support/scripted-provider.js";
import { createApp } from "../setup/create-app.js";

it("reads saved/failed sessions through authorized APIs without a native project, preserving source and refusal across restart", async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  const root = await mkdtemp(join(tmpdir(), "ya-saved-view-"));
  const dataDir = join(root, "data"),
    project = join(root, "project"),
    working = join(root, "working"),
    nativeRoot = join(root, "native");
  await Promise.all(
    [dataDir, project, working].map((path) => mkdir(path, { recursive: true })),
  );
  const projectId = toUrlProjectId(project),
    workingId = toUrlProjectId(working);
  let instance: ReturnType<typeof createApp> | undefined,
    storage: DiscoverySqliteService | undefined,
    sessionId = "",
    requestId = "saved_request_01";
  try {
    for (let restart = 0; restart < 2; restart++) {
      storage = new DiscoverySqliteService({
        dataDir,
        probeNetworkFilesystem: () => undefined,
      });
      const metadata = new SessionMetadataService({
        dataDir,
        database: storage.getDatabase(),
      });
      await metadata.initialize();
      const auth = new AuthService({
        dataDir,
        cookieSecret: "owned-saved-view-secret",
      });
      await auth.initialize();
      const users = new LimitedUsersService({ dataDir });
      await users.initialize();
      const settings = new ServerSettingsService({ dataDir });
      await settings.initialize();
      if (!restart) {
        await auth.enableAuth("owned-superuser-password");
        for (const username of ["alice", "bobby"])
          await users.create({ username, password: "owned-test-password" });
        await settings.updateSettings({ limitedUsersEnabled: true });
        const saved = metadata.creations.admit({
          requestId,
          context: {
            owner: { kind: "limited", username: "alice" },
            source: {
              kind: "request",
              provenance: { surface: "desktop", clientVersion: "saved-test" },
            },
          },
          request: {
            provider: "claude",
            projectId,
            projectPath: project,
            message: "  original saved prompt\n\n",
            settings: {
              permissionMode: "default",
              requestedModel: "default",
              serviceTier: null,
              thinking: null,
              effort: null,
            },
          },
        });
        sessionId = saved.sessionId;
      }
      const routerBinding = {
        id: "saved-router-binding",
        routerId: "saved-router",
        accountId: "saved-account",
        provider: "claude" as const,
        poolId: "saved-pool",
        poolName: "Personal Claude",
      };
      if (!restart) await metadata.updateMetadata(sessionId, { routerBinding });
      const sdk = new ScriptedClaudeProvider(),
        start = vi.spyOn(sdk, "startSession");
      instance = createApp({
        provider: sdk,
        dataDir,
        discoverySqlite: storage,
        sessionMetadataService: metadata,
        projectsDir: nativeRoot,
        authService: auth,
        authDisabled: false,
        limitedUsersService: users,
        serverSettingsService: settings,
      });
      const alice = `${SESSION_COOKIE_NAME}=${await auth.createSession("owned", "alice")}`,
        bobby = `${SESSION_COOKIE_NAME}=${await auth.createSession("owned", "bobby")}`,
        superuser = `${SESSION_COOKIE_NAME}=${await auth.createSession("owned")}`;
      const read = async (
        cookie: string,
        suffix = "",
        currentProject = restart ? workingId : projectId,
      ) => {
        const response = await instance!.app.request(
          `/api/projects/${currentProject}/sessions/${sessionId}${suffix}`,
          {
            headers: { Cookie: cookie, "X-Yep-Anywhere": "true" },
          },
        );
        return { response, body: await response.json() };
      };
      const saved = await read(alice);
      expect(saved.response.status).toBe(200);
      expect(saved.body).toMatchObject({
        session: {
          id: sessionId,
          projectId: restart ? workingId : projectId,
          provider: "claude",
          messageCount: 0,
          routerBinding,
          initialPrompt: "  original saved prompt\n\n",
          creationProvenance: {
            surface: "desktop",
            clientVersion: "saved-test",
          },
          creation: {
            state: restart ? "failed" : "saved",
            delivery: "not-admitted",
          },
        },
        messages: [],
        ownership: { owner: "none" },
        providerRuntimeStatus: null,
        pendingInputRequest: null,
      });
      expect(saved.body.transcriptSnapshotUpdatedAt).toBe("");
      expect(
        (await read(alice, "/metadata")).body.session.routerBinding,
      ).toEqual(routerBinding);
      expect((await read(bobby)).response.status).toBe(404);
      expect((await read(superuser)).response.status).toBe(200);
      const privateFields = JSON.stringify(saved.body);
      for (const name of [
        "owner_key",
        "request_hash",
        "context_json",
        "generation",
        "creationId",
        requestId,
      ])
        expect(privateFields).not.toContain(name);
      if (!restart) {
        const creation = metadata.creations.getForSession(
          saved.body.session.id,
        )!;
        metadata.creations.failBeforeEffects(
          creation.attempt,
          "launch-refused",
        );
        await metadata.setWorkingProject(sessionId, workingId, projectId);
        const failed = await read(alice, "/metadata", workingId);
        expect(failed.response.status).toBe(200);
        expect(failed.body).toMatchObject({
          session: {
            id: sessionId,
            projectId: workingId,
            creation: { state: "failed", failure: "launch-refused" },
            creationProvenance: { surface: "desktop" },
          },
          processState: null,
          slashCommands: [],
        });
        const redirect = await instance.app.request(
          `/api/projects/${projectId}/sessions/${sessionId}`,
          {
            headers: { Cookie: alice, "X-Yep-Anywhere": "true" },
          },
        );
        expect(redirect.status).toBe(307);
        expect(redirect.headers.get("Location")).toContain(workingId);
      }
      if (restart) {
        const current = metadata.creations.getForSession(
          saved.body.session.id,
        )!;
        const retry = metadata.creations.retry(
          current.context.owner,
          requestId,
          "retry_bound_missing",
          current.attempt.attemptId,
        );
        const scope = join(root, "selected-native-scope");
        await mkdir(scope);
        const dispatch = metadata.creations.beginDispatch(retry, {
          family: "claude",
          storageScope: await realpath(scope),
        });
        metadata.creations.bindNative(
          dispatch,
          nativeSessionRef(
            "claude",
            await realpath(scope),
            parseNativeSessionId("99999999-9999-4999-8999-999999999999"),
          ),
        );
        const bound = await read(alice);
        expect(bound.response.status).toBe(200);
        expect(bound.body).toMatchObject({
          session: {
            id: sessionId,
            creation: { state: "bound", delivery: "not-admitted" },
          },
          messages: [],
        });
        expect((await read(alice, "/metadata")).response.status).toBe(200);
        await expect(
          instance.supervisor.resumeSession(sessionId, working, {
            text: "must not bypass first-input recovery",
          }),
        ).rejects.toThrow("creation recovery");
        metadata.creations.markUncertain(dispatch);
        expect((await read(alice)).body.session.creation.state).toBe(
          "uncertain",
        );
        metadata.creations.delete(dispatch);
        expect((await read(alice)).response.status).toBe(404);
      }
      await expect(
        instance.supervisor.resumeSession(sessionId, working, {
          text: "must not allocate a native conversation",
        }),
      ).rejects.toThrow("creation recovery");
      expect(start).not.toHaveBeenCalled();
      await expect(access(nativeRoot)).rejects.toThrow();
      await instance.disposeSessionReaders();
      instance = undefined;
      storage.close();
      storage = undefined;
    }
  } finally {
    await instance?.disposeSessionReaders();
    storage?.close();
    await rm(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  }
});

it("keeps saved project facts authoritative over a previously cached native alias without importing its activity", async () => {
  let saved: { projectId: string; provider: string } | undefined;
  const catalog = vi.fn(async () => [
    {
      sessionId: "same-spelling",
      projectId: "foreign-native-project",
      provider: "codex",
      updatedAt: new Date().toISOString(),
    },
  ]);
  const resolver = new SessionAccessResolver({
    getLiveSession: () => undefined,
    getSessionMetadata: () => ({ createdByUser: "alice" }),
    readCatalogRows: catalog,
    getCreationSession: () => saved,
  });
  expect((await resolver.resolve("same-spelling"))?.projectId).toBe(
    "foreign-native-project",
  );
  saved = { projectId: "actual-saved-project", provider: "claude" };
  const expected = {
    projectId: "actual-saved-project",
    provider: "claude",
    lastActivityMs: null,
    createdByUser: "alice",
  };
  expect(await resolver.resolve("same-spelling")).toMatchObject(expected);
  expect(resolver.resolveKnown("same-spelling")).toMatchObject(expected);
  expect(catalog).toHaveBeenCalledOnce();
});
