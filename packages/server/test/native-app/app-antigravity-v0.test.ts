import { expect, it } from "vitest";
import { apiCommand } from "../support/api-command-request.js";
import { nativeAppTestFixture } from "./fixture.js";

it("creates, steers, compacts and follows Antigravity through v0", async (context) => {
  const app = await nativeAppTestFixture("antigravity", context, {
    agentApiManagement: true,
  });
  await app.ready();
  const { project } = await app.api("/projects", { path: app.project });
  const base = `${app.baseUrl}/v0/servers/self`;
  async function get(path: string) {
    const response = await fetch(base + path, {
      signal: AbortSignal.timeout(5000),
    });
    expect(response.status, await response.clone().text()).toBe(200);
    return response.json();
  }
  async function send(
    path: string,
    body: object,
    requestId = crypto.randomUUID(),
  ) {
    const request = apiCommand({ ...body, requestId });
    const response = await fetch(base + path, {
      ...request,
      method: "POST",
      headers: { ...request.headers, "X-Yep-Anywhere": "true" },
      signal: AbortSignal.timeout(5000),
    });
    expect(response.status, await response.clone().text()).toBe(202);
    return response.json();
  }
  const receipt = async (
    id: string,
    match: (result: Record<string, unknown>) => boolean,
  ) => {
    let result: Record<string, unknown> = {};
    await expect
      .poll(
        async () => {
          result = await get(`/receipts/${id}`);
          return match(result) ? "matched" : JSON.stringify(result);
        },
        { timeout: 4000 },
      )
      .toBe("matched");
    return result;
  };

  const model = "gemini-3.8-flash";
  expect(
    (await get("/selection?provider=antigravity&routing=direct")).models,
  ).toContainEqual(
    expect.objectContaining({
      id: model,
      supportsEffort: true,
      supportedEffortLevels: expect.arrayContaining(["low", "medium"]),
    }),
  );
  const requestId = crypto.randomUUID();
  const launch = {
    projectId: project.id,
    provider: "antigravity",
    model,
    thinking: "on:medium",
    permissionMode: "bypassPermissions",
    prompt: "V0_AGY_INITIAL",
  };
  const creation = await send("/sessions", launch, requestId);
  expect((await send("/sessions", launch, requestId)).id).toBe(creation.id);
  const initial = await app.model.next();
  expect(JSON.stringify(initial.body)).toContain("V0_AGY_INITIAL");
  expect(JSON.stringify(initial.body)).toContain("AGENT_YA_V0_SOCKET");
  expect(JSON.stringify(initial.body)).toMatch(
    /"thinkingLevel":"MEDIUM"|"thinking_level":"MEDIUM"/i,
  );
  const accepted = await receipt(
    creation.id,
    (result) => result.state === "accepted",
  );
  const session = `/sessions/${accepted.sessionId}`;
  initial.tool("run_command", {
    CommandLine:
      'curl -fsS --unix-socket "$AGENT_YA_V0_SOCKET" -H "Authorization: $AGENT_YA_V0_AUTHORIZATION" "$AGENT_YA_V0_URL/v0/me"',
    WaitMsBeforeAsync: 5000,
    toolSummary: "Verify launch identity",
  });
  const original = await app.model.next();
  const contents = original.body.contents;
  const shellResult = JSON.stringify(
    Array.isArray(contents) ? contents.at(-1) : null,
  );
  expect(shellResult).toContain(accepted.sessionId);
  expect(shellResult).toContain('\\"management\\":true');
  const steered = await send(`${session}/inputs`, {
    type: "prompt",
    text: "V0_AGY_STEER",
    delivery: "steer",
  });
  expect((await get(`/receipts/${steered.id}`)).delivery).not.toBe("consumed");
  const compact = await send(`${session}/inputs`, {
    type: "compact",
    instructions: "V0_AGY_FOCUS",
  });
  const followup = await send(`${session}/inputs`, {
    type: "prompt",
    text: "V0_AGY_AFTER_COMPACT",
  });
  original.finish("V0_AGY_ORIGINAL_DONE");
  const correction = await app.model.next();
  expect(JSON.stringify(correction.body)).toContain("V0_AGY_STEER");
  correction.finish("V0_AGY_STEER_DONE");
  await receipt(steered.id, (result) => result.delivery === "consumed");
  const summary = await app.model.next();
  expect(JSON.stringify(summary.body)).toContain("V0_AGY_FOCUS");
  expect(JSON.stringify(summary.body)).not.toContain("V0_AGY_AFTER_COMPACT");
  expect((await get(session)).state).toBe("compacting");
  summary.finish("<summary>V0_AGY_SUMMARY</summary>");
  const continuation = await app.model.next();
  expect(JSON.stringify(continuation.body)).toContain("V0_AGY_SUMMARY");
  expect((await get(`/receipts/${compact.id}`)).completion).not.toBe(
    "compacted",
  );
  continuation.finish("V0_AGY_COMPACT_DONE");
  const after = await app.model.next();
  expect(JSON.stringify(after.body)).toContain("V0_AGY_SUMMARY");
  expect(JSON.stringify(after.body)).toContain("V0_AGY_AFTER_COMPACT");
  await receipt(compact.id, (result) => result.completion === "compacted");
  after.finish("V0_AGY_FOLLOWUP_DONE");
  await receipt(followup.id, (result) => result.delivery === "consumed");
  await expect
    .poll(async () => JSON.stringify(await get(`${session}/conversation`)), {
      timeout: 4000,
    })
    .toContain("V0_AGY_FOLLOWUP_DONE");
  await app.api(`${session}/messages`, { message: "V0_AGY_SCHEDULE" });
  const schedule = await app.model.next();
  schedule.tool("schedule", {
    DurationSeconds: 3,
    Prompt: "V0_AGY_WAKE",
  });
  const waiting = await app.model.next();
  expect((await get(session)).state).toBe("in-turn");
  waiting.finish("V0_AGY_WAITING");
  await expect.poll(async () => (await get(session)).state).toBe("background");
  expect((await get(`${session}/conversation`)).activity).toBe("working");
  const wake = await app.model.next();
  expect(JSON.stringify(wake.body)).toContain("V0_AGY_WAKE");
  const followPath = `${session}/conversation/follow`;
  const { cursor } = await get(`${followPath}?waitMs=0`);
  const changed = get(`${followPath}?after=${encodeURIComponent(cursor)}`);
  wake.finish("V0_AGY_WAKE_DONE");
  const followed = await changed;
  expect(followed.changed).toBe(true);
  expect(JSON.stringify(followed.conversation)).toContain("V0_AGY_WAKE_DONE");
  await expect.poll(async () => (await get(session)).state).toBe("idle");
  const stop = await send(`${session}/stop`, {});
  expect(
    (await receipt(stop.id, (result) => result.state === "accepted")).result,
  ).toMatchObject({ verifiedStopped: true });
  expect(JSON.stringify(await get(`${session}/conversation`))).toContain(
    "V0_AGY_WAKE_DONE",
  );
  await app.api(`/projects/${project.id}${session}/resume`, {
    message: "V0_AGY_RESUMED",
    provider: "antigravity",
    mode: "bypassPermissions",
  });
  const resumed = await app.model.next();
  const resumedRequest = JSON.stringify(resumed.body);
  expect(resumedRequest).toContain("V0_AGY_RESUMED");
  expect(resumedRequest).toContain("V0_AGY_SUMMARY");
  expect(resumedRequest).toContain("AGENT_YA_V0_SOCKET");
  expect(resumedRequest).toMatch(
    /"thinkingLevel":"MEDIUM"|"thinking_level":"MEDIUM"/i,
  );
  resumed.finish("V0_AGY_RESUMED_DONE");
  await expect
    .poll(async () => JSON.stringify(await get(`${session}/conversation`)), {
      timeout: 4000,
    })
    .toContain("V0_AGY_RESUMED_DONE");
  expect(app.model.failures).toEqual([]);
}, 30_000);
