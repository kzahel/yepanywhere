import { apiCommand } from "../support/api-command-request.js";
import { seedHistoricalSessionAlias } from "../support/legacy-session-aliases.js";
import {
  PeerDirectory,
  fixturePeerGrant,
} from "../../src/peer-api/directory.js";
import { Hono } from "hono";
import { EMPTY_LIMITED_USER_GRANTS } from "@yep-anywhere/shared";
import { createV0Routes } from "../../src/routes/v0/index.js";
import { request } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { openSqliteOrThrow } from "../../src/storage/sqlite.js";
import { migrateDiscoveryDatabase } from "../../src/storage/discovery-sqlite.js";
import { ApiReceiptStore } from "../../src/core-api/receipt-store.js";
import {
  SessionCommands,
  type SessionCommandOwner,
} from "../../src/core-api/session-commands.js";
import { CoreApi, type CoreApiSources } from "../../src/core-api/service.js";
import type { ApiSession } from "../../src/core-api/contracts.js";
import type { PeerPrincipal } from "../../src/core-api/peer-policy.js";
import { createSessionRequest } from "../../src/core-api/command-contracts.js";
import { SUPERUSER } from "../../src/auth/principal.js";
import {
  createAgentApiRuntime,
  type AgentApiRuntime,
} from "../../src/agent-api/runtime.js";

const project = { id: "p", name: "Project", path: "/fixture/project" };
const body = createSessionRequest.parse({
  requestId: "review-0001",
  projectId: "p",
  provider: "codex",
  prompt: "Review this change",
  thinking: "on:high",
});
function fixture(
  owner: SessionCommandOwner,
  database = openSqliteOrThrow(":memory:"),
) {
  migrateDiscoveryDatabase(database);
  const store = new ApiReceiptStore(database);
  let enabled = false;
  const commands = new SessionCommands("A", store, owner, () => enabled);
  const sessions: ApiSession[] = [
    {
      id: "parent",
      projectId: "p",
      provider: "codex",
      title: null,
      updatedAt: "",
      state: "in-turn",
    },
  ];
  const sources: CoreApiSources = {
    commands,
    projects: async () => ({ items: [project] }),
    providers: async () => [
      {
        id: "codex",
        name: "Codex",
        supportsSteering: true,
        supportsPermissionMode: true,
      },
    ],
    sessions: async () => ({ items: sessions }),
  };
  const core = new CoreApi("A", sources);
  return {
    sources,
    database,
    store,
    commands,
    core,
    sessions,
    enable() {
      enabled = true;
    },
    disable() {
      enabled = false;
    },
    close() {
      commands.close();
      store.close();
      database.close();
    },
  };
}
function http(
  runtime: AgentApiRuntime,
  path: string,
  authorization: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  return new Promise<{ status: number; body: Record<string, unknown> }>(
    (resolve, reject) => {
      const req = request(
        new URL(path, runtime.baseUrl),
        {
          socketPath: runtime.socketPath,
          agent: false,
          method: body === undefined ? "GET" : "POST",
          headers: {
            Authorization: authorization,
            ...(body !== undefined ? apiCommand(body).headers : {}),
            ...headers,
          },
        },
        (res) => {
          let text = "";
          res.on("data", (chunk) => (text += chunk));
          res.on("end", () =>
            resolve({ status: res.statusCode!, body: JSON.parse(text) }),
          );
        },
      );
      req.on("error", (error: NodeJS.ErrnoException) =>
        reject(
          Object.assign(
            new Error(
              `HTTP ${body === undefined ? "GET" : "POST"} ${path} (${body === undefined ? 0 : Buffer.byteLength(JSON.stringify(body))} bytes): ${error.code}`,
            ),
            { code: error.code },
          ),
        ),
      );
      req.end(body === undefined ? undefined : apiCommand(body).body);
    },
  );
}

