import { createReadStream } from "node:fs";
import {
  chmod,
  mkdtemp,
  readFile,
  realpath,
  rm,
  truncate,
  writeFile,
  mkdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toUrlProjectId } from "@yep-anywhere/shared";
import { createProvidersRoutes } from "../../../src/routes/providers.js";
import { AntigravityProvider } from "../../../src/sdk/providers/antigravity.js";
import { AntigravityRuntime } from "../../../src/sdk/providers/antigravity-runtime.js";
import { AntigravitySubagentTracker } from "../../../src/sdk/providers/antigravity-subagent-tracker.js";
import {
  antigravityLiveHistory,
  antigravityOwnerView,
} from "../../../src/sdk/providers/antigravity-owners.js";
import { setAntigravityLiveLimitsForTests } from "../../../src/sdk/providers/antigravity-live-projection.js";
import {
  observeOwnedAntigravity,
  type NativeProcessDiagnostic,
} from "../../native-provider/native-process-diagnostics.js";
import { AntigravitySessionCatalogAdapter } from "../../../src/sessions/catalog-adapters/antigravity-catalog-adapter.js";
import { createCatalogSessionLookup } from "../../../src/sessions/catalog-session-lookup.js";
import { projectCatalogIdentities } from "../../../src/sessions/catalog-identity.js";
import { AntigravitySessionReader } from "../../../src/sessions/antigravity-reader.js";
import type { SDKMessage } from "../../../src/sdk/types.js";
import type { Process } from "../../../src/supervisor/Process.js";
import { createApp } from "../../setup/create-app.js";
import { writeAntigravitySummaries } from "../../utils/antigravity-store.js";
import { writeAntigravityScaleConversation } from "../../utils/antigravity-scale-log.js";
import {
  antigravityLogLines,
  projectAntigravityLog,
} from "../../../src/sessions/antigravity-log-projection.js";
import { EventBus } from "../../../src/watcher/EventBus.js";
import { createProviderConversationSource } from "../../../src/experimental/provider-conversation-source.js";
import {
  createTestSessionMetadataService,
  closeTestDiscoveryDatabases,
} from "../../utils/session-metadata-database.js";

