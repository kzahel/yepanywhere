import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, type TestContext } from "vitest";
import { apiCommand } from "../support/api-command-request.js";
import { nativeAppTestFixture } from "./fixture.js";

async function exerciseAntigravityV0(context: TestContext) {
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
}

async function exerciseAntigravitySubagent(context: TestContext) {
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
        { timeout: 6000 },
      )
      .toBe("matched");
    return result;
  };

  const creation = await send("/sessions", {
    projectId: project.id,
    provider: "antigravity",
    model: "gemini-3.8-flash",
    permissionMode: "bypassPermissions",
    prompt: "V0_AGY_SUBAGENT_PARENT",
  });
  const parentTurn = await app.model.next();
  expect(JSON.stringify(parentTurn.body)).toContain("V0_AGY_SUBAGENT_PARENT");
  const accepted = await receipt(
    creation.id,
    (result) => result.state === "accepted",
  );
  const parentSessionId = String(accepted.sessionId);
  const session = `/sessions/${parentSessionId}`;

  parentTurn.tool("invoke_subagent", {
    TypeName: "research",
    Role: "Smoke Researcher",
    Prompt: "V0_AGY_SUBAGENT_CHILD_PROMPT",
  });

  // Both the parent's post-spawn continuation and the child's first turn hit
  // our scripted local model server. Wait for both and identify them by prompt.
  const firstNext = await app.model.next();
  const secondNext = await app.model.next();
  const isChildReq = (req: typeof firstNext) =>
    JSON.stringify(req.body).includes("V0_AGY_SUBAGENT_CHILD_PROMPT") &&
    !JSON.stringify(req.body).includes("V0_AGY_SUBAGENT_PARENT");
  const childTurn = isChildReq(firstNext) ? firstNext : secondNext;
  const parentAfterSpawn = childTurn === firstNext ? secondNext : firstNext;

  // Parent finishes its foreground turn while the child is still running.
  parentAfterSpawn.finish("V0_AGY_PARENT_WAITING_FOR_CHILD");
  await expect
    .poll(async () => (await get(session)).state, { timeout: 6000 })
    .toBe("background");
  expect((await get(`${session}/conversation`)).activity).toBe("working");

  // Complete the child and let the parent process its passive wake.
  childTurn.finish("V0_AGY_CHILD_FINAL_ANSWER");
  const parentWake = await app.model.next();
  expect(JSON.stringify(parentWake.body)).toContain(
    "V0_AGY_CHILD_FINAL_ANSWER",
  );
  parentWake.finish("V0_AGY_PARENT_RECEIVED_CHILD");

  await expect
    .poll(async () => JSON.stringify(await get(`${session}/conversation`)), {
      timeout: 6000,
    })
    .toContain("V0_AGY_PARENT_RECEIVED_CHILD");
  await expect
    .poll(async () => (await get(session)).state, { timeout: 6000 })
    .toBe("idle");

  // Durable providerChildren must surface the child under the parent via
  // conversation_summaries.db + companion WAL watching.
  let childId = "";
  await expect
    .poll(
      async () => {
        const meta = (await app.api(
          `/projects/${project.id}/sessions/${parentSessionId}/metadata`,
        )) as {
          session?: {
            providerChildren?: Array<{ id: string; agentType?: string }>;
          };
        };
        const firstChild = meta.session?.providerChildren?.[0];
        if (firstChild?.id) childId = firstChild.id;
        return firstChild?.agentType ?? "";
      },
      { timeout: 6000 },
    )
    .toBe("research");
  expect(childId).toMatch(/^[0-9a-f-]{36}$/i);

  // Top-level session list must contain only the parent, never the child.
  const listed = (await get(`/sessions?projectId=${project.id}`)) as {
    items?: Array<{ id: string }>;
  };
  expect(listed.items?.some((s) => s.id === parentSessionId)).toBe(true);
  expect(listed.items?.some((s) => s.id === childId)).toBe(false);

  // Agent mappings must correlate the parent's spawn_agent tool call to childId.
  await expect
    .poll(
      async () => {
        const res = (await app.api(
          `/projects/${project.id}/sessions/${parentSessionId}/agents`,
        )) as { mappings?: Array<{ toolUseId: string; agentId: string }> };
        return res.mappings?.some((m) => m.agentId === childId) ?? false;
      },
      { timeout: 4000 },
    )
    .toBe(true);

  // Read-only child transcript endpoint must return the child's replay.
  const childTranscript = (await app.api(
    `/projects/${project.id}/sessions/${parentSessionId}/agents/${childId}`,
  )) as { messages: unknown[]; status: string };
  expect(childTranscript.status).toBe("completed");
  expect(JSON.stringify(childTranscript.messages)).toContain(
    "V0_AGY_CHILD_FINAL_ANSWER",
  );

  // An unrelated UUID must be refused with 404.
  const bogusRes = await fetch(
    `${app.baseUrl}/api/projects/${project.id}/sessions/${parentSessionId}/agents/99999999-9999-4999-8999-999999999999`,
    {
      headers: { "X-Yep-Anywhere": "true" },
      signal: AbortSignal.timeout(5000),
    },
  );
  expect(bogusRes.status).toBe(404);
  expect(app.model.failures).toEqual([]);
}

