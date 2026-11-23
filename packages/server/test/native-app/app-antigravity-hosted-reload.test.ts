import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, type TestContext } from "vitest";
import { captureLeaderStartTime } from "../../../client/e2e/support/process-lifecycle.js";
import {
  appBarrier,
  type NativeWorker,
} from "../native-provider/app-fixture.js";
import { nativeAppTestFixture } from "./fixture.js";

/**
 * Plan 195 step 9: an Antigravity owner (its `agy`, ACP client, live window
 * and permission requests) runs in a Provider Host worker, so a backend
 * reload or loss no longer ends the session. Real `agy` against the
 * scripted model, through the real wrapper, host, worker and backend.
 */
const exec = promisify(execFile);
type App = Awaited<ReturnType<typeof nativeAppTestFixture>>;
type Detail = {
  messages: Array<{ uuid?: string; type?: string; message?: unknown }>;
  pendingInputRequest?: { id: string; toolName: string } | null;
  ownership?: { owner?: string; processId?: string };
  transcriptComplete?: boolean;
};

async function open(context: TestContext) {
  const app = await nativeAppTestFixture("antigravity", context, {
    agentApiManagement: true,
  });
  context.onTestFailed(async () => {
    console.info(await app.diagnostics());
  });
  await app.ready();
  return app;
}

async function state(app: App, sessionId: string): Promise<string> {
  const response = await fetch(
    `${app.baseUrl}/v0/servers/self/sessions/${sessionId}`,
    { signal: AbortSignal.timeout(5000) },
  );
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as { state: string }).state;
}

const detail = (app: App, projectId: string, sessionId: string) =>
  app.api(`/projects/${projectId}/sessions/${sessionId}`) as Promise<Detail>;

/** How many rows of the conversation hold each marker. */
function counts(messages: Detail["messages"], markers: readonly string[]) {
  return Object.fromEntries(
    markers.map((marker) => [
      marker,
      messages.filter((row) =>
        JSON.stringify(row.message ?? "").includes(marker),
      ).length,
    ]),
  );
}

/**
 * How many times a prompt reached `agy`: its occurrences in the history of
 * the newest model request that carries it (a prompt delivered twice is
 * twice in `agy`'s context).
 */
function requested(app: App, marker: string) {
  const prompt = JSON.stringify(
    `<USER_REQUEST>\n${marker}\n</USER_REQUEST>`,
  ).slice(1, -1);
  const body = app.model.requests
    .map((request) => JSON.stringify(request.body))
    .reverse()
    .find((text) => text.includes(prompt));
  return body?.split(prompt).length ? body.split(prompt).length - 1 : 0;
}

async function workerFor(app: App, before?: NativeWorker) {
  const workers = await app.inventory();
  expect(workers).toHaveLength(1);
  const worker = workers[0]!;
  if (before) {
    expect(worker.runtimeId).toBe(before.runtimeId);
    expect(worker.pid).toBe(before.pid);
    expect(worker.providerSessionId).toBe(before.providerSessionId);
  }
  return worker;
}

/** The worker attached to a backend generation other than `before`'s. */
async function reattached(app: App, before: NativeWorker) {
  return await appBarrier(async () => {
    const worker = (await app.inventory()).find(
      (candidate) => candidate.runtimeId === before.runtimeId,
    );
    return worker?.attachedServerGeneration &&
      worker.attachedServerGeneration !== before.attachedServerGeneration
      ? worker
      : false;
  }, "worker attached to the replacement backend");
}

async function replaced(
  app: App,
  before: Awaited<ReturnType<App["processes"]>>,
) {
  const after = await appBarrier(async () => {
    const processes = await app.processes();
    return processes.backend !== before.backend && processes;
  }, "backend replacement");
  expect(after.wrapper).toBe(before.wrapper);
  await app.ready();
  return after;
}

async function send(app: App, sessionId: string, message: string, extra = {}) {
  return await app.api(`/sessions/${sessionId}/messages`, {
    message,
    ...extra,
  });
}

async function idle(app: App, sessionId: string) {
  await appBarrier(
    async () => (await state(app, sessionId)) === "idle",
    "idle owner",
  );
}

