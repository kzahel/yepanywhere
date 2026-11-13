import {
  chmod,
  mkdtemp,
  readFile,
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
import { createApp } from "../../setup/create-app.js";
import { EventBus } from "../../../src/watcher/EventBus.js";
import {
  createTestSessionMetadataService,
  closeTestDiscoveryDatabases,
} from "../../utils/session-metadata-database.js";

const nativeId = "11111111-1111-4111-8111-111111111111";
const peer = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const id = '${nativeId}';
const root = path.join(process.env.GEMINI_HOME, 'antigravity-acp', 'conversations');
const send = value => process.stdout.write(JSON.stringify(value)+'\\n');
const reply = (id, result) => send({jsonrpc:'2.0', id, result});
const update = value => send({jsonrpc:'2.0',method:'session/update',params:{sessionId:id,update:value}});
let prompt;
readline.createInterface({input:process.stdin}).on('line', line => {
 const m = JSON.parse(line);
 if(m.method) fs.appendFileSync(process.env.AGY_TEST_LOG,m.method+'\\n');
 if(m.method === 'initialize') return reply(m.id,{protocolVersion:1});
 if(m.method === 'session/new') {
  fs.mkdirSync(root,{recursive:true});
  fs.writeFileSync(path.join(root,id+'.meta'),JSON.stringify({cwd:m.params.cwd}));
  fs.writeFileSync(path.join(root,id+'.db'),'native fixture');
  return reply(m.id,{sessionId:id,models:{currentModelId:'native-default',availableModels:[{modelId:'native-default',name:'Native default'}]}});
 }
 if(m.method === 'session/load' && m.params.sessionId !== id)
  return send({jsonrpc:'2.0',id:m.id,error:{code:-32000,message:'Native resume refused'}});
 if(m.method === 'session/load') {
  update({sessionUpdate:'user_message_chunk',content:{type:'text',text:'Original question'}});
  update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Saved answer'}});
  return reply(m.id,{});
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

describe("Antigravity native process boundary", () => {
  let directory: string;
  let executable: string;
  let log: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "ya-agy-test-"));
    executable = join(directory, "peer.cjs");
    log = join(directory, "methods.log");
    await writeFile(executable, peer);
    await chmod(executable, 0o755);
    vi.stubEnv("GEMINI_HOME", join(directory, "native-home"));
    vi.stubEnv("ANTIGRAVITY_ACP_PATH", executable);
    vi.stubEnv("AGY_TEST_LOG", log);
  });
  afterEach(async () => {
    closeTestDiscoveryDatabases();
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  });

  it.skipIf(process.platform === "win32")(
    "admits a real child through YA and reopens its native conversation under the same public identity",
    async () => {
      vi.stubEnv("ENABLED_PROVIDERS", "antigravity");
      const metadata = createTestSessionMetadataService(
        join(directory, "data"),
      );
      await metadata.initialize();
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
      let active: ReturnType<typeof app.supervisor.getProcessForSession>;
      const projectId = toUrlProjectId(directory);
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
        await vi.waitFor(() => {
          active = app.supervisor.getProcessForSession(receipt.sessionId);
          expect(active?.state.type).toBe("idle");
          expect(active?.resolvedModel).toBe("native-default");
          expect(
            active?.getMessageHistory().some((m) => m.type === "result"),
          ).toBe(true);
        });
        expect(
          metadata.identities.resolveYa(receipt.sessionId)?.native?.id,
        ).toBe(nativeId);
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
        const nativeCatalog = await new AntigravitySessionCatalogAdapter().scan(
          {
            catalogEpoch: "test",
            targetGeneration: 1,
            mode: { kind: "complete" },
            signal: new AbortController().signal,
          },
        );
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
        await active?.abort();
        active = undefined;
        app.stopNotifications();
        await app.disposeSessionReaders();
        app = boot();
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
        await vi.waitFor(() => {
          active = app.supervisor.getProcessForSession(receipt.sessionId);
          expect(active?.state.type).toBe("idle");
          expect(JSON.stringify(active?.getMessageHistory())).toContain(
            "Saved answer",
          );
          expect(JSON.stringify(active?.getMessageHistory())).toContain(
            "Hello world",
          );
        });
        expect(
          metadata.identities.resolveYa(receipt.sessionId)?.native?.id,
        ).toBe(nativeId);
      } finally {
        await active?.abort();
        app.stopNotifications();
        await app.disposeSessionReaders();
      }
    },
  );

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
      const root = join(
        directory,
        "native-home",
        "antigravity-acp",
        "conversations",
      );
      await mkdir(root, { recursive: true });
      await writeFile(
        join(root, `${nativeId}.meta`),
        JSON.stringify({ cwd: directory }),
      );
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
});
