import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import {
  nativeSessionRef,
  parseNativeSessionId,
  toUrlProjectId,
} from "@yep-anywhere/shared";
import { DiscoverySqliteService } from "../../src/storage/discovery-sqlite.js";
import { openSqliteOrThrow } from "../../src/storage/sqlite.js";
import { SessionMetadataService } from "../../src/metadata/SessionMetadataService.js";

async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

// The real adapter owns an OS process and HTTP exchange; no external CLI/model.
it.skipIf(process.platform === "win32").each([false, true])(
  "cold-resumes OpenCode DB, JSON and export (empty XDG: %s)",
  async (emptyXdg) => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "ya-opencode-resume-")),
    );
    const xdg = emptyXdg
        ? join(root, ".local", "share")
        : join(root, "native-data"),
      scope = join(xdg, "opencode"),
      project = join(root, "project"),
      bin = join(root, "bin"),
      log = join(root, "requests.jsonl");
    await Promise.all(
      [scope, project, bin].map((p) => mkdir(p, { recursive: true })),
    );
    vi.stubEnv("HOME", root);
    vi.stubEnv("XDG_DATA_HOME", emptyXdg ? "" : xdg);
    vi.stubEnv("PATH", bin + ":" + process.env.PATH);
    vi.resetModules();
    const { createApp } = await import("../setup/create-app.js");
    const { MockClaudeSDK } = await import("../../src/sdk/mock.js");
    const { OpenCodeProvider } = await import(
      "../../src/sdk/providers/opencode.js"
    );
    expect(
      (await new OpenCodeProvider().getNewSessionNamespace(project))
        .storageScope,
    ).toBe(scope);
    let app: ReturnType<typeof createApp> | undefined;
    let storage: DiscoverySqliteService | undefined;
    const cli = join(bin, "opencode");
    try {
      for (const layout of ["db", "json", "export"] as const) {
        const id = parseNativeSessionId("ses_owned_" + layout),
          projectId = toUrlProjectId(project),
          exported = join(scope, "fixture-export.json");
        const info = {
          id,
          projectID: "native-project",
          directory: project,
          title: "Selected native " + layout,
          time: { created: 1, updated: 2 },
        };
        const messages = [
          {
            info: {
              id: "seed-" + layout,
              sessionID: id,
              role: "user",
              time: { created: 1 },
            },
            parts: [
              {
                id: "seed-part-" + layout,
                sessionID: id,
                messageID: "seed-" + layout,
                type: "text",
                text: "SELECTED_NATIVE_" + layout,
              },
            ],
          },
        ];
        await writeFile(exported, JSON.stringify({ info, messages }));
        const dbPath = join(scope, "opencode.db");
        const jsonPath = join(
          scope,
          "storage",
          "session",
          "native-project",
          id + ".json",
        );
        if (layout === "db") {
          const db = openSqliteOrThrow(dbPath);
          try {
            db.exec(
              "CREATE TABLE project(id TEXT PRIMARY KEY, worktree TEXT); CREATE TABLE session(id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, agent TEXT, directory TEXT, title TEXT, model TEXT, time_created INTEGER, time_updated INTEGER); CREATE TABLE message(id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT); CREATE TABLE part(id TEXT PRIMARY KEY, session_id TEXT, message_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)",
            );
            db.prepare("INSERT INTO project VALUES (?, ?)").run(
              "native-project",
              project,
            );
            db.prepare(
              "INSERT INTO session VALUES (?, 'native-project', NULL, NULL, ?, ?, NULL, 1, 2)",
            ).run(id, project, info.title);
            db.prepare("INSERT INTO message VALUES (?, ?, 1, 2, ?)").run(
              messages[0]!.info.id,
              id,
              JSON.stringify(messages[0]!.info),
            );
            db.prepare("INSERT INTO part VALUES (?, ?, ?, 1, 2, ?)").run(
              messages[0]!.parts[0]!.id,
              id,
              messages[0]!.info.id,
              JSON.stringify(messages[0]!.parts[0]),
            );
          } finally {
            db.close();
          }
        } else if (layout === "json") {
          for (const path of [
            join(scope, "storage", "project"),
            join(scope, "storage", "session", "native-project"),
            join(scope, "storage", "message", id),
            join(scope, "storage", "part", messages[0]!.info.id),
          ])
            await mkdir(path, { recursive: true });
          await writeFile(
            join(scope, "storage", "project", "native-project.json"),
            JSON.stringify({ id: "native-project", worktree: project }),
          );
          await writeFile(jsonPath, JSON.stringify(info));
          await writeFile(
            join(
              scope,
              "storage",
              "message",
              id,
              messages[0]!.info.id + ".json",
            ),
            JSON.stringify(messages[0]!.info),
          );
          await writeFile(
            join(
              scope,
              "storage",
              "part",
              messages[0]!.info.id,
              messages[0]!.parts[0]!.id + ".json",
            ),
            JSON.stringify(messages[0]!.parts[0]),
          );
        }
        await writeFile(
          cli,
          `#!${process.execPath}
import {createServer} from 'node:http';
import {appendFileSync,readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
const scope=${JSON.stringify(scope)},id=${JSON.stringify(id)},layout=${JSON.stringify(layout)},log=${JSON.stringify(log)},exported=${JSON.stringify(exported)};
const args=process.argv.slice(2);
appendFileSync(log,JSON.stringify({argv:args,pid:process.pid})+'\\n');
if(args.includes('--version')){console.log('1.17.9');process.exit(0);}
if(args[0]==='export'){process.stdout.write(readFileSync(exported));process.exit(0);}
if(args[0]==='session'){console.log(JSON.stringify([JSON.parse(readFileSync(exported)).info]));process.exit(0);}
if(args[0]!=='serve'){console.log('');process.exit(0);}
const port=Number(args[args.indexOf('--port')+1]);
const hostname=args[args.indexOf('--hostname')+1];
if(!args.includes('--hostname')||hostname!=='127.0.0.1')throw Error('Protected listener must pin loopback');
const expected='Basic '+Buffer.from(process.env.OPENCODE_SERVER_USERNAME+':'+process.env.OPENCODE_SERVER_PASSWORD).toString('base64');
const server=createServer(async(req,res)=>{
 if(req.headers.authorization!==expected){res.statusCode=401;res.end();return;}
 let body='';for await(const c of req)body+=c;
 appendFileSync(log,JSON.stringify({method:req.method,url:req.url,id,pid:process.pid})+'\\n');
 res.setHeader('content-type','application/json');
 if(req.url?.startsWith('/event')){res.setHeader('content-type','text/event-stream');res.end();return;}
 if(req.method==='POST'&&req.url==='/session/'+id+'/message'){
  const response={info:{id:'answer-'+id,sessionID:id,role:'assistant',time:{created:3,completed:4}},parts:[{id:'reply-part-'+id,sessionID:id,messageID:'answer-'+id,type:'text',text:'OWNED_REPLY_'+layout}]};
  if(layout==='db'){
   const db=new DatabaseSync(join(scope,'opencode.db'));
   db.prepare('INSERT INTO message VALUES (?, ?, 3, 4, ?)').run(response.info.id,id,JSON.stringify(response.info));
   db.prepare('INSERT INTO part VALUES (?, ?, ?, 3, 4, ?)').run(response.parts[0].id,id,response.info.id,JSON.stringify(response.parts[0]));db.close();
  }else if(layout==='json'){
   mkdirSync(join(scope,'storage','part',response.info.id),{recursive:true});
   writeFileSync(join(scope,'storage','message',id,response.info.id+'.json'),JSON.stringify(response.info));
   writeFileSync(join(scope,'storage','part',response.info.id,response.parts[0].id+'.json'),JSON.stringify(response.parts[0]));
  }else{const data=JSON.parse(readFileSync(exported));data.messages.push(response);writeFileSync(exported,JSON.stringify(data));}
  res.end(JSON.stringify(response));return;
 }
 if(req.method==='POST'&&req.url==='/session'){res.statusCode=409;res.end('unexpected allocation');return;}
 res.end(JSON.stringify([]));
});
server.listen(port,hostname);
process.on('SIGTERM',()=>{server.closeAllConnections();server.close(()=>process.exit(0));});
`,
          { mode: 0o755 },
        );
        const logBefore = await readFile(log, "utf8").catch(() => "");
        await expect(
          new OpenCodeProvider({ opencodePath: cli }).startSession({
            cwd: project,
            resumeSessionId: id,
            nativeResumeSource: {
              native: nativeSessionRef("opencode", root, id),
              projectId,
            },
          }),
        ).rejects.toThrow("outside the launch data store");
        await expect(
          new OpenCodeProvider({ opencodePath: cli }).startSession({
            cwd: project,
            resumeSessionId: "public-handle-is-not-native",
          }),
        ).rejects.toThrow("native ses_ handle");
        expect(await readFile(log, "utf8").catch(() => "")).toBe(logBefore);
        const dataDir = join(root, "ya-" + layout);
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
          requestId: "opencode-cold-" + layout,
          context: {
            owner: { kind: "superuser" },
            source: { kind: "request", provenance: { surface: "web" } },
          },
          request: {
            projectPath: project,
            projectId,
            provider: "opencode",
            message: "SELECTED_NATIVE_" + layout,
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
          family: "opencode",
          storageScope: scope,
        });
        metadata.creations.bindNative(
          fence,
          nativeSessionRef("opencode", scope, id),
        );
        metadata.creations.confirmOwnedInput(
          fence,
          nativeSessionRef("opencode", scope, id),
          saved.initialInputId!,
        );
        if (layout === "db") {
          const foreignMethods: string[] = [];
          const foreign = createHttpServer((request, response) => {
            foreignMethods.push(request.method!);
            response.setHeader("Content-Type", "application/json");
            response.end("[]");
          });
          await new Promise<void>((resolve) =>
            foreign.listen(0, "127.0.0.1", resolve),
          );
          const foreignPort = (foreign.address() as { port: number }).port;
          try {
            const refused = await new OpenCodeProvider({
              opencodePath: cli,
              basePort: foreignPort,
            }).startSession({
              cwd: project,
              resumeSessionId: id,
              nativeResumeSource: {
                native: nativeSessionRef("opencode", scope, id),
                projectId,
              },
            });
            expect((await refused.iterator.next()).value).toMatchObject({
              type: "error",
            });
            expect(foreignMethods).toEqual(["GET"]);
            expect(refused.pid).toBeGreaterThan(0);
            await vi.waitFor(() =>
              expect(refused.isProcessAlive?.()).toBe(false),
            );
          } finally {
            foreign.closeAllConnections();
            await new Promise<void>((resolve) =>
              foreign.close(() => resolve()),
            );
          }
        }
        const port = await freePort();
        const provider = new OpenCodeProvider({
          opencodePath: cli,
          basePort: port,
        });
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
            body: JSON.stringify({
              message: "later owned turn",
              provider: "opencode",
            }),
          },
        );
        expect(response.status, await response.clone().text()).toBe(200);
        const launched = await response.json();
        expect(start).toHaveBeenCalledOnce();
        expect(start.mock.calls[0]![0]).toMatchObject({
          resumeSessionId: id,
          publicSessionId: saved.sessionId,
          nativeResumeSource: {
            native: { family: "opencode", storageScope: scope, id },
          },
        });
        expect(start.mock.calls[0]![0].nativeResumeSource?.filePath).toBe(
          layout === "db" ? dbPath : layout === "json" ? jsonPath : undefined,
        );
        const active = app.supervisor.getProcess(launched.processId)!;
        await vi.waitFor(() =>
          expect(JSON.stringify(active.getMessageHistory())).toContain(
            "OWNED_REPLY_" + layout,
          ),
        );
        expect(active.sessionId).toBe(saved.sessionId);
        expect(
          active
            .getMessageHistory()
            .every((m) => !m.session_id || m.session_id === saved.sessionId),
        ).toBe(true);
        const requests = (await readFile(log, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        expect(
          requests.some(
            (r) =>
              r.argv?.[0] === "serve" &&
              r.argv[r.argv.indexOf("--port") + 1] === String(port),
          ),
        ).toBe(true);
        expect(
          requests.some(
            (r) =>
              r.argv?.[0] === "serve" &&
              r.argv[r.argv.indexOf("--hostname") + 1] === "127.0.0.1",
          ),
        ).toBe(true);
        expect(
          requests.filter((r) => r.method === "POST" && r.url === "/session"),
        ).toEqual([]);
        expect(
          requests.filter(
            (r) => r.method === "POST" && r.url === `/session/${id}/message`,
          ),
        ).toHaveLength(1);
        await app.supervisor.abortProcess(active.id);
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
        expect(JSON.stringify(body.messages)).toContain(
          "OWNED_REPLY_" + layout,
        );
        const list = await (await app.app.request("/api/sessions")).json();
        expect(
          list.sessions.filter((s: { id: string }) => s.id === saved.sessionId),
        ).toHaveLength(1);
        expect(
          list.sessions.filter((s: { id: string }) => s.id === id),
        ).toHaveLength(0);
        app.stopNotifications();
        await app.disposeSessionReaders();
        app = undefined;
        storage.close();
        storage = undefined;
        if (layout === "db") await rm(dbPath);
        if (layout === "json")
          await rm(join(scope, "storage"), { recursive: true });
      }
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
  20000,
);