it.skipIf(process.platform === "win32")(
  "keeps existing grants read-only, attributes native admission, and deduplicates concurrent HTTP retries",
  async () => {
    let launches = 0;
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => (finish = resolve));
    const f = fixture({
      async start(_project, _request, _receipt, settled) {
        launches++;
        await pending;
        settled("child");
        return { sessionId: "child" };
      },
    });
    const runtime = await createAgentApiRuntime({
      serverId: "A",
      transport: "unix",
    });
    try {
      runtime.attachController(f.core);
      const read = runtime.issue({
        principal: SUPERUSER,
        sessionId: () => "parent",
      });
      const manage = runtime.issue({
        principal: SUPERUSER,
        sessionId: () => "parent",
        management: true,
      });
      const token = manage.environment.AGENT_YA_V0_AUTHORIZATION!;
      const path = "/v0/servers/A/sessions";
      expect((await http(runtime, path, token, body)).status).toBe(403);
      f.enable();
      expect(
        (
          await http(
            runtime,
            path,
            read.environment.AGENT_YA_V0_AUTHORIZATION!,
            body,
            { "X-Agent-Session-Id": "forged", "X-Management": "true" },
          )
        ).status,
      ).toBe(403);
      const access = await http(
        runtime,
        "/v0/servers/A/access",
        read.environment.AGENT_YA_V0_AUTHORIZATION!,
      );
      expect(access.body.operations).not.toContain("createSession");
      const [first, retry] = await Promise.all([
        http(runtime, path, token, body),
        http(runtime, path, token, body),
      ]);
      expect(first.status).toBe(202);
      expect(retry.status).toBe(202);
      expect(first.body.id).toBe(retry.body.id);
      expect(launches).toBe(1);
      expect(first.body.creator).toEqual({
        serverId: "A",
        sessionId: "parent",
        launchId: manage.launchId,
        principal: { kind: "superuser" },
      });
      expect(
        (await http(runtime, path, token, { ...body, prompt: "different" }))
          .status,
      ).toBe(409);
      expect(
        (
          await http(runtime, path, token, {
            ...body,
            creator: { sessionId: "forged" },
          })
        ).status,
      ).toBe(400);
      // Early size rejection can close an uploading Node client before its
      // body finishes; neither outcome may reserve or dispatch native work.
      const oversized = {
        ...body,
        requestId: "too-large",
        prompt: "界".repeat(90000),
      };
      const outcome = await http(runtime, path, token, oversized).then(
        (response) => response.status,
        (error: NodeJS.ErrnoException) => error.code,
      );
      expect([400, "EPIPE", "ECONNRESET"]).toContain(outcome);
      expect(launches).toBe(1);
      const app = new Hono<{ Variables: { yaPrincipal: typeof SUPERUSER } }>();
      app.use("*", async (c, next) => {
        c.set("yaPrincipal", SUPERUSER);
        await next();
      });
      app.route("/v0", createV0Routes(f.core));
      expect(
        (
          await app.request(path, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(oversized),
          })
        ).status,
      ).toBe(400);
      finish();
      await f.commands.idle();
      f.sessions.push({
        id: "child",
        projectId: "p",
        provider: "codex",
        title: null,
        updatedAt: "",
        state: "idle",
      });
      const receipt = await http(
        runtime,
        `/v0/servers/A/receipts/${first.body.id}`,
        token,
      );
      expect(receipt.body).toMatchObject({
        state: "accepted",
        sessionId: "child",
        delivery: "unknown",
        completion: "unknown",
      });
      const target = await http(
        runtime,
        "/v0/servers/A/sessions/child/relationships",
        token,
      );
      expect(target.body.creation).toMatchObject({
        id: first.body.id,
        creator: { sessionId: "parent" },
      });
      const parent = await http(
        runtime,
        "/v0/servers/A/sessions/parent/relationships",
        token,
      );
      expect(parent.body.initiated as unknown[]).toHaveLength(1);
      const schema = await http(
        runtime,
        "/v0/schema?operation=createSession",
        token,
      );
      const paths = schema.body.paths as Record<string, unknown>;
      expect(Object.keys(paths)).toEqual(["/v0/servers/{serverId}/sessions"]);
      expect(paths["/v0/servers/{serverId}/sessions"]).toHaveProperty(
        "post.requestBody",
      );
    } finally {
      finish();
      await f.commands.idle();
      await runtime.close();
      f.close();
    }
  },
);

