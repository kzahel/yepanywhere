import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { captureLeaderStartTime } from "../../../client/e2e/support/process-lifecycle.js";
import { appBarrier } from "../native-provider/app-fixture.js";
import type { Exchange } from "../native-provider/model-server.js";
import { nativeAppTestFixture } from "./fixture.js";

type App = Awaited<ReturnType<typeof nativeAppTestFixture>>;
// The existing Antigravity native app cases use the same wrapper setup.
const caseBudget = { timeout: 30_000 };

async function ownedSession(app: App, sessionId: string) {
  const response = await fetch(
    `${app.baseUrl}/v0/servers/self/sessions/${sessionId}`,
    { signal: AbortSignal.timeout(5000) },
  );
  expect(response.status, await response.clone().text()).toBe(200);
  return response.json();
}

async function armWake(app: App, turn: Exchange) {
  turn.tool("schedule", { DurationSeconds: 3, Prompt: "AGY_GAP_WAKE" });
  return app.model.next();
}

async function holdWake(app: App, sessionId: string, waiting: Exchange) {
  waiting.finish("AGY_GAP_WAITING");
  await expect
    .poll(async () => (await ownedSession(app, sessionId)).state)
    .toBe("background");
  const wake = await app.model.next();
  expect(JSON.stringify(wake.body)).toContain("AGY_GAP_WAKE");
  return wake;
}

async function waitForReplacement(
  app: App,
  before: Awaited<ReturnType<App["processes"]>>,
) {
  const after = await appBarrier(async () => {
    const processes = await app.processes();
    return processes.backend !== before.backend && processes;
  }, "Antigravity backend replacement");
  expect(after.wrapper).toBe(before.wrapper);
  await app.ready();
}

async function expectReloadInterruption(
  app: App,
  before: Awaited<ReturnType<App["processes"]>>,
  sessionId: string,
  held: Exchange,
) {
  await waitForReplacement(app, before);
  await appBarrier(async () => {
    const session = await ownedSession(app, sessionId);
    return session.state === "not-running";
  }, "interrupted Antigravity owner after reload");
  await held.cancelled;
  expect(app.output()).toContain("after API request");
  const log = await readFile(join(app.root, "logs", "server.log"), "utf8");
  expect(log).toContain(
    `SIGHUP is interrupting antigravity session ${sessionId}`,
  );
  expect(app.model.failures).toEqual([]);
}