const nativeId = "11111111-1111-4111-8111-111111111111";
// The pinned agy reports this version from ACP initialize.
const nativeVersion = "1.5.13";
const peer = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const id = '${nativeId}';
const root = path.join(process.env.GEMINI_HOME, 'antigravity-cli', 'conversations');
const send = value => process.stdout.write(JSON.stringify(value)+'\\n');
const reply = (id, result) => send({jsonrpc:'2.0', id, result});
const update = (value, meta) => send({jsonrpc:'2.0',method:'session/update',params:{sessionId:id,update:value,_meta:meta}});
let prompt;
// With AGY_TEST_LOG_TURNS, append each ended step to the brain log as agy does.
const brainLog = path.join(process.env.GEMINI_HOME, 'antigravity-cli', 'brain', id, '.system_generated', 'logs', 'transcript_full.jsonl');
const logStep = (type, source, fields) => {
 if (!process.env.AGY_TEST_LOG_TURNS) return;
 fs.mkdirSync(path.dirname(brainLog),{recursive:true});
 fs.appendFileSync(brainLog, '');
 const fd = fs.openSync(brainLog, 'r');
 const size = fs.fstatSync(fd).size;
 // The last line's head, however long that line is.
 let read = Math.min(size, 65536);
 let tail = Buffer.alloc(0);
 for (;;) {
  tail = Buffer.alloc(read);
  fs.readSync(fd, tail, 0, read, size - read);
  if (read === size || tail.subarray(0, read - 1).includes(10)) break;
  read = Math.min(size, read * 2);
 }
 fs.closeSync(fd);
 const last = tail.toString('utf8').trimEnd().split('\\n').pop();
 const step = last ? JSON.parse(last).step_index + 1 : 0;
 fs.appendFileSync(brainLog, JSON.stringify({step_index:step,source,type,status:'DONE',created_at:new Date().toISOString(),...fields})+'\\n');
};
// agy keeps the first 192,000 UTF-8 bytes of a longer request (measured).
const agyClip = content => {
 const bytes = Buffer.from(content, 'utf8');
 if (bytes.length <= 192000) return content;
 let end = 192000;
 while ((bytes[end] & 0xc0) === 0x80) end--;
 return bytes.subarray(0, end).toString('utf8') + '\\n<truncated ' + (bytes.length - end) + ' bytes>\\n\\nNOTE: The output was truncated because it was too long. Use a more targeted query or a smaller range to get the information you need.';
};
// A detached wake after a 'wake' turn: AGY_TEST_LOG.wake1 starts it (its
// task-end message is logged, its first chunk sent), AGY_TEST_LOG.wake2
// ends it (its last chunk sent, its reply logged). A prompt arriving while
// it is open waits until it is logged, as agy logged a wake's reply before
// the next prompt's input.
let wake = 'none';
let heldPrompt;
const watchWake = () => {
 const timer = setInterval(() => {
  if (wake === 'armed' && fs.existsSync(process.env.AGY_TEST_LOG+'.wake1')) {
   wake = 'open';
   const nl = String.fromCharCode(10);
   logStep('SYSTEM_MESSAGE','SYSTEM',{content:'The following is a <SYSTEM_MESSAGE> not actually sent by the user. It is provided by the system as important information to pay attention to.'+nl+nl+'<SYSTEM_MESSAGE>'+nl+'[Message] task-1 finished with result: done'+nl+'</SYSTEM_MESSAGE>'});
   update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'WAKE_HEAD '}});
  } else if (wake === 'open' && fs.existsSync(process.env.AGY_TEST_LOG+'.wake2')) {
   wake = 'done';
   clearInterval(timer);
   update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'WAKE_TAIL'}});
   logStep('PLANNER_RESPONSE','MODEL',{content:'WAKE_HEAD WAKE_TAIL'});
   if (heldPrompt) { const held = heldPrompt; heldPrompt = undefined; onLine(held); }
  }
 }, 5);
};
const onLine = line => {
 const m = JSON.parse(line);
 if(m.method === 'session/prompt' && wake === 'open') { heldPrompt = line; return; }
 if(m.method) fs.appendFileSync(process.env.AGY_TEST_LOG,m.method+'\\n');
 if(m.method === 'initialize') {
  return reply(m.id,{protocolVersion:1,agentInfo:{version:'${nativeVersion}'}});
 }
 if(m.method === 'session/new') {
  fs.mkdirSync(root,{recursive:true});
  fs.writeFileSync(path.join(root,id+'.db'),'native fixture');
  return reply(m.id,{sessionId:id,models:{currentModelId:'native-default',availableModels:[{modelId:'native-default',name:'Native default'}]}});
 }
 if(m.method === 'session/resume' && m.params.sessionId !== id)
  return send({jsonrpc:'2.0',id:m.id,error:{code:-32000,message:'Native resume refused'}});
 // session/resume replays nothing, whatever the history holds.
 if(m.method === 'session/resume') return reply(m.id,{});
 if(m.method === 'session/list') return reply(m.id,{sessions:[{sessionId:id,title:'Original question'}]});
 if(m.method === 'session/prompt') {
  prompt=m.id;
  logStep('USER_INPUT','USER_EXPLICIT',{content:agyClip('<USER_REQUEST>\\n'+m.params.prompt[0].text+'\\n</USER_REQUEST>')});
  // An echo of the prompt, which YA ignores (agy 1.5.13 and 1.5.14 send none).
  update({sessionUpdate:'user_message_chunk',content:{type:'text',text:m.params.prompt[0].text}});
  update({sessionUpdate:'usage_update',used:123,size:1048576});
  // agy sends permission requests with string IDs; numeric ones are valid too.
  const permissionId = {approval:'1','approval-numeric':100}[m.params.prompt[0].text];
  if(permissionId !== undefined) {
   return send({jsonrpc:'2.0',id:permissionId,method:'session/request_permission',params:{sessionId:id,
    toolCall:{toolCallId:'tool-1',title:'Write file',kind:'edit'},
    options:[{optionId:'native-allow',name:'Allow',kind:'allow_once'},{optionId:'native-deny',name:'Deny',kind:'reject_once'}]}});
  }
  if(m.params.prompt[0].text === 'big') {
   for (let chunk = 0; chunk < 3; chunk++)
    update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'y'.repeat(1024*1024)}});
   logStep('PLANNER_RESPONSE','MODEL',{content:'y'.repeat(3*1024*1024)});
   return reply(m.id,{stopReason:'end_turn'});
  }
  if(m.params.prompt[0].text === 'wait') {
   update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Waiting'}});
   return;
  }
  if(m.params.prompt[0].text === 'wake') { wake = 'armed'; watchWake(); }
  // AGY_TEST_RECORD_ORDER: the reply's record before its last chunk, or
  // after the prompt's result, instead of between them.
  const order = process.env.AGY_TEST_RECORD_ORDER;
  const planner = () => logStep('PLANNER_RESPONSE','MODEL',{content:'Hello world'});
  update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Hello '}});
  if (order === 'before-chunk') planner();
  update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'world'}});
  if (!order) planner();
  reply(m.id,{stopReason:'end_turn'});
  if (order === 'after-result') setTimeout(planner, 30);
  return;
 }
 if(!m.method && (m.id==='1' || m.id===100)) {
  const outcome = m.result ? (m.result.outcome.optionId ?? m.result.outcome.outcome) : 'error '+m.error?.code;
  fs.appendFileSync(process.env.AGY_TEST_LOG,'answer '+JSON.stringify(m.id)+' '+outcome+'\\n');
  if(!m.result || m.result.outcome.outcome === 'cancelled') return;
  update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:m.result.outcome.optionId}});
  return reply(prompt,{stopReason:'end_turn'});
 }
 if(m.method === 'session/cancel') return reply(prompt,{stopReason:'cancelled'});
 return reply(m.id,{});
};
readline.createInterface({input:process.stdin}).on('line', onLine);
`;

async function waitForIdle(
  process: Process,
  signal: AbortSignal,
  ready: (process: Process) => boolean = () => true,
) {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const abort = () => finish(signal.reason);
    const finish = (error?: unknown) => {
      unsubscribe();
      signal.removeEventListener("abort", abort);
      if (error !== undefined) reject(error);
      else resolve();
    };
    const observe = () => {
      const state = process.state;
      if (state.type === "idle" && ready(process)) finish();
      if (state.type === "terminated")
        finish(state.error ?? new Error(state.reason));
    };
    const unsubscribe = process.subscribe((event) => {
      if (event.type === "error") finish(event.error);
      else observe();
    });
    signal.addEventListener("abort", abort, { once: true });
    observe();
  });
}

describe("Antigravity native process boundary", () => {
  let directory: string;
  let executable: string;
  let log: string;
  let store: string;
  let admissionFinished: Promise<void> | undefined;
  beforeEach(async () => {
    // The temp root is itself a link on macOS; a project is its real folder.
    directory = await realpath(await mkdtemp(join(tmpdir(), "ya-agy-test-")));
    await mkdir(join(directory, "bin"));
    executable = join(directory, "bin", "agy");
    log = join(directory, "methods.log");
    await writeFile(executable, peer);
    await chmod(executable, 0o755);
    // agy opens HOME/.gemini unless YA passes --gemini-dir.
    const home = join(directory, "home");
    store = join(home, ".gemini", "antigravity-cli");
    await writeAntigravitySummaries(store, [{ id: nativeId, cwd: directory }]);
    vi.stubEnv("HOME", home);
    vi.stubEnv("GEMINI_HOME", join(home, ".gemini"));
    vi.stubEnv("ANTIGRAVITY_ACP_PATH", executable);
    vi.stubEnv("AGY_TEST_LOG", log);
  });
  /** Spies a test installs on shared prototypes, restored after it. */
  const spies: Array<{ mockRestore(): void }> = [];
  afterEach(async () => {
    for (const spy of spies.splice(0)) spy.mockRestore();
    setAntigravityLiveLimitsForTests();
    await admissionFinished;
    admissionFinished = undefined;
    closeTestDiscoveryDatabases();
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  });

  it.skipIf(process.platform === "win32")(
    "admits a real child through YA and reopens its native conversation under the same public identity",
    async ({ signal }) => {
      const finished = Promise.withResolvers<void>();
      admissionFinished = finished.promise;
      try {
        await exerciseAdmission(signal);
      } finally {
        finished.resolve();
      }
    },
    // Three real child launches took up to 2.2s under local CPU contention. Earlier full-suite runs exhausted a 1s startup
    // wait before reaching any of the reopen steps.
    8_000,
  );

  async function exerciseAdmission(signal: AbortSignal) {
    vi.stubEnv("ENABLED_PROVIDERS", "antigravity");
    // The peer logs each turn, as agy does.
    vi.stubEnv("AGY_TEST_LOG_TURNS", "1");
    const metadata = createTestSessionMetadataService(join(directory, "data"));
    await metadata.initialize();
    signal.throwIfAborted();
    const provider = new AntigravityProvider();
    const boot = () =>
      createApp({
        provider,
        dataDir: join(directory, "data"),
        sessionMetadataService: metadata,
        eventBus: new EventBus(),
        authDisabled: true,
        enabledProviders: ["antigravity"],
      });
    let app = boot();
    const startup = vi.spyOn(app.supervisor, "startSession");
    const projectId = toUrlProjectId(directory);
    let failure: { error: unknown } | undefined;
    try {
      const response = await app.app.request(
        `/api/projects/${projectId}/session-creations`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Yep-Anywhere": "true",
          },
          body: JSON.stringify({
            requestId: "preview-admission",
            message: "hello",
            provider: "antigravity",
            mode: "default",
          }),
        },
      );
      expect(response.status).toBe(202);
      const receipt = await response.json();
      const started = await startup.mock.results[0]?.value;
      let active = app.supervisor.getProcessForSession(receipt.sessionId);
      if (!active) throw new Error("Accepted creation has no active owner");
      expect(active).toBe(started);
      await waitForIdle(active, signal);
      expect(active.resolvedModel).toBe("native-default");
      expect(active.getMessageHistory().some((m) => m.type === "result")).toBe(
        true,
      );
      expect(metadata.identities.resolveYa(receipt.sessionId)?.native?.id).toBe(
        nativeId,
      );
      expect(receipt.sessionId).not.toBe(nativeId);
      // The native prompt echo must not duplicate YA's own user message.
      expect(
        active
          ?.getMessageHistory()
          .filter((m) => m.type === "user" && m.message?.content === "hello"),
      ).toHaveLength(1);
      // An anchored catch-up is incremental: the reader must leave the
      // anchor for the route to find, or the client replaces its window.
      const detailPath = `/api/projects/${projectId}/sessions/${receipt.sessionId}`;
      const detail = await (
        await app.app.request(detailPath, {
          headers: { "X-Yep-Anywhere": "true" },
        })
      ).json();
      const [first, ...rest] = detail.messages as Array<{ uuid: string }>;
      const anchored = await (
        await app.app.request(
          `${detailPath}?afterMessageId=${encodeURIComponent(first!.uuid)}`,
          { headers: { "X-Yep-Anywhere": "true" } },
        )
      ).json();
      expect(anchored.pagination).toBeUndefined();
      expect(anchored.messages.map((m: { uuid: string }) => m.uuid)).toEqual(
        rest.map((m) => m.uuid),
      );
      const nativeCatalog = await new AntigravitySessionCatalogAdapter().scan({
        catalogEpoch: "test",
        targetGeneration: 1,
        mode: { kind: "complete" },
        signal: new AbortController().signal,
      });
      const publicRows = await projectCatalogIdentities(
        nativeCatalog.rows,
        metadata,
      );
      expect(
        publicRows.find((row) => row.nativeSessionId === nativeId)?.sessionId,
      ).toBe(receipt.sessionId);
      expect(
        await projectCatalogIdentities(nativeCatalog.rows, metadata),
      ).toEqual(publicRows);

      const row = nativeCatalog.rows[0]!;
      const lookup = createCatalogSessionLookup(
        {
          readPublishedProjectRows: async () => [
            {
              ...row,
              nativeStorageScope: `${row.nativeStorageScope}-foreign`,
              title: "Wrong store",
            },
            { ...row, title: "Exact native title" },
          ],
        },
        metadata,
      );
      expect((await lookup(projectId, receipt.sessionId))?.title).toBe(
        "Exact native title",
      );
      expect(
        await lookup(projectId, receipt.sessionId, "codex"),
      ).toBeUndefined();
      expect(
        await lookup(
          toUrlProjectId(join(directory, "foreign-project")),
          receipt.sessionId,
        ),
      ).toBeUndefined();
      expect(metadata.identities.resolveYa(nativeId)).toBeUndefined();
      const reader = new AntigravitySessionReader({ projectPath: directory });
      try {
        expect(
          JSON.stringify(await reader.getSession(nativeId, projectId)),
        ).toContain("Hello world");
        expect(await readFile(log, "utf8")).not.toContain("session/load");
      } finally {
        await reader.close();
      }
      await active.abort();
      app.stopNotifications();
      await app.disposeSessionReaders();
      app = boot();
      const history = await (
        await app.app.request(detailPath, {
          headers: { "X-Yep-Anywhere": "true" },
        })
      ).json();
      expect(JSON.stringify(history.messages)).toContain("Hello world");
      const reactivate = await app.app.request(`${detailPath}/reactivate`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Yep-Anywhere": "true",
        },
        body: JSON.stringify({ provider: "antigravity" }),
      });
      expect(reactivate.status).toBe(200);
      active = app.supervisor.getProcessForSession(receipt.sessionId);
      if (!active) throw new Error("Reactivation has no active owner");
      // The reactivated owner reopens the conversation without a prompt.
      await vi.waitFor(async () =>
        expect(await readFile(log, "utf8")).toContain("session/resume"),
      );
      await waitForIdle(active, signal);
      expect(
        (await readFile(log, "utf8"))
          .split("\n")
          .filter((method) => method === "session/prompt"),
      ).toHaveLength(1);
      await active.abort();
      const resume = await app.app.request(
        `/api/projects/${projectId}/sessions/${receipt.sessionId}/resume`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Yep-Anywhere": "true",
          },
          body: JSON.stringify({
            message: "continue",
            provider: "antigravity",
            mode: "default",
          }),
        },
      );
      expect(resume.status).toBe(200);
      active = app.supervisor.getProcessForSession(receipt.sessionId);
      if (!active) throw new Error("Resume has no active owner");
      await waitForIdle(active, signal);
      const resumedHistory = JSON.stringify(active.getMessageHistory());
      expect(resumedHistory).toContain("continue");
      expect(resumedHistory).toContain("Hello world");
      // Reactivation and resume both reopened with session/resume.
      const methods = (await readFile(log, "utf8")).split("\n");
      expect(methods.filter((m) => m === "session/resume")).toHaveLength(2);
      expect(methods).not.toContain("session/load");
      expect(metadata.identities.resolveYa(receipt.sessionId)?.native?.id).toBe(
        nativeId,
      );
    } catch (error) {
      failure = { error };
    }
    app.stopNotifications();
    await Promise.allSettled(startup.mock.results.map(({ value }) => value));
    startup.mockRestore();
    const cleanup = await Promise.allSettled(
      app.supervisor.getAllProcesses().map((process) => process.abort()),
    );
    const errors = cleanup.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    try {
      await app.disposeSessionReaders();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length > 0) {
      throw new AggregateError(
        failure ? [failure.error, ...errors] : errors,
        "Antigravity admission fixture cleanup failed",
      );
    }
    if (failure) throw failure.error;
  }

  // Exact native signal status is POSIX-only; the exit-code path stays portable.
  it.each(
    process.platform === "win32"
      ? (["exit"] as const)
      : (["exit", "signal"] as const),
  )(
    "retains owned bootstrap %s diagnostics without private URL tails",
    async (outcome) => {
      const diagnostics: NativeProcessDiagnostic[] = [];
      // A prior teardown may still own the spy; replacement must not recurse.
      const previousObserver = observeOwnedAntigravity([]);
      const observer = observeOwnedAntigravity(diagnostics);
      const runtime = new AntigravityRuntime();
      const stderr =
        `https://accounts.example/authorize?state=${"x".repeat(20_000)}SPLIT_PRIVATE_MARKER\n` +
        String.raw`open https:\/\/accounts.example/authorize?client_id=OWNED_CLIENT` +
        "\n" +
        "open https://accounts.example/authorize?state=OWNED_PLAIN\n" +
        '"code": "OWNED_CODE_01234567890123456789"\nkey=OWNED_KEY_01234567890123456789\n"state": "OWNED_STATE_01234567890123456789"\n' +
        "&code_challenge=OWNED_CHALLENGE&client_id=OWNED_CLIENTID\n" +
        "api_key=OWNED_SECRET\nordinary owned native failure\n" +
        "rpc error: code = Unavailable desc = owned failure\ncode: 'ENOENT'\n" +
        "loader: error while loading shared libraries: libsecret-1.so.0: missing\n";
      const script = `require('node:readline').createInterface({input:process.stdin}).once('line',()=>{
        process.stderr.write(${JSON.stringify(stderr)},()=>${outcome === "exit" ? "process.exit(7)" : "process.kill(process.pid, 'SIGTERM')"});
      });`;
      try {
        await expect(
          runtime.connect(process.execPath, directory, ["-e", script]),
        ).rejects.toThrow("closed");
        await runtime.closed;
        expect(diagnostics).toHaveLength(1);
        expect(diagnostics[0]).toMatchObject({
          exitCode: outcome === "exit" ? 7 : null,
          signal: outcome === "signal" ? "SIGTERM" : null,
          truncated: true,
        });
        const report = diagnostics[0]!.stderr!;
        expect(report).toContain("ordinary owned native failure");
        expect(report).toContain(
          "rpc error: code = Unavailable desc = owned failure",
        );
        expect(report).toContain("code: 'ENOENT'");
        expect(report).toContain("Missing native library: libsecret-1.so.0");
        for (const secret of [
          "https://",
          "SPLIT_PRIVATE_MARKER",
          "OWNED_SECRET",
          "accounts.example",
          "OWNED_CLIENT",
          "OWNED_PLAIN",
          "OWNED_CODE",
          "OWNED_KEY",
          "OWNED_STATE",
          "OWNED_CHALLENGE",
          "OWNED_CLIENTID",
        ])
          expect(report).not.toContain(secret);
      } finally {
        await runtime.close();
        observer.mockRestore();
        previousObserver.mockRestore();
      }
    },
  );

  it("accepts newer native notifications and rejects in-flight requests on real child teardown", async () => {
    const runtime = new AntigravityRuntime();
    let observed!: () => void;
    const started = new Promise<void>((resolve) => {
      observed = resolve;
    });
    runtime.onUpdate = () => observed();
    try {
      await runtime.connect(process.execPath, directory, [executable]);
      const pending = runtime.call(
        "session/prompt",
        { sessionId: nativeId, prompt: [{ type: "text", text: "wait" }] },
        0,
      );
      const rejected = expect(pending).rejects.toThrow("closed");
      await started;
      await runtime.close();
      await rejected;
      expect(runtime.alive).toBe(false);
    } finally {
      await runtime.close();
    }
  });

  // agy 1.5.13 and 1.5.14 send string IDs; a numeric ID must work as well.
  it.skipIf(process.platform === "win32").each([
    ["approval", '"1"'],
    ["approval-numeric", "100"],
  ])(
    "streams and answers a native approval (%s, ID %s) without owning login",
    async (text, echoedId) => {
      const provider = new AntigravityProvider();
      const session = await provider.startSession({
        cwd: directory,
        model: "default",
        initialMessage: { text, uuid: "input-1" },
        onToolApproval: async () => ({ behavior: "allow" }),
      });
      try {
        const messages: SDKMessage[] = [];
        for await (const message of session.iterator) {
          messages.push(message);
          if (message.type === "result") break;
        }
        expect(
          messages.find((message) => message.type === "assistant")?.message
            ?.content,
        ).toBe("native-allow");
        expect(
          messages.find((message) => message.type === "system")?.model,
        ).toBe("native-default");
        expect(
          messages.find((message) => message.type === "assistant")?.message
            ?.model,
        ).toBe("native-default");
        const lines = (await readFile(log, "utf8")).trim().split("\n");
        expect(lines).not.toContainEqual(
          expect.stringMatching(/authenticate|logout|set_model|set_mode/),
        );
        // The answer echoes the request's own ID, type included.
        expect(lines.filter((line) => line.startsWith("answer "))).toEqual([
          `answer ${echoedId} native-allow`,
        ]);
      } finally {
        await session.abort();
      }
      expect(session.isProcessAlive?.()).toBe(false);
    },
  );

  it.skipIf(process.platform === "win32")(
    "publishes partial text as streaming snapshots, then commits it",
    async () => {
      const session = await new AntigravityProvider().startSession({
        cwd: directory,
        initialMessage: { text: "hello", uuid: "input-1" },
      });
      try {
        const messages: SDKMessage[] = [];
        for await (const message of session.iterator) {
          messages.push(message);
          if (message.type === "result") break;
        }
        const turn = messages.filter(
          (m) => m.type === "user" || m.type === "assistant",
        );
        // Snapshots may coalesce before the consumer reads them.
        const [echo, ...assistant] = turn;
        const committed = assistant.pop();
        expect([echo?.type, echo?.message?.content]).toEqual(["user", "hello"]);
        expect(assistant.length).toBeGreaterThan(0);
        expect(assistant.every((m) => m._isStreaming === true)).toBe(true);
        expect(committed?._isStreaming).toBeUndefined();
        expect(committed?.message?.content).toBe("Hello world");
        expect(new Set(turn.slice(1).map((m) => m.uuid)).size).toBe(1);
        expect(turn.every((m) => typeof m.timestamp === "string")).toBe(true);
      } finally {
        await session.abort();
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "interrupts an active native prompt through session/cancel",
    async () => {
      const session = await new AntigravityProvider().startSession({
        cwd: directory,
        initialMessage: { text: "wait" },
      });
      try {
        let interrupted = false;
        for await (const message of session.iterator) {
          if (message.type === "assistant") {
            expect(await session.interrupt?.()).toBe(true);
            interrupted = true;
          }
          if (message.type === "result") break;
        }
        expect(interrupted).toBe(true);
        expect(await readFile(log, "utf8")).toContain("session/cancel");
      } finally {
        await session.abort();
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "never creates or prompts after a native cold-resume refusal",
    async () => {
      const session = await new AntigravityProvider().startSession({
        cwd: directory,
        resumeSessionId: "22222222-2222-4222-8222-222222222222",
        initialMessage: { text: "must not send" },
      });
      try {
        const messages: SDKMessage[] = [];
        for await (const message of session.iterator) messages.push(message);
        expect(messages).toEqual([
          { type: "error", error: "Native resume refused" },
        ]);
        expect((await readFile(log, "utf8")).trim().split("\n")).toEqual([
          "initialize",
          "session/resume",
        ]);
      } finally {
        await session.abort();
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "shows a conversation with no log as one row saying so, starting no agy, and refuses another project",
    async () => {
      const root = join(store, "conversations");
      await mkdir(root, { recursive: true });
      await writeFile(join(root, `${nativeId}.db`), "native fixture");
      const reader = new AntigravitySessionReader({ projectPath: directory });
      try {
        const loaded = await reader.getSession(
          nativeId,
          toUrlProjectId(directory),
        );
        expect(loaded?.data.provider).toBe("antigravity");
        expect(loaded?.transcriptComplete).toBe(false);
        expect(loaded?.data.session.messages).toEqual([
          expect.objectContaining({
            type: "system",
            subtype: "informational",
            uuid: `${nativeId}:history-unavailable`,
          }),
        ]);
        await expect(readFile(log, "utf8")).rejects.toThrow();
        const other = new AntigravitySessionReader({ projectPath: tmpdir() });
        expect(
          await other.getSession(nativeId, toUrlProjectId(tmpdir())),
        ).toBeNull();
        await other.close();
      } finally {
        await reader.close();
      }
    },
  );

  // Plan 195 step 8: every resume uses session/resume. Without a readable
  // log agy keeps the context, and YA says the earlier history cannot be
  // shown; a conversation never prompted starts as a new session does.
  it.skipIf(process.platform === "win32").each([
    ["an unknown log", "unknown"],
    ["a missing log", "missing"],
    ["a conversation never prompted", "never"],
  ] as const)(
    "resumes %s with session/resume, joining the new turn after a notice of what it cannot show",
    async (_name, shape) => {
      vi.stubEnv("AGY_TEST_LOG_TURNS", "1");
      const conversations = join(store, "conversations");
      await mkdir(conversations, { recursive: true });
      await writeFile(join(conversations, `${nativeId}.db`), "db");
      if (shape === "never")
        await writeAntigravitySummaries(store, [
          { id: nativeId, cwd: directory, stepCount: 0 },
        ]);
      if (shape === "unknown") {
        const logs = join(
          store,
          "brain",
          nativeId,
          ".system_generated",
          "logs",
        );
        await mkdir(logs, { recursive: true });
        // A field no observed agy writes makes the log unknown.
        await writeFile(
          join(logs, "transcript_full.jsonl"),
          `${JSON.stringify({ step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-11-22T08:00:00Z", content: "Saved answer", novel: 1 })}\n`,
        );
      }
      const scope = await realpath(conversations);
      const session = await new AntigravityProvider().startSession({
        cwd: directory,
        resumeSessionId: nativeId,
        initialMessage: { text: "continue", uuid: "resumed-prompt" },
      });
      const reader = new AntigravitySessionReader({ projectPath: directory });
      try {
        // Not a for-await loop: leaving one would close the session.
        for (;;) {
          const { value, done } = await session.iterator.next();
          if (done) throw new Error("The resumed session ended");
          expect(value.type).not.toBe("error");
          if (value.type === "result") break;
        }
        expect(antigravityOwnerView(scope, nativeId)?.earlier).toBe(
          shape === "never" ? undefined : shape,
        );
        const loaded = await reader.getSession(
          nativeId,
          toUrlProjectId(directory),
          undefined,
          { tailCompactions: 2 },
        );
        const rows = loaded?.data.session.messages.map((message) =>
          message.type === "system"
            ? message.uuid
            : `${message.type}:${String(message.message?.content)}`,
        );
        expect(rows).toEqual([
          ...(shape === "never" ? [] : [`${nativeId}:history-unavailable`]),
          "user:continue",
          "assistant:Hello world",
        ]);
        expect(loaded?.transcriptComplete).toBe(
          shape === "never" ? undefined : false,
        );
      } finally {
        await session.abort();
        await reader.close();
      }
      expect(await methods()).toEqual([
        "initialize",
        "session/resume",
        "session/prompt",
      ]);
    },
  );

  // Plan 195 step 4 flipped the open half of this repro: cold history comes
  // from the brain log, a page at a time, with no ACP replay at all.
  it.skipIf(process.platform === "win32")(
    "opens and pages a history over 8 MiB from the log, starting no agy",
    async () => {
      vi.stubEnv("ENABLED_PROVIDERS", "antigravity");
      const scale = await writeAntigravityScaleConversation({
        store,
        id: nativeId,
        cwd: directory,
        steps: 4000,
        targetBytes: 12 * 1024 * 1024,
        checkpointEvery: 0,
        skipEvery: 900,
        interruptedGroupEvery: 700,
        interiorGapGroupEvery: 1100,
        shortLog: false,
        summaries: false,
      });
      const all = await projectAntigravityLog(
        antigravityLogLines(createReadStream(scale.fullPath)),
        { conversationId: nativeId, ownerLive: false },
      );
      if (all.status !== "known") throw Error(all.reason);
      const metadata = createTestSessionMetadataService(
        join(directory, "data"),
      );
      await metadata.initialize();
      const app = createApp({
        provider: new AntigravityProvider(),
        dataDir: join(directory, "data"),
        sessionMetadataService: metadata,
        eventBus: new EventBus(),
        authDisabled: true,
        enabledProviders: ["antigravity"],
      });
      try {
        const detailPath = `/api/projects/${toUrlProjectId(directory)}/sessions/${nativeId}`;
        const get = async (query = "") => {
          const response = await app.app.request(`${detailPath}${query}`, {
            headers: { "X-Yep-Anywhere": "true" },
          });
          expect(response.status).toBe(200);
          return (await response.json()) as {
            messages: Array<{ uuid: string }>;
            pagination?: {
              hasOlderMessages: boolean;
              truncatedBeforeMessageId?: string;
            };
          };
        };
        let page = await get();
        const pages = [page.messages];
        while (page.pagination?.hasOlderMessages) {
          page = await get(
            `?beforeMessageId=${encodeURIComponent(page.pagination.truncatedBeforeMessageId!)}`,
          );
          pages.unshift(page.messages);
        }
        // Several 4 MiB pages, which together are the whole conversation.
        expect(pages.length).toBeGreaterThanOrEqual(3);
        expect(pages.flat().map((message) => message.uuid)).toEqual(
          all.messages.map((message) => message.uuid),
        );
        // Catching up from the newest message returns nothing new.
        const last = pages.at(-1)!.at(-1)!.uuid;
        expect(
          (await get(`?afterMessageId=${encodeURIComponent(last)}`)).messages,
        ).toEqual([]);
        // A stale positional ID misses: the client gets the latest page.
        const stale = await get(
          `?afterMessageId=${encodeURIComponent(`${nativeId}:12`)}`,
        );
        expect(stale.messages.map((message) => message.uuid)).toEqual(
          pages.at(-1)!.map((message) => message.uuid),
        );
        expect(
          (
            await get(
              `?beforeMessageId=${encodeURIComponent(`${nativeId}:12`)}`,
            )
          ).messages,
        ).toEqual([]);
        // A catch-up from a durable overlay's ID reads a bounded page too.
        await metadata.addLocalCommandMessage(nativeId, {
          type: "system",
          subtype: "local_command",
          content: "/status",
          timestamp: "2027-01-01T00:00:00.000Z",
          uuid: "overlay-1",
          id: "overlay-1",
        });
        const reads = vi.spyOn(
          AntigravitySessionReader.prototype,
          "getSession",
        );
        const overlay = await get("?afterMessageId=overlay-1");
        expect(overlay.messages).toEqual([]);
        expect(reads.mock.calls.at(-1)?.[3]).toMatchObject({
          boundedCatchUp: 2,
        });
        reads.mockRestore();
        // An overlay older than the newest page is a missed anchor: the
        // client gets the newest page as a replacement, with its cursor.
        await metadata.addLocalCommandMessage(nativeId, {
          type: "system",
          subtype: "local_command",
          content: "/model",
          timestamp: "2020-01-01T00:00:00.000Z",
          uuid: "overlay-old",
          id: "overlay-old",
        });
        const old = await get("?afterMessageId=overlay-old");
        expect(old.pagination?.hasOlderMessages).toBe(true);
        expect(old.pagination?.truncatedBeforeMessageId).toBe(
          pages.at(-1)![0]!.uuid,
        );
        // The newer overlay belongs to that page; the older one does not.
        expect(old.messages.map((message) => message.uuid)).toEqual([
          ...pages.at(-1)!.map((message) => message.uuid),
          "overlay-1",
        ]);
      } finally {
        app.stopNotifications();
        await app.disposeSessionReaders();
      }
      // No agy process was started for any of it.
      await expect(readFile(log, "utf8")).rejects.toThrow();
    },
    20_000,
  );

  /** A generated conversation whose replay would exceed YA's 8 MiB cap. */
  const writeLargeConversation = () =>
    writeAntigravityScaleConversation({
      store,
      id: nativeId,
      cwd: directory,
      steps: 4000,
      targetBytes: 12 * 1024 * 1024,
      checkpointEvery: 0,
      skipEvery: 900,
      interruptedGroupEvery: 700,
      interiorGapGroupEvery: 1100,
      shortLog: false,
      summaries: false,
    });
  const methods = async () => (await readFile(log, "utf8")).trim().split("\n");

  // Plan 195 step 5 flipped this from "today: a displayed replay over 8 MiB
  // fails on resume": session/resume replays nothing, so nothing is retained
  // from before the resume point.
  it.skipIf(process.platform === "win32")(
    "resumes a history over 8 MiB without replaying it, retaining only the new turn",
    async () => {
      vi.stubEnv("AGY_TEST_LOG_TURNS", "1");
      const scale = await writeLargeConversation();
      const scope = await realpath(join(store, "conversations"));
      const session = await new AntigravityProvider().startSession({
        cwd: directory,
        resumeSessionId: nativeId,
        initialMessage: { text: "continue", uuid: "resumed-prompt" },
      });
      try {
        const messages: SDKMessage[] = [];
        let retained: SDKMessage[] = [];
        for await (const message of session.iterator) {
          messages.push(message);
          if (message.type !== "result") continue;
          retained = antigravityLiveHistory(scope, nativeId)!;
          break;
        }
        expect(messages.filter((message) => message.type === "error")).toEqual(
          [],
        );
        // Zero replayed messages retained: only the resumed turn.
        expect(retained.map((message) => message.type)).toEqual([
          "user",
          "assistant",
        ]);
        expect(JSON.stringify(retained)).toContain("Hello world");
        expect(Buffer.byteLength(JSON.stringify(retained))).toBeLessThan(4096);
        expect(scale.fullBytes).toBeGreaterThan(8 * 1024 * 1024);
      } finally {
        await session.abort();
      }
      expect(await methods()).toEqual([
        "initialize",
        "session/resume",
        "session/prompt",
      ]);
    },
  );

  it.skipIf(process.platform === "win32")(
    "serves a resumed session as its log through the resume point and its live rows after it",
    async () => {
      vi.stubEnv("ENABLED_PROVIDERS", "antigravity");
      vi.stubEnv("AGY_TEST_LOG_TURNS", "1");
      const scale = await writeLargeConversation();
      const before = await projectAntigravityLog(
        antigravityLogLines(createReadStream(scale.fullPath)),
        { conversationId: nativeId, ownerLive: false },
      );
      if (before.status !== "known") throw Error(before.reason);
      const logIds = before.messages.map((message) => message.uuid);
      const metadata = createTestSessionMetadataService(
        join(directory, "data"),
      );
      await metadata.initialize();
      const app = createApp({
        provider: new AntigravityProvider(),
        dataDir: join(directory, "data"),
        sessionMetadataService: metadata,
        eventBus: new EventBus(),
        authDisabled: true,
        enabledProviders: ["antigravity"],
      });
      const projectId = toUrlProjectId(directory);
      const detailPath = `/api/projects/${projectId}/sessions/${nativeId}`;
      type Page = {
        session?: { title?: string | null };
        messages: Array<{ uuid: string; message?: { content?: unknown } }>;
        pagination?: {
          hasOlderMessages: boolean;
          truncatedBeforeMessageId?: string;
        };
      };
      const get = async (query = "") => {
        const response = await app.app.request(`${detailPath}${query}`, {
          headers: { "X-Yep-Anywhere": "true" },
        });
        expect(response.status).toBe(200);
        return (await response.json()) as Page;
      };
      const resume = async (message: string) => {
        const response = await app.app.request(`${detailPath}/resume`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Yep-Anywhere": "true",
          },
          body: JSON.stringify({
            message,
            provider: "antigravity",
            mode: "default",
          }),
        });
        expect(response.status).toBe(200);
        const active = app.supervisor.getProcessForSession(nativeId);
        if (!active) throw new Error("Resume has no active owner");
        return active;
      };
      /** Every page from the latest back, oldest first. */
      const pageAll = async () => {
        let page = await get();
        const pages = [page.messages];
        while (page.pagination?.hasOlderMessages) {
          page = await get(
            `?beforeMessageId=${encodeURIComponent(page.pagination.truncatedBeforeMessageId!)}`,
          );
          pages.unshift(page.messages);
        }
        return pages;
      };
      const uuids = (messages: Page["messages"]) =>
        messages.map((message) => message.uuid);
      const texts = (messages: Page["messages"]) =>
        messages.map((message) => JSON.stringify(message.message?.content));
      try {
        const first = await resume("continue");
        await waitForIdle(first, AbortSignal.timeout(15_000));
        // agy logged the resumed turn after the boundary; the owner's rows
        // serve it.
        const live = first
          .getMessageHistory()
          .filter(
            (message) =>
              (message.type === "user" || message.type === "assistant") &&
              !message._isStreaming,
          )
          .map((message) => message.uuid!);
        expect(live).toHaveLength(2);
        const pages = await pageAll();
        expect(pages.length).toBeGreaterThanOrEqual(3);
        const joined = pages.flat();
        expect(uuids(joined)).toEqual([...logIds, ...live]);
        expect(
          texts(joined).filter((text) => text?.includes("continue")),
        ).toHaveLength(1);
        // Catch-ups from either side of the boundary.
        expect(
          uuids(
            (await get(`?afterMessageId=${encodeURIComponent(logIds.at(-1)!)}`))
              .messages,
          ),
        ).toEqual(live);
        const fromLive = await get(
          `?afterMessageId=${encodeURIComponent(live[0]!)}`,
        );
        expect(uuids(fromLive.messages)).toEqual([live[1]]);
        // The title stays the conversation's first prompt, whichever side
        // served the read.
        const firstPrompt = before.messages.find(
          (message) => message.type === "user",
        )?.message?.content as string;
        expect(fromLive.session?.title).toBe(firstPrompt.slice(0, 120));
        expect((await get()).session?.title).toBe(firstPrompt.slice(0, 120));
        // An older page from a live row ends at the boundary.
        const older = await get(
          `?beforeMessageId=${encodeURIComponent(live[0]!)}`,
        );
        expect(uuids(older.messages).at(-1)).toBe(logIds.at(-1));
        expect(older.pagination?.hasOlderMessages).toBe(true);
        // The hover excerpt and the mappings read the same split.
        const reader = new AntigravitySessionReader({ projectPath: directory });
        try {
          expect(await reader.getLastAgentExcerpt(nativeId)).toBe(
            "Hello world",
          );
          expect(await reader.getAgentMappings(nativeId)).toEqual([]);
        } finally {
          await reader.close();
        }

        // Stop, then resume at once: the first resumed turn is now history
        // from the log, and a turn in progress is read while it runs.
        await first.abort();
        const stopped = (await pageAll()).flat();
        expect(
          texts(stopped).filter((text) => text?.includes("continue")),
        ).toHaveLength(1);
        const loggedIds = uuids(stopped);
        const second = await resume("wait");
        await vi.waitFor(() =>
          expect(
            second
              .getMessageHistory()
              .some((message) => message.type === "assistant"),
          ).toBe(true),
        );
        // agy has logged the prompt in progress; it is served once, live.
        const during = (await pageAll()).flat();
        expect(uuids(during).slice(0, loggedIds.length)).toEqual(loggedIds);
        expect(
          texts(during).filter((text) => text?.includes('"wait"')),
        ).toHaveLength(1);
        expect(new Set(uuids(during)).size).toBe(during.length);
        expect(await second.interrupt()).toBe(true);
        // Earlier pagination reads do not consume this turn's idle budget.
        await waitForIdle(second, AbortSignal.timeout(15_000));
        await second.abort();
      } finally {
        app.stopNotifications();
        await Promise.allSettled(
          app.supervisor.getAllProcesses().map((process) => process.abort()),
        );
        await app.disposeSessionReaders();
      }
      // Neither resume, nor any read, replayed history.
      expect(await methods()).not.toContain("session/load");
      expect(
        (await methods()).filter((method) => method === "session/resume"),
      ).toHaveLength(2);
    },
    30_000,
  );

  // Review round 3 item 4: a configuration hold that arrived while a staged
  // input read its subagent position was bypassed at dispatch.
  it.skipIf(process.platform === "win32")(
    "waits out a configuration hold that arrives while a staged input starts",
    async () => {
      const session = await new AntigravityProvider().startSession({
        cwd: directory,
        initialMessage: { text: "first", uuid: "turn-1" },
      });
      const prompts = async () =>
        (await methods()).filter((method) => method === "session/prompt")
          .length;
      let results = 0;
      const consuming = (async () => {
        for await (const message of session.iterator)
          if (message.type === "result" && ++results === 2) return;
      })();
      try {
        await vi.waitFor(() => expect(results).toBe(1));
        let entered = () => {};
        let release = () => {};
        const reading = new Promise<void>((resolve) => (entered = resolve));
        const gate = new Promise<void>((resolve) => (release = resolve));
        const read = AntigravitySubagentTracker.prototype.readStartPosition;
        spies.push(
          vi
            .spyOn(AntigravitySubagentTracker.prototype, "readStartPosition")
            .mockImplementationOnce(async function (
              this: AntigravitySubagentTracker,
            ) {
              entered();
              await gate;
              return read.call(this);
            }),
        );
        session.queue.push({ text: "held", uuid: "turn-2" });
        await reading;
        session.queue.setConfigurationInputHeld(true);
        release();
        await new Promise((resolve) => setTimeout(resolve, 100));
        // Held: not sent.
        expect(await prompts()).toBe(1);
        session.queue.setConfigurationInputHeld(false);
        await consuming;
        expect(await prompts()).toBe(2);
      } finally {
        await session.abort();
      }
    },
    20_000,
  );

  // Review round 4 finding 4: a Stop that woke the hold wait as the hold
  // cleared still read the position again before acknowledging.
  it.skipIf(process.platform === "win32")(
    "acknowledges a Stop during the hold wait without reading the position again",
    async () => {
      const session = await new AntigravityProvider().startSession({
        cwd: directory,
        initialMessage: { text: "first", uuid: "turn-1" },
      });
      let results = 0;
      const consuming = (async () => {
        for await (const message of session.iterator)
          if (message.type === "result" && ++results === 2) return;
      })();
      try {
        await vi.waitFor(() => expect(results).toBe(1));
        let entered = () => {};
        let release = () => {};
        const reading = new Promise<void>((resolve) => (entered = resolve));
        const gate = new Promise<void>((resolve) => (release = resolve));
        const read = AntigravitySubagentTracker.prototype.readStartPosition;
        let rereads = 0;
        spies.push(
          vi
            .spyOn(AntigravitySubagentTracker.prototype, "readStartPosition")
            .mockImplementationOnce(async function (
              this: AntigravitySubagentTracker,
            ) {
              entered();
              await gate;
              return read.call(this);
            })
            .mockImplementation(async function (
              this: AntigravitySubagentTracker,
            ) {
              rereads++;
              return read.call(this);
            }),
        );
        session.queue.push({ text: "held", uuid: "turn-2" });
        await reading;
        session.queue.setConfigurationInputHeld(true);
        release();
        await new Promise((resolve) => setTimeout(resolve, 50));
        // Stop, and the hold clears before the staged path runs again.
        const stopped = session.interrupt!();
        session.queue.setConfigurationInputHeld(false);
        expect(await stopped).toBe(true);
        await consuming;
        expect(rereads).toBe(0);
        expect(
          (await methods()).filter((method) => method === "session/prompt"),
        ).toHaveLength(1);
      } finally {
        await session.abort();
      }
    },
    20_000,
  );

  /** Runs `turns` 3 MiB turns, reporting retained bytes after each result. */
  async function runBigTurns(
    session: Awaited<ReturnType<AntigravityProvider["startSession"]>>,
    turns: number,
    afterResult: (turn: number) => Promise<void>,
  ) {
    const errors: SDKMessage[] = [];
    let results = 0;
    for await (const message of session.iterator) {
      if (message.type === "error") errors.push(message);
      if (message.type !== "result") continue;
      await afterResult(++results);
      if (results === turns) break;
      session.queue.push({ text: "big", uuid: `turn-${results + 1}` });
    }
    return { errors, results };
  }

  // Flipped by plan 195 step 6 from "today: a live session that passes
  // 8 MiB across turns is torn down mid-turn": past its soft budget the
  // owner moves its boundary to a proven split point, so the session keeps
  // running however much it writes, retaining at most the budget and a turn.
  it.skipIf(process.platform === "win32")(
    "keeps a live session running past 8 MiB, retaining a fixed amount while its whole history stays readable",
    async () => {
      vi.stubEnv("AGY_TEST_LOG_TURNS", "1");
      // Split points may be used at once (Process's replay window is not in play).
      setAntigravityLiveLimitsForTests({ splitAgeMs: 0 });
      const scope = await realpath(join(store, "conversations"));
      const session = await new AntigravityProvider().startSession({
        cwd: directory,
        initialMessage: { text: "big", uuid: "turn-1" },
      });
      const turn = 3 * 1024 * 1024;
      try {
        const { errors, results } = await runBigTurns(session, 5, async (n) => {
          expect(session.isProcessAlive?.()).toBe(true);
          // Each prompt is queued behind the last turn and sent right after
          // its result: from the second turn, the turn before it leaves
          // memory once agy logs the prompt's input after that result.
          if (n >= 2)
            await vi.waitFor(() =>
              expect(
                antigravityLiveHistory(scope, nativeId)!.map((m) => m.uuid),
              ).not.toContain(`turn-${n - 1}`),
            );
          const bytes = Buffer.byteLength(
            JSON.stringify(antigravityLiveHistory(scope, nativeId)),
          );
          expect(bytes).toBeLessThanOrEqual(2 * 1024 * 1024 + turn + 4096);
        });
        expect(errors).toEqual([]);
        expect(results).toBe(5);
        const reader = new AntigravitySessionReader({ projectPath: directory });
        try {
          const whole = await reader.getSession(
            nativeId,
            toUrlProjectId(directory),
          );
          const messages = whole?.data.session.messages ?? [];
          expect(whole?.transcriptComplete).not.toBe(false);
          expect(
            messages.filter(
              (message) =>
                message.type === "assistant" &&
                String(message.message?.content).length === 3 * 1024 * 1024,
            ),
          ).toHaveLength(5);
          expect(
            messages.filter((message) => message.type === "user"),
          ).toHaveLength(5);
        } finally {
          await reader.close();
        }
      } finally {
        await session.abort();
      }
      const methods = (await readFile(log, "utf8")).trim().split("\n");
      expect(
        methods.filter((method) => method === "session/prompt"),
      ).toHaveLength(5);
    },
    20_000,
  );

  it
    .skipIf(process.platform === "win32")
    .each(["stops growing", "is unlinked"])(
    "evicts the oldest row at the cap, never throwing, when the log %s while the session lives",
    async (shape) => {
      const scope = await realpath(join(store, "conversations"));
      if (shape === "is unlinked") {
        // A resumed session whose log goes away: nothing can advance.
        await writeLargeConversation();
        const session = await new AntigravityProvider().startSession({
          cwd: directory,
          resumeSessionId: nativeId,
          initialMessage: { text: "big", uuid: "turn-1" },
        });
        await rm(
          join(
            store,
            "brain",
            nativeId,
            ".system_generated",
            "logs",
            "transcript_full.jsonl",
          ),
        );
        await exercise(session);
      } else
        await exercise(
          await new AntigravityProvider().startSession({
            cwd: directory,
            initialMessage: { text: "big", uuid: "turn-1" },
          }),
        );

      async function exercise(
        session: Awaited<ReturnType<AntigravityProvider["startSession"]>>,
      ) {
        try {
          const retained: number[] = [];
          let lastHistory: SDKMessage[] = [];
          let lastRead: Awaited<
            ReturnType<AntigravitySessionReader["getSession"]>
          > = null;
          const { errors, results } = await runBigTurns(
            session,
            4,
            async (turn) => {
              expect(session.isProcessAlive?.()).toBe(true);
              retained.push(
                Buffer.byteLength(
                  JSON.stringify(antigravityLiveHistory(scope, nativeId)),
                ),
              );
              if (turn < 4) return;
              lastHistory = antigravityLiveHistory(scope, nativeId)!;
              const reader = new AntigravitySessionReader({
                projectPath: directory,
              });
              try {
                lastRead = await reader.getSession(
                  nativeId,
                  toUrlProjectId(directory),
                  undefined,
                  { tailCompactions: 2 },
                );
              } finally {
                await reader.close();
              }
            },
          );
          expect(errors).toEqual([]);
          expect(results).toBe(4);
          // Two 3 MiB turns fit; from the third, the oldest rows go.
          for (const bytes of retained)
            expect(bytes).toBeLessThanOrEqual(8 * 1024 * 1024 + 1024);
          expect(retained.at(-1)).toBeGreaterThan(6 * 1024 * 1024);
          const ids = lastHistory.map((message) => message.uuid);
          expect(ids).not.toContain("turn-1");
          expect(ids).toContain("turn-4");
          // The view says history is missing rather than looking whole.
          expect(lastRead?.transcriptComplete).toBe(false);
          expect(
            lastRead?.data.session.messages.map((message) => message.uuid),
          ).toContain("turn-4");
        } finally {
          await session.abort();
        }
      }
    },
    20_000,
  );

  /**
   * A resumed conversation through the real route and a v0 observer, with a
   * client that keeps its rows the way the browser does: its catch-ups
   * start after its last fetched row, a paginated answer replaces its
   * window, and streamed rows count as held.
   */
  async function liveRoute() {
    vi.stubEnv("ENABLED_PROVIDERS", "antigravity");
    vi.stubEnv("AGY_TEST_LOG_TURNS", "1");
    const logs = join(store, "brain", nativeId, ".system_generated", "logs");
    await mkdir(logs, { recursive: true });
    await mkdir(join(store, "conversations"), { recursive: true });
    await writeFile(join(store, "conversations", `${nativeId}.db`), "db");
    const at = "2026-11-23T08:00:00Z";
    await writeFile(
      join(logs, "transcript_full.jsonl"),
      `${JSON.stringify({ step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", created_at: at, content: "<USER_REQUEST>\nOriginal question\n</USER_REQUEST>" })}\n` +
        `${JSON.stringify({ step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: at, content: "Saved" })}\n`,
    );
    const scope = await realpath(join(store, "conversations"));
    const metadata = createTestSessionMetadataService(join(directory, "data"));
    await metadata.initialize();
    const app = createApp({
      provider: new AntigravityProvider(),
      dataDir: join(directory, "data"),
      sessionMetadataService: metadata,
      eventBus: new EventBus(),
      authDisabled: true,
      enabledProviders: ["antigravity"],
    });
    const projectId = toUrlProjectId(directory);
    const detailPath = `/api/projects/${projectId}/sessions/${nativeId}`;
    type Row = { uuid: string; message?: { content?: unknown } };
    type Page = { messages: Row[]; pagination?: unknown };
    const get = async (query = "?tailCompactions=2") => {
      const response = await app.app.request(`${detailPath}${query}`, {
        headers: { "X-Yep-Anywhere": "true" },
      });
      expect(response.status).toBe(200);
      return (await response.json()) as Page;
    };
    const post = (path: string, body: unknown) =>
      app.app.request(path, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Yep-Anywhere": "true",
        },
        body: JSON.stringify(body),
      });
    const text = (row: Row) =>
      typeof row.message?.content === "string"
        ? row.message.content
        : JSON.stringify(row.message?.content ?? null);
    const shown = (rows: readonly Row[]) =>
      rows.map(text).filter((value) => value !== "null");
    const v0 = createProviderConversationSource({
      readerFactory: () =>
        new AntigravitySessionReader({ projectPath: directory }),
      resolve: async () => ({
        sessionId: nativeId,
        catalogFamily: "antigravity",
        storeKey: "test",
        projectId,
        projectPath: directory,
        projectIdentityKey: directory,
        updatedAt: at,
        fidelity: "tail",
        sourceVersion: "1",
        location: { kind: "file", path: join(scope, `${nativeId}.db`) },
        nativeStorageScope: scope,
      }),
      getProcess: (id) => app.supervisor.getProcessForSession(id) as never,
    });
    const observing = new AbortController();
    const observer = await v0(nativeId, () => {}, observing.signal);
    /** A client as the browser keeps one. */
    const client = {
      rows: [] as Row[],
      replacements: 0,
      async load() {
        client.rows = (await get()).messages;
      },
      /** Streamed rows: held under their live IDs, as the browser does. */
      stream(rows: Row[]) {
        for (const row of rows)
          if (!client.rows.some((held) => held.uuid === row.uuid))
            client.rows.push(row);
      },
      async catchUp() {
        const last = client.rows.at(-1)!.uuid;
        const page = await get(`?afterMessageId=${encodeURIComponent(last)}`);
        if (page.pagination) {
          client.replacements++;
          client.rows = page.messages;
        } else client.stream(page.messages);
      },
    };
    return {
      app,
      scope,
      get,
      post,
      shown,
      client,
      observed: async () =>
        (await observer.read(observing.signal)).messages as Row[],
      async close() {
        observing.abort();
        app.stopNotifications();
        await Promise.allSettled(
          app.supervisor.getAllProcesses().map((process) => process.abort()),
        );
        await app.disposeSessionReaders();
      },
    };
  }

  it.skipIf(process.platform === "win32")(
    "keeps every row's ID while the live rows stay under the soft budget, so each catch-up is incremental",
    async () => {
      const route = await liveRoute();
      const signal = AbortSignal.timeout(15_000);
      try {
        await route.client.load();
        expect(
          (
            await route.post(
              `/api/projects/${toUrlProjectId(directory)}/sessions/${nativeId}/resume`,
              {
                message: "turn 1",
                provider: "antigravity",
                mode: "default",
              },
            )
          ).status,
        ).toBe(200);
        const active = route.app.supervisor.getProcessForSession(nativeId)!;
        await waitForIdle(active, signal);
        const liveIds = new Set<string>();
        for (let turn = 1; turn <= 8; turn++) {
          if (turn > 1) {
            await route.post(`/api/sessions/${nativeId}/messages`, {
              message: `turn ${turn}`,
            });
            await vi.waitFor(() =>
              expect(JSON.stringify(active.getMessageHistory())).toContain(
                `"turn ${turn}"`,
              ),
            );
            await waitForIdle(active, signal);
          }
          await route.client.catchUp();
          for (const row of route.client.rows)
            if (!row.uuid.includes(":step-")) liveIds.add(row.uuid);
        }
        expect(route.client.replacements).toBe(0);
        // Nothing moved: every row this owner produced keeps its live ID.
        const latest = await route.get();
        for (const id of liveIds)
          expect(latest.messages.map((row) => row.uuid)).toContain(id);
        expect(liveIds.size).toBe(16);
        expect(route.shown(route.client.rows)).toEqual(
          route.shown(latest.messages),
        );
        expect(route.shown(await route.observed())).toEqual(
          route.shown(latest.messages),
        );
      } finally {
        await route.close();
      }
    },
    20_000,
  );

  it
    .skipIf(process.platform === "win32")
    .each([
      "between the last chunk and the result",
      "before the last chunk",
      "after the result",
    ])(
    "moves past the soft budget with one replacement per connected client, every row once and the rows bounded, with the reply's record %s",
    async (order) => {
      if (order === "before the last chunk")
        vi.stubEnv("AGY_TEST_RECORD_ORDER", "before-chunk");
      if (order === "after the result")
        vi.stubEnv("AGY_TEST_RECORD_ORDER", "after-result");
      // Four rows: past them a move happens at the next proven split point.
      const softRows = 4;
      setAntigravityLiveLimitsForTests({ softRows, splitAgeMs: 0 });
      const route = await liveRoute();
      const logPath = join(
        store,
        "brain",
        nativeId,
        ".system_generated",
        "logs",
        "transcript_full.jsonl",
      );
      const waitForReplyRecord = async (turn: number) => {
        if (order !== "after the result") return;
        await vi.waitFor(async () => {
          const records = (await readFile(logPath, "utf8")).split("\n");
          expect(
            records.filter((line) =>
              line.includes('"type":"PLANNER_RESPONSE"'),
            ),
          ).toHaveLength(turn + 1); // Includes the seeded reply.
        });
      };
      try {
        await route.client.load();
        expect(
          (
            await route.post(
              `/api/projects/${toUrlProjectId(directory)}/sessions/${nativeId}/resume`,
              {
                message: "turn 1",
                provider: "antigravity",
                mode: "default",
              },
            )
          ).status,
        ).toBe(200);
        const active = route.app.supervisor.getProcessForSession(nativeId)!;
        await waitForIdle(active, AbortSignal.timeout(15_000));
        await waitForReplyRecord(1);
        const expected = [
          "Original question",
          "Saved",
          "turn 1",
          "Hello world",
        ];
        const send = async (message: string) => {
          await route.post(`/api/sessions/${nativeId}/messages`, { message });
          await vi.waitFor(() =>
            expect(JSON.stringify(active.getMessageHistory())).toContain(
              `"${message}"`,
            ),
          );
        };
        // A turn the log never finishes: Stop while the reply streams.
        await send("wait");
        await vi.waitFor(() =>
          expect(JSON.stringify(active.getMessageHistory())).toContain(
            "Waiting",
          ),
        );
        // A reply still streaming is served marked, so a client that reads
        // it keeps following its stream rather than freezing that snapshot.
        const streaming = (await route.get()).messages.find(
          (row) => row.message?.content === "Waiting",
        ) as { _isStreaming?: boolean } | undefined;
        expect(streaming?._isStreaming).toBe(true);
        expect(await active.interrupt()).toBe(true);
        await waitForIdle(active, AbortSignal.timeout(15_000));
        await route.client.catchUp();
        expected.push("wait", "Waiting");
        expect(route.shown(route.client.rows)).toEqual(expected);
        const boundary = () => {
          const view = antigravityOwnerView(route.scope, nativeId);
          return view?.boundary.end;
        };
        let moves = 0;
        for (let turn = 2; turn <= 7; turn++) {
          const before = boundary();
          const replaced = route.client.replacements;
          await send(`turn ${turn}`);
          await waitForIdle(active, AbortSignal.timeout(15_000));
          await waitForReplyRecord(turn);
          // An asynchronous split can finish after the turn goes idle. At
          // the soft limit no further split can race the catch-up assertion.
          await vi.waitFor(() =>
            expect(
              antigravityLiveHistory(route.scope, nativeId)!.length,
            ).toBeLessThanOrEqual(softRows),
          );
          if (boundary() !== before) moves++;
          // Once the row it last fetched has left memory, the client gets one
          // replacement; otherwise its catch-up appends.
          const view = antigravityOwnerView(route.scope, nativeId);
          const anchor = route.client.rows.at(-1)!.uuid;
          const left =
            !!view && !anchor.includes(":step-") && !view.has(anchor);
          await route.client.catchUp();
          expect(route.client.replacements - replaced, `turn ${turn}`).toBe(
            left ? 1 : 0,
          );
          expected.push(`turn ${turn}`, "Hello world");
        }
        // Each move was one replacement for this client, never an append
        // of rows it held; the client shows every row once, in order.
        expect(moves).toBeGreaterThanOrEqual(2);
        expect(route.client.replacements).toBeGreaterThanOrEqual(1);
        const latest = await route.get("");
        // The stopped reply the log never recorded left with its turn.
        const settled = expected.filter((value) => value !== "Waiting");
        expect(route.shown(latest.messages)).toEqual(settled);
        expect(route.shown(route.client.rows)).toEqual(settled);
        expect(new Set(route.client.rows.map((row) => row.uuid)).size).toBe(
          route.client.rows.length,
        );
        // A v0 observer open throughout shows each row once, as the reader.
        const observed = await route.observed();
        expect(new Set(observed.map((row) => row.uuid)).size).toBe(
          observed.length,
        );
        expect(route.shown(observed)).toEqual(
          route.shown((await route.get()).messages),
        );
        // Stopped, the cold view is the same rows in the same order.
        await active.abort();
        expect(route.shown((await route.get("")).messages)).toEqual(settled);
      } finally {
        await route.close();
      }
      expect(await methods()).not.toContain("session/load");
    },
    30_000,
  );

  // Review round 1 finding 1: a detached wake overlapping a turn's end or
  // the next prompt must never be split from its own rows. The stat proof
  // splits before a prompt sent once the wake is logged and streamed (its
  // reply is the last record), and refuses one sent while it streams (its
  // task-end message is).
  it
    .skipIf(process.platform === "win32")
    .each([
      "a prompt sent once the wake is logged and streamed",
      "a prompt sent after the wake's first chunk",
    ])(
    "never shows a detached wake twice before or after a move, with %s",
    async (shape) => {
      setAntigravityLiveLimitsForTests({ softRows: 6, splitAgeMs: 0 });
      const route = await liveRoute();
      const signal = AbortSignal.timeout(15_000);
      const logPath = join(
        store,
        "brain",
        nativeId,
        ".system_generated",
        "logs",
        "transcript_full.jsonl",
      );
      try {
        expect(
          (
            await route.post(
              `/api/projects/${toUrlProjectId(directory)}/sessions/${nativeId}/resume`,
              { message: "turn 1", provider: "antigravity", mode: "default" },
            )
          ).status,
        ).toBe(200);
        const active = route.app.supervisor.getProcessForSession(nativeId)!;
        await waitForIdle(active, signal);
        const send = async (message: string) => {
          await route.post(`/api/sessions/${nativeId}/messages`, { message });
          await vi.waitFor(() =>
            expect(JSON.stringify(active.getMessageHistory())).toContain(
              `"${message}"`,
            ),
          );
        };
        /**
         * How often the wake's head and tail show, live, complete and to
         * v0: once each (as two live rows, or the log's one reply).
         */
        const shown = async () => {
          const count = (rows: Array<{ message?: { content?: unknown } }>) =>
            ["WAKE_HEAD", "WAKE_TAIL"]
              .map(
                (part) =>
                  rows.filter((row) =>
                    JSON.stringify(row.message?.content ?? "").includes(part),
                  ).length,
              )
              .join("+");
          return [
            count((await route.get()).messages),
            count((await route.get("?fullHistory=1")).messages),
            count(await route.observed()),
          ];
        };
        await send("turn 2");
        await waitForIdle(active, signal);
        await send("wake");
        await waitForIdle(active, signal);
        await writeFile(`${log}.wake1`, "");
        await vi.waitFor(() =>
          expect(JSON.stringify(active.getMessageHistory())).toContain(
            "WAKE_HEAD",
          ),
        );
        if (shape === "a prompt sent after the wake's first chunk") {
          // Dispatched while the wake streams; agy logs the wake first.
          await send("turn 3");
          await writeFile(`${log}.wake2`, "");
        } else {
          await writeFile(`${log}.wake2`, "");
          await vi.waitFor(async () =>
            expect(await readFile(logPath, "utf8")).toContain("WAKE_TAIL"),
          );
          await vi.waitFor(() =>
            expect(JSON.stringify(active.getMessageHistory())).toContain(
              "WAKE_TAIL",
            ),
          );
          await send("turn 3");
        }
        await waitForIdle(active, signal);
        await vi.waitFor(async () =>
          expect(await shown()).toEqual(["1+1", "1+1", "1+1"]),
        );
        const boundary = () => {
          const view = antigravityOwnerView(route.scope, nativeId);
          return view?.boundary.step;
        };
        const before = boundary();
        for (let turn = 4; turn <= 7; turn++) {
          await send(`turn ${turn}`);
          await waitForIdle(active, signal);
          await new Promise((resolve) => setTimeout(resolve, 50));
          expect(await shown(), `turn ${turn}`).toEqual(["1+1", "1+1", "1+1"]);
        }
        // The wake has moved to the log by now: shown once from there.
        expect(boundary()).not.toBe(before);
        expect(
          antigravityLiveHistory(route.scope, nativeId)!.some((row) =>
            JSON.stringify(row).includes("WAKE"),
          ),
        ).toBe(false);
        await active.abort();
        expect((await shown()).slice(0, 2)).toEqual(["1+1", "1+1"]);
      } finally {
        await route.close();
      }
    },
    30_000,
  );

  // Review round 2 finding 3: a split proven before the log was truncated
  // moved rows the log could no longer serve. Nothing is proven ahead of
  // need now, so a truncated log moves nothing.
  it.skipIf(process.platform === "win32")(
    "moves nothing once the log is truncated, keeping the rows it can no longer serve",
    async () => {
      const route = await liveRoute();
      const signal = AbortSignal.timeout(15_000);
      try {
        expect(
          (
            await route.post(
              `/api/projects/${toUrlProjectId(directory)}/sessions/${nativeId}/resume`,
              { message: "turn 1", provider: "antigravity", mode: "default" },
            )
          ).status,
        ).toBe(200);
        const active = route.app.supervisor.getProcessForSession(nativeId)!;
        await waitForIdle(active, signal);
        for (const message of ["turn 2", "turn 3"]) {
          await route.post(`/api/sessions/${nativeId}/messages`, { message });
          await vi.waitFor(() =>
            expect(JSON.stringify(active.getMessageHistory())).toContain(
              `"${message}"`,
            ),
          );
          await waitForIdle(active, signal);
        }
        const view = () => {
          const owner = antigravityOwnerView(route.scope, nativeId);
          if (!owner) throw new Error("not open");
          return owner;
        };
        const opened = view().boundary;
        // Every candidate so far was taken under budget; then the log
        // loses all but its first record, and the rows pass the budget.
        const logPath = join(
          store,
          "brain",
          nativeId,
          ".system_generated",
          "logs",
          "transcript_full.jsonl",
        );
        const first = (await readFile(logPath, "utf8")).split("\n")[0]!;
        await truncate(logPath, Buffer.byteLength(`${first}\n`));
        setAntigravityLiveLimitsForTests({ softRows: 2, splitAgeMs: 0 });
        await route.post(`/api/sessions/${nativeId}/messages`, {
          message: "turn 4",
        });
        await vi.waitFor(() =>
          expect(JSON.stringify(active.getMessageHistory())).toContain(
            '"turn 4"',
          ),
        );
        await waitForIdle(active, signal);
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(view().boundary).toEqual(opened);
        expect(
          view()
            .history()
            .filter((row) => row.type === "user")
            .map((row) => row.message?.content),
        ).toEqual(["turn 1", "turn 2", "turn 3", "turn 4"]);
      } finally {
        await route.close();
      }
    },
    20_000,
  );

  // Review round 3 finding 1: agy logs a long pasted prompt clipped. That
  // record made the log unknown, so a move left a fresh read with only the
  // turn after it, incomplete.
  it.skipIf(process.platform === "win32")(
    "keeps every turn readable across a move past a prompt agy clipped in its log",
    async () => {
      setAntigravityLiveLimitsForTests({ softRows: 2, splitAgeMs: 0 });
      const route = await liveRoute();
      const signal = AbortSignal.timeout(15_000);
      const paste = `PASTE_START ${"p".repeat(262_144)}`;
      try {
        expect(
          (
            await route.post(
              `/api/projects/${toUrlProjectId(directory)}/sessions/${nativeId}/resume`,
              { message: "turn 1", provider: "antigravity", mode: "default" },
            )
          ).status,
        ).toBe(200);
        const active = route.app.supervisor.getProcessForSession(nativeId)!;
        await waitForIdle(active, signal);
        const opened = antigravityOwnerView(route.scope, nativeId);
        const boundary = () => {
          const view = antigravityOwnerView(route.scope, nativeId);
          return view?.boundary.step;
        };
        const before = opened ? opened.boundary.step : -2;
        for (const message of [paste, "turn 3"]) {
          await route.post(`/api/sessions/${nativeId}/messages`, { message });
          await vi.waitFor(() =>
            expect(JSON.stringify(active.getMessageHistory())).toContain(
              message.slice(0, 40),
            ),
          );
          await waitForIdle(active, signal);
        }
        // The pasted turn has moved to the log.
        await vi.waitFor(() => {
          expect(boundary()).not.toBe(before);
          expect(
            JSON.stringify(antigravityLiveHistory(route.scope, nativeId)),
          ).not.toContain("PASTE_START");
        });
        const reader = new AntigravitySessionReader({ projectPath: directory });
        try {
          const fresh = await reader.getSession(
            nativeId,
            toUrlProjectId(directory),
          );
          expect(fresh?.transcriptComplete).not.toBe(false);
          const users = (fresh?.data.session.messages ?? [])
            .filter((message) => message.type === "user")
            .map((message) => String(message.message?.content));
          expect(users.map((text) => text.slice(0, 12))).toEqual([
            "Original que",
            "turn 1",
            "PASTE_START ",
            "turn 3",
          ]);
          expect(users[2]).toMatch(
            /agy logged only the beginning of this prompt/,
          );
        } finally {
          await reader.close();
        }
      } finally {
        await route.close();
      }
    },
    20_000,
  );

  it.skipIf(process.platform === "win32")(
    "projects configOptions base models and switches model and thinking level live without restarting",
    async () => {
      const cliDir = join(directory, "cli-bin");
      await mkdir(cliDir, { recursive: true });
      const cliExe = join(cliDir, "agy");
      const configLog = join(directory, "config-calls.log");
      const cliPeer = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const id = '${nativeId}';
const root = path.join(process.env.GEMINI_HOME, 'antigravity-cli', 'conversations');
const send = value => process.stdout.write(JSON.stringify(value)+'\\n');
const reply = (id, result) => send({jsonrpc:'2.0', id, result});
const update = value => send({jsonrpc:'2.0',method:'session/update',params:{sessionId:id,update:value}});
const thoughtByModel = {
  'gemini-4-neon': ['low', 'medium', 'high', 'xhigh'],
  'claude-opus-5-5': ['low', 'medium', 'high'],
  'gemini-pro-orchestrator-neon': [],
};
let curModel = 'gemini-4-neon';
let curThought = 'high';
const buildConfigOptions = () => {
  const levels = thoughtByModel[curModel] || [];
  return [
    {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: curModel,
      options: [
        { value: 'gemini-4-neon', name: 'Gemini 4 Neon' },
        { value: 'claude-opus-5-5', name: 'Claude Opus 5.5' },
        { value: 'gemini-pro-orchestrator-neon', name: 'Orchestrator (Neon)' },
      ],
    },
    ...(levels.length ? [{
      id: 'thought_level',
      name: 'Thinking Level',
      category: 'thought_level',
      type: 'select',
      currentValue: curThought,
      options: levels.map(v => ({ value: v, name: v })),
    }] : []),
    { id: 'mode', name: 'Mode', category: 'mode', type: 'select', currentValue: 'default', options: [{ value: 'default', name: 'Default' }] },
  ];
};
readline.createInterface({input:process.stdin}).on('line', line => {
  const m = JSON.parse(line);
  if (m.method) fs.appendFileSync(process.env.AGY_CONFIG_LOG, JSON.stringify({ method: m.method, params: m.params }) + '\\n');
  if (m.method === 'initialize') return reply(m.id, { protocolVersion: 1, agentInfo: { version: '${nativeVersion}' } });
  if (m.method === 'session/new') {
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, id + '.db'), 'native fixture');
    return reply(m.id, {
      sessionId: id,
      models: {
        currentModelId: 'gemini-4-neon-high',
        availableModels: [
          { modelId: 'gemini-4-neon-high', name: 'Gemini 4 Neon (High)' },
          { modelId: 'gemini-4-neon-xhigh', name: 'Gemini 4 Neon (XHigh)' },
          { modelId: 'gemini-4-neon-medium', name: 'Gemini 4 Neon (Medium)' },
          { modelId: 'gemini-4-neon-low', name: 'Gemini 4 Neon (Low)' },
          { modelId: 'claude-opus-5-5-low', name: 'Claude Opus 5.5 (Low)' },
          { modelId: 'claude-opus-5-5-medium', name: 'Claude Opus 5.5 (Medium)' },
          { modelId: 'claude-opus-5-5-high', name: 'Claude Opus 5.5 (High)' },
          { modelId: 'gemini-pro-orchestrator-neon', name: 'Orchestrator (Neon)' },
        ],
      },
      modes: { currentModeId: 'default', availableModes: [{ id: 'default' }] },
      configOptions: buildConfigOptions(),
    });
  }
  if (m.method === 'session/set_config_option') {
    if (m.params.configId === 'model') {
      const legacy = m.params.value.match(/^(.+)-(low|medium|high|xhigh)$/);
      if (legacy && thoughtByModel[legacy[1]]) {
        curModel = legacy[1];
        curThought = legacy[2];
      } else if (thoughtByModel[m.params.value]) {
        curModel = m.params.value;
        const levels = thoughtByModel[curModel];
        if (levels.length && !levels.includes(curThought)) curThought = levels[levels.length - 1];
      } else {
        return send({ jsonrpc: '2.0', id: m.id, error: { code: -32602, message: 'Unknown model ID: ' + m.params.value } });
      }
      const configOptions = buildConfigOptions();
      update({ sessionUpdate: 'config_option_update', configOptions });
      return reply(m.id, { configOptions });
    }
    if (m.params.configId === 'thought_level') {
      const levels = thoughtByModel[curModel] || [];
      if (!levels.includes(m.params.value)) {
        return send({ jsonrpc: '2.0', id: m.id, error: { code: -32602, message: 'Thinking level not offered: ' + m.params.value } });
      }
      curThought = m.params.value;
      const configOptions = buildConfigOptions();
      update({ sessionUpdate: 'config_option_update', configOptions });
      return reply(m.id, { configOptions });
    }
  }
  if (m.method === 'session/prompt') {
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: curModel + '@' + (thoughtByModel[curModel].length ? curThought : 'fixed') } });
    return reply(m.id, { stopReason: 'end_turn' });
  }
  return reply(m.id, {});
});
`;
      await writeFile(cliExe, cliPeer);
      await chmod(cliExe, 0o755);
      vi.stubEnv("ANTIGRAVITY_ACP_PATH", cliExe);
      vi.stubEnv("AGY_CONFIG_LOG", configLog);
      vi.stubEnv("ENABLED_PROVIDERS", "antigravity");

      const provider = new AntigravityProvider();
      const models = await provider.getAvailableModels({ forceRefresh: true });
      expect(models).toEqual([
        expect.objectContaining({
          id: "default",
          isDefault: true,
          supportsEffort: true,
          supportedEffortLevels: ["low", "medium", "high", "xhigh"],
          defaultEffortLevel: "high",
        }),
        expect.objectContaining({
          id: "gemini-4-neon",
          name: "Gemini 4 Neon",
          supportsEffort: true,
          supportedEffortLevels: ["low", "medium", "high", "xhigh"],
          defaultEffortLevel: "high",
        }),
        expect.objectContaining({
          id: "claude-opus-5-5",
          name: "Claude Opus 5.5",
          supportsEffort: true,
          supportedEffortLevels: ["low", "medium", "high"],
        }),
        expect.objectContaining({
          id: "gemini-pro-orchestrator-neon",
          name: "Orchestrator (Neon)",
          supportsEffort: false,
          supportsAdaptiveThinking: false,
        }),
      ]);
      expect(
        models.find((m) => m.id === "gemini-4-neon")?.isDefault,
      ).toBeUndefined();

      const metadata = createTestSessionMetadataService(
        join(directory, "data-config"),
      );
      await metadata.initialize();
      const app = createApp({
        provider,
        dataDir: join(directory, "data-config"),
        sessionMetadataService: metadata,
        eventBus: new EventBus(),
        authDisabled: true,
        enabledProviders: ["antigravity"],
      });
      const projectId = toUrlProjectId(directory);
      let active: ReturnType<typeof app.supervisor.getProcessForSession>;
      try {
        const created = await app.app.request(
          `/api/projects/${projectId}/session-creations`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Yep-Anywhere": "true",
            },
            body: JSON.stringify({
              requestId: "agy-live-config",
              message: "turn-1",
              provider: "antigravity",
              model: "gemini-4-neon",
              thinking: "on:low",
              mode: "default",
            }),
          },
        );
        expect(created.status).toBe(202);
        const receipt = await created.json();
        await vi.waitFor(() => {
          active = app.supervisor.getProcessForSession(receipt.sessionId);
          expect(active?.state.type).toBe("idle");
          expect(JSON.stringify(active?.getMessageHistory())).toContain(
            "gemini-4-neon@low",
          );
        });
        const initialProcessId = active!.id;
        expect(active?.resolvedModel).toBe("gemini-4-neon");
        expect(active?.effort).toBe("low");

        // Switch BOTH model and effort live on the same process without restarting.
        const switched = await app.app.request(
          `/api/processes/${initialProcessId}/config`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Yep-Anywhere": "true",
            },
            body: JSON.stringify({
              model: "claude-opus-5-5",
              thinking: "on:medium",
            }),
          },
        );
        expect(switched.status).toBe(200);
        const switchedBody = await switched.json();
        expect(switchedBody.processId).toBe(initialProcessId);
        expect(switchedBody.model).toBe("claude-opus-5-5");
        expect(switchedBody.effort).toBe("medium");

        // Switch effort back to high live, then send turn-2 and verify output.
        const effortOnly = await app.app.request(
          `/api/processes/${initialProcessId}/config`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Yep-Anywhere": "true",
            },
            body: JSON.stringify({ thinking: "on:high" }),
          },
        );
        expect(effortOnly.status).toBe(200);
        expect((await effortOnly.json()).processId).toBe(initialProcessId);

        const turn2 = await app.app.request(
          `/api/sessions/${receipt.sessionId}/messages`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Yep-Anywhere": "true",
            },
            body: JSON.stringify({ message: "turn-2" }),
          },
        );
        expect(turn2.status).toBe(200);
        await vi.waitFor(() => {
          expect(active?.state.type).toBe("idle");
          expect(JSON.stringify(active?.getMessageHistory())).toContain(
            "claude-opus-5-5@high",
          );
        });
        expect(app.supervisor.getProcessForSession(receipt.sessionId)?.id).toBe(
          initialProcessId,
        );

        // Switch to a fixed-effort model with auto thinking (live, no restart).
        const fixed = await app.app.request(
          `/api/processes/${initialProcessId}/config`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Yep-Anywhere": "true",
            },
            body: JSON.stringify({
              model: "gemini-pro-orchestrator-neon",
              thinking: "auto",
            }),
          },
        );
        expect(fixed.status).toBe(200);
        expect((await fixed.json()).processId).toBe(initialProcessId);

        // Requesting an explicit thinking level on a fixed-effort model fails
        // before mutating state and does not block subsequent turns.
        const rejected = await app.app.request(
          `/api/processes/${initialProcessId}/config`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Yep-Anywhere": "true",
            },
            body: JSON.stringify({ thinking: "on:high" }),
          },
        );
        expect(rejected.status).toBe(500);
        const turn3 = await app.app.request(
          `/api/sessions/${receipt.sessionId}/messages`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Yep-Anywhere": "true",
            },
            body: JSON.stringify({ message: "turn-3-after-reject" }),
          },
        );
        expect(turn3.status).toBe(200);
        await vi.waitFor(() => {
          expect(active?.state.type).toBe("idle");
          expect(JSON.stringify(active?.getMessageHistory())).toContain(
            "gemini-pro-orchestrator-neon@fixed",
          );
        });

        // Legacy effort-suffixed model switch syncs both model and effort in YA.
        const legacySwitch = await app.app.request(
          `/api/processes/${initialProcessId}/model`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Yep-Anywhere": "true",
            },
            body: JSON.stringify({ model: "gemini-4-neon-low" }),
          },
        );
        expect(legacySwitch.status).toBe(200);
        expect(await legacySwitch.json()).toMatchObject({
          processId: initialProcessId,
          model: "gemini-4-neon",
        });
        expect(active?.resolvedModel).toBe("gemini-4-neon");
        expect(active?.appliedEffort).toBe("low");

        const calls = (await readFile(configLog, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as { method: string });
        expect(calls.some((c) => c.method === "session/load")).toBe(false);
        expect(
          calls.filter((c) => c.method === "session/set_config_option").length,
        ).toBeGreaterThanOrEqual(5);
      } finally {
        await active?.abort();
        app.stopNotifications();
        await app.disposeSessionReaders();
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "keeps an in-flight reply attributed to the turn's model when setModel runs mid-turn",
    async () => {
      const cliDir = join(directory, "cli-attr");
      await mkdir(cliDir, { recursive: true });
      const cliExe = join(cliDir, "agy");
      const holdPeer = `#!/usr/bin/env node
