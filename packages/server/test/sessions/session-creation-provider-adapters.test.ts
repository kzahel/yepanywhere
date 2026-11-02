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
  parseYaSessionId,
  toUrlProjectId,
} from "@yep-anywhere/shared";
import { GrokACPProvider } from "../../src/sdk/providers/grok-acp.js";
import { GeminiACPProvider } from "../../src/sdk/providers/gemini-acp.js";
import { CodexOSSProvider } from "../../src/sdk/providers/codex-oss.js";
import { Supervisor } from "../../src/supervisor/Supervisor.js";
import { getLogger } from "../../src/logging/logger.js";

import {
  closeTestDiscoveryDatabases,
  createTestSessionMetadataService,
} from "../utils/session-metadata-database.js";

// Real adapter/stdio children plus SQLite; no provider account or model network.
it.skipIf(process.platform === "win32").each(
  (["grok", "gemini-acp", "codex-oss"] as const).flatMap((name) => [
    { name, lostProof: false },
    { name, lostProof: true },
  ]),
)(
  "$name preserves admission through native proof (owner loss: $lostProof)",
  async ({ name, lostProof }) => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "ya-admitted-adapter-")),
    );
    const project = join(root, "project"),
      home = join(root, "home"),
      cli = join(root, "provider"),
      log = join(root, "native-calls.jsonl"),
      release = join(root, "release"),
      data = join(root, "data");
    await Promise.all([project, home].map((p) => mkdir(p)));
    const scope =
      name === "grok"
        ? join(home, "sessions")
        : name === "gemini-acp"
          ? join(home, ".gemini", "tmp")
          : join(home, "sessions");
    const nativeId = "310ed378-49e7-40be-9ab8-0f1d371cd079",
      file = join(scope, "owned.jsonl"),
      projectId = toUrlProjectId(project);
    await mkdir(scope, { recursive: true });
    await writeFile(
      file,
      JSON.stringify({
        type: "session_meta",
        payload: { id: nativeId, cwd: project },
      }) + "\n",
    );
    await writeFile(
      cli,
      `#!${process.execPath}
const fs=require('node:fs'),rl=require('node:readline'),id=${JSON.stringify(nativeId)},log=${JSON.stringify(log)},release=${JSON.stringify(release)};
const argv=process.argv.slice(2);
if(argv.includes('--version')){console.log('codex-cli 0.166.0');process.exit(0);}
if(argv.includes('--help')){console.log('--experimental-acp');process.exit(0);}
const record=v=>fs.appendFileSync(log,JSON.stringify(v)+'\\n');
const wait=()=>new Promise(r=>{const t=setInterval(()=>{if(fs.existsSync(release)){clearInterval(t);r();}},5)});
if(argv[0]==='exec'){
 record({method:argv[1]==='resume'?'resume':'new',id:argv[1]==='resume'?argv[2]:id});
 console.log(JSON.stringify({type:'thread.started',thread_id:id}));
 wait().then(()=>{console.log(JSON.stringify({type:'turn.started'}));console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:1,cached_input_tokens:0}}));});
 process.stdin.resume(); process.stdin.on('data',()=>{});
}else{
 const send=v=>console.log(JSON.stringify(v));
 rl.createInterface({input:process.stdin}).on('line',async line=>{const q=JSON.parse(line);let result;
 if(q.method==='initialize')result={protocolVersion:1,agentCapabilities:{loadSession:true},authMethods:[]};
 else if(q.method==='session/new'){record({method:'new',id});result={sessionId:id};}
 else if(q.method==='session/load'||q.method==='session/resume'){record({method:'resume',id:q.params.sessionId});result={};}
 else if(q.method==='session/prompt'){record({method:'prompt',id:q.params.sessionId,prompt:q.params.prompt});await wait();result={stopReason:'end_turn'};}
 else result={};
 if(q.id!==undefined)send({jsonrpc:'2.0',id:q.id,result});
 });
}
`,
      { mode: 0o755 },
    );
    vi.stubEnv("GROK_HOME", home);
    vi.stubEnv("GEMINI_CLI_HOME", home);
    vi.stubEnv("CODEX_HOME", home);
    const provider =
      name === "grok"
        ? new GrokACPProvider({ grokPath: cli })
        : name === "gemini-acp"
          ? new GeminiACPProvider({ geminiPath: cli })
          : new CodexOSSProvider({ codexPath: cli });
    const nativeIterators: Array<AsyncIterableIterator<unknown>> = [];
    const startNative = provider.startSession.bind(provider);
    vi.spyOn(provider, "startSession").mockImplementation(async (options) => {
      const result = await startNative(options);
      nativeIterators.push(result.iterator);
      return result;
    });
    // Availability is controlled; all execution and evidence use the real adapter.
    vi.spyOn(provider, "getAuthStatus").mockResolvedValue({
      installed: true,
      authenticated: true,
      enabled: true,
    });
    vi.spyOn(provider, "getAvailableModels").mockResolvedValue([]);
    const errors = vi.spyOn(getLogger(), "error").mockImplementation(() => {});
    const warnings = vi.spyOn(getLogger(), "warn").mockImplementation(() => {});
    const metadata = createTestSessionMetadataService(data);
    await metadata.initialize();
    let supervisor: Supervisor | undefined;
    const calls = async () =>
      (await readFile(log, "utf8").catch(() => ""))
        .split("\n")
        .filter(Boolean)
        .map((s) => JSON.parse(s));
    try {
      supervisor = new Supervisor({
        provider,
        sessionMetadataService: metadata,
      });
      let savedId = "";
      const process = await supervisor.startSession(
        project,
        { text: "FIRST_EXACT" },
        undefined,
        undefined,
        {
          creation: {
            requestId: "owned-adapter-start",
            context: {
              owner: { kind: "superuser" },
              source: { kind: "request", provenance: { surface: "web" } },
            },
            authorize: async () => {},
            onAccepted(saved) {
              savedId = saved.sessionId;
              expect(
                metadata.creations.getForSession(saved.sessionId)?.request
                  ?.message,
              ).toBe("FIRST_EXACT");
            },
          },
        },
      );
      if ("queued" in process || "error" in process)
        throw Error("unexpected queue");
      expect(process.sessionId).toBe(savedId);
      expect(savedId).not.toBe(nativeId);
      await vi.waitFor(() =>
        expect(
          metadata.creations.getForSession(parseYaSessionId(savedId))?.attempt
            .state,
        ).toBe("bound"),
      );
      expect(
        metadata.creations.getForSession(parseYaSessionId(savedId))?.attempt
          .delivery,
      ).not.toBe("consumed");
      if (lostProof) {
        await process.abort();
        await vi.waitFor(() =>
          expect(
            metadata.creations.getForSession(parseYaSessionId(savedId))?.attempt
              .state,
          ).toBe("uncertain"),
        );
        const reopened = createTestSessionMetadataService(data);
        await reopened.initialize();
        const refusing = new Supervisor({
          provider,
          sessionMetadataService: reopened,
        });
        try {
          await expect(
            refusing.resumeSession(savedId, project, {
              text: "MUST_NOT_ALLOCATE",
            }),
          ).rejects.toThrow("startup has not completed");
          expect(
            (await calls()).filter((c) => c.method === "new"),
          ).toHaveLength(1);
        } finally {
          await refusing.stopBackgroundTasks();
        }
        return;
      }
      await writeFile(release, "");
      await vi.waitFor(() =>
        expect(
          metadata.creations.getForSession(parseYaSessionId(savedId))?.attempt
            .delivery,
        ).toBe("consumed"),
      );
      expect(
        metadata.identities.resolveYa(parseYaSessionId(savedId))?.native,
      ).toEqual(
        nativeSessionRef(
          name === "codex-oss"
            ? "codex"
            : name === "gemini-acp"
              ? "gemini"
              : "grok",
          scope,
          parseNativeSessionId(nativeId),
        ),
      );
      await process.abort();
      await supervisor.stopBackgroundTasks();
      const reopened = createTestSessionMetadataService(data);
      await reopened.initialize();
      supervisor = new Supervisor({
        provider,
        sessionMetadataService: reopened,
        resolveNativeSessionSource: async () => ({
          native: nativeSessionRef(
            name === "codex-oss"
              ? "codex"
              : name === "gemini-acp"
                ? "gemini"
                : "grok",
            scope,
            parseNativeSessionId(nativeId),
          ),
          projectId,
          filePath: file,
        }),
      });
      const resumed = await supervisor.resumeSession(savedId, project, {
        text: "SECOND_EXACT",
      });
      if ("queued" in resumed || "error" in resumed)
        throw Error("unexpected queue");
      expect(resumed.sessionId).toBe(savedId);
      await vi.waitFor(async () =>
        expect((await calls()).some((c) => c.method === "resume")).toBe(true),
      );
      const nativeCalls = await calls();
      expect(nativeCalls.filter((c) => c.method === "new")).toHaveLength(1);
      expect(nativeCalls.find((c) => c.method === "resume")?.id).toBe(nativeId);
      expect(
        reopened.creations.getForSession(parseYaSessionId(savedId))?.request
          ?.message,
      ).toBe("FIRST_EXACT");
    } finally {
      for (const p of supervisor?.getAllProcesses() ?? []) await p.abort();
      await supervisor?.stopBackgroundTasks();
      for (const iterator of nativeIterators) await iterator.return?.();
      for (const c of warnings.mock.calls)
        expect(String(c[1])).toMatch(
          /Process terminated|Provider teardown remains unverified/,
        );
      for (const c of errors.mock.calls)
        expect(String(c[1])).toMatch(
          /Grok prompt error|Grok ACP session error|Prompt error|Gemini ACP session error/,
        );
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      closeTestDiscoveryDatabases();
      await rm(root, { recursive: true, force: true });
    }
  },
);
