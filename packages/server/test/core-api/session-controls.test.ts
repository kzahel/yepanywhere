import {
  PeerDirectory,
  fixturePeerGrant,
} from "../../src/peer-api/directory.js";
import { MessageQueue } from "../../src/sdk/messageQueue.js";
import { afterEach, expect, it } from "vitest";
import { Hono } from "hono";
import {
  EMPTY_LIMITED_USER_GRANTS,
  type UrlProjectId,
} from "@yep-anywhere/shared";
import { SUPERUSER, type Principal } from "../../src/auth/principal.js";
import { CoreApi } from "../../src/core-api/service.js";
import { SessionCommands } from "../../src/core-api/session-commands.js";
import { nativeSessionControl } from "../../src/core-api/native-session-control.js";
import { ApiReceiptStore } from "../../src/core-api/receipt-store.js";
import { createV0Routes } from "../../src/routes/v0/index.js";
import { openSqliteOrThrow } from "../../src/storage/sqlite.js";
import { migrateDiscoveryDatabase } from "../../src/storage/discovery-sqlite.js";
import {
  Process,
  createControllableIterator,
} from "../process.test-support.js";
import { apiCommand } from "../support/api-command-request.js";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
function fixture(onSessionLookup?: () => void) {
  const database = openSqliteOrThrow(":memory:");
  migrateDiscoveryDatabase(database);
  const store = new ApiReceiptStore(database);
  let interrupted = 0,
    stopped = 0;
  const makeProcess = () => {
    const controlled = createControllableIterator();
    const process = new Process(controlled.iterator, {
      sessionId: "worker",
      projectId: "p" as UrlProjectId,
      projectPath: "/fixture",
      provider: "codex",
      queue: new MessageQueue(),
      permissionMode: "default",
      abortFn: async () => controlled.finish(),
    });
    cleanups.push(async () => {
      await process.abort();
    });
    return process;
  };
  let process = makeProcess();
  const controls = nativeSessionControl({
    supervisor: {
      getProcessForSession: () => process,
      interruptProcess: async () => {
        interrupted++;
        return { success: false, supported: true, hardAborted: true };
      },
      abortProcessWithVerification: async () => {
        stopped++;
        return {
          sessionId: "worker",
          processId: process.id,
          provider: "codex",
          verifiedStopped: true,
          verification: "iterator",
        };
      },
    },
  });
  const commands = new SessionCommands(
    "A",
    store,
    {
      ...controls,
      start: async () => {
        throw Error("Unexpected start");
      },
    },
    () => true,
  );
  const core = new CoreApi("A", {
    commands,
    projects: async () => ({
      items: [{ id: "p", name: "P", path: "/fixture" }],
    }),
    providers: async () => [],
    sessions: async () => (
      onSessionLookup?.(),
      {
        items: [
          {
            id: "worker",
            projectId: "p",
            provider: "codex",
            title: "Worker",
            state: "idle",
            updatedAt: "",
          },
        ],
      }
    ),
  });
  const app = new Hono<{ Variables: { yaPrincipal: typeof SUPERUSER } }>();
  app.use("*", async (c, next) => {
    c.set("yaPrincipal", SUPERUSER);
    await next();
  });
  app.route("/v0", createV0Routes(core));
  cleanups.push(() => {
    commands.close();
    store.close();
    database.close();
  });
  return {
    app,
    core,
    commands,
    store,
    get process() {
      return process;
    },
    replace() {
      process = makeProcess();
    },
    counts: () => ({ interrupted, stopped }),
    post: (path: string, body: unknown) =>
      app.request(`/v0/servers/self/sessions/worker/${path}`, {
        method: "POST",
        ...apiCommand(body),
      }),
  };
}
it.each(["ui", "api"])(
  "resolves a real pending approval exactly once when %s wins, without treating questions as permissions",
  async (winner) => {
    const f = fixture();
    const approval = f.process.handleToolApproval(
      "Bash",
      { command: "echo owned" },
      { signal: new AbortController().signal },
    );
    const pending = f.process.getPendingInputRequest()!;
    const request = { requestId: "approval-race-001", response: "approve" };
    if (winner === "ui")
      expect(f.process.respondToInput(pending.id, "approve")).toBe(true);
    const response = await f.post(`requests/${pending.id}/response`, request);
    expect(response.status).toBe(winner === "ui" ? 409 : 202);
    if (winner === "api") {
      expect(f.process.respondToInput(pending.id, "deny")).toBe(false);
      const receipt = await response.json();
      expect(
        (
          await (
            await f.post(`requests/${pending.id}/response`, request)
          ).json()
        ).id,
      ).toBe(receipt.id);
      expect(
        (
          await f.post(`requests/${pending.id}/response`, {
            ...request,
            requestId: "late-answer-002",
          })
        ).status,
      ).toBe(409);
    }
    expect((await approval).behavior).toBe("allow");
    const question = f.process.handleToolApproval(
      "AskUserQuestion",
      { questions: [{ question: "Choose?", header: "Choice", options: [] }] },
      { signal: new AbortController().signal },
    );
    const questionId = f.process.getPendingInputRequest()!.id;
    expect(
      (
        await (
          await f.app.request("/v0/servers/self/sessions/worker/requests")
        ).json()
      ).items[0],
    ).toMatchObject({ id: questionId, kind: "question", canRespond: false });
    expect(
      (
        await f.post(`requests/${questionId}/response`, {
          requestId: "question-deny-001",
          response: "deny",
        })
      ).status,
    ).toBe(409);
    f.process.respondToInput(questionId, "deny");
    await question;
  },
);
it("records actual hard-abort and stop outcomes and never repeats them against a later incumbent", async () => {
  const f = fixture();
  for (const operation of ["cancel", "stop"]) {
    const request = { requestId: `${operation}-retry-001` };
    const first = await f.post(operation, request);
    expect(first.status).toBe(202);
    const receipt = await first.json();
    await f.commands.idle();
    const observed = await (
      await f.app.request(`/v0/servers/self/receipts/${receipt.id}`)
    ).json();
    expect(observed).toMatchObject({
      state: "accepted",
      result:
        operation === "cancel"
          ? { interrupted: false, aborted: true, supported: true }
          : { stopped: true },
    });
    f.replace();
    expect((await (await f.post(operation, request)).json()).id).toBe(
      receipt.id,
    );
    // A restart keeps the recorded outcome; a control delivers no input.
    f.store.recoverInterrupted();
    expect(
      await (
        await f.app.request(`/v0/servers/self/receipts/${receipt.id}`)
      ).json(),
    ).toEqual(observed);
  }
  expect(f.counts()).toEqual({ interrupted: 1, stopped: 1 });
});

