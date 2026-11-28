import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { EMPTY_LIMITED_USER_GRANTS } from "@yep-anywhere/shared";
import { createDraftRoutes } from "../../src/routes/drafts.js";
import { DraftStore } from "../../src/drafts/DraftStore.js";
import {
  openSqliteOrThrow,
  type SqliteDatabase,
} from "../../src/storage/sqlite.js";
import { migrateDiscoveryDatabase } from "../../src/storage/discovery-sqlite.js";
import {
  PRINCIPAL_VARIABLE,
  type Principal,
} from "../../src/auth/principal.js";
import type { AttachmentStagingService } from "../../src/uploads/AttachmentStagingService.js";
import type { SessionAccessResolver } from "../../src/auth/sessionAccess.js";
import type { ProjectScanner } from "../../src/projects/scanner.js";
type PrincipalEnv = { Variables: Record<typeof PRINCIPAL_VARIABLE, Principal> };

let store: DraftStore,
  db: SqliteDatabase,
  app: Hono<PrincipalEnv>,
  principal: Principal;
let sessions: SessionAccessResolver;
beforeEach(() => {
  db = openSqliteOrThrow(":memory:");
  migrateDiscoveryDatabase(db);
  store = new DraftStore(db);
  sessions = {
    resolve: async (id: string) =>
      id === "session" ? { projectId: "project" } : null,
  } as SessionAccessResolver;
  principal = { kind: "superuser" };
  app = new Hono<PrincipalEnv>();
  app.use("*", async (c, next) => {
    c.set(PRINCIPAL_VARIABLE, principal);
    await next();
  });
  app.route(
    "/api/drafts",
    createDraftRoutes({
      store,
      scanner: {
        getProject: async (id: string) => (id === "project" ? { id } : null),
      } as ProjectScanner,
      sessions,
      staging: {
        forUser: () => ({ validateDraftRefs: async () => [] }),
      } as unknown as AttachmentStagingService,
    }),
  );
});
afterEach(() => {
  store.close();
  db.close();
});
const post = (route: string, body: unknown) =>
  app.request(`/api/drafts/${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
describe("authenticated personal draft routes", () => {
  it("returns only changed records, including clears, within the acting account", async () => {
    const slot = { kind: "new-session" as const };
    const write = (owner: string, text: string, operationId: string) => {
      const read = store.read(owner, slot);
      return store.write(owner, {
        slot,
        baseRevision: read.snapshot.revision,
        ticket: read.ticket,
        operationId,
        payload: { fields: text ? { text } : {}, attachments: [] },
      }).snapshot;
    };
    const first = write("", "owner draft", "first");
    write("alice", "private alice draft", "alice");
    const unchanged = await (
      await app.request(`/api/drafts/index?since=${first.sequence}`)
    ).json();
    expect(unchanged.entries).toEqual([]);
    write("", "", "clear");
    const changed = await (
      await app.request(`/api/drafts/index?since=${first.sequence}`)
    ).json();
    expect(changed.entries).toMatchObject([{ slot, empty: true }]);
    expect(changed.entries).toHaveLength(1);
    principal = {
      kind: "limited",
      username: "alice",
      grants: EMPTY_LIMITED_USER_GRANTS,
      switched: false,
      locked: true,
      via: "direct",
    };
    const alice = await (await app.request("/api/drafts/index?since=0")).json();
    expect(alice.entries).toHaveLength(1);
    expect(alice.entries[0].empty).toBe(false);
  });
  it.each(["-1", "NaN", "Infinity", "1.5", "9007199254740992", ""])(
    "refuses an invalid incremental cursor %j",
    async (since) => {
      expect(
        (await app.request(`/api/drafts/index?since=${since}`)).status,
      ).toBe(400);
    },
  );
  it("keeps edits during index access checks newer than the page's change cursor", async () => {
    const slot = { kind: "session" as const, sessionId: "session" };
    const write = (text: string, operationId: string) => {
      const read = store.read("", slot);
      return store.write("", {
        slot,
        ticket: read.ticket,
        baseRevision: read.snapshot.revision,
        operationId,
        payload: { fields: { text }, attachments: [] },
      }).snapshot;
    };
    const before = write("before access check", "first");
    let release!: () => void;
    const paused = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const checking = new Promise<void>((resolve) => {
      entered = resolve;
    });
    vi.spyOn(sessions, "resolve").mockImplementation(async () => {
      entered();
      await paused;
      return { projectId: "project" } as Awaited<
        ReturnType<SessionAccessResolver["resolve"]>
      >;
    });
    const indexing = app.request("/api/drafts/index");
    await checking;
    const during = write("during access check", "second");
    release();
    const page = await (await indexing).json();
    expect(page.entries).toMatchObject([{ revision: before.revision }]);
    expect(page.sequence).toBe(before.sequence);
    const changes = await app.request(
      `/api/drafts/changes?after=${page.sequence}`,
    );
    expect((await changes.json()).sequence).toBe(during.sequence);
  });
  it("isolates principals and checks slot resources instead of trusting body IDs", async () => {
    const slot = { kind: "session", sessionId: "session" };
    const read = await (await post("read", { slot })).json();
    expect(
      (
        await post("write", {
          slot,
          ticket: read.ticket,
          baseRevision: null,
          operationId: "owner-write",
          payload: { fields: { text: "private" }, attachments: [] },
        })
      ).status,
    ).toBe(200);
    principal = {
      kind: "limited",
      username: "alice",
      grants: EMPTY_LIMITED_USER_GRANTS,
      switched: false,
      locked: true,
      via: "direct",
    };
    expect((await post("read", { slot })).status).toBe(404);
    expect(
      (await post("read", { slot: { ...slot, projectId: "other" } })).status,
    ).toBe(404);
    expect(
      (await (await app.request("/api/drafts/index")).json()).entries,
    ).toEqual([]);
    principal = {
      ...principal,
      grants: { ...EMPTY_LIMITED_USER_GRANTS, viewProjects: ["project"] },
    };
    expect(
      (await (await post("read", { slot })).json()).snapshot.payload.fields,
    ).toEqual({});
  });
  it("refuses an attachment reference the acting account cannot validate", async () => {
    const slot = { kind: "new-session" };
    const read = await (await post("read", { slot })).json();
    expect(
      (
        await post("write", {
          slot,
          ticket: read.ticket,
          baseRevision: null,
          operationId: "forged",
          payload: {
            fields: { text: "text" },
            attachments: [{ id: "someone-elses-file", batchId: "batch" }],
          },
        })
      ).status,
    ).toBe(400);
    expect(
      store.read("", slot as { kind: "new-session" }).snapshot.revision,
    ).toBeNull();
  });
  it("publishes a change only after a committed accepted write", async () => {
    const seq = store.sequence();
    const waiting = app.request(`/api/drafts/changes?after=${seq}`);
    const slot = { kind: "new-session" };
    const read = await (await post("read", { slot })).json();
    await post("write", {
      slot,
      ticket: read.ticket,
      baseRevision: null,
      operationId: "change",
      payload: { fields: { text: "saved" }, attachments: [] },
    });
    expect((await (await waiting).json()).sequence).toBeGreaterThan(seq);
  });
});
