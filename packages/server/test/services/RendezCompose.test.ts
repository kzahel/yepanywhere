import {
  mkdtemp,
  mkdir,
  readFile,
  readlink,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { expect, it, vi } from "vitest";
import { DraftStore } from "../../src/drafts/DraftStore.js";
import { openSqliteOrThrow } from "../../src/storage/sqlite.js";
import { migrateDiscoveryDatabase } from "../../src/storage/discovery-sqlite.js";
import { AttachmentStagingService } from "../../src/uploads/AttachmentStagingService.js";
import { RendezCompose } from "../../src/services/RendezCompose.js";
import { RendezDraftDelivery } from "../../src/services/RendezDraftDelivery.js";
import { RendezWatchService } from "../../src/services/RendezWatchService.js";
import { ServerSettingsService } from "../../src/services/ServerSettingsService.js";
import { createRendezComposeRoutes } from "../../src/routes/rendez-compose.js";
import { createRendezSessions } from "../../src/services/rendezSessions.js";
import { subscribe } from "../../src/services/rendez-protocol.mjs";
import { runIdleSweeps } from "../../src/lib/processIdleSweep.js";
import type { ProjectScanner } from "../../src/projects/scanner.js";
import type { Process } from "../../src/supervisor/Process.js";

it.skipIf(process.platform === "win32")(
  "routes a filesystem upload to the single draft, arbitrates claims, and never steals explicit session uploads",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "rendez-compose-"));
    const project = join(directory, "project");
    await mkdir(project);
    const db = openSqliteOrThrow(":memory:");
    migrateDiscoveryDatabase(db);
    const drafts = new DraftStore(db);
    const staging = new AttachmentStagingService({ dataDir: directory });
    staging.setDraftProtection((owner, id) => drafts.protects(owner ?? "", id));
    const sessionDelivery = new RendezDraftDelivery(drafts, staging);
    const settings = new ServerSettingsService({ dataDir: directory });
    await settings.initialize();
    await settings.updateSettings({ rendez: { enabled: true, projects: {} } });
    let now = Date.now();
    let watch: RendezWatchService | undefined;
    const compose = new RendezCompose(
      drafts,
      staging,
      () => watch,
      () => now,
    );
    const sent = vi.fn(() => ({ success: true }));
    const process = {
      sessionId: "session-a",
      projectPath: project,
      isProcessAlive: true,
      provider: "claude",
      resolvedModel: "sonnet",
      queueMessage: sent,
    } as unknown as Process;
    watch = new RendezWatchService(
      settings,
      async () => [],
      createRendezSessions(
        () => [process],
        () => "steer",
        (path, target) => compose.route(path, target),
        sessionDelivery,
      ),
      () => () => {},
    );
    const app = new Hono().route(
      "/api/rendez",
      createRendezComposeRoutes(compose, {
        getProject: async (id: string) =>
          id === "project" ? { id, path: project } : null,
      } as unknown as ProjectScanner),
    );
    const claim = async (
      claimId: string,
      projectId: string | null,
      acquire: boolean,
    ) => {
      const response = await app.request("/api/rendez/compose", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ claimId, projectId, acquire }),
      });
      expect(response.status).toBe(200);
      return (await response.json()).active;
    };
    const root = join(project, ".rendez");
    const slot = { kind: "new-session" } as const;
    try {
      expect(await claim("first", "project", true)).toBe(true);
      const read = drafts.read("", slot);
      drafts.write("", {
        slot,
        ticket: read.ticket,
        baseRevision: null,
        operationId: "typed",
        payload: { fields: { text: "Keep this draft" }, attachments: [] },
      });
      const target = {
        harness: "claude",
        providerSessionId: "session-a",
        yaSessionId: "session-a",
      };
      await subscribe(root, target, { latest: true });
      const latest = await readlink(join(root, "latest-session"));
      await writeFile(
        join(root, "active-compose", "example.txt"),
        "attachment bytes",
      );
      await vi.waitFor(
        () =>
          expect(
            drafts.read("", slot).snapshot.payload.attachments,
          ).toHaveLength(1),
        { timeout: 8000 },
      );
      const payload = drafts.read("", slot).snapshot.payload;
      expect(payload.fields.text).toBe("Keep this draft");
      const ref = payload.attachments[0]!;
      expect(await staging.validateDraftRefs(ref.batchId, [ref])).toHaveLength(
        1,
      );
      expect(sent).not.toHaveBeenCalled();
      expect(await readlink(join(root, "latest-session"))).toBe(latest);
      const sessionSlot = { kind: "session", sessionId: "session-a" } as const;
      const sessionDraft = drafts.read("", sessionSlot);
      drafts.write("", {
        slot: sessionSlot,
        ticket: sessionDraft.ticket,
        baseRevision: sessionDraft.snapshot.revision,
        operationId: "session-text",
        payload: {
          fields: { text: "An existing session draft" },
          attachments: [],
        },
      });
      await writeFile(join(root, "session-a", "explicit.txt"), "session bytes");
      await vi.waitFor(
        () =>
          expect(
            drafts.read("", sessionSlot).snapshot.payload.attachments,
          ).toHaveLength(1),
        { timeout: 8000 },
      );
      expect(drafts.read("", sessionSlot).snapshot.payload).toMatchObject({
        fields: { text: "An existing session draft" },
        attachments: [{ rendezAutoSendAt: null }],
      });
      expect(sent).not.toHaveBeenCalled();
      expect(await claim("second", "project", true)).toBe(true);
      expect(await claim("first", "project", false)).toBe(false);
      expect(await claim("first", null, false)).toBe(false);
      expect(
        await compose
          .route(project, { draft: { claimId: "first" } })
          .send("late", ""),
      ).toMatchObject({ accepted: false });
      expect(await readlink(join(root, "active-compose"))).toContain(
        "ya-new-session-draft",
      );
      now += 46_000;
      expect(
        await compose
          .route(project, { draft: { claimId: "second" } })
          .send("expired", ""),
      ).toMatchObject({ accepted: false });
      runIdleSweeps(now);
      // A rejected claim joins the same queue as the expiration sweep.
      expect(await claim("first", null, false)).toBe(false);
      expect(await readlink(join(root, "active-compose"))).toBe(
        "latest-session",
      );
      expect(drafts.read("", slot).snapshot.payload.attachments).toHaveLength(
        1,
      );
      const records = await readdir(
        join(root, "delivered", "ya-new-session-draft"),
      );
      const record = JSON.parse(
        await readFile(
          join(
            root,
            "delivered",
            "ya-new-session-draft",
            records[0]!,
            "record.json",
          ),
          "utf8",
        ),
      );
      expect(record.state).toBe("accepted");
      expect(record.transport).toBe("draft");
    } finally {
      await sessionDelivery.close();
      await compose.close();
      await watch.close();
      drafts.close();
      db.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
  // The previous 5s limit preempted the two 8s upload checks on macOS.
  // A run can need both quiet intervals and both startup rechecks.
  20_000,
);