/** The processes the worker started (its `agy`), with their start identities. */
async function nativePids(worker: NativeWorker) {
  const { stdout } = await exec("ps", ["-axo", "pid=,ppid="]);
  const rows = stdout
    .trim()
    .split("\n")
    .map((line) => line.trim().split(/\s+/).map(Number) as [number, number]);
  const owned = new Set([worker.pid]);
  for (let changed = true; changed; ) {
    changed = false;
    for (const [pid, parent] of rows)
      if (owned.has(parent) && !owned.has(pid)) {
        owned.add(pid);
        changed = true;
      }
  }
  owned.delete(worker.pid);
  return Promise.all(
    [...owned]
      .sort((a, b) => a - b)
      .map(async (pid) => ({ pid, start: await captureLeaderStartTime(pid) })),
  );
}

/**
 * Runs `during` with no backend: the wrapper (and the host inside it) is
 * stopped so it cannot start a replacement, and the backend is killed. The
 * worker and its `agy` keep running. Then the wrapper replaces the backend.
 */
async function withoutBackend(app: App, during: () => Promise<void>) {
  const before = await app.processes();
  const wrapperStart = await captureLeaderStartTime(before.wrapper);
  process.kill(before.wrapper, "SIGSTOP");
  try {
    await app.crashBackend();
    await appBarrier(
      async () => (await captureLeaderStartTime(before.backend)) === undefined,
      "backend gone",
    );
    await during();
  } finally {
    if ((await captureLeaderStartTime(before.wrapper)) === wrapperStart)
      process.kill(before.wrapper, "SIGCONT");
  }
  await replaced(app, before);
}

