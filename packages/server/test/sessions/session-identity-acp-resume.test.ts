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
import { hashProjectPath } from "../../src/projects/gemini-project-map.js";

for (const family of ["grok", "gemini"] as const) {
  it.skipIf(process.platform === "win32")(
    `cold-resumes ${family} without allocating or replacing public identity`,
    async () => {
      const root = await realpath(
        await mkdtemp(join(tmpdir(), "ya-acp-resume-")),
      );
      const project = join(root, "project"),
        other = join(root, "other"),
        log = join(root, "rpc.jsonl"),
        cli = join(root, family + "-cli"),
        dataDir = join(root, "ya");
      const scope =
        family === "grok"
          ? join(root, "grok", "sessions")
          : join(root, ".gemini", "tmp");
      const launchProvider = family === "grok" ? "grok" : "gemini-acp";
      const id = parseNativeSessionId("310ed378-49e7-40be-9ab8-0f1d371cd079"),
        projectId = toUrlProjectId(project);
      const folder =
        family === "grok"
          ? join(scope, encodeURIComponent(project), id)
          : join(scope, hashProjectPath(project), "chats");
      const file = join(
        folder,
        family === "grok"
          ? "summary.json"
          : "session-2026-11-01-" + id + ".json",
      );
      await Promise.all(
        [project, other, folder].map((p) => mkdir(p, { recursive: true })),
      );
      await writeFile(
        file,
        JSON.stringify(
          family === "grok"
            ? {
                info: { id, cwd: project },
                created_at: "2026-11-01T00:00:00Z",
                generated_title: "Original Grok",
                num_messages: 1,
              }
            : {
                sessionId: id,
                projectHash: hashProjectPath(project),
                startTime: "2026-11-01T00:00:00Z",
                lastUpdated: "2026-11-01T00:00:01Z",
                messages: [
                  {
                    id: "seed",
                    type: "user",
                    timestamp: "2026-11-01T00:00:01Z",
                    content: "ORIGINAL_ONCE",
                  },
                ],
              },
        ),
      );
      if (family === "grok")
        await writeFile(
          join(folder, "updates.jsonl"),
          JSON.stringify({
            timestamp: 1793491200,
            params: {
              update: {
                sessionUpdate: "user_message_chunk",
                content: { type: "text", text: "ORIGINAL_ONCE" },
              },
            },
          }) + "\n",
        );
      await writeFile(
        cli,
        `#!${process.execPath}
const { readFileSync, writeFileSync, appendFileSync } = require('node:fs');
const { dirname, join } = require('node:path');
const readline = require('node:readline');
const { spawnSync } = require('node:child_process');
const argv = process.argv.slice(2), log = ${JSON.stringify(log)}, file = ${JSON.stringify(file)}, family = ${JSON.stringify(family)}, id = ${JSON.stringify(id)};
appendFileSync(log,JSON.stringify({argv,publicId:process.env.AGENTCTL_SESSION_ID})+'\\n');
if(argv.includes('--help')) { console.log('--experimental-acp'); process.exit(0); }
if(argv.includes('models')) { console.log('Default model: fake\\n* fake'); process.exit(0); }
const send = x => console.log(JSON.stringify({jsonrpc:'2.0',...x}));
readline.createInterface({ input: process.stdin }).on('line', line => {
 const q = JSON.parse(line); appendFileSync(log,JSON.stringify({q})+'\\n');
 if(q.method === 'initialize') { send({id:q.id,result:{protocolVersion:1,agentCapabilities:{loadSession:true,promptCapabilities:{}}}}); return; }
 if(q.method === 'session/load' || q.method === 'session/resume') {
  if(process.env.ACP_FIXTURE_FAIL) send({id:q.id,error:{code:-32000,message:'controlled resume failure'}});
  else if(q.params.sessionId !== id) send({id:q.id,error:{code:-32000,message:'wrong native id'}});
  else send({id:q.id,result:{}}); return;
 }
 if(q.method === 'session/new') { send({id:q.id,result:{sessionId:'unexpected-new-native'}}); return; }
 if(q.method === 'session/prompt') {
  if(family==='grok') appendFileSync(log,JSON.stringify({toolPublicId:spawnSync('bash',['-c','printf %s "$AGENTCTL_SESSION_ID"'],{encoding:'utf8',env:process.env}).stdout})+'\\n');
  const text=q.params.prompt.filter(p=>p.type==='text').map(p=>p.text).join('');
  if(family==='gemini') { const data=JSON.parse(readFileSync(file));data.messages.push({id:'later-user',type:'user',timestamp:'2026-11-01T00:00:02Z',content:text},{id:'later-answer',type:'gemini',timestamp:'2026-11-01T00:00:03Z',content:'OWNED_ACP_REPLY'});writeFileSync(file,JSON.stringify(data)); }
  else { const output=join(dirname(file),'updates.jsonl');for(const [sessionUpdate,contentText] of [['user_message_chunk',text],['agent_message_chunk','OWNED_ACP_REPLY']]) appendFileSync(output,JSON.stringify({timestamp:1793491202,params:{sessionId:id,update:{sessionUpdate,content:{type:'text',text:contentText}}}})+'\\n'); }
  send({method:'session/update',params:{sessionId:id,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'OWNED_ACP_REPLY'}}}});
  send({id:q.id,result:{stopReason:'end_turn'}});return;
 }
 if(q.id!==undefined) send({id:q.id,result:{}});
});
`,
        { mode: 0o755 },
      );
      vi.stubEnv("GROK_HOME", join(root, "grok"));
      vi.stubEnv("GEMINI_CLI_HOME", root);
      vi.resetModules();
      const { createApp } = await import("../setup/create-app.js");
      const { GrokACPProvider } = await import(
        "../../src/sdk/providers/grok-acp.js"
      );
      const { GeminiACPProvider } = await import(
        "../../src/sdk/providers/gemini-acp.js"
      );
      const provider =
        family === "grok"
          ? new GrokACPProvider({ grokPath: cli })
          : new GeminiACPProvider({ geminiPath: cli });
      const source = {
        native: nativeSessionRef(family, scope, id),
        projectId,
        filePath: file,
      };
      let app: ReturnType<typeof createApp> | undefined,
        storage: DiscoverySqliteService | undefined;
      try {
        await expect(
          provider.startSession({
            cwd: other,
            resumeSessionId: id,
            nativeResumeSource: source,
          }),
        ).rejects.toThrow("native working project");
        await expect(
          provider.startSession({
            cwd: project,
            resumeSessionId: id,
            nativeResumeSource: {
              ...source,
              native: nativeSessionRef(family, root, id),
            },
          }),
        ).rejects.toThrow("outside the launch session store");
        expect(await readFile(log, "utf8").catch(() => "")).toBe("");
        vi.stubEnv("ACP_FIXTURE_FAIL", "1");
        const failed = await provider.startSession({
          cwd: project,
          resumeSessionId: id,
          nativeResumeSource: source,
          publicSessionId: "owned-public-refusal",
        });
        const errors = [];
        for await (const event of failed.iterator) errors.push(event);
        expect(JSON.stringify(errors)).toContain("controlled resume failure");
        expect(failed.pid).toBeGreaterThan(0);
        await vi.waitFor(() => expect(failed.isProcessAlive?.()).toBe(false));
        vi.stubEnv("ACP_FIXTURE_FAIL", "");
        for (const stop of ["idle", "at-init"]) {
          const idle = await provider.startSession({
            cwd: project,
            resumeSessionId: id,
            nativeResumeSource: source,
            publicSessionId: "owned-public-idle",
          });
          expect((await idle.iterator.next()).value).toMatchObject({
            type: "system",
            subtype: "init",
            session_id: id,
          });
          const waiting = stop === "idle" ? idle.iterator.next() : undefined;
          if (stop === "at-init") await idle.iterator.return?.();
          else await idle.abort();
          if (waiting) expect((await waiting).done).toBe(true);
          expect(idle.isProcessAlive?.()).toBe(false);
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
          requestId: family + "-cold-resume",
          context: {
            owner: { kind: "superuser" },
            source: { kind: "request", provenance: { surface: "web" } },
          },
          request: {
            projectPath: project,
            projectId,
            provider: launchProvider,
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
          family,
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
          geminiSessionsDir: scope,
          grokSessionsDir: scope,
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
              provider: launchProvider,
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
            "OWNED_ACP_REPLY",
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
        expect(JSON.stringify(body.messages)).toContain("OWNED_ACP_REPLY");
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
        expect(calls.filter((c) => c.q?.method === "session/new")).toHaveLength(
          0,
        );
        expect(
          calls.filter((c) => c.q?.method === "session/prompt"),
        ).toHaveLength(1);
        expect(
          calls
            .filter(
              (c) =>
                c.q?.method === "session/load" ||
                c.q?.method === "session/resume",
            )
            .every(
              (c) => c.q.params.sessionId === id && c.q.params.cwd === project,
            ),
        ).toBe(true);
        if (family === "grok") {
          expect(
            calls
              .filter((c) => c.argv?.includes("stdio"))
              .map((c) => c.publicId),
          ).toEqual([
            "owned-public-refusal",
            "owned-public-idle",
            "owned-public-idle",
            saved.sessionId,
          ]);
          expect(
            calls
              .filter((c) => c.toolPublicId !== undefined)
              .map((c) => c.toolPublicId),
          ).toEqual([saved.sessionId]);
        }
        const transcript = await readFile(
          family === "grok" ? join(folder, "updates.jsonl") : file,
          "utf8",
        );
        expect(transcript.match(/ORIGINAL_ONCE/g)).toHaveLength(1);
        expect(transcript.match(/LATER_ONCE/g)).toHaveLength(1);
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
}
