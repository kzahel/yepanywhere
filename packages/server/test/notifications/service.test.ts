import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NotificationService } from "../../src/notifications/NotificationService.js";
import { EventBus } from "../../src/watcher/EventBus.js";
import {
  closeTestDiscoveryDatabases,
  openTestDiscoveryDatabase,
} from "../utils/session-metadata-database.js";
let directory: string;
beforeEach(async () => {
  vi.useFakeTimers({ now: new Date("2024-01-01T00:00:00Z") });
  directory = join(tmpdir(), `ya-seen-sql-${randomUUID()}`);
  await fs.mkdir(directory);
});
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  closeTestDiscoveryDatabases();
  await fs.rm(directory, { recursive: true, force: true });
});
const legacy = () => join(directory, "notifications.json");
const fixture = (eventBus?: EventBus) => {
  const database = openTestDiscoveryDatabase(directory);
  return {
    database,
    service: new NotificationService({
      database,
      dataDir: directory,
      eventBus,
    }),
  };
};

it("imports legacy entries once without losing escaped message IDs or resurrecting cleared rows", async () => {
  const entry = { timestamp: "2024-06-15T12:00:00Z", messageId: "msg\0\ud800" };
  await fs.writeFile(
    legacy(),
    JSON.stringify({ version: 1, lastSeen: { session: entry } }),
  );
  const { service } = fixture();
  await service.initialize();
  expect(service.getLastSeen("session")).toEqual(entry);
  expect(await fs.stat(legacy()).catch(() => undefined)).toBeUndefined();
  await service.clearSession("session");
  // A leftover file/manual edit is never a second authority after adoption.
  await fs.writeFile(
    legacy(),
    JSON.stringify({ version: 1, lastSeen: { session: entry } }),
  );
  const reopened = fixture().service;
  await reopened.initialize();
  expect(reopened.getLastSeen("session")).toBeUndefined();
});

it("keeps monotonic seen timestamps across connections, reopen, unread and clear", async () => {
  const a = fixture().service,
    b = fixture().service;
  await Promise.all([a.initialize(), b.initialize()]);
  expect(a.hasUnread("session", "2024-06-15T12:00:00Z")).toBe(true);
  await Promise.all([
    a.markSeen("session", "2024-06-15T12:00:00Z", "latest"),
    b.markSeen("session", "2024-06-14T12:00:00Z", "older"),
    b.markSeen("other"),
  ]);
  expect(b.getLastSeen("session")).toEqual({
    timestamp: "2024-06-15T12:00:00Z",
    messageId: "latest",
  });
  expect(a.hasUnread("session", "2024-06-15T12:00:00Z")).toBe(false);
  expect(a.hasUnread("session", "2024-06-15T13:00:00Z")).toBe(true);
  expect(a.getLastSeen("other")?.timestamp).toBe(new Date().toISOString());
  const exported = a.getAllLastSeen();
  exported.session!.timestamp = "changed";
  expect(a.getLastSeen("session")?.timestamp).toBe("2024-06-15T12:00:00Z");
  await b.clearSession("session");
  await a.flush();
  expect(a.hasUnread("session", "2024-06-15T12:00:00Z")).toBe(true);
  const reopened = fixture().service;
  await reopened.initialize();
  expect(reopened.getAllLastSeen()).toEqual({
    other: { timestamp: new Date().toISOString() },
  });
  expect(await fs.stat(legacy()).catch(() => undefined)).toBeUndefined();
});

it("preserves unreadable/invalid imports and retries after repair", async () => {
  const { service, database } = fixture();
  for (const text of [
    "broken{",
    "null",
    '{"lastSeen":{"s":{"timestamp":7}}}',
  ]) {
    await fs.writeFile(legacy(), text);
    await expect(service.initialize()).rejects.toThrow(
      "invalid seen-state JSON",
    );
    expect(await fs.readFile(legacy(), "utf8")).toBe(text);
    const marker = database.prepare("SELECT * FROM session_last_seen_import");
    expect(marker.all()).toEqual([]);
    marker.finalize();
  }
  await fs.writeFile(
    legacy(),
    JSON.stringify({ lastSeen: { repaired: { timestamp: "2024-06-15" } } }),
  );
  await service.initialize();
  expect(service.getLastSeen("repaired")).toEqual({ timestamp: "2024-06-15" });
});

it("rolls back a failed import together with its marker", async () => {
  const { service, database } = fixture();
  const text = JSON.stringify({
    version: 1,
    lastSeen: { a: { timestamp: "a" }, b: { timestamp: "b" } },
  });
  await fs.writeFile(legacy(), text);
  database.exec(
    "CREATE TRIGGER refuse_seen BEFORE INSERT ON session_last_seen WHEN NEW.session_id='b' BEGIN SELECT RAISE(ABORT,'blocked'); END",
  );
  await expect(service.initialize()).rejects.toThrow("blocked");
  expect(service.getAllLastSeen()).toEqual({});
  expect(await fs.readFile(legacy(), "utf8")).toBe(text);
  database.exec("DROP TRIGGER refuse_seen");
  await service.initialize();
  expect(service.getAllLastSeen()).toEqual({
    a: { timestamp: "a" },
    b: { timestamp: "b" },
  });
});

it("publishes seen changes only after successful SQL commit and allows a failed mutation to retry", async () => {
  const bus = new EventBus();
  const events = vi.fn();
  bus.subscribe(events);
  const { service, database } = fixture(bus);
  await service.initialize();
  const changed = vi.fn();
  service.subscribeChanges(changed);
  database.exec(
    "CREATE TRIGGER refuse_seen BEFORE INSERT ON session_last_seen BEGIN SELECT RAISE(ABORT,'blocked'); END",
  );
  await expect(
    service.markSeen("session", "2024-06-15T12:00:00Z"),
  ).rejects.toThrow("blocked");
  expect(service.getLastSeen("session")).toBeUndefined();
  expect(events).not.toHaveBeenCalled();
  expect(changed).not.toHaveBeenCalled();
  database.exec("DROP TRIGGER refuse_seen");
  await service.markSeen("session", "2024-06-15T12:00:00Z", "m");
  expect(events).toHaveBeenCalledWith({
    type: "session-seen",
    sessionId: "session",
    timestamp: "2024-06-15T12:00:00Z",
    messageId: "m",
  });
  await service.markSeen("session", "2024-06-14T12:00:00Z");
  expect(events).toHaveBeenCalledOnce();
  await service.clearSession("session");
  expect(changed).toHaveBeenCalledTimes(2);
});
