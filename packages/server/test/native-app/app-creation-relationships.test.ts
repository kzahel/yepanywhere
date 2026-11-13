import { nativeAppTestFixture } from "./fixture.js";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseYaSessionId } from "@yep-anywhere/shared";
import { quoteShellWord } from "../../src/utils/posixShell.js";
import { appBarrier } from "../native-provider/app-fixture.js";
import {
  relationshipResourceKey,
  SessionRelationshipStore,
} from "../../src/sessions/SessionRelationshipStore.js";
import { SessionIdentityStore } from "../../src/sessions/SessionIdentityStore.js";
import { loadSqliteDriver } from "../../src/storage/sqlite.js";

let fixture: Awaited<ReturnType<typeof nativeAppTestFixture>> | undefined;
afterEach(async (context) => {
  if (fixture && context.task.result?.state === "fail")
    console.info(await fixture.diagnostics());
  await fixture?.close();
  fixture = undefined;
});

describe.runIf(process.env.YEP_NATIVE_APP_TESTS === "1")(
  "native v0 creation relationships",
  () => {
    it.for([
      ["claude", "claude"],
      ["claude", "codex"],
      ["codex", "claude"],
      ["codex", "codex"],
    ] as const)(
      "%s creates native %s through its launch-bound API and preserves proof across app replacement",
      {
        // Hosted one-worker M1 run 42121264200 reaches 25.648s. 80s is
        // 3.12x that maximum; receipt and native identity checks stay fixed.
        timeout: 80_000,
      },
      async ([provider, childProvider], context) => {
        const f = await nativeAppTestFixture(provider, context, {
          agentApiManagement: true,
          additionalProviders: [childProvider],
        });
        fixture = f;
        await f.ready();
        const wire = (name: typeof provider) =>
          name === "claude" ? "anthropic" : "responses";
        const parent = await f.create("V0_PARENT_INITIAL");
        const first = await f.model.next();
        expect(first.wire).toBe(wire(provider));
        const socket = await f.connect(parent.sessionId);
        const output = join(f.project, "creation-result.json"),
          script = join(f.project, "create-owned-session.cjs");
        await writeFile(
          script,
          `const http=require('node:http'),fs=require('node:fs');
async function api(path,body){return await new Promise((resolve,reject)=>{const url=new URL(process.env.AGENT_YA_V0_URL+path);const data=body===undefined?undefined:JSON.stringify(Object.fromEntries(Object.entries(body).filter(([k])=>k!=='requestId')));const r=http.request(url,{...(process.env.AGENT_YA_V0_SOCKET?{socketPath:process.env.AGENT_YA_V0_SOCKET}:{}),method:data?'POST':'GET',headers:{Authorization:process.env.AGENT_YA_V0_AUTHORIZATION,'Content-Type':'application/json',...(body?.requestId?{'Idempotency-Key':body.requestId}:{})}},res=>{let text='';res.on('data',c=>text+=c);res.on('end',()=>{try{resolve({status:res.statusCode,body:JSON.parse(text)})}catch(e){reject(e)}})});r.on('error',reject);r.setTimeout(10000,()=>r.destroy(Error('Owned API deadline')));r.end(data)});}
(async()=>{const me=await api('/v0/me');if(me.status!==200||!me.body.session?.management)throw Error('Launch management unavailable');const base='/v0/servers/'+me.body.server.id;
const request={requestId:'native-v0-owned-creation',projectId:${JSON.stringify(parent.projectId)},provider:${JSON.stringify(childProvider)},prompt:'V0_CHILD_INITIAL',permissionMode:'bypassPermissions',model:${JSON.stringify(childProvider === "claude" ? "claude-haiku-5-5" : "gpt-6.1-sol")}};
const created=await api(base+'/sessions',request),retry=await api(base+'/sessions',request),conflict=await api(base+'/sessions',{...request,prompt:'Conflicting input'});
let receipt=created.body;for(let i=0;i<40&&!receipt.sessionId;i++){await new Promise(r=>setTimeout(r,50));receipt=(await api(base+'/receipts/'+receipt.id)).body;}
fs.writeFileSync(${JSON.stringify(output)},JSON.stringify({me:{serverId:me.body.server.id,session:me.body.session},created,retry,conflict,receipt}));console.log('V0_CREATION_TOOL_DONE');})().catch(e=>{console.error(e.message);process.exitCode=1});
`,
        );
        const command = `${quoteShellWord(process.execPath)} ${quoteShellWord(script)}`;
        if (provider === "claude")
          first.tool("Bash", {
            command,
            timeout: 20000,
            description:
              "Create one owned native session through launch-bound v0",
          });
        else
          first.tool(
            "exec",
            `let r=await tools.exec_command({cmd:${JSON.stringify(command)},workdir:${JSON.stringify(f.project)},yield_time_ms:1000,max_output_tokens:100});while(r.session_id)r=await tools.write_stdin({session_id:r.session_id,chars:"",yield_time_ms:1000,max_output_tokens:100});text(r.output);`,
          );
        let parentReply: Awaited<ReturnType<typeof f.model.next>> | undefined;
        for (let i = 0; i < 2; i++) {
          const request = await f.model.next();
          if (JSON.stringify(request.body).includes("V0_PARENT_INITIAL")) {
            expect(request.wire).toBe(wire(provider));
            expect(JSON.stringify(request.body)).toContain(
              "V0_CREATION_TOOL_DONE",
            );
            parentReply = request;
            request.partial("V0_PARENT_HELD");
          } else {
            expect(request.wire).toBe(wire(childProvider));
            expect(JSON.stringify(request.body)).toContain("V0_CHILD_INITIAL");
            request.finish("V0_CHILD_DONE");
          }
        }
        expect(parentReply).toBeDefined();
        const result = JSON.parse(await readFile(output, "utf8"));
        expect(result.created.status).toBe(202);
        expect(result.retry.status).toBe(202);
        expect(result.retry.body.id).toBe(result.created.body.id);
        expect(result.conflict.status).toBe(409);
        expect(result.conflict.body.error.code).toBe("request_id_conflict");
        expect(result.me.session.id).toBe(parent.sessionId);
        expect(result.receipt.creator.sessionId).toBe(parent.sessionId);
        const child = result.receipt.sessionId as string;
        expect(child).toBeTruthy();
        expect(child).not.toBe(parent.sessionId);
        const source = {
          kind: "session" as const,
          serverId: result.me.serverId,
          sessionId: parent.sessionId,
        };
        const target = { ...source, sessionId: child };
        const assertDurable = async (verifyNativeObservation = false) => {
          const rows = await appBarrier(async () => {
            // Also fences fixture teardown: a closed app aborts this barrier.
            await f.api("/version");
            const db = loadSqliteDriver()!.open(
              join(f.root, "home", "ya", "discovery.sqlite"),
              { readOnly: true },
            );
            let graph: SessionRelationshipStore | undefined;
            let identities: SessionIdentityStore | undefined;
            try {
              db.exec("BEGIN"); // One read-only snapshot, never BEGIN IMMEDIATE.
              graph = new SessionRelationshipStore(db);
              identities = new SessionIdentityStore(db);
              const edges = graph.list({
                resource: source,
                direction: "outgoing",
                type: "created_session",
              }).edges;
              const childIdentity = identities.resolveYa(
                parseYaSessionId(child),
              );
              const parentIdentity = identities.resolveYa(
                parseYaSessionId(parent.sessionId),
              );
              if (
                !edges.length ||
                !childIdentity?.native ||
                !parentIdentity?.native
              )
                return false;
              const nativeObservation = graph.checkpoint(
                "provider-child-snapshot-v1",
                relationshipResourceKey({
                  kind: "native",
                  serverId: result.me.serverId,
                  native: parentIdentity.native,
                }),
              );
              if (
                verifyNativeObservation &&
                nativeObservation?.state !== "complete"
              )
                return false;
              const snapshot = {
                nativeObservation,
                edges,
                incoming: graph.list({
                  resource: target,
                  direction: "incoming",
                  type: "created_session",
                }).edges,
                evidence: graph.evidence(edges[0]!.id),
                publicChildren: graph.list({
                  resource: target,
                  type: "provider_child",
                }).edges,
                nativeChildren: graph.list({
                  resource: {
                    kind: "native",
                    serverId: result.me.serverId,
                    native: childIdentity.native,
                  },
                  type: "provider_child",
                }).edges,
                childIdentity,
                parentIdentity,
              };
              db.exec("COMMIT");
              return snapshot;
            } finally {
              graph?.dispose();
              identities?.close();
              db.close();
            }
          }, "durable creation SQL publication");
          // Once publication exists, semantic regressions fail immediately.
          expect(rows.edges).toHaveLength(1);
          expect(rows.edges[0]?.target).toEqual(target);
          expect(rows.incoming).toEqual(rows.edges);
          expect(rows.evidence).toContainEqual(
            expect.objectContaining({
              trust: "local-authenticated",
              metadata: expect.objectContaining({
                receiptId: result.receipt.id,
              }),
            }),
          );
          if (verifyNativeObservation)
            expect(rows.nativeObservation?.state).toBe("complete");
          expect(rows.publicChildren).toEqual([]);
          expect(rows.nativeChildren).toEqual([]);
          expect(rows.parentIdentity.native?.family).toBe(provider);
          expect(rows.childIdentity.native?.family).toBe(childProvider);
          const page = await f.api(
            `/projects/${parent.projectId}/sessions/${parent.sessionId}/relationships?direction=outgoing&type=created_session`,
          );
          expect(page.relationships).toEqual([
            expect.objectContaining({
              type: "created_session",
              source: {
                ...source,
                kind: "session",
                projectId: parent.projectId,
                provider,
              },
              target: {
                ...target,
                kind: "session",
                projectId: parent.projectId,
                provider: childProvider,
              },
              evidence: [
                expect.objectContaining({ trust: "local-authenticated" }),
              ],
            }),
          ]);
          expect(page.nextCursor).toBeNull();
          const incomingPage = await f.api(
            `/projects/${parent.projectId}/sessions/${child}/relationships?direction=incoming&type=created_session`,
          );
          expect(incomingPage).toEqual(page);
          const publicJson = JSON.stringify(page);
          expect(publicJson).not.toContain(
            rows.parentIdentity.native!.storageScope,
          );
          expect(publicJson).not.toContain(
            rows.childIdentity.native!.storageScope,
          );
          expect(publicJson).not.toContain(result.receipt.id);
          return rows.parentIdentity.native!.id;
        };
        const nativeParentId = await assertDurable();
        const metadata = await f.api(
          `/projects/${parent.projectId}/sessions/${child}/metadata`,
        );
        expect(metadata.session.creationProvenance).toMatchObject({
          surface: "api",
        });
        const before = (await f.inventory()).find(
          (w) => w.providerSessionId === nativeParentId,
        );
        expect(before).toBeDefined();
        if (!before)
          throw new Error("Parent native owner missing before replacement");
        await f.api("/server/restart", {});
        const after = await appBarrier(async () => {
          const next = (await f.inventory()).find(
            (w) => w.runtimeId === before.runtimeId,
          );
          return next?.attachedServerGeneration &&
            next.attachedServerGeneration !== before.attachedServerGeneration
            ? next
            : false;
        }, "v0 creation replacement");
        expect(after.pid).toBe(before.pid);
        expect(after.providerProcessGroupIds).toEqual(
          before.providerProcessGroupIds,
        );
        await appBarrier(
          async () => await f.api("/version"),
          "replacement API",
        );
        await f.api(
          `/projects/${parent.projectId}/sessions/${parent.sessionId}`,
        );
        await assertDurable(true);
        const relationshipResponse = await fetch(
          `${f.baseUrl}/v0/servers/${result.me.serverId}/sessions/${child}/relationships?includeRelated=true&relatedDirection=incoming&relatedType=created_session`,
        );
        expect(relationshipResponse.ok).toBe(true);
        const relationships = await relationshipResponse.json();
        const sessions = await appBarrier(async () => {
          const response = await fetch(
            `${f.baseUrl}/v0/servers/${result.me.serverId}/sessions?projectId=${encodeURIComponent(parent.projectId)}`,
          );
          if (!response.ok)
            throw new Error(`Owned session catalog: ${response.status}`);
          const page = await response.json();
          return page.items?.some(
            (s: { id: string }) => s.id === parent.sessionId,
          ) && page.items.some((s: { id: string }) => s.id === child)
            ? page.items
            : false;
        }, "both native sessions in catalog");
        expect(sessions.map((s: { id: string }) => s.id).sort()).toEqual(
          [parent.sessionId, child].sort(),
        );
        expect(relationships.creation?.id).toBe(result.receipt.id);
        expect(relationships.related.relationships).toEqual([
          expect.objectContaining({
            type: "created_session",
            source: expect.objectContaining({
              sessionId: parent.sessionId,
              provider,
            }),
            target: expect.objectContaining({
              sessionId: child,
              provider: childProvider,
            }),
          }),
        ]);
        expect(relationships.related.nextCursor).toBeNull();
        socket.ws.close();
        const reconnected = await f.connect(parent.sessionId);
        parentReply!.finish("V0_PARENT_FINISHED");
        await reconnected.wait("V0_PARENT_FINISHED");
        await reconnected.wait('"type":"result"');
        await f.close();
        expect(f.model.failures).toEqual([]);
        expect(f.model.requests).toHaveLength(3);
        expect(f.model.requests.map((request) => request.wire).sort()).toEqual(
          [wire(provider), wire(provider), wire(childProvider)].sort(),
        );
      },
    );
  },
);