it.runIf(process.env.YEP_NATIVE_APP_TESTS === "1")(
  "creates, steers, compacts and follows Antigravity through v0",
  exerciseAntigravityV0,
  30_000,
);

it.runIf(process.env.YEP_NATIVE_APP_TESTS === "1")(
  "tracks native Antigravity invoke_subagent children, background retention, and child transcript replay",
  exerciseAntigravitySubagent,
  30_000,
);

async function exerciseRefusedAntigravity(context: TestContext) {
  // An ACP peer that reports a version below the floor and logs any method
  // past initialize, which a refused runtime must never receive.
  const directory = await mkdtemp(join(tmpdir(), "ya-agy-floor-"));
  context.onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const agy = join(directory, "agy");
  const log = join(directory, "methods.log");
  await writeFile(
    agy,
    `#!${process.execPath}
const fs = require('node:fs');
if (process.argv.includes('--version')) { console.log('1.4.12'); process.exit(0); }
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line);
  fs.appendFileSync(${JSON.stringify(log)}, m.method + '\\n');
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: 1, agentInfo: { version: '1.4.12' } } }) + '\\n');
});
`,
  );
  await chmod(agy, 0o755);
  const app = await nativeAppTestFixture("antigravity", context, {
    agentApiManagement: true,
    antigravityExecutable: agy,
  });
  await app.ready();
  const refusal =
    "Antigravity requires agy 1.5.13 or later; the installed runtime reports version 1.4.12. Run `agy update`, or install the agy CLI.";
  const { project } = await app.api("/projects", { path: app.project });

  const requestId = crypto.randomUUID();
  await app.api(`/projects/${project.id}/session-creations`, {
    requestId,
    provider: "antigravity",
    message: "APP_MUST_NOT_SEND",
    mode: "default",
  });
  await expect
    .poll(
      async () => (await app.api(`/session-creations/${requestId}`)).creation,
    )
    .toMatchObject({
      state: "failed",
      delivery: "not-admitted",
      failure: "startup-unavailable",
      failureDetail: refusal,
    });

  const request = apiCommand({
    requestId: crypto.randomUUID(),
    projectId: project.id,
    provider: "antigravity",
    prompt: "V0_MUST_NOT_SEND",
  });
  const response = await fetch(`${app.baseUrl}/v0/servers/self/sessions`, {
    ...request,
    method: "POST",
    headers: { ...request.headers, "X-Yep-Anywhere": "true" },
    signal: AbortSignal.timeout(5000),
  });
  expect(response.status, await response.clone().text()).toBe(202);
  const { id } = await response.json();
  await expect
    .poll(async () => {
      const receipt = await fetch(
        `${app.baseUrl}/v0/servers/self/receipts/${id}`,
        { signal: AbortSignal.timeout(5000) },
      );
      return receipt.json();
    })
    .toMatchObject({
      state: "failed",
      failure: { code: "startup-unavailable", message: refusal },
    });
  expect(await readFile(log, "utf8").catch(() => "")).not.toMatch(/session\//);
  expect(app.model.requests).toEqual([]);
}

it.runIf(process.env.YEP_NATIVE_APP_TESTS === "1")(
  "refuses agy below the floor in app and v0 creation with the actionable reason",
  exerciseRefusedAntigravity,
  30_000,
);