it("serves reserved session ids during dispatch and queueing with the creation's access scope", async () => {
  let queued!: () => void;
  const waitForQueue = new Promise<void>((resolve) => (queued = resolve));
  let settle!: (sessionId: string) => void;
  let fail!: () => void;
  const f = fixture({
    async start(
      _project,
      request,
      _receipt,
      settled,
      failed,
      _consumed,
      admitted,
    ) {
      if (request.requestId === "review-fail") {
        admitted?.("refused-child");
        fail = failed;
        return { queueId: "refused-queue" };
      }
      admitted?.("child");
      settle = settled;
      await waitForQueue;
      return { queueId: "native-queue" };
    },
  });
  f.enable();
  const peer: PeerPrincipal = {
    kind: "peer",
    serverId: "origin",
    credentialId: "fixture-credential",
    projects: [project.id],
    operations: ["session", "createSession"],
    sourceSessionId: null,
    sourceLaunchId: null,
    signal: new AbortController().signal,
    assertActive() {},
  };
  const app = new Hono<{ Variables: { yaPrincipal: typeof SUPERUSER } }>();
  app.use("*", async (c, next) => {
    c.set("yaPrincipal", SUPERUSER);
    await next();
  });
  app.route("/v0", createV0Routes(f.core));
  const path = "/v0/servers/self/sessions/child";
  const lookup = { sessionId: "child" };
  try {
    const receipt = (await f.core.call("createSession", peer, { body })) as {
      id: string;
    };
    expect(f.store.get(receipt.id)).toMatchObject({
      sessionId: "child",
      state: "dispatching",
    });
    const starting = await app.request(path);
    expect(starting.status).toBe(200);
    expect(await starting.json()).toEqual({
      id: "child",
      projectId: project.id,
      provider: "codex",
      title: null,
      updatedAt: f.store.get(receipt.id)?.updatedAt,
      state: "launching",
    });
    await expect(f.core.call("session", peer, lookup)).resolves.toMatchObject({
      state: "launching",
    });
    for (const caller of [
      { ...peer, serverId: "other" },
      { ...peer, projects: [] },
      {
        kind: "limited" as const,
        username: "reader",
        grants: { ...EMPTY_LIMITED_USER_GRANTS, viewProjects: [project.id] },
        locked: true,
        switched: false,
        via: "direct" as const,
      },
    ]) {
      await expect(
        f.core.call("session", caller, lookup),
      ).rejects.toMatchObject({
        status: 404,
        code: "session_not_found",
      });
    }
    const listed = await app.request("/v0/servers/self/sessions");
    expect(await listed.json()).toMatchObject({
      items: [{ id: "parent" }],
    });
    for (const suffix of ["/conversation", "/conversation/follow"]) {
      const response = await app.request(path + suffix);
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        error: { code: "session_not_ready" },
      });
    }
    expect((await app.request(path.replace("child", "missing"))).status).toBe(
      404,
    );
    queued();
    await f.commands.idle();
    expect(f.store.get(receipt.id)?.state).toBe("queued");
    expect(await (await app.request(path)).json()).toMatchObject({
      state: "launching",
    });

    f.sessions.push({
      id: "child",
      projectId: project.id,
      provider: "codex",
      title: "Ready",
      updatedAt: "",
      state: "idle",
    });
    expect(await (await app.request(path)).json()).toMatchObject({
      state: "launching",
    });
    settle("child");
    expect(f.store.get(receipt.id)?.state).toBe("accepted");
    expect(await (await app.request(path)).json()).toMatchObject({
      id: "child",
      title: "Ready",
      state: "idle",
    });
    expect(f.store.launchingSession("child")).toBeUndefined();

    await f.core.call("createSession", peer, {
      body: { ...body, requestId: "review-fail" },
    });
    await f.commands.idle();
    const refused = path.replace("child", "refused-child");
    expect((await app.request(refused)).status).toBe(200);
    fail();
    expect((await app.request(refused)).status).toBe(404);
  } finally {
    queued();
    await f.commands.idle();
    f.close();
  }
});

