import { apiCommand } from "../support/api-command-request.js";
import { request } from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { expect, it } from "vitest";
import { createFixture } from "../../../../scripts/agent-api-eval/fixture.js";
import {
  providerLimitReached,
  trialAuth,
} from "../../../../scripts/agent-api-eval/support.js";
import { ownProcessGroup } from "../../../../scripts/agent-api-eval/process.js";
import {
  grade,
  SERVER_ID,
  REVIEW_IDS,
  PROJECT_ID,
  OWN_SESSION_ID,
  type Answer,
} from "../../../../scripts/agent-api-eval/cases.js";

const empty: Answer = {
  serverId: null,
  sessionId: null,
  projectId: null,
  sessionIds: [],
  complete: null,
  supported: null,
  answer: "",
};

it.skipIf(process.platform === "win32")(
  "kills a TERM-resistant descendant after its leader exits",
  async () => {
    const child = spawn(
      process.execPath,
      [
        "-e",
        `
    const {spawn}=require('node:child_process');
    const descendant=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});process.send('ready');setInterval(()=>{},1000)"],{stdio:['ignore','ignore','ignore','ipc']});
    descendant.on('message',()=>process.stdout.write(String(descendant.pid)+'\\n'));
    process.on('SIGTERM',()=>process.exit(0));
  `,
      ],
      { detached: true, stdio: ["ignore", "pipe", "ignore"] },
    );
    const owned = ownProcessGroup(child);
    let descendant = 0;
    try {
      const [data] = await once(child.stdout!, "data");
      descendant = Number(String(data).trim());
      expect(descendant).toBeGreaterThan(0);
      const closed = once(child, "close");
      owned.stop();
      await closed;
      await owned.finished;
      let state = "";
      try {
        state = execFileSync("ps", ["-p", String(descendant), "-o", "stat="], {
          encoding: "utf8",
        }).trim();
      } catch {
        /* absent is expected */
      }
      expect(state === "" || state.startsWith("Z")).toBe(true);
    } finally {
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          /* gone */
        }
      }
    }
  },
);

it("does not treat model prose as a quota failure or give a trial refresh/API-key authority", () => {
  expect(
    providerLimitReached(
      [{ type: "turn.completed", usage: { output_tokens: 429 } }],
      "",
      0,
    ),
  ).toBe(false);
  expect(
    providerLimitReached(
      [
        {
          type: "item.completed",
          item: {
            type: "agent_message",
            text: "This API has no rate limit feature",
          },
        },
      ],
      "",
      0,
    ),
  ).toBe(false);
  expect(
    providerLimitReached(
      [{ type: "turn.failed", error: { message: "HTTP 429 rate limit" } }],
      "",
      1,
    ),
  ).toBe(true);
  const now = Date.UTC(2026, 0, 1);
  const token = `header.${Buffer.from(JSON.stringify({ exp: (now + 3_600_000) / 1000 })).toString("base64url")}.signature`;
  const saved = JSON.stringify({
    auth_mode: "chatgpt",
    OPENAI_API_KEY: "do-not-copy",
    tokens: { access_token: token, refresh_token: "never-rotate-this" },
    last_refresh: new Date(now).toISOString(),
  });
  const copy = JSON.parse(trialAuth(saved, 120_000, now));
  expect(copy.tokens.access_token).toBe(token);
  expect(copy.tokens.refresh_token).toBe("");
  expect(copy.OPENAI_API_KEY).toBeUndefined();
  expect(() => trialAuth(saved, 3_600_000, now)).toThrow("needs refreshing");
});
function read(
  env: Record<string, string>,
  path: string,
  authenticated = true,
  body?: unknown,
) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request(
      new URL(path, env.AGENT_YA_V0_URL),
      {
        socketPath: env.AGENT_YA_V0_SOCKET,
        method: body === undefined ? "GET" : "POST",
        headers: authenticated
          ? {
              Authorization: env.AGENT_YA_V0_AUTHORIZATION,
              ...(body !== undefined ? apiCommand(body).headers : {}),
            }
          : {},
      },
      (response) => {
        let body = "";
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () =>
          resolve({ status: response.statusCode!, body }),
        );
      },
    );
    req.on("error", reject);
    req.end(body === undefined ? undefined : apiCommand(body).body);
  });
}

