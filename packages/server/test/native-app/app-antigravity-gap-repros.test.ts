import { describe, expect, it } from "vitest";
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
  },
);