const readline = require('node:readline');
const id = '${nativeId}';
const send = v => process.stdout.write(JSON.stringify(v) + '\\n');
const reply = (rid, result) => send({ jsonrpc: '2.0', id: rid, result });
const update = v => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: id, update: v } });
let curModel = 'gemini-4-neon';
let heldPromptId = null;
const opts = () => ([
  { id: 'model', category: 'model', type: 'select', currentValue: curModel, options: [{ value: 'gemini-4-neon', name: 'Neon' }, { value: 'claude-opus-5-5', name: 'Opus' }] },
  { id: 'thought_level', category: 'thought_level', type: 'select', currentValue: 'high', options: [{ value: 'high', name: 'High' }] },
]);
readline.createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') return reply(m.id, { protocolVersion: 1, agentInfo: { version: '${nativeVersion}' } });
  if (m.method === 'session/new') return reply(m.id, { sessionId: id, models: { currentModelId: 'gemini-4-neon-high', availableModels: [] }, modes: { currentModeId: 'default', availableModes: [{ id: 'default' }] }, configOptions: opts() });
  if (m.method === 'session/set_config_option') {
    if (m.params.configId === 'model') curModel = m.params.value;
    const configOptions = opts();
    update({ sessionUpdate: 'config_option_update', configOptions });
    reply(m.id, { configOptions });
    if (heldPromptId !== null) {
      const pid = heldPromptId;
      heldPromptId = null;
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'turn-1-done' } });
      reply(pid, { stopReason: 'end_turn' });
    }
    return;
  }
  if (m.method === 'session/prompt') {
    if (m.params.prompt[0].text === 'hold') {
      heldPromptId = m.id;
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'turn-1-start:' } });
      return;
    }
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'turn-2-done' } });
    return reply(m.id, { stopReason: 'end_turn' });
  }
  return reply(m.id, {});
});
`;
      await writeFile(cliExe, holdPeer);
      await chmod(cliExe, 0o755);
      vi.stubEnv("ANTIGRAVITY_ACP_PATH", cliExe);

      const session = await new AntigravityProvider().startSession({
        cwd: directory,
        initialMessage: { text: "hold", uuid: "turn-1" },
      });
      try {
        const committed: Array<{ text: string; model?: string }> = [];
        let switched = false;
        let sentSecond = false;
        for await (const msg of session.iterator) {
          if (
            msg.type === "assistant" &&
            msg._isStreaming &&
            !switched &&
            String(msg.message?.content).includes("turn-1-start")
          ) {
            switched = true;
            await session.setModel?.("claude-opus-5-5");
          }
          if (msg.type === "assistant" && !msg._isStreaming) {
            committed.push({
              text: String(msg.message?.content),
              model: msg.message?.model,
            });
          }
          if (msg.type === "result") {
            if (!sentSecond) {
              sentSecond = true;
              session.queue.push({ text: "next", uuid: "turn-2" });
            } else {
              break;
            }
          }
        }
        expect(committed).toEqual([
          { text: "turn-1-start:turn-1-done", model: "gemini-4-neon" },
          { text: "turn-2-done", model: "claude-opus-5-5" },
        ]);
      } finally {
        await session.abort();
      }
    },
  );

  /**
   * A controlled `agy`: `--version` prints `cliVersion` (or hangs, ignoring
   * SIGTERM), and `agy acp` exits, answers initialize with `acpVersion`, or
   * answers with a JSON-RPC error. Each launch, version query and method is
   * logged, with `leaked` when a YA credential is visible to the child.
   */
  async function controlledAgy(options: {
    cliVersion?: string;
    hangOnVersion?: string;
    acp:
      | "exit"
      | { version?: string }
      | { error: string }
      | { result: null | "omitted" };
  }) {
    const path = join(directory, "controlled-bin", "agy");
    await mkdir(join(directory, "controlled-bin"), { recursive: true });
    await writeFile(
      path,
      `#!${process.execPath}
