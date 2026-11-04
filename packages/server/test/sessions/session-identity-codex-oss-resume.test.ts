import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import {
  nativeSessionRef,
  parseNativeSessionId,
  toUrlProjectId,
} from "@yep-anywhere/shared";
import { DiscoverySqliteService } from "../../src/storage/discovery-sqlite.js";
import { SessionMetadataService } from "../../src/metadata/SessionMetadataService.js";
import type { ProviderInstallationCoordinator } from "../../src/services/ProviderInstallationCoordinator.js";

it.skipIf(process.platform === "win32")(
  "keeps Codex OSS continuation at its native UUID/store through exec failures and profile reopen",
  async () => {
    const root = await realpath(
        await mkdtemp(join(tmpdir(), "ya-oss-resume-")),
      ),
      home = join(root, "codex"),
      scope = join(home, "sessions"),
      project = join(root, "project"),
      folder = join(scope, "2026", "11", "01"),
      log = join(root, "argv.jsonl"),
      cli = join(root, "codex-cli"),
      dataDir = join(root, "ya");
    await Promise.all(
      [folder, project].map((p) => mkdir(p, { recursive: true })),
    );
    const id = parseNativeSessionId("310ed378-49e7-40be-9ab8-0f1d371cd079"),
      projectId = toUrlProjectId(project),
      file = join(folder, "rollout-2026-11-01T00-00-00-" + id + ".jsonl");
    const stamp = "2026-11-01T00:00:00Z";
    const original =
      [
        {
          type: "session_meta",
          timestamp: stamp,
          payload: {
            id,
            cwd: project,
            timestamp: stamp,
            model_provider: "ollama",
            originator: "codex_cli_rs",
            source: "exec",
          },
        },
        {
          type: "event_msg",
          timestamp: stamp,
          payload: { type: "user_message", message: "ORIGINAL_ONCE" },
        },
      ]
        .map((v) => JSON.stringify(v))
        .join("\n") + "\n";
    await writeFile(file, original);
    await writeFile(
      cli,
      `#!${process.execPath}
const { appendFileSync }=require('node:fs');
const argv=process.argv.slice(2),log=${JSON.stringify(log)},file=${JSON.stringify(file)},id=${JSON.stringify(id)};
appendFileSync(log,JSON.stringify({argv,home:process.env.CODEX_HOME})+'\\n');
if(argv.includes('--version')){if(process.env.CODEX_OSS_FIXTURE_FAIL==='spawn')require('node:fs').chmodSync(__filename,0o644);console.log('codex-cli 0.166.0');process.exit(0);}
if(argv[0]!=='exec'||argv[1]!=='resume'||argv[2]!==id){console.error('unexpected native allocation');process.exit(9);}
if(process.env.CODEX_OSS_FIXTURE_FAIL==='wrong-native'){console.log(JSON.stringify({type:'thread.started',thread_id:'710ed378-49e7-40be-9ab8-0f1d371cd079'}));process.exit(0);}
if(process.env.CODEX_OSS_FIXTURE_FAIL){console.error('controlled exec failure');process.exit(7);}
appendFileSync(file,JSON.stringify({type:'event_msg',timestamp:'2026-11-01T00:00:02Z',payload:{type:'user_message',message:argv[3]}})+'\\n');
appendFileSync(file,JSON.stringify({type:'response_item',timestamp:'2026-11-01T00:00:03Z',payload:{type:'message',role:'assistant',content:[{type:'output_text',text:'OWNED_OSS_REPLY'}]}})+'\\n');
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',id:'owned-reply',text:'OWNED_OSS_REPLY'}}));
`,
      { mode: 0o755 },
    );
    vi.stubEnv("CODEX_HOME", home);
    vi.resetModules();
    const { createApp } = await import("../setup/create-app.js");
    const { CodexOSSProvider } = await import(
      "../../src/sdk/providers/codex-oss.js"
    );
    let leases = 0;
    const installationCoordinator = {
      acquireRuntimeLease: async () => {
        leases++;
        let released = false;
        return {
          release: async () => {
            if (!released) {
              released = true;
              leases--;
            }
          },
        };
      },
      getSourceVersion: () => "owned-fixture",
      withReadLease: async (
        _family: string,
        operation: () => Promise<unknown>,
      ) => operation(),
    } as unknown as ProviderInstallationCoordinator;
    const provider = new CodexOSSProvider({
      codexPath: cli,
      installationCoordinator,
    });
    const source = {
      native: nativeSessionRef("codex", scope, id),
      projectId,
      filePath: file,
    };
    let storage: DiscoverySqliteService | undefined,
      app: ReturnType<typeof createApp> | undefined;
    try {
      await expect(
        provider.startSession({
          cwd: project,
          resumeSessionId: id,
          nativeResumeSource: {
            ...source,
            native: nativeSessionRef("codex", root, id),
          },
        }),
      ).rejects.toThrow("outside the launch session store");
      await expect(
        provider.startSession({
          cwd: project,
          resumeSessionId: "named-alias",
          nativeResumeSource: {
            ...source,
            native: nativeSessionRef(
              "codex",
              scope,
              parseNativeSessionId("named-alias"),
            ),
          },
        }),
      ).rejects.toThrow("native UUID");
      expect(leases).toBe(0);
      expect(await readFile(log, "utf8").catch(() => "")).toBe("");
      for (const failure of ["native", "spawn"]) {
        vi.stubEnv(
          "CODEX_OSS_FIXTURE_FAIL",
          failure === "native" ? "1" : "spawn",
        );
        await chmod(cli, 0o755);
        const failed = await provider.startSession({
          cwd: project,
          resumeSessionId: id,
          nativeResumeSource: source,
          initialMessage: { text: "UNDELIVERED", uuid: "failed-input" },
        });
        const events = [];
        for await (const event of failed.iterator) {
          events.push(event);
          if (event.type === "result") break;
        }
        expect(JSON.stringify(events)).toContain(
          failure === "native" ? "controlled exec failure" : "EACCES",
        );
        if (failure === "native") {
          expect(failed.pid).toBeGreaterThan(0);
          expect(() => process.kill(failed.pid!, 0)).toThrow();
        } else expect(failed.pid).toBeUndefined();
        expect(leases).toBe(0);
      }
      await chmod(cli, 0o755);
      vi.stubEnv("CODEX_OSS_FIXTURE_FAIL", "wrong-native");
      const wrong = await provider.startSession({
        cwd: project,
        resumeSessionId: id,
        nativeResumeSource: source,
        initialMessage: { text: "UNDELIVERED_WRONG_NATIVE" },
      });
      await expect(
        (async () => {
          for await (const _event of wrong.iterator) {
            /* drain native frames */
          }
        })(),
      ).rejects.toThrow("different native thread");
      expect(() => process.kill(wrong.pid!, 0)).toThrow();
      expect(leases).toBe(0);
      vi.stubEnv("CODEX_OSS_FIXTURE_FAIL", "");
      const idle = await provider.startSession({
        cwd: project,
        resumeSessionId: id,
        nativeResumeSource: source,
      });
      expect((await idle.iterator.next()).value).toMatchObject({
        type: "system",
        subtype: "init",
        session_id: id,
      });
      const waiting = idle.iterator.next();
      await idle.abort();
      expect((await waiting).done).toBe(true);
      expect(leases).toBe(0);
      const beforeNative = await provider.startSession({
        cwd: project,
        resumeSessionId: id,
        nativeResumeSource: source,
        initialMessage: { text: "UNDELIVERED_ABORT" },
      });
      await beforeNative.iterator.next();
      expect((await beforeNative.iterator.next()).value).toMatchObject({
        type: "user",
      });
      await beforeNative.abort();
      await beforeNative.iterator.return?.();
      expect(leases).toBe(0);
      const beforePull = await provider.startSession({
        cwd: project,
        resumeSessionId: id,
        nativeResumeSource: source,
      });
      await beforePull.abort();
      expect((await beforePull.iterator.next()).done).toBe(true);
      expect(leases).toBe(0);
      storage = new DiscoverySqliteService({
        dataDir,
        probeNetworkFilesystem: () => undefined,
      });
      const metadata = new SessionMetadataService({
        dataDir,
        database: storage.getDatabase(),
      });
      await metadata.initialize();
      const saved = metadata.creations.admit({
        requestId: "oss-cold-resume",
        context: {
          owner: { kind: "superuser" },
          source: { kind: "request", provenance: { surface: "web" } },
        },
        request: {
          projectPath: project,
          projectId,
          provider: "codex-oss",
          message: "ORIGINAL_ONCE",
          settings: {
            permissionMode: "default",
            requestedModel: "default",
            thinking: null,
            effort: null,
            serviceTier: null,
          },
          launch: { schemaVersion: 1 },
        },
      });
      const fence = metadata.creations.beginDispatch(saved.attempt, {
        family: "codex",
        storageScope: scope,
      });
      metadata.creations.bindNative(fence, source.native);
      metadata.creations.confirmOwnedInput(
        fence,
        source.native,
        saved.initialInputId!,
      );
      const start = vi.spyOn(provider, "startSession");
      const options = {
        provider,
        dataDir,
        sessionMetadataService: metadata,
        discoverySqlite: storage,
        codexSessionsDir: scope,
      };
      app = createApp(options);
      await app.scanner.getOrCreateProject(projectId);
      const response = await app.app.request(
        `/api/projects/${projectId}/sessions/${saved.sessionId}/resume`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Yep-Anywhere": "true",
          },
          body: JSON.stringify({
            message: "LATER_ONCE",
            provider: "codex-oss",
          }),
        },
      );
      expect(response.status, await response.clone().text()).toBe(200);
      const launched = await response.json();
      expect(start).toHaveBeenCalledOnce();
      expect(start.mock.calls[0]![0]).toMatchObject({
        resumeSessionId: id,
        publicSessionId: saved.sessionId,
        nativeResumeSource: source,
      });
      const active = app.supervisor.getProcess(launched.processId)!;
      await vi.waitFor(() =>
        expect(JSON.stringify(active.getMessageHistory())).toContain(
          "OWNED_OSS_REPLY",
        ),
      );
      expect(active.sessionId).toBe(saved.sessionId);
      expect(
        active
          .getMessageHistory()
          .every((m) => !m.session_id || m.session_id === saved.sessionId),
      ).toBe(true);
      await app.supervisor.abortProcess(active.id);
      expect(leases).toBe(0);
      app.stopNotifications();
      await app.disposeSessionReaders();
      app = undefined;
      storage.close();
      storage = new DiscoverySqliteService({
        dataDir,
        probeNetworkFilesystem: () => undefined,
      });
      const reopened = new SessionMetadataService({
        dataDir,
        database: storage.getDatabase(),
      });
      await reopened.initialize();
      app = createApp({
        ...options,
        discoverySqlite: storage,
        sessionMetadataService: reopened,
      });
      const detail = await app.app.request(
        `/api/projects/${projectId}/sessions/${saved.sessionId}`,
      );
      expect(detail.status, await detail.clone().text()).toBe(200);
      const body = await detail.json();
      expect(body.session.id).toBe(saved.sessionId);
      expect(JSON.stringify(body.messages)).toContain("OWNED_OSS_REPLY");
      const list = await (await app.app.request("/api/sessions")).json();
      expect(
        list.sessions.filter((s: { id: string }) => s.id === saved.sessionId),
      ).toHaveLength(1);
      expect(
        list.sessions.filter((s: { id: string }) => s.id === id),
      ).toHaveLength(0);
      const calls = (await readFile(log, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(
        calls
          .filter((c) => c.argv[0] !== "--version")
          .every(
            (c) =>
              c.argv[0] === "exec" &&
              c.argv[1] === "resume" &&
              c.argv[2] === id &&
              c.home === home,
          ),
      ).toBe(true);
      expect(calls.filter((c) => c.argv[3] === "LATER_ONCE")).toHaveLength(1);
      const native = await readFile(file, "utf8");
      expect(native.match(/ORIGINAL_ONCE/g)).toHaveLength(1);
      expect(native.match(/LATER_ONCE/g)).toHaveLength(1);
      expect(native).not.toContain("UNDELIVERED");
    } finally {
      if (app) {
        for (const p of app.supervisor.getAllProcesses())
          await app.supervisor.abortProcess(p.id);
        app.stopNotifications();
        await app.disposeSessionReaders();
      }
      storage?.close();
      vi.unstubAllEnvs();
      await rm(root, { recursive: true, force: true });
    }
  },
  15000,
);
