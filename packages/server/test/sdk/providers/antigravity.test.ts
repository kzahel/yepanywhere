import {
  chmod,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
  mkdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toUrlProjectId } from "@yep-anywhere/shared";
import { AntigravityProvider } from "../../../src/sdk/providers/antigravity.js";
import { AntigravityRuntime } from "../../../src/sdk/providers/antigravity-runtime.js";
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
import { EventBus } from "../../../src/watcher/EventBus.js";
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
let replayHeld = false;
readline.createInterface({input:process.stdin}).on('line', line => {
 const m = JSON.parse(line);
 if(m.method) fs.appendFileSync(process.env.AGY_TEST_LOG,m.method+'\\n');
 if(m.method === 'initialize') return reply(m.id,{protocolVersion:1,agentInfo:{version:'${nativeVersion}'}});
 if(m.method === 'session/new') {
  fs.mkdirSync(root,{recursive:true});
  fs.writeFileSync(path.join(root,id+'.db'),'native fixture');
  return reply(m.id,{sessionId:id,models:{currentModelId:'native-default',availableModels:[{modelId:'native-default',name:'Native default'}]}});
 }
 if(m.method === 'session/load' && m.params.sessionId !== id)
  return send({jsonrpc:'2.0',id:m.id,error:{code:-32000,message:'Native resume refused'}});
 if(m.method === 'session/load') {
  update({sessionUpdate:'user_message_chunk',content:{type:'text',text:'Original question'}});
  if (process.env.AGY_TEST_HOLD_REPLAY) {
   update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Saved prefix'}});
   if (process.env.AGY_TEST_INCOMPLETE_REPLAY) {
    reply(m.id,{});
    return process.stdout.write('', () => process.exit(0));
   }
   replayHeld = true;
   return reply(m.id,{});
  }
  if (process.env.AGY_TEST_LARGE_REPLAY) {
   const content = [{type:'content',content:{type:'text',text:'x'.repeat(1024*1024)}}];
   for (let tool = 0; tool < 9; tool++)
    update({sessionUpdate:'tool_call',toolCallId:'replayed-'+tool,title:'Saved tool',status:'completed',content});
  }
  // Displayed history, unlike undisplayed tool fields, counts toward YA's cap.
  if (process.env.AGY_TEST_OVERSIZED_REPLAY)
   for (let chunk = 0; chunk < 9; chunk++)
    update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'z'.repeat(1024*1024)}});
  update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Saved answer'}});
  return reply(m.id,{});
 }
 if(m.method === 'test/releaseReplay' && replayHeld) {
  replayHeld = false;
  return update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:' Final replay frame'}},{isReplay:true});
 }
 if(m.method === 'session/list') return reply(m.id,{sessions:[{sessionId:id,title:'Original question'}]});
 if(m.method === 'session/prompt') {
  prompt=m.id;
  // agy 1.5+ echoes the submitted prompt during the live turn.
  update({sessionUpdate:'user_message_chunk',content:{type:'text',text:m.params.prompt[0].text}});
  update({sessionUpdate:'usage_update',used:123,size:1048576});
  if(m.params.prompt[0].text === 'approval') {
   return send({jsonrpc:'2.0',id:100,method:'session/request_permission',params:{sessionId:id,
    toolCall:{toolCallId:'tool-1',title:'Write file',kind:'edit'},
    options:[{optionId:'native-allow',name:'Allow',kind:'allow_once'},{optionId:'native-deny',name:'Deny',kind:'reject_once'}]}});
  }
  if(m.params.prompt[0].text === 'big') {
   for (let chunk = 0; chunk < 3; chunk++)
    update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'y'.repeat(1024*1024)}});
   return reply(m.id,{stopReason:'end_turn'});
  }
  if(m.params.prompt[0].text === 'wait') {
   update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Waiting'}});
   return;
  }
  update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Hello '}});
  update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'world'}});
  return reply(m.id,{stopReason:'end_turn'});
 }
 if(m.id===100 && m.result) {
  update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:m.result.outcome.optionId}});
  return reply(prompt,{stopReason:'end_turn'});
 }
 if(m.method === 'session/cancel') return reply(prompt,{stopReason:'cancelled'});
 return reply(m.id,{});
});
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
  afterEach(async () => {
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
    // Three real child launches and a large replay took up to 2.2s under
    // local CPU contention. Earlier full-suite runs exhausted a 1s startup
    // wait before reaching any of the reopen steps.
    8_000,
  );

  async function exerciseAdmission(signal: AbortSignal) {
    vi.stubEnv("ENABLED_PROVIDERS", "antigravity");
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
      vi.stubEnv("AGY_TEST_LARGE_REPLAY", "1");
      app = boot();
      const history = await (
        await app.app.request(detailPath, {
          headers: { "X-Yep-Anywhere": "true" },
        })
      ).json();
      expect(JSON.stringify(history.messages)).toContain("Saved answer");
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
      await waitForIdle(active, signal, (process) =>
        process
          .getMessageHistory()
          .some(
            (message) =>
              message.type === "assistant" &&
              message.message?.content === "Saved answer",
          ),
      );
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
      expect(resumedHistory).toContain("Saved answer");
      expect(resumedHistory).toContain("Hello world");
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

  it.skipIf(process.platform === "win32")(
    "streams, translates native approvals, and cancels without owning login",
    async () => {
      const provider = new AntigravityProvider();
      const session = await provider.startSession({
        cwd: directory,
        model: "default",
        initialMessage: { text: "approval", uuid: "input-1" },
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
        expect(await readFile(log, "utf8")).not.toMatch(
          /authenticate|logout|set_model|set_mode/,
        );
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
          "session/load",
        ]);
      } finally {
        await session.abort();
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "reads native history with no prompt/authentication and refuses another project",
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
        expect(loaded?.summary.fullTitle).toBe("Original question");
        expect(loaded?.data.provider).toBe("antigravity");
        expect((await readFile(log, "utf8")).trim().split("\n")).toEqual([
          "initialize",
          "session/load",
        ]);
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

  it.skipIf(process.platform === "win32")(
    "requires the saved tail after an early load response, even on retry and resume",
    async () => {
      const root = join(store, "conversations");
      await mkdir(root, { recursive: true });
      await writeFile(join(root, `${nativeId}.db`), "native fixture");
      const logs = join(store, "brain", nativeId, ".system_generated", "logs");
      await mkdir(logs, { recursive: true });
      const finalText = "Saved prefix Final replay frame";
      const transcriptPath = join(logs, "transcript_full.jsonl");
      const reader = new AntigravitySessionReader({ projectPath: directory });
      const projectId = toUrlProjectId(directory);
      let loadReplied = Promise.withResolvers<AntigravityRuntime>();
      const releaseTail = (runtime: AntigravityRuntime) => {
        const transport = runtime as unknown as {
          send(frame: Record<string, unknown>): void;
        };
        transport.send({ jsonrpc: "2.0", method: "test/releaseReplay" });
      };
      const call = AntigravityRuntime.prototype.call;
      const observeReply = vi
        .spyOn(AntigravityRuntime.prototype, "call")
        .mockImplementation(async function (
          this: AntigravityRuntime,
          method,
          params,
          timeoutMs,
        ) {
          const result = await call.call(this, method, params, timeoutMs);
          if (method === "session/load") loadReplied.resolve(this);
          return result;
        });
      try {
        // A killed provider can leave a partial native line. Keep that reply
        // labeled incomplete across watcher-triggered reads of the same version.
        await writeFile(transcriptPath, '{"step_index":');
        const fallback = await reader.getSession(nativeId, projectId);
        expect(fallback?.transcriptComplete).toBe(false);
        expect(fallback?.data.session.messages.at(-1)?.message?.content).toBe(
          "Saved answer",
        );
        expect(
          (await reader.getSession(nativeId, projectId))?.transcriptComplete,
        ).toBe(false);
        // Native writes create a new conversation version to recheck.
        await writeFile(join(root, `${nativeId}.db`), "updated native fixture");
        await writeFile(
          transcriptPath,
          JSON.stringify({
            step_index: 1,
            type: "PLANNER_RESPONSE",
            status: "DONE",
            content: finalText,
          }) + "\n",
        );
        vi.stubEnv("AGY_TEST_HOLD_REPLAY", "1");
        vi.stubEnv("AGY_TEST_INCOMPLETE_REPLAY", "1");
        await expect(reader.getSession(nativeId, projectId)).rejects.toThrow(
          "closed before its saved replay tail arrived",
        );
        vi.stubEnv("AGY_TEST_INCOMPLETE_REPLAY", "");
        loadReplied = Promise.withResolvers<AntigravityRuntime>();
        const reopened = reader.getSession(nativeId, projectId);
        // Propagate a production read failure even if the load never starts.
        releaseTail(
          await Promise.race([
            loadReplied.promise,
            reopened.then(() => {
              throw new Error("Cold history returned before replay release");
            }),
          ]),
        );
        const first = await reopened;
        const second = await reader.getSession(nativeId, projectId);
        for (const result of [first, second]) {
          expect(result?.transcriptComplete).toBeUndefined();
          expect(
            result?.data.session.messages
              .filter((message) => message.type === "assistant")
              .map((message) => message.message?.content),
          ).toEqual([finalText]);
        }
        const loads = (await readFile(log, "utf8"))
          .split("\n")
          .filter((line) => line === "session/load");
        expect(loads).toHaveLength(3);

        loadReplied = Promise.withResolvers<AntigravityRuntime>();
        const session = await new AntigravityProvider().startSession({
          cwd: directory,
          resumeSessionId: nativeId,
          initialMessage: { text: "continue" },
        });
        try {
          const resumed = (async () => {
            const messages: SDKMessage[] = [];
            for await (const message of session.iterator) {
              messages.push(message);
              if (message.type === "result") break;
            }
            return messages;
          })();
          const runtime = await Promise.race([
            loadReplied.promise,
            resumed.then(() => {
              throw new Error("Resume finished before replay release");
            }),
          ]);
          expect(await readFile(log, "utf8")).not.toContain("session/prompt");
          releaseTail(runtime);
          const messages = await resumed;
          expect(
            messages
              .filter(
                (message) => message.isReplay && message.type === "assistant",
              )
              .map((message) => message.message?.content),
          ).toEqual([finalText]);
          expect(messages.at(-1)?.type).toBe("result");
        } finally {
          await session.abort();
        }
      } finally {
        observeReply.mockRestore();
        await reader.close();
      }
    },
    // Multiple peer launches shared a 5s test deadline that was exhausted
    // while qualifying the native suites under concurrent load.
    10_000,
  );

  // Plan 195 records today's limits here. Step 4 flips the open half (cold
  // history comes from the log), step 5 the resume half (resume retains no
  // replayed history); both then assert success with bounded retained bytes.
  it.skipIf(process.platform === "win32")(
    "today: a displayed replay over 8 MiB fails on open and on resume",
    async () => {
      const root = join(store, "conversations");
      await mkdir(root, { recursive: true });
      await writeFile(join(root, `${nativeId}.db`), "native fixture");
      vi.stubEnv("AGY_TEST_OVERSIZED_REPLAY", "1");
      const limit = "Antigravity replay exceeds the experimental history limit";
      const reader = new AntigravitySessionReader({ projectPath: directory });
      try {
        await expect(
          reader.getSession(nativeId, toUrlProjectId(directory)),
        ).rejects.toThrow(limit);
      } finally {
        await reader.close();
      }
      const session = await new AntigravityProvider().startSession({
        cwd: directory,
        resumeSessionId: nativeId,
        initialMessage: { text: "must not send" },
      });
      try {
        const messages: SDKMessage[] = [];
        for await (const message of session.iterator) messages.push(message);
        expect(messages).toEqual([{ type: "error", error: limit }]);
      } finally {
        await session.abort();
      }
      // The runtime is torn down mid-replay; nothing is prompted.
      expect((await readFile(log, "utf8")).trim().split("\n")).toEqual([
        "initialize",
        "session/load",
        "initialize",
        "session/load",
      ]);
    },
  );

  // Plan 195 step 6 flips this: retained history stays bounded and the
  // session keeps running however much it has written.
  it.skipIf(process.platform === "win32")(
    "today: a live session that passes 8 MiB across turns is torn down mid-turn",
    async () => {
      const session = await new AntigravityProvider().startSession({
        cwd: directory,
        initialMessage: { text: "big", uuid: "turn-1" },
      });
      try {
        const results: number[] = [];
        let error: SDKMessage | undefined;
        let committed = 0;
        for await (const message of session.iterator) {
          if (message.type === "assistant" && !message._isStreaming)
            committed++;
          if (message.type === "error") error = message;
          if (message.type !== "result") continue;
          results.push(committed);
          session.queue.push({
            text: "big",
            uuid: `turn-${results.length + 1}`,
          });
        }
        // Each turn is 3 MiB of displayed text, so the third crosses the
        // owner's cumulative 8 MiB cap. Recording throws inside the native
        // update handler, which fails the pending prompt and stops `agy`.
        expect(results).toEqual([1, 2]);
        expect(error).toEqual({
          type: "error",
          error:
            "Antigravity live history exceeds the experimental history limit",
        });
        expect(session.isProcessAlive?.()).toBe(false);
        const methods = (await readFile(log, "utf8")).trim().split("\n");
        expect(
          methods.filter((method) => method === "session/prompt"),
        ).toHaveLength(3);
        expect(methods).not.toContain("session/cancel");
      } finally {
        await session.abort();
      }
    },
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