it("keeps request identity for the process only and resolves historical session aliases", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ya-receipts-"));
  let f: ReturnType<typeof fixture> | undefined;
  try {
    const path = join(dir, "discovery.sqlite");
    f = fixture(
      {
        async start() {
          return { queueId: "native-queue" };
        },
      },
      openSqliteOrThrow(path),
    );
    f.enable();
    seedHistoricalSessionAlias(f.database, "old-parent", "parent");
    const launch = {
      id: "old-parent",
      launchId: "launch-a",
      management: true as const,
    };
    const first = await f.core.call("createSession", SUPERUSER, {
      serverId: "A",
      body,
      launch,
    });
    const id = (first as { id: string }).id;
    expect(first).toMatchObject({ creator: { sessionId: "parent" } });
    await f.commands.idle();
    expect(f.store.get(id)?.state).toBe("queued");
    f.sources.projects = async () => ({ items: [] });
    f.sources.providers = async () => [];
    expect(
      await f.core.call("createSession", SUPERUSER, {
        body,
        launch: { ...launch, id: "parent", launchId: "launch-b" },
      }),
    ).toMatchObject({ id, state: "queued" });
    expect(f.store.relationships("parent", 0, 50).initiated[0]?.id).toBe(id);
    f.close();
    let relaunched = 0;
    f = fixture(
      {
        async start() {
          relaunched++;
          return { queueId: "second-queue" };
        },
      },
      openSqliteOrThrow(path),
    );
    f.enable();
    await expect(
      f.core.call("receipt", SUPERUSER, { receiptId: id }),
    ).rejects.toMatchObject({ status: 404, code: "receipt_not_found" });
    const fresh = await f.core.call("createSession", SUPERUSER, {
      body,
      launch,
    });
    expect((fresh as { id: string }).id).not.toBe(id);
    await f.commands.idle();
    expect(relaunched).toBe(1);
    expect(f.store.relationships("parent", 0, 50).initiated).toHaveLength(1);
  } finally {
    f?.close();
    await rm(dir, { recursive: true, force: true });
  }
});

it("records ambiguous launch failures without repeating work and reconciles only unique owner evidence", async () => {
  let launches = 0;
  const owner: SessionCommandOwner = {
    async start() {
      launches++;
      throw new Error("provider exited after launch boundary");
    },
    async recover() {
      return { sessionId: "native-child" };
    },
  };
  const f = fixture(owner);
  f.enable();
  try {
    const first = await f.core.call("createSession", SUPERUSER, { body });
    const id = (first as { id: string }).id;
    await f.commands.idle();
    expect(f.store.get(id)).toMatchObject({
      state: "uncertain",
      sessionId: null,
    });
    expect(
      await f.core.call("createSession", SUPERUSER, { body }),
    ).toMatchObject({ id, state: "uncertain" });
    expect(launches).toBe(1);
    expect(
      await f.core.call("receipt", SUPERUSER, { receiptId: id }),
    ).toMatchObject({
      state: "accepted",
      sessionId: "native-child",
      delivery: "uncertain",
    });
    await expect(
      f.core.call("createSession", SUPERUSER, {
        body,
        launch: { id: null, launchId: "pending", management: true },
      }),
    ).rejects.toMatchObject({ status: 409, code: "identity_pending" });
  } finally {
    f.close();
  }
});