// Run the native adapter with an owned app and a scripted loopback model.
describe.runIf(process.env.YEP_NATIVE_ANTIGRAVITY_GAP_REPROS === "1")(
  "Antigravity reliability",
  () => {
    it(
      "retains a detached reply and verifies idle after delayed native settlement",
      caseBudget,
      async (context) => {
        const app = await nativeAppTestFixture("antigravity", context, {
          agentApiManagement: true,
        });
        await app.ready();
        const session = await app.create("AGY_GAP_LIVENESS");
        const turn = await app.model.next();
        const waiting = await armWake(app, turn);
        const metadataPath = `/projects/${session.projectId}/sessions/${session.sessionId}/metadata`;
        waiting.finish("AGY_GAP_WAITING");
        await expect
          .poll(async () => (await ownedSession(app, session.sessionId)).state)
          .toBe("background");
        expect((await app.api(metadataPath)).processState).toBe("in-turn");

        const wake = await app.model.next();
        expect(JSON.stringify(wake.body)).toContain("AGY_GAP_WAKE");
        expect((await ownedSession(app, session.sessionId)).state).toBe(
          "background",
        );
        const live = await app.connect(session.sessionId);
        wake.partial("AGY_GAP_DETACHED_PARTIAL");
        await live.wait("AGY_GAP_DETACHED_PARTIAL");
        expect((await ownedSession(app, session.sessionId)).state).toBe(
          "background",
        );
        const snapshot = await app.connect(session.sessionId);
        await snapshot.wait('"derivedStatus":"verified-progressing"');

        await app.api("/settings", { idleReapHours: 0 }, "PUT");
        const closed = Promise.all(
          [live, snapshot].map(
            ({ ws }) =>
              new Promise<void>((resolve) => {
                ws.addEventListener("close", () => resolve(), { once: true });
              }),
          ),
        );
        live.ws.close();
        snapshot.ws.close();
        await closed;
        expect((await ownedSession(app, session.sessionId)).state).toBe(
          "background",
        );

        // Finishing without additional text takes the native completion path.
        // With no viewers, the shared summaries observation still settles and
        // releases the owner for immediate idle reap.
        wake.finish("");
        await appBarrier(async () => {
          const current = await ownedSession(app, session.sessionId);
          return current.state === "not-running";
        }, "completed native wake reaped after settlement");
        expect(app.model.failures).toEqual([]);
      },
    );

    it(
      "delivers ordinary queue work at turn end and patient work after the native wake and quiet interval",
      caseBudget,
      async (context) => {
        const app = await nativeAppTestFixture("antigravity", context, {
          agentApiManagement: true,
        });
        await app.ready();
        const { sessionId } = await app.create("AGY_GAP_PATIENT_PARENT");
        const turn = await app.model.next();
        turn.tool("invoke_subagent", {
          TypeName: "research",
          Role: "Test researcher",
          Prompt: "AGY_GAP_PATIENT_CHILD",
        });
        const first = await app.model.next();
        const second = await app.model.next();
        const [parent, child] = JSON.stringify(first.body).includes(
          "AGY_GAP_PATIENT_PARENT",
        )
          ? [first, second]
          : [second, first];
        expect(JSON.stringify(parent.body)).toContain("AGY_GAP_PATIENT_PARENT");
        expect(JSON.stringify(child.body)).toContain("AGY_GAP_PATIENT_CHILD");
        expect(JSON.stringify(child.body)).not.toContain(
          "AGY_GAP_PATIENT_PARENT",
        );

        const queued = await app.api(`/sessions/${sessionId}/messages`, {
          message: "AGY_GAP_PATIENT_NEXT",
          deferred: true,
          messageMetadata: { deliveryIntent: "patient", patienceSeconds: 1 },
        });
        expect(queued).toMatchObject({ queued: true, deferred: true });
        expect(queued.deferredMessages).toContainEqual(
          expect.objectContaining({
            kind: "patient",
            metadata: expect.objectContaining({
              deliveryIntent: "patient",
              patienceSeconds: 1,
            }),
          }),
        );
        await app.api(`/sessions/${sessionId}/messages`, {
          message: "AGY_GAP_ORDINARY_NEXT",
          deferred: true,
          messageMetadata: { deliveryIntent: "deferred" },
        });
        parent.finish("AGY_GAP_PARENT_FOREGROUND_DONE");
        const ordinary = await app.model.next();
        expect(JSON.stringify(ordinary.body)).toContain(
          "AGY_GAP_ORDINARY_NEXT",
        );
        expect(JSON.stringify(ordinary.body)).not.toContain(
          "AGY_GAP_PATIENT_NEXT",
        );
        ordinary.finish("AGY_GAP_ORDINARY_DONE");
        await expect
          .poll(async () => (await ownedSession(app, sessionId)).state)
          .toBe("background");

        const live = await app.connect(sessionId);
        child.finish("AGY_GAP_PATIENT_CHILD_DONE");
        const wake = await app.model.next();
        expect(JSON.stringify(wake.body)).toContain(
          "AGY_GAP_PATIENT_CHILD_DONE",
        );
        expect(JSON.stringify(wake.body)).not.toContain("AGY_GAP_PATIENT_NEXT");
        wake.partial("AGY_GAP_PATIENT_WAKE_DONE");
        await live.wait('"derivedStatus":"verified-progressing"');
        const afterWake = live.events.length;
        const next = app.model.next().then((request) => ({
          request,
          at: Date.now(),
        }));
        void next.catch(() => {});
        wake.finish("");
        await live.wait('"derivedStatus":"verified-idle"', afterWake);
        const idle = live.events.slice(afterWake).find((event) => {
          const data = event.data as { liveness?: { derivedStatus?: string } };
          return data?.liveness?.derivedStatus === "verified-idle";
        });
        const data = idle?.data as {
          liveness: { lastVerifiedIdleAt: string };
        };
        const delivered = await next;
        expect(
          delivered.at - Date.parse(data.liveness.lastVerifiedIdleAt),
        ).toBeGreaterThanOrEqual(1_000);
        expect(JSON.stringify(delivered.request.body)).toContain(
          "AGY_GAP_PATIENT_NEXT",
        );
        delivered.request.finish("AGY_GAP_PATIENT_NEXT_DONE");
        await live.wait("AGY_GAP_PATIENT_NEXT_DONE");
        await expect
          .poll(async () => (await ownedSession(app, sessionId)).state)
          .toBe("idle");
        expect(
          app.model.requests.filter((request) =>
            JSON.stringify(request.body).includes("AGY_GAP_PATIENT_NEXT"),
          ),
        ).toHaveLength(1);
        expect(app.model.failures).toEqual([]);
      },
    );

    it(
      "waits for a detached wake and the patient turn before safe reload and cold history",
      caseBudget,
      async (context) => {
        const app = await nativeAppTestFixture("antigravity", context, {
          agentApiManagement: true,
        });
        await app.ready();
        const { sessionId, projectId } = await app.create("AGY_GAP_RELOAD");
        const turn = await app.model.next();
        const before = await app.processes();
        expect(await app.api("/dev/safe-restart", {})).toMatchObject({
          status: "scheduled",
          blockers: [{ type: "active-sessions", count: 1 }],
        });
        expect(
          await app.api("/dev/safe-restart", undefined, "DELETE"),
        ).toMatchObject({
          status: "idle",
        });

        const wake = await holdWake(app, sessionId, await armWake(app, turn));
        const live = await app.connect(sessionId);
        wake.partial("AGY_GAP_BEFORE_RELOAD");
        await live.wait("AGY_GAP_BEFORE_RELOAD");
        expect(await app.api("/dev/safe-restart")).toMatchObject({
          canRestartNow: false,
          blockers: [{ type: "active-sessions", count: 1 }],
        });
        expect(await app.api("/dev/safe-restart", {})).toMatchObject({
          status: "scheduled",
          blockers: [{ type: "active-sessions", count: 1 }],
        });
        expect((await app.processes()).backend).toBe(before.backend);
        await app.api("/dev/safe-restart", undefined, "DELETE");
        await app.api(`/sessions/${sessionId}/messages`, {
          message: "AGY_PATIENT_BEFORE_SAFE_RELOAD",
          deferred: true,
          messageMetadata: { deliveryIntent: "patient", patienceSeconds: 1 },
        });
        wake.finish("AGY_WAKE_FINISHED_BEFORE_SAFE_RELOAD");
        const patient = await app.model.next();
        expect(JSON.stringify(patient.body)).toContain(
          "AGY_PATIENT_BEFORE_SAFE_RELOAD",
        );
        expect(await app.api("/dev/safe-restart", {})).toMatchObject({
          status: "scheduled",
          blockers: [{ type: "active-sessions", count: 1 }],
        });
        patient.finish("AGY_PATIENT_FINISHED_BEFORE_SAFE_RELOAD");
        await waitForReplacement(app, before);
        expect((await ownedSession(app, sessionId)).state).toBe("not-running");
        const reopened = await app.api(
          `/projects/${projectId}/sessions/${sessionId}`,
        );
        const replay = JSON.stringify(reopened.messages);
        expect(replay).toContain("AGY_WAKE_FINISHED_BEFORE_SAFE_RELOAD");
        expect(replay).toContain("AGY_PATIENT_FINISHED_BEFORE_SAFE_RELOAD");
        expect(reopened.transcriptComplete).toBeUndefined();
        expect(app.model.failures).toEqual([]);
      },
    );

    it(
      "backs out of the wrapper handoff when new foreground work was admitted",
      caseBudget,
      async (context) => {
        const app = await nativeAppTestFixture("antigravity", context, {
          agentApiManagement: true,
        });
        await app.ready();
        const { sessionId } = await app.create("AGY_GAP_WARM_OWNER");
        (await app.model.next()).finish("AGY_GAP_WARM_DONE");
        await expect
          .poll(async () => (await ownedSession(app, sessionId)).state)
          .toBe("idle");
        const before = await app.processes();
        const wrapperStart = await captureLeaderStartTime(before.wrapper);
        expect(wrapperStart).toBeTruthy();

        // Hold the test-owned wrapper before it can acknowledge the reload.
        process.kill(before.wrapper, "SIGSTOP");
        const reload = app.api("/dev/safe-restart", {});
        void reload.catch(() => undefined);
        let lateTurn: Exchange;
        try {
          await expect
            .poll(async () => (await app.api("/dev/safe-restart")).status)
            .toBe("restarting");
          await app.api(`/sessions/${sessionId}/messages`, {
            message: "AGY_GAP_LATE_INPUT",
          });
          lateTurn = await app.model.next();
          expect(JSON.stringify(lateTurn.body)).toContain("AGY_GAP_LATE_INPUT");
          expect(await app.api("/dev/safe-restart")).toMatchObject({
            status: "restarting",
            blockers: [{ type: "active-sessions", count: 1 }],
          });
        } finally {
          if ((await captureLeaderStartTime(before.wrapper)) === wrapperStart) {
            process.kill(before.wrapper, "SIGCONT");
          }
        }
        await expect(reload).resolves.toMatchObject({
          status: "scheduled",
          blockers: [{ type: "active-sessions", count: 1 }],
        });
        expect((await app.processes()).backend).toBe(before.backend);
        lateTurn.finish("AGY_GAP_LATE_INPUT_DONE");
        await waitForReplacement(app, before);
        expect(app.model.failures).toEqual([]);
      },
    );

    it(
      "reports interrupted Antigravity work on an explicit immediate restart",
      caseBudget,
      async (context) => {
        const app = await nativeAppTestFixture("antigravity", context, {
          agentApiManagement: true,
        });
        await app.ready();
        const { sessionId } = await app.create("AGY_FORCED_RESTART");
        const held = await app.model.next();
        const before = await app.processes();
        expect(await app.api("/server/restart", {})).toMatchObject({
          ok: true,
        });
        await expectReloadInterruption(app, before, sessionId, held);
      },
    );
  },
);
