import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { SessionMetadataService } from "../../src/metadata/SessionMetadataService.js";
import {
  closeTestDiscoveryDatabases,
  createTestSessionMetadataService,
} from "../utils/session-metadata-database.js";

let dataDir: string;
let service: SessionMetadataService;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "non-human-turn-"));
  service = createTestSessionMetadataService(dataDir);
  await service.initialize();
});

afterEach(async () => {
  closeTestDiscoveryDatabases();
  await rm(dataDir, { recursive: true });
});

it("persists a delivered turn and its acknowledgement across restarts", async () => {
  const turn = {
    messageId: "delivered-turn",
    timestamp: "2026-09-14T12:00:00.000Z",
    sourceSessionId: "sender",
  };
  await service.recordNonHumanUserTurn("receiver", turn);
  await service.setTitle("receiver", "Working session");
  const restored = createTestSessionMetadataService(dataDir);
  await restored.initialize();
  expect(restored.getPendingNonHumanUserTurn("receiver")).toEqual(turn);
  expect(
    await restored.acknowledgeNonHumanUserTurn("receiver", turn.messageId),
  ).toBe(true);
  const reopened = createTestSessionMetadataService(dataDir);
  await reopened.initialize();
  expect(reopened.getPendingNonHumanUserTurn("receiver")).toBeUndefined();
  await reopened.recordNonHumanUserTurn("receiver", turn);
  expect(reopened.getPendingNonHumanUserTurn("receiver")).toBeUndefined();
});

it("keeps a newer delivery pending when an older turn is visited or replayed", async () => {
  const first = {
    messageId: "first",
    timestamp: "2026-09-14T12:00:00.000Z",
    sourceSessionId: "sender",
  };
  const second = {
    ...first,
    messageId: "second",
    timestamp: "2026-09-14T12:00:01.000Z",
  };
  await service.recordNonHumanUserTurn("receiver", first);
  await service.recordNonHumanUserTurn("receiver", second);
  expect(
    await service.acknowledgeNonHumanUserTurn("receiver", first.messageId),
  ).toBe(false);
  await service.recordNonHumanUserTurn("receiver", first);
  expect(service.getPendingNonHumanUserTurn("receiver")).toEqual(second);
});