it("rechecks current enablement after async catalog lookup and before reservation", async () => {
  let launched = 0;
  const f = fixture({
    async start() {
      launched++;
      return { sessionId: "unexpected" };
    },
  });
  f.enable();
  let release!: (value: { items: (typeof project)[] }) => void;
  f.sources.projects = () => new Promise((resolve) => (release = resolve));
  try {
    const pending = f.core.call("createSession", SUPERUSER, { body });
    f.disable();
    release({ items: [project] });
    await expect(pending).rejects.toMatchObject({
      code: "forbidden",
      status: 403,
    });
    await f.commands.idle();
    expect(launched).toBe(0);
    expect(f.commands.replayCreate(body)).toBeUndefined();
  } finally {
    f.close();
  }
});

it("rechecks a queued peer creation's actual grant before native dispatch without replacing its trusted creator", async () => {
  let authority: (() => Promise<void>) | undefined;
  const f = fixture({
    start: async (
      _project,
      _request,
      _receipt,
      _settled,
      _failed,
      _consumed,
      _admitted,
      authorize,
    ) => {
      authority = authorize;
      return { queueId: "owned-queued-command" };
    },
  });
  const grant = fixturePeerGrant(
    "source-peer",
    "owned-peer-token-at-least-thirty-two-characters",
    ["p"],
    ["createSession"],
  );
  const directory = new PeerDirectory([grant]);
  const lease = directory.authenticate(
    "owned-peer-token-at-least-thirty-two-characters",
    { sessionId: "source-session", launchId: "source-launch" },
  );
  f.enable();
  try {
    const created = await f.core.read("createSession", lease.principal, {
      body,
    });
    await f.commands.idle();
    expect(authority).toBeTypeOf("function");
    await authority!();
    directory.revoke(grant.id);
    await expect(authority!()).rejects.toThrow("Peer credential is not active");
    expect(f.store.get((created as { id: string }).id)?.creator).toMatchObject({
      principal: { kind: "peer" },
      serverId: "source-peer",
      sessionId: "source-session",
      authentication: { credentialId: grant.id },
    });
  } finally {
    lease.release();
    directory.close();
    f.close();
  }
});

it("evicts the oldest finished receipts at capacity and never an in-flight one", () => {
  const database = openSqliteOrThrow(":memory:");
  migrateDiscoveryDatabase(database);
  const store = new ApiReceiptStore(database, undefined, 3);
  const reserve = (requestId: string, kind: "input" | "cancel" = "input") =>
    store.reserve({
      requestId,
      kind,
      projectId: "p",
      sessionId: "s",
      creator: {
        serverId: "A",
        sessionId: "parent",
        launchId: null,
        principal: { kind: "superuser" },
      },
      destinationServerId: "A",
      payload: { requestId },
    });
  try {
    const waiting = reserve("waiting-0001").receipt;
    const failed = reserve("failed-00001").receipt;
    const control = reserve("control-0001", "cancel").receipt;
    store.update(waiting.id, { state: "accepted" });
    store.update(failed.id, { state: "failed" });
    store.update(control.id, { state: "accepted" });
    const fourth = reserve("fourth-00001").receipt;
    expect(store.get(failed.id)).toBeUndefined();
    expect(store.get(waiting.id)).toBeDefined();
    reserve("fifth-000001");
    expect(store.get(control.id)).toBeUndefined();
    expect(() => reserve("sixth-000001")).toThrow(
      expect.objectContaining({ code: "receipt_capacity", status: 503 }),
    );
    expect(reserve("waiting-0001")).toMatchObject({
      created: false,
      receipt: { id: waiting.id },
    });
    store.update(fourth.id, { state: "accepted", delivery: "consumed" });
    const sixth = reserve("sixth-000001");
    expect(sixth.created).toBe(true);
    expect(store.get(fourth.id)).toBeUndefined();
    expect(store.get(waiting.id)).toBeDefined();
  } finally {
    store.close();
    database.close();
  }
});