const fs = require('node:fs');
const log = line => fs.appendFileSync(${JSON.stringify(log)}, line + '\\n');
const leaked = JSON.stringify(process.env).includes('YA_CANARY') ? ' leaked' : '';
const options = ${JSON.stringify(options)};
if (process.argv.includes('--version')) {
  log('--version' + leaked);
  if (options.hangOnVersion) {
    fs.writeFileSync(options.hangOnVersion, String(process.pid));
    process.on('SIGTERM', () => {});
    setInterval(() => {}, 1000);
  } else {
    console.log(options.cliVersion ?? '');
  }
} else {
  log('launch' + leaked);
  if (options.acp === 'exit') {
    console.error('unknown command "acp"');
    process.exit(2);
  }
  require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
    const m = JSON.parse(line);
    log(m.method);
    const reply = options.acp.error
      ? { error: { code: -32000, message: options.acp.error } }
      : 'result' in options.acp
        ? options.acp.result === null ? { result: null } : {}
        : { result: { protocolVersion: 1, agentInfo: options.acp.version ? { version: options.acp.version } : {} } };
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, ...reply }) + '\\n');
  });
}
`,
    );
    await chmod(path, 0o755);
    vi.stubEnv("ANTIGRAVITY_ACP_PATH", path);
    // Present in YA's environment; never in a child's.
    vi.stubEnv("AUTH_COOKIE_SECRET", "YA_CANARY");
    return path;
  }

  const refusalFor = (installed: string) =>
    `Antigravity requires agy 1.5.13 or later; the installed runtime ${installed}. Run \`agy update\`, or install the agy CLI.`;

  // Each case is a real child: one answers initialize with an old or missing
  // version, the other is an agy too old to have an ACP server at all.
  (process.platform === "win32" ? it.skip : it).each([
    [{ acp: { version: "1.4.5" } }, "reports version 1.4.5"],
    [{ acp: {} }, "did not report a version"],
    [{ acp: { result: null } }, "did not report a version"],
    [{ acp: { result: "omitted" } }, "did not report a version"],
    [{ acp: "exit", cliVersion: "1.4.12" }, "reports version 1.4.12"],
  ] as const)(
    "refuses agy below the floor (%j) in provider status and at start",
    async (behavior, installed) => {
      await controlledAgy(behavior);
      const refusal = refusalFor(installed);

      const provider = new AntigravityProvider();
      expect(await provider.getAuthStatus()).toEqual({
        installed: false,
        authenticated: false,
        enabled: false,
        unavailableReason: refusal,
      });
      expect(provider.getModelCatalogStatus()?.error).toBe(refusal);

      const session = await provider.startSession({
        cwd: directory,
        initialMessage: { text: "must not send" },
      });
      try {
        const messages: SDKMessage[] = [];
        for await (const message of session.iterator) messages.push(message);
        expect(messages).toEqual([{ type: "error", error: refusal }]);
      } finally {
        await session.abort();
      }
      // Nothing beyond initialize reaches a refused runtime, and a version
      // query runs only when ACP never answered.
      const lines = (await readFile(log, "utf8")).trim().split("\n");
      expect(lines.filter((line) => line !== "launch")).toEqual(
        behavior.acp === "exit"
          ? ["--version", "--version"]
          : ["initialize", "initialize"],
      );
    },
  );

  it.skipIf(process.platform === "win32")(
    "describes an updated agy on the first forced refresh",
    async () => {
      await controlledAgy({ acp: { version: "1.4.12" } });
      const provider = new AntigravityProvider();
      expect((await provider.getAuthStatus()).installed).toBe(false);
      await controlledAgy({ acp: { version: "1.5.13" } });
      // The providers route reads status and a forced catalog together.
      const [status] = await Promise.all([
        provider.getAuthStatus(),
        provider.getAvailableModels({ forceRefresh: true }),
      ]);
      expect(status.installed).toBe(true);
      expect(status.unavailableReason).toBeUndefined();
    },
  );

  it.skipIf(process.platform === "win32")(
    "stops serving a cached refusal once agy is replaced",
    async () => {
      await controlledAgy({ acp: { version: "1.4.12" } });
      const routes = createProvidersRoutes({
        providers: [new AntigravityProvider()],
      });
      const installed = async () =>
        (
          (await (await routes.request("/antigravity")).json()) as {
            provider: { installed: boolean };
          }
        ).provider.installed;
      expect(await installed()).toBe(false);
      // `agy update` replaces the file; the page reload after it, or a
      // rescan, reads providers without forcing a refresh.
      await controlledAgy({ acp: { version: "1.5.13" } });
      expect(await installed()).toBe(true);
    },
  );

  it.skipIf(process.platform === "win32")(
    "keeps an ACP peer's own initialize error instead of upgrade advice",
    async () => {
      const agy = await controlledAgy({
        acp: { error: "Native profile is corrupt" },
        cliVersion: "1.4.12",
      });
      const runtime = new AntigravityRuntime();
      try {
        await expect(runtime.connect(agy, directory, ["acp"])).rejects.toThrow(
          /^Native profile is corrupt$/,
        );
      } finally {
        await runtime.close();
      }
      expect((await readFile(log, "utf8")).trim().split("\n")).toEqual([
        "launch",
        "initialize",
      ]);
    },
  );

  it.skipIf(process.platform === "win32")(
    "stops a version probe that ignores SIGTERM when the runtime closes",
    async () => {
      const marker = join(directory, "probe.pid");
      const agy = await controlledAgy({ acp: "exit", hangOnVersion: marker });
      const runtime = new AntigravityRuntime();
      const connecting = runtime.connect(agy, directory, ["acp"]);
      const rejected = expect(connecting).rejects.toThrow("closed");
      await vi.waitFor(() => readFile(marker, "utf8"), { timeout: 5_000 });
      await runtime.close();
      await rejected;
      const pid = Number(await readFile(marker, "utf8"));
      expect(() => process.kill(pid, 0)).toThrow();
    },
  );

  it.skipIf(process.platform === "win32")(
    "saves a refused app creation as a known startup failure carrying the refusal",
    async () => {
      await controlledAgy({ acp: { version: "1.4.12" } });
      const metadata = createTestSessionMetadataService(
        join(directory, "data"),
      );
      await metadata.initialize();
      const app = createApp({
        provider: new AntigravityProvider(),
        dataDir: join(directory, "data"),
        sessionMetadataService: metadata,
        eventBus: new EventBus(),
        authDisabled: true,
        enabledProviders: ["antigravity"],
      });
      try {
        const response = await app.app.request(
          `/api/projects/${toUrlProjectId(directory)}/session-creations`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Yep-Anywhere": "true",
            },
            body: JSON.stringify({
              requestId: "refused-floor",
              message: "must not send",
              provider: "antigravity",
              mode: "default",
            }),
          },
        );
        expect(response.status).toBe(202);
        await vi.waitFor(async () =>
          expect(
            (
              await (
                await app.app.request("/api/session-creations/refused-floor", {
                  headers: { "X-Yep-Anywhere": "true" },
                })
              ).json()
            ).creation,
          ).toMatchObject({
            state: "failed",
            delivery: "not-admitted",
            failure: "startup-unavailable",
            failureDetail: refusalFor("reports version 1.4.12"),
          }),
        );
        expect(await readFile(log, "utf8")).not.toMatch(
          /session\/new|session\/prompt|leaked/,
        );
      } finally {
        app.stopNotifications();
        await app.disposeSessionReaders();
      }
    },
  );
});
