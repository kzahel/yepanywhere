import assert from "node:assert/strict";
import type { SqliteDatabase } from "@yep-anywhere/shared/sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../src/db.js";
import { UsernameRegistry } from "../src/registry.js";

describe("UsernameRegistry", () => {
  let db: SqliteDatabase;
  let registry: UsernameRegistry;

  beforeEach(() => {
    db = createTestDb();
    registry = new UsernameRegistry(db);
  });

  afterEach(() => {
    db.close();
  });

  describe("canRegister", () => {
    it("returns true for unregistered username", () => {
      expect(registry.canRegister("alice", "install-1")).toBe(true);
    });

    it("returns true for same installId", () => {
      registry.register("alice", "install-1");
      expect(registry.canRegister("alice", "install-1")).toBe(true);
    });

    it("returns false for different installId", () => {
      registry.register("alice", "install-1");
      expect(registry.canRegister("alice", "install-2")).toBe(false);
    });

    it("returns false for invalid username", () => {
      expect(registry.canRegister("ab", "install-1")).toBe(false); // Too short
      expect(registry.canRegister("Alice", "install-1")).toBe(false); // Uppercase
      expect(registry.canRegister("-abc", "install-1")).toBe(false); // Starts with hyphen
    });
  });

  describe("register", () => {
    it("registers new username", () => {
      expect(registry.register("alice", "install-1")).toBe(true);
      expect(registry.isRegistered("alice")).toBe(true);
    });

    it("allows same installId to re-register", () => {
      registry.register("alice", "install-1");
      expect(registry.register("alice", "install-1")).toBe(true);
    });

    it("rejects different installId", () => {
      registry.register("alice", "install-1");
      expect(registry.register("alice", "install-2")).toBe(false);
    });

    it("rejects invalid username", () => {
      expect(registry.register("ab", "install-1")).toBe(false);
      expect(registry.register("Alice", "install-1")).toBe(false);
    });

    it("updates last_seen_at on re-registration", () => {
      registry.register("alice", "install-1");
      const record1 = registry.get("alice");

      // Wait a tiny bit and re-register
      registry.register("alice", "install-1");
      const record2 = registry.get("alice");

      expect(record1).toBeDefined();
      expect(record2).toBeDefined();
      // registered_at should be the same
      expect(record2?.registered_at).toBe(record1?.registered_at);
      // last_seen_at should be updated (or same if too fast)
      expect(record2?.last_seen_at).toBeDefined();
    });

    it("stores install_id correctly", () => {
      registry.register("alice", "my-special-install-id");
      const record = registry.get("alice");
      expect(record?.install_id).toBe("my-special-install-id");
    });
  });

  describe("isRegistered", () => {
    it("returns false for unregistered username", () => {
      expect(registry.isRegistered("alice")).toBe(false);
    });

    it("returns true for registered username", () => {
      registry.register("alice", "install-1");
      expect(registry.isRegistered("alice")).toBe(true);
    });
  });

  describe("updateLastSeen", () => {
    it("updates last_seen_at timestamp", () => {
      registry.register("alice", "install-1");
      const before = registry.get("alice")?.last_seen_at;

      registry.updateLastSeen("alice");
      const after = registry.get("alice")?.last_seen_at;

      assert(before !== undefined, "expected initial last_seen_at");
      assert(after !== undefined, "expected updated last_seen_at");
      expect(new Date(after).getTime()).toBeGreaterThanOrEqual(
        new Date(before).getTime(),
      );
    });
  });

  describe("reclaimInactive", () => {
    it("deletes old registrations", () => {
      // Register a username
      registry.register("alice", "install-1");

      // Manually set last_seen_at to 100 days ago
      const oldDate = new Date();
      oldDate.setDate(oldDate.getDate() - 100);
      db.prepare(
        "UPDATE usernames SET last_seen_at = ? WHERE username = ?",
      ).run(oldDate.toISOString(), "alice");

      // Reclaim with 90-day threshold
      const count = registry.reclaimInactive(90);
      expect(count).toBe(1);
      expect(registry.isRegistered("alice")).toBe(false);
    });

    it("keeps recent registrations", () => {
      registry.register("alice", "install-1");

      // Reclaim with 90-day threshold - should not affect recent registration
      const count = registry.reclaimInactive(90);
      expect(count).toBe(0);
      expect(registry.isRegistered("alice")).toBe(true);
    });

    it("returns count of deleted records", () => {
      // Register multiple usernames
      registry.register("alice", "install-1");
      registry.register("bob", "install-2");
      registry.register("charlie", "install-3");

      // Make alice and bob old
      const oldDate = new Date();
      oldDate.setDate(oldDate.getDate() - 100);
      db.prepare(
        "UPDATE usernames SET last_seen_at = ? WHERE username IN (?, ?)",
      ).run(oldDate.toISOString(), "alice", "bob");

      const count = registry.reclaimInactive(90);
      expect(count).toBe(2);
      expect(registry.isRegistered("alice")).toBe(false);
      expect(registry.isRegistered("bob")).toBe(false);
      expect(registry.isRegistered("charlie")).toBe(true);
    });
  });

  describe("delete", () => {
    it("deletes registered username", () => {
      registry.register("alice", "install-1");
      expect(registry.delete("alice")).toBe(true);
      expect(registry.isRegistered("alice")).toBe(false);
    });

    it("returns false for non-existent username", () => {
      expect(registry.delete("nonexistent")).toBe(false);
    });
  });

  describe("list", () => {
    it("returns empty array when no registrations", () => {
      expect(registry.list()).toEqual([]);
    });

    it("returns all registrations sorted by username", () => {
      registry.register("charlie", "install-3");
      registry.register("alice", "install-1");
      registry.register("bob", "install-2");

      const list = registry.list();
      expect(list.length).toBe(3);
      expect(list[0]?.username).toBe("alice");
      expect(list[1]?.username).toBe("bob");
      expect(list[2]?.username).toBe("charlie");
    });
  });

  describe("get", () => {
    it("returns undefined for non-existent username", () => {
      expect(registry.get("nonexistent")).toBeUndefined();
    });

    it("returns full record for registered username", () => {
      registry.register("alice", "install-1");
      const record = registry.get("alice");

      expect(record).toBeDefined();
      expect(record?.username).toBe("alice");
      expect(record?.install_id).toBe("install-1");
      expect(record?.registered_at).toBeDefined();
      expect(record?.last_seen_at).toBeDefined();
    });
  });
});
