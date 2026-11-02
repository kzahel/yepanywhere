import {
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

// Exercise the actual adapter/process boundary without a model account or CLI.
it.skipIf(process.platform === "win32")(
  "cold-resumes the exact Pi file and preserves YA identity after restart",
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "ya-pi-resume-")));
    const agent = join(root, ".pi", "agent"),
      scope = join(agent, "sessions"),
      project = join(root, "project"),
      other = join(root, "other"),
      log = join(root, "rpc.jsonl");
    const id = parseNativeSessionId("310ed378-49e7-40be-9ab8-0f1d371cd079"),
      projectId = toUrlProjectId(project);
    const folder = join(scope, "--selected--"),
      file = join(folder, "2026-11-01_" + id + ".jsonl"),
      cli = join(root, "pi");
    await Promise.all(
      [folder, project, other].map((p) => mkdir(p, { recursive: true })),
    );
    const header = {
      type: "session",
      version: 3,
      id,
      timestamp: "2026-11-01T00:00:00Z",
      cwd: project,
    };
    const seed = {
      type: "message",
      id: "seed",
      parentId: null,
      timestamp: "2026-11-01T00:00:01Z",
      message: { role: "user", content: "ORIGINAL_ONCE" },
    };
    await writeFile(
      file,
      [header, seed].map((value) => JSON.stringify(value)).join("\n") + "\n",
    );
    const foreignFolder = join(scope, "--foreign--");
    await mkdir(foreignFolder);
    await writeFile(
      join(foreignFolder, "2026-11-01_" + id + ".jsonl"),
      JSON.stringify({ ...header, cwd: other }) + "\n",
    );
    await writeFile(
      cli,
      `#!${process.execPath}
const { readFileSync, appendFileSync } = require('node:fs');
const readline = require('node:readline');
const argv = process.argv.slice(2), log = ${JSON.stringify(log)};
appendFileSync(log,JSON.stringify({argv})+'\\n');
if(argv.includes('--version')) { console.log('1.1.0'); process.exit(0); }
const file = argv[argv.indexOf('--session')+1];
const header = JSON.parse(readFileSync(file,'utf8').split('\\n')[0]);
const send = x => console.log(JSON.stringify(x));
readline.createInterface({ input: process.stdin }).on('line', line => {
 const q = JSON.parse(line); appendFileSync(log,JSON.stringify({q,file})+'\\n');
 if(q.type === 'get_state') { send({type:'response',id:q.id,command:q.type,success:true,data:{sessionId:process.env.PI_FIXTURE_WRONG_ID ? 'wrong-native-id' : header.id,sessionFile:file,isStreaming:false}}); return; }
 if(q.type === 'prompt') {
  appendFileSync(file,JSON.stringify({type:'message',id:'later-user',parentId:'seed',timestamp:'2026-11-01T00:00:02Z',message:{role:'user',content:q.message}})+'\\n');
  appendFileSync(file,JSON.stringify({type:'message',id:'later-answer',parentId:'later-user',timestamp:'2026-11-01T00:00:03Z',message:{role:'assistant',content:[{type:'text',text:'OWNED_PI_REPLY'}]}})+'\\n');
  send({type:'response',id:q.id,command:q.type,success:true});
  send({type:'agent_start'}); send({type:'message_start',message:{role:'assistant'}});
  send({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'OWNED_PI_REPLY'}});
  send({type:'agent_settled'}); return;
 }
 send({type:'response',id:q.id,command:q.type,success:true});
});
`,
      { mode: 0o755 },
    );
    vi.stubEnv("HOME", root);
    vi.stubEnv("PI_CODING_AGENT_DIR", agent);
    vi.stubEnv("PI_SESSIONS_DIR", scope);
    vi.resetModules();
    const { createApp } = await import("../setup/create-app.js");
    const { MockClaudeSDK } = await import("../../src/sdk/mock.js");
    const { PiProvider } = await import("../../src/sdk/providers/pi.js");
    const provider = new PiProvider({ piPath: cli, sessionsDir: scope });
    const source = {
      native: nativeSessionRef("pi", scope, id),
      projectId,
      filePath: file,
    };
    let app: ReturnType<typeof createApp> | undefined,
      storage: DiscoverySqliteService | undefined;
    const dataDir = join(root, "ya");
    try {
      for (const options of [
        {
          cwd: project,
          nativeResumeSource: source,
          remoteEnv: { HOME: other },
        },
        {
          cwd: project,
          nativeResumeSource: source,
          remoteEnv: { USERPROFILE: other },
        },
        { cwd: other, nativeResumeSource: source },
        {
          cwd: project,
          nativeResumeSource: {
            ...source,
            native: nativeSessionRef("pi", root, id),
          },
        },
        {
          cwd: project,
          nativeResumeSource: source,
          remoteEnv: { PI_CODING_AGENT_SESSION_DIR: other },
        },
      ])
        await expect(
          provider.startSession({ resumeSessionId: id, ...options }),
        ).rejects.toThrow(/Pi continuation/);
      await writeFile(
        file,
        JSON.stringify({ ...header, id: "wrong-header" }) + "\n",
      );
      await expect(
        provider.startSession({
          cwd: project,
          resumeSessionId: id,
          nativeResumeSource: source,
        }),
      ).rejects.toThrow("header does not match");
      await writeFile(
        file,
        [header, seed].map((value) => JSON.stringify(value)).join("\n") + "\n",
      );
      expect(await readFile(log, "utf8").catch(() => "")).toBe("");
      const refused = await provider.startSession({
        cwd: project,
        resumeSessionId: id,
        nativeResumeSource: source,
        remoteEnv: { PI_FIXTURE_WRONG_ID: "1" },
      });
      expect((await refused.iterator.next()).value).toMatchObject({
        type: "error",
      });
      expect(refused.pid).toBeGreaterThan(0);
      await vi.waitFor(() => expect(refused.isProcessAlive?.()).toBe(false));
      expect((await readFile(log, "utf8")).includes('"type":"prompt"')).toBe(
        false,
      );
      for (const stop of [
        "before-init",
        "idle",
        "at-init",
        "empty-home-default",
        "tilde",
      ]) {
        const idle = await provider.startSession({
          cwd: project,
          resumeSessionId: id,
          nativeResumeSource: source,
          remoteEnv:
            stop === "empty-home-default"
              ? { PI_CODING_AGENT_DIR: "" }
              : stop === "tilde"
                ? {
                    PI_CODING_AGENT_DIR: "~/.pi/agent",
                    PI_CODING_AGENT_SESSION_DIR:
                      "~/.pi/agent/sessions/--selected--",
                  }
                : undefined,
        });
        if (stop !== "before-init") {
          expect((await idle.iterator.next()).value).toMatchObject({
            type: "system",
            subtype: "init",
          });
        }
        const waiting = stop === "idle" ? idle.iterator.next() : undefined;
        if (stop === "at-init") await idle.iterator.return?.();
        else idle.abort();
        if (waiting) expect((await waiting).done).toBe(true);
        await vi.waitFor(() => expect(idle.isProcessAlive?.()).toBe(false));
        await idle.iterator.return?.();
      }
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
        requestId: "pi-cold-resume",
        context: {
          owner: { kind: "superuser" },
          source: { kind: "request", provenance: { surface: "web" } },
        },
        request: {
          projectPath: project,
          projectId,
          provider: "pi",
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
        family: "pi",
        storageScope: scope,
      });
      metadata.creations.bindNative(fence, source.native);
      metadata.creations.confirmOwnedInput(
        fence,
        source.native,
        saved.initialInputId!,
      );
      const start = vi.spyOn(provider, "startSession");
      app = createApp({
        sdk: new MockClaudeSDK(),
        provider,
        dataDir,
        sessionMetadataService: metadata,
        discoverySqlite: storage,
      });
      await app.scanner.getOrCreateProject(projectId);
      const response = await app.app.request(
        `/api/projects/${projectId}/sessions/${saved.sessionId}/resume`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Yep-Anywhere": "true",
          },
          body: JSON.stringify({ message: "LATER_ONCE", provider: "pi" }),
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
          "OWNED_PI_REPLY",
        ),
      );
      expect(active.sessionId).toBe(saved.sessionId);
      expect(
        active
          .getMessageHistory()
          .every((m) => !m.session_id || m.session_id === saved.sessionId),
      ).toBe(true);
      await app.supervisor.abortProcess(active.id);
      await vi.waitFor(() => expect(active.isProcessAlive).toBe(false));
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
        sdk: new MockClaudeSDK(),
        provider,
        dataDir,
        sessionMetadataService: reopened,
        discoverySqlite: storage,
      });
      const detail = await app.app.request(
        `/api/projects/${projectId}/sessions/${saved.sessionId}`,
      );
      expect(detail.status, await detail.clone().text()).toBe(200);
      const body = await detail.json();
      expect(body.session.id).toBe(saved.sessionId);
      expect(JSON.stringify(body.messages)).toContain("OWNED_PI_REPLY");
      const list = await (await app.app.request("/api/sessions")).json();
      expect(
        list.sessions.filter((s: { id: string }) => s.id === saved.sessionId),
      ).toHaveLength(1);
      expect(
        list.sessions.filter((s: { id: string }) => s.id === id),
      ).toHaveLength(0);
      const requests = (await readFile(log, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(requests.filter((r) => r.q?.type === "prompt")).toHaveLength(1);
      expect(requests.filter((r) => r.q).every((r) => r.file === file)).toBe(
        true,
      );
      expect(
        (await readFile(file, "utf8")).match(/ORIGINAL_ONCE/g),
      ).toHaveLength(1);
      expect((await readFile(file, "utf8")).match(/LATER_ONCE/g)).toHaveLength(
        1,
      );
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