it("grades all matching sessions over real pagination and measures repeated documentation plus failed auth", async () => {
  const fixture = await createFixture("pagination");
  try {
    const ids: string[] = [];
    let cursor: string | null = null;
    do {
      const response = await read(
        fixture.environment,
        `/v0/servers/${SERVER_ID}/sessions?projectId=${PROJECT_ID}&limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      );
      expect(response.status).toBe(200);
      const body = JSON.parse(response.body);
      ids.push(
        ...body.items
          .filter((item: { title: string }) => item.title === "Release review")
          .map((item: { id: string }) => item.id),
      );
      cursor = body.nextCursor;
    } while (cursor);
    expect(ids.sort()).toEqual([...REVIEW_IDS].sort());
    const answer = { ...empty, sessionIds: ids };
    expect(grade("pagination", answer, fixture.trace)).toBe(true);
    expect(
      grade(
        "pagination",
        { ...answer, sessionIds: ids.slice(1) },
        fixture.trace,
      ),
    ).toBe(false);
    expect(grade("pagination", answer, [])).toBe(false);
    const first = await read(fixture.environment, "/v0/help");
    const second = await read(fixture.environment, "/v0/help");
    await read(fixture.environment, "/v0/help", false);
    const docs = fixture.trace.filter((entry) => entry.path === "/v0/help");
    expect(docs.map((entry) => entry.status)).toEqual([200, 200, 401]);
    expect(docs[0]?.bytes).toBe(Buffer.byteLength(first.body));
    expect(docs[1]?.bytes).toBe(Buffer.byteLength(second.body));
  } finally {
    await fixture.close();
  }
});

it("distinguishes incomplete evidence, unsupported actions and an ordinary no-API task", async () => {
  const fixture = await createFixture("incomplete");
  try {
    const response = await read(
      fixture.environment,
      `/v0/servers/${SERVER_ID}/sessions`,
    );
    expect(JSON.parse(response.body).catalog.complete).toBe(false);
    expect(
      grade("incomplete", { ...empty, complete: false }, fixture.trace),
    ).toBe(true);
    expect(
      grade("incomplete", { ...empty, complete: true }, fixture.trace),
    ).toBe(false);
    await read(fixture.environment, "/v0/servers");
    const topologyOnly = fixture.trace.filter(
      (entry) => entry.path === "/v0/servers",
    );
    expect(
      grade("unsupported", { ...empty, supported: false }, topologyOnly, true),
    ).toBe(true);
    expect(
      grade("unsupported", { ...empty, supported: false }, topologyOnly),
    ).toBe(false);
    await read(fixture.environment, `/v0/servers/${SERVER_ID}/capabilities`);
    expect(
      grade("unsupported", { ...empty, supported: false }, fixture.trace),
    ).toBe(true);
    const alternative = fixture.trace.filter(
      (entry) => !entry.path.endsWith("/capabilities"),
    );
    await read(fixture.environment, "/v0/schema");
    alternative.push(fixture.trace.at(-1)!);
    expect(
      grade("unsupported", { ...empty, supported: false }, alternative),
    ).toBe(true);
    expect(grade("control", { ...empty, answer: "391" }, [])).toBe(true);
    expect(grade("control", { ...empty, answer: "391" }, fixture.trace)).toBe(
      false,
    );
    expect(grade("project", {} as Answer, fixture.trace)).toBe(false);
  } finally {
    await fixture.close();
  }
});

it("lets an unobserved worker finish for polling and requires real reset evidence", async () => {
  const polling = await createFixture("follow");
  const path = `/v0/servers/${SERVER_ID}/sessions/orchid-072/conversation`;
  try {
    const first = JSON.parse((await read(polling.environment, path)).body);
    expect(first.activity).toBe("working");
    await polling.workerFinished;
    const final = JSON.parse((await read(polling.environment, path)).body);
    expect(final.activity).toBe("idle");
    expect(
      grade("follow", { ...empty, answer: "worker-9c4" }, polling.trace),
    ).toBe(true);
  } finally {
    await polling.close();
  }
  const reconnect = await createFixture("reconnect");
  try {
    const initial = JSON.parse(
      (await read(reconnect.environment, path + "/follow?maxMessages=1")).body,
    );
    const answer = { ...empty, supported: true, answer: "worker-9c4" };
    expect(grade("reconnect", answer, reconnect.trace)).toBe(false);
    await read(
      reconnect.environment,
      path + "/follow?after=" + initial.cursor + "&maxMessages=20&waitMs=0",
    );
    expect(grade("reconnect", answer, reconnect.trace)).toBe(true);
    expect(
      grade(
        "reconnect",
        answer,
        reconnect.trace.map((item) => ({ ...item, follow: undefined })),
      ),
    ).toBe(false);
  } finally {
    await reconnect.close();
  }
});

// CI 41288604016 exhausted 5,000 ms for the real relay workflow; focused
// macOS took 3,069 ms. Allow 4x the CI lower bound for its SRP requests.
it.each([false, true])(
  "requires a real same-receipt retry and consumed observation (peer relay: %s)",
  async (peerRelay) => {
    const fixture = await createFixture("workflow", peerRelay);
    const root = `/v0/servers/${fixture.apiServerId}`;
    try {
      const created = JSON.parse(
        (
          await read(fixture.environment, root + "/sessions", true, {
            requestId: "eval-create-1",
            projectId: PROJECT_ID,
            provider: "codex",
            prompt: "Release review",
          })
        ).body,
      );
      const creation = JSON.parse(
        (await read(fixture.environment, root + "/receipts/" + created.id))
          .body,
      );
      expect(creation.sessionId).toBe("eval-worker-1");
      const path = root + "/sessions/eval-worker-1";
      await read(fixture.environment, path + "/conversation");
      const input = {
        requestId: "eval-message-1",
        prompt: "Follow-up artifact",
      };
      const sent = JSON.parse(
        (await read(fixture.environment, path + "/prompts", true, input)).body,
      );
      await read(fixture.environment, path + "/relationships");
      await read(fixture.environment, path + "/conversation/follow?waitMs=0");
      const answer = {
        ...empty,
        sessionId: "eval-worker-1",
        sessionIds: [OWN_SESSION_ID],
        answer: "followup-c82",
      };
      expect(
        grade("workflow", answer, fixture.trace, false, fixture.apiServerId),
      ).toBe(false);
      const repeated = JSON.parse(
        (await read(fixture.environment, path + "/prompts", true, input)).body,
      );
      expect(repeated.id).toBe(sent.id);
      expect(
        grade("workflow", answer, fixture.trace, false, fixture.apiServerId),
      ).toBe(false);
      await read(
        fixture.environment,
        root + "/receipts/" + sent.id + "/follow?waitMs=0",
      );
      expect(
        grade("workflow", answer, fixture.trace, false, fixture.apiServerId),
      ).toBe(true);
      expect(
        grade(
          "workflow",
          answer,
          fixture.trace.map((entry) => ({ ...entry, receipt: undefined })),
          false,
          fixture.apiServerId,
        ),
      ).toBe(false);
      const view = JSON.parse(
        (await read(fixture.environment, path + "/conversation")).body,
      );
      expect(JSON.stringify(view).match(/followup-c82/g)).toHaveLength(1);
    } finally {
      await fixture.close();
    }
  },
  20_000,
);

it("discovers, creates and verifies a routed worker through the private HTTP adapter with focused docs", async () => {
  const fixture = await createFixture("selection");
  try {
    const help = await read(fixture.environment, "/v0/help");
    expect(help.status).toBe(200);
    expect(help.body).toContain("/v0/schema?operation=createSession");
    expect(help.body).toContain("| `selection` | GET |");
    // The prior shipped help was 15,884 UTF-8 bytes (same bootstrap).
    // Keep discovery below that observed baseline, including the new index.
    expect(Buffer.byteLength(help.body)).toBeLessThan(15884);
    const focused = await read(
      fixture.environment,
      "/v0/schema?operation=createSession",
    );
    const full = await read(fixture.environment, "/v0/schema");
    expect(Buffer.byteLength(focused.body)).toBeLessThan(
      Buffer.byteLength(full.body),
    );
    const schema = JSON.parse(focused.body);
    expect(Object.keys(schema.paths)).toHaveLength(1);
    const properties =
      schema.paths["/v0/servers/{serverId}/sessions"].post.requestBody.content[
        "application/json"
      ].schema.properties;
    expect(properties.routerPoolId).toBeDefined();
    const root = "/v0/servers/self";
    const choices = JSON.parse(
      (await read(fixture.environment, `${root}/selection?provider=codex`))
        .body,
    );
    expect(choices.accounts[0].models[0].serviceTiers[0].id).toBe("priority");
    const created = JSON.parse(
      (
        await read(fixture.environment, `${root}/sessions`, true, {
          requestId: "selection-eval-01",
          projectId: PROJECT_ID,
          provider: "codex",
          prompt: "Review release",
          routerPoolId: choices.pools[0].id,
          model: choices.accounts[0].models[0].id,
          thinking: "on:high",
          serviceTier: "priority",
          permissionMode: "plan",
        })
      ).body,
    );
    let receipt = JSON.parse(
      (await read(fixture.environment, `${root}/receipts/${created.id}`)).body,
    );
    // Dispatch is asynchronous: identical-key/receipt observation never relaunches.
    if (!receipt.sessionId)
      receipt = JSON.parse(
        (await read(fixture.environment, `${root}/receipts/${created.id}`))
          .body,
      );
    const inspected = await read(
      fixture.environment,
      `${root}/sessions/${receipt.sessionId}`,
    );
    expect(inspected.status).toBe(200);
    const answer = {
      ...empty,
      sessionId: "eval-worker-1",
      supported: true,
      answer: "release-model|high|priority|release-pool|release-account|plan",
    };
    expect(grade("selection", answer, fixture.trace)).toBe(true);
    expect(
      grade(
        "selection",
        answer,
        fixture.trace.filter((entry) => !entry.inspection),
      ),
    ).toBe(false);
    expect(
      grade(
        "selection",
        answer,
        fixture.trace.map((entry) =>
          entry.inspection
            ? {
                ...entry,
                inspection: {
                  ...entry.inspection,
                  settings: { ...entry.inspection.settings, effort: "low" },
                },
              }
            : entry,
        ),
      ),
    ).toBe(false);
    expect(
      grade(
        "operation",
        { ...empty, answer: "createSession" },
        fixture.trace.filter((entry) => entry.path !== "/v0/schema"),
      ),
    ).toBe(true);
    expect(
      grade("operation", { ...empty, answer: "createSession" }, fixture.trace),
    ).toBe(false);
  } finally {
    await fixture.close();
  }
});

it.each(["target_contract", "approval", "controls"] as const)(
  "grades %s from protected peer effects and rejects unsupported claims",
  // Windows ARM64 owned VM exhausted 5 s; 20 s retains 4x that observed floor.
  { timeout: 20_000 },
  async (caseId) => {
    const fixture = await createFixture(caseId, true);
    const root = `/v0/servers/${fixture.apiServerId}`;
    const get = (path: string) => read(fixture.environment, root + path);
    const post = (path: string, input: unknown) =>
      read(fixture.environment, root + path, true, input);
    let answer = { ...empty };
    try {
      await get("/help");
      if (caseId === "target_contract") {
        await get("/schema?operation=targetProbe");
        expect((await get("/extension/probe?proof=wrong")).status).toBe(400);
        const result = await get("/extension/probe?proof=target-shape-37");
        expect(result.status).toBe(200);
        expect(JSON.parse(result.body).unfamiliarField).toEqual([
          "retained",
          37,
        ]);
        answer.answer = "target-artifact-6e2";
        await fixture.peers!.source.store.mutate((state) => {
          state.outgoing[0]!.operations = state.outgoing[0]!.operations.filter(
            (op) => op !== "targetProbe",
          );
        });
        expect(
          (await get("/extension/probe?proof=target-shape-37")).status,
        ).toBe(403);
        await fixture.peers!.source.store.mutate((state) => {
          state.outgoing[0]!.operations.push("targetProbe");
        });
        await fixture.peers!.target.store.mutate((state) => {
          state.incoming[0]!.operations = state.incoming[0]!.operations.filter(
            (op) => op !== "targetProbe",
          );
        });
        expect(
          (await get("/extension/probe?proof=target-shape-37")).status,
        ).toBe(403);
      } else if (caseId === "approval") {
        await get("/sessions/approval-worker/requests");
        const input = { requestId: "approve-fixture-001", response: "approve" };
        const response = await post(
          "/sessions/approval-worker/requests/permission-001/response",
          input,
        );
        expect(response.status).toBe(202);
        const receipt = JSON.parse(response.body);
        expect(
          JSON.parse(
            (
              await post(
                "/sessions/approval-worker/requests/permission-001/response",
                input,
              )
            ).body,
          ).id,
        ).toBe(receipt.id);
        await get(`/receipts/${receipt.id}`);
        expect(
          (
            await post(
              "/sessions/approval-worker/requests/permission-001/response",
              { ...input, requestId: "different-approval-001" },
            )
          ).status,
        ).toBe(409);
        await get("/sessions/approval-worker/conversation");
        answer = {
          ...answer,
          sessionId: "approval-worker",
          answer: "approved-artifact-4d8",
        };
      } else {
        for (const [id, op] of [
          ["interrupt-worker", "cancel"],
          ["stop-worker", "stop"],
        ]) {
          const response = await post(`/sessions/${id}/${op}`, {
            requestId: `${op}-fixture-001`,
          });
          expect(response.status).toBe(202);
          await get(`/receipts/${JSON.parse(response.body).id}`);
          await get(`/sessions/${id}`);
        }
        answer = {
          ...answer,
          sessionIds: ["interrupt-worker", "stop-worker"],
          answer: "idle|terminated",
        };
      }
      expect(
        grade(caseId, answer, fixture.trace, false, fixture.apiServerId),
      ).toBe(true);
      expect(grade(caseId, answer, [], false, fixture.apiServerId)).toBe(false);
      expect(
        grade(
          caseId,
          answer,
          fixture.trace.map((t) => ({
            ...t,
            receipt: undefined,
            artifact: undefined,
            sessionState: undefined,
            pendingId: undefined,
          })),
          false,
          fixture.apiServerId,
        ),
      ).toBe(false);
    } finally {
      await fixture.close();
    }
  },
);