it.each(["cancel", "stop"] as const)(
  "does not execute %s when its launch is revoked during the session lookup",
  async (operation) => {
    const revoked = new AbortController();
    const f = fixture(() => revoked.abort());
    await expect(
      f.core.read(operation, SUPERUSER, {
        serverId: "A",
        sessionId: "worker",
        body: { requestId: `revoked-${operation}-001` },
        signal: revoked.signal,
      }),
    ).rejects.toThrow();
    await f.commands.idle();
    expect(f.counts()).toEqual({ interrupted: 0, stopped: 0 });
  },
);
it("keeps peer control payload conflicts as 409 after the original approval has resolved", async () => {
  const f = fixture();
  const directory = new PeerDirectory([
    fixturePeerGrant("source", "s".repeat(32), ["p"], ["respond", "session"]),
  ]);
  const auth = directory.authenticate("s".repeat(32), {
    sessionId: "source-parent",
    launchId: "source-launch",
  });
  cleanups.push(() => {
    auth.release();
    directory.close();
  });
  const approval = f.process.handleToolApproval(
    "Bash",
    { command: "owned-peer-check" },
    { signal: new AbortController().signal },
  );
  const pendingRequestId = f.process.getPendingInputRequest()!.id;
  const input = {
    sessionId: "worker",
    pendingRequestId,
    body: { requestId: "peer-approval-001", response: "approve" },
  };
  await f.core.read("respond", auth.principal, input);
  expect((await approval).behavior).toBe("allow");
  await expect(
    f.core.read("respond", auth.principal, {
      ...input,
      body: { ...input.body, response: "deny" },
    }),
  ).rejects.toMatchObject({ code: "request_id_conflict", status: 409 });
});

it("does not advertise or execute controls for a limited caller", async () => {
  const f = fixture();
  const caller: Principal = {
    kind: "limited",
    username: "limited",
    switched: false,
    locked: true,
    via: "direct",
    grants: { ...EMPTY_LIMITED_USER_GRANTS, viewProjects: ["p"] },
  };
  const access = (await f.core.read("access", caller)) as {
    operations: string[];
  };
  for (const operation of ["respond", "cancel", "stop"] as const) {
    expect(access.operations).not.toContain(operation);
    await expect(
      f.core.read(operation, caller, {
        sessionId: "worker",
        body: { requestId: "limited-control-001" },
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
  }
  expect(f.counts()).toEqual({ interrupted: 0, stopped: 0 });
});