describe.runIf(process.env.YEP_NATIVE_ANTIGRAVITY_GAP_REPROS === "1")(
  "Antigravity in the Provider Host",
  () => {
    it("keeps a turn, its permission request and a patient message through a reload, then takes control once", {
      // Real agy turns, two backend replacements and a compaction.
      timeout: 150_000,
    }, async (context) => {
      const app = await open(context);
      const { sessionId, projectId } = await app.create(
        "AGY_HOST_PERMISSION",
        "default",
      );
      const path = join(app.project, "written.txt");
      const turn = await app.model.next();
      turn.tool("write_file", {
        Path: path,
        Content: "WRITTEN_BY_AGY\n",
        Overwrite: true,
      });
      const pending = await appBarrier(async () => {
        const read = await detail(app, projectId, sessionId);
        return read.pendingInputRequest ?? false;
      }, "permission request");
      const live = await app.connect(sessionId);
      await send(app, sessionId, "AGY_HOST_PATIENT", {
        deferred: true,
        messageMetadata: { deliveryIntent: "patient", patienceSeconds: 1 },
      });
      const worker = await workerFor(app);
      const agy = await nativePids(worker);
      expect(agy.length).toBeGreaterThan(0);

      // The turn no longer blocks a reload (the patient message does, for a
      // scheduled one); the wrapper's reload detaches the worker, and the
      // patient queue is handed to the replacement.
      const backend = await app.processes();
      expect(await app.api("/dev/safe-restart")).toMatchObject({
        blockers: [{ type: "session-queue", count: 1 }],
      });
      await app.reload();
      await replaced(app, backend);
      const attached = await reattached(app, worker);
      expect(attached.pid).toBe(worker.pid);
      expect(await nativePids(attached)).toEqual(agy);
      expect(live.ws.readyState).not.toBe(WebSocket.OPEN);

      // The same request, still answerable, answered once.
      const reopened = await appBarrier(async () => {
        const read = await detail(app, projectId, sessionId);
        return read.pendingInputRequest ?? false;
      }, "permission request after reload");
      expect(reopened.toolName).toBe(pending.toolName);
      await app.api(`/sessions/${sessionId}/input`, {
        requestId: reopened.id,
        response: "approve",
      });
      const written = await app.model.next();
      expect(await readFile(path, "utf8")).toBe("WRITTEN_BY_AGY\n");
      written.finish("AGY_HOST_PERMISSION_DONE");
      const patient = await app.model.next();
      expect(JSON.stringify(patient.body)).toContain("AGY_HOST_PATIENT");
      patient.finish("AGY_HOST_PATIENT_DONE");
      await idle(app, sessionId);

      // Model and effort after reattach: applied once, on this owner.
      const { processId } = (await detail(app, projectId, sessionId))
        .ownership!;
      expect(processId).toBeTruthy();
      await app.api(`/processes/${processId}/config`, {
        model: "gemini-3.7-flash",
        thinking: "on:high",
      });
      await send(app, sessionId, "AGY_HOST_MODEL");
      const model = await app.model.next();
      expect(model.model).toBe("gemini-3.7-flash");
      expect(JSON.stringify(model.body)).toMatch(
        /"(?:thinkingLevel|thinking_level)":"HIGH"/i,
      );
      model.finish("AGY_HOST_MODEL_DONE");
      await idle(app, sessionId);

      // Stop after reattach ends this owner's turn once.
      const socket = await app.connect(sessionId);
      await send(app, sessionId, "AGY_HOST_STOP");
      const stopped = await app.model.next();
      stopped.partial("AGY_HOST_STOPPING");
      await socket.wait("AGY_HOST_STOPPING");
      expect(
        await app.api(`/processes/${processId}/interrupt`, {}),
      ).toMatchObject({ interrupted: true });
      await stopped.cancelled;
      await idle(app, sessionId);

      // A queued compaction and the message behind it, each once.
      await send(app, sessionId, "AGY_HOST_BEFORE_COMPACT");
      const before = await app.model.next();
      await send(app, sessionId, "/compact keep the markers", {
        deferred: true,
      });
      await send(app, sessionId, "AGY_HOST_AFTER_COMPACT", {
        deferred: true,
      });
      before.finish(`AGY_HOST_BEFORE_DONE ${"Owned context. ".repeat(200)}`);
      const summary = await app.model.next();
      expect(JSON.stringify(summary.body)).not.toContain(
        "AGY_HOST_AFTER_COMPACT",
      );
      summary.finish(
        "<analysis>Keep the markers.</analysis><summary>AGY_HOST_SUMMARY</summary>",
      );
      const continuation = await app.model.next();
      continuation.finish("AGY_HOST_COMPACTED");
      const after = await app.model.next();
      expect(JSON.stringify(after.body)).toContain("AGY_HOST_AFTER_COMPACT");
      expect(JSON.stringify(after.body)).toContain("AGY_HOST_SUMMARY");
      after.finish("AGY_HOST_AFTER_COMPACT_DONE");
      await idle(app, sessionId);

      // A scheduled reload acts once and keeps the same worker.
      const second = await app.processes();
      expect(await app.api("/dev/safe-restart", {})).toMatchObject({
        status: "restarting",
      });
      await replaced(app, second);
      await reattached(app, attached);
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      expect(app.output().match(/\[Reload\] Replacing backend/g)).toHaveLength(
        2,
      );
      await workerFor(app, worker);

      const final = await detail(app, projectId, sessionId);
      expect(
        counts(final.messages, [
          "AGY_HOST_PERMISSION_DONE",
          "AGY_HOST_PATIENT_DONE",
          "AGY_HOST_MODEL_DONE",
          "AGY_HOST_STOPPING",
          "AGY_HOST_AFTER_COMPACT_DONE",
        ]),
      ).toEqual({
        AGY_HOST_PERMISSION_DONE: 1,
        AGY_HOST_PATIENT_DONE: 1,
        AGY_HOST_MODEL_DONE: 1,
        AGY_HOST_STOPPING: 1,
        AGY_HOST_AFTER_COMPACT_DONE: 1,
      });
      for (const marker of [
        "AGY_HOST_PATIENT",
        "AGY_HOST_MODEL",
        "AGY_HOST_STOP",
        "AGY_HOST_AFTER_COMPACT",
      ])
        expect(requested(app, marker), marker).toBe(1);
      expect(final.ownership?.owner).toBe("self");
      expect(app.model.failures).toEqual([]);
    });

    it("streams a turn and ends a detached wake with the backend gone, then tears down idle and resumes", {
      // Two abrupt backend losses with the wrapper held, a 3 s native
      // schedule, idle reap and a resume, all on real agy.
      timeout: 150_000,
    }, async (context) => {
      const app = await open(context);
      const { sessionId, projectId } = await app.create("AGY_HOST_ABSENT");
      const turn = await app.model.next();
      const live = await app.connect(sessionId);
      turn.partial("AGY_HOST_BEFORE_LOSS");
      await live.wait("AGY_HOST_BEFORE_LOSS");
      const worker = await workerFor(app);
      const workerStart = await captureLeaderStartTime(worker.pid);
      const agy = await nativePids(worker);
      expect(agy.length).toBeGreaterThan(0);

      // No backend at all while the turn streams on.
      await withoutBackend(app, async () => {
        turn.partial("AGY_HOST_WHILE_ABSENT");
        await new Promise((resolve) => setTimeout(resolve, 500));
      });
      const attached = await reattached(app, worker);
      expect(await nativePids(attached)).toEqual(agy);
      const during = await detail(app, projectId, sessionId);
      expect(
        counts(during.messages, [
          "AGY_HOST_BEFORE_LOSS",
          "AGY_HOST_WHILE_ABSENT",
        ]),
      ).toEqual({ AGY_HOST_BEFORE_LOSS: 1, AGY_HOST_WHILE_ABSENT: 1 });

      // A steer after reattach reaches the same agy turn.
      const socket = await app.connect(sessionId);
      await send(app, sessionId, "AGY_HOST_STEER", {
        messageMetadata: { deliveryIntent: "steer" },
      });
      turn.finish("AGY_HOST_TURN_DONE");
      const steered = await app.model.next();
      expect(JSON.stringify(steered.body)).toContain("AGY_HOST_STEER");
      steered.finish("AGY_HOST_STEER_DONE");
      await socket.wait("AGY_HOST_STEER_DONE");
      await idle(app, sessionId);

      // A detached wake that starts and ends with no backend.
      await send(app, sessionId, "AGY_HOST_WAKE_PARENT");
      const parent = await app.model.next();
      parent.tool("schedule", { DurationSeconds: 3, Prompt: "AGY_HOST_WAKE" });
      const waiting = await app.model.next();
      waiting.finish("AGY_HOST_WAITING");
      await appBarrier(
        async () => (await state(app, sessionId)) === "background",
        "detached schedule",
      );
      await withoutBackend(app, async () => {
        const wake = await app.model.next();
        expect(JSON.stringify(wake.body)).toContain("AGY_HOST_WAKE");
        wake.partial("AGY_HOST_WAKE_REPLY");
        wake.finish("");
        // agy logs and settles the wake while no backend observes it.
        await new Promise((resolve) => setTimeout(resolve, 1_500));
      });
      await reattached(app, attached);
      await idle(app, sessionId);
      const woken = await detail(app, projectId, sessionId);
      expect(counts(woken.messages, ["AGY_HOST_WAKE_REPLY"])).toEqual({
        AGY_HOST_WAKE_REPLY: 1,
      });

      // Idle teardown leaves no worker and no agy behind.
      for (const client of [live, socket]) client.ws.close();
      await app.api("/settings", { idleReapHours: 0 }, "PUT");
      await appBarrier(
        async () =>
          (await state(app, sessionId)) === "not-running" &&
          (await app.inventory()).length === 0,
        "idle owner reaped",
      );
      for (const { pid, start } of [
        { pid: worker.pid, start: workerStart },
        ...agy,
      ])
        await appBarrier(
          async () => (await captureLeaderStartTime(pid)) !== start,
          `process ${pid} gone`,
        );
      await app.api("/settings", { idleReapHours: 24 }, "PUT");

      // The conversation resumes afterwards, its history once.
      await app.api(`/projects/${projectId}/sessions/${sessionId}/resume`, {
        message: "AGY_HOST_RESUMED",
        provider: "antigravity",
        mode: "bypassPermissions",
      });
      const resumed = await app.model.next();
      expect(JSON.stringify(resumed.body)).toContain("AGY_HOST_STEER");
      resumed.finish("AGY_HOST_RESUMED_DONE");
      await idle(app, sessionId);
      const final = await detail(app, projectId, sessionId);
      expect(
        counts(final.messages, [
          "AGY_HOST_BEFORE_LOSS",
          "AGY_HOST_TURN_DONE",
          "AGY_HOST_STEER_DONE",
          "AGY_HOST_WAKE_REPLY",
          "AGY_HOST_RESUMED_DONE",
        ]),
      ).toEqual({
        AGY_HOST_BEFORE_LOSS: 1,
        AGY_HOST_TURN_DONE: 1,
        AGY_HOST_STEER_DONE: 1,
        AGY_HOST_WAKE_REPLY: 1,
        AGY_HOST_RESUMED_DONE: 1,
      });
      expect(final.transcriptComplete).toBeUndefined();
      for (const marker of ["AGY_HOST_STEER", "AGY_HOST_RESUMED"])
        expect(requested(app, marker), marker).toBe(1);
      expect(app.model.failures).toEqual([]);
    });
  },
);
