import {
  PUBLIC_SHARE_INITIAL_PROMPT_MAX_LENGTH,
  PUBLIC_SHARE_SESSION_CHUNK_MAX_BYTES,
  PUBLIC_SHARE_SESSION_COMPRESSED_MAX_BYTES,
  PUBLIC_SHARE_TITLE_MAX_LENGTH,
  type AppSession,
  type UrlProjectId,
} from "@yep-anywhere/shared";
import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inspectLegacySessionBody } from "../../src/services/LegacyPublicShareReader.js";
import {
  PUBLIC_SHARE_SECRET_BITS,
  PUBLIC_SHARE_SECRET_BYTES,
  PUBLIC_SHARE_VIEWER_TELEMETRY_MAX_ENTRIES,
  PublicShareChunkCursorError,
  PublicShareService,
} from "../../src/services/PublicShareService.js";
import {
  PublicShareStore,
  cowDescriptorRoot,
} from "../../src/services/PublicShareStore.js";

const projectId = "cHJvamVjdA" as UrlProjectId;

function secretHash(seed: string): string {
  return createHash("sha512").update(seed).digest("base64url");
}

it("uses descriptor-relative CoW traversal only on Linux", () => {
  expect(cowDescriptorRoot("linux")).toBe("/proc/self/fd");
  expect(cowDescriptorRoot("darwin")).toBeNull();
  expect(cowDescriptorRoot("win32")).toBeNull();
});

function makeSession(overrides: Partial<AppSession> = {}): AppSession {
  return {
    id: "session-1",
    projectId,
    title: "Test session",
    fullTitle: "Test session",
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt: "2026-05-01T00:01:00.000Z",
    messageCount: 0,
    ownership: { owner: "self", processId: "proc-1" },
    provider: "codex",
    messages: [],
    pendingInputType: "tool-approval",
    activity: "waiting-input",
    lastSeenAt: "2026-05-01T00:00:30.000Z",
    hasUnread: true,
    ...overrides,
  } as AppSession;
}

async function captureSession(
  service: PublicShareService,
  session = makeSession(),
) {
  const capture = await service.captureCompleteSession(async () => session);
  if (!capture) throw new Error("Expected test session capture");
  return capture;
}

function makeRevisionSession(content: string): AppSession {
  return makeSession({
    messageCount: 1,
    messages: [
      {
        type: "user",
        uuid: "stable-message-id",
        message: { role: "user", content },
        timestamp: "2026-05-01T00:00:00.000Z",
      },
    ] as AppSession["messages"],
  });
}

async function captureChangingSession(service: PublicShareService) {
  let readCount = 0;
  const capture = await service.captureCompleteSession(async () => {
    readCount += 1;
    return makeRevisionSession(readCount === 1 ? "before" : "after");
  });
  if (!capture) throw new Error("Expected changing test session capture");
  return capture;
}

async function captureGrowingSession(service: PublicShareService) {
  let readCount = 0;
  const capture = await service.captureCompleteSession(async () => {
    readCount += 1;
    const first = makeRevisionSession("completed");
    return readCount === 1
      ? first
      : makeSession({
          messageCount: 2,
          messages: [
            ...first.messages,
            {
              type: "user",
              uuid: "later-message-id",
              message: { role: "user", content: "later" },
              timestamp: "2026-05-01T00:02:00.000Z",
            },
          ] as AppSession["messages"],
        });
  });
  if (!capture) throw new Error("Expected growing test session capture");
  return capture;
}

async function inspectLegacySessionValue(value: unknown) {
  async function* serialized(): AsyncGenerator<string> {
    yield JSON.stringify(value);
  }
  return inspectLegacySessionBody(serialized());
}

describe("PublicShareService", () => {
  let service: PublicShareService;
  let testDir: string;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), "public-shares-test-"));
    service = new PublicShareService({ dataDir: testDir });
    await service.initialize();
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it.skipIf(process.platform === "win32")(
    "remediates existing public-share root and control permissions on open",
    async () => {
      const root = path.join(testDir, "public-shares");
      const grantsPath = path.join(root, "grants.json");
      await fs.chmod(root, 0o777);
      await fs.chmod(grantsPath, 0o666);

      const reopened = new PublicShareService({ dataDir: testDir });
      await reopened.initialize();

      expect((await fs.lstat(root)).mode & 0o777).toBe(0o700);
      expect((await fs.lstat(grantsPath)).mode & 0o777).toBe(0o600);
      expect(
        (await fs.lstat(path.join(root, "cleanup.json"))).mode & 0o777,
      ).toBe(0o600);
      expect(
        (await fs.lstat(path.join(root, "migration.json"))).mode & 0o777,
      ).toBe(0o600);
    },
  );

  it("preserves split UTF-8 characters while inspecting streamed revisions", async () => {
    const body = Buffer.from(
      JSON.stringify({ messageCount: 1, messages: [{ content: "🙂" }] }),
    );
    const splitAt = body.indexOf(Buffer.from("🙂")) + 1;
    async function* splitBody(): AsyncGenerator<Buffer> {
      yield body.subarray(0, splitAt);
      yield body.subarray(splitAt);
    }

    await expect(inspectLegacySessionBody(splitBody())).resolves.toEqual({
      repairRequired: false,
    });
  });

  it("requires the streamed legacy array to satisfy the declared message count", async () => {
    await expect(
      inspectLegacySessionValue({
        messageCount: 100,
        messages: [{ content: "one" }],
      }),
    ).resolves.toEqual({ repairRequired: true });
    await expect(
      inspectLegacySessionValue({
        messageCount: 2,
        messages: [
          { content: { nested: [1, 2, 3] } },
          { content: [{ nested: [4, 5] }] },
        ],
      }),
    ).resolves.toEqual({ repairRequired: false });
    await expect(
      inspectLegacySessionValue({
        messageCount: 1,
        messages: [{ type: "user" }, { type: "system" }],
      }),
    ).resolves.toEqual({ repairRequired: false });
  });

  it("preserves empty and missing legacy message-array behavior", async () => {
    await expect(
      inspectLegacySessionValue({ messageCount: 0, messages: [] }),
    ).resolves.toEqual({ repairRequired: false });
    await expect(
      inspectLegacySessionValue({ messageCount: 0 }),
    ).resolves.toEqual({ repairRequired: false });
    await expect(
      inspectLegacySessionValue({ messageCount: 1 }),
    ).resolves.toEqual({ repairRequired: true });
  });

  it("stores a 128-bit grant separately from its frozen body", async () => {
    const { secret, secretBits } = await service.createShare({
      mode: "frozen",
      title: "Share me",
      source: {
        projectId,
        sessionId: "session-1",
        projectName: "project",
        provider: "codex",
      },
      capture: await captureSession(service),
    });

    expect(secretBits).toBe(PUBLIC_SHARE_SECRET_BITS);
    expect(Buffer.from(secret, "base64url")).toHaveLength(
      PUBLIC_SHARE_SECRET_BYTES,
    );

    const persisted = await fs.readFile(
      path.join(testDir, "public-shares", "grants.json"),
      "utf-8",
    );
    expect(persisted).not.toContain(secret);
    expect(persisted).toContain("secretHash");
    expect(persisted).not.toContain("Test session");

    const stateDirectories = await fs.readdir(
      path.join(testDir, "public-shares", "shares"),
    );
    expect(stateDirectories).toHaveLength(1);
    const frozenDirectories = await fs.readdir(
      path.join(
        testDir,
        "public-shares",
        "shares",
        stateDirectories[0]!,
        "frozen",
      ),
    );
    expect(frozenDirectories).toHaveLength(1);
    await expect(
      fs.stat(
        path.join(
          testDir,
          "public-shares",
          "shares",
          stateDirectories[0]!,
          "frozen",
          frozenDirectories[0]!,
          "session.json.gz",
        ),
      ),
    ).resolves.toMatchObject({});
  });

  it("normalizes and bounds persisted grant text", async () => {
    const { secret, record } = await service.createShare({
      mode: "live",
      title: `  ${"t".repeat(PUBLIC_SHARE_TITLE_MAX_LENGTH + 20)}  `,
      initialPrompt: `  ${"prompt  ".repeat(200)}  `,
      source: { projectId, sessionId: "session-1" },
    });

    expect(record.title).toHaveLength(PUBLIC_SHARE_TITLE_MAX_LENGTH);
    expect(record.title).toMatch(/\.\.\.$/);
    expect(record.initialPrompt).toHaveLength(
      PUBLIC_SHARE_INITIAL_PROMPT_MAX_LENGTH,
    );
    expect(record.initialPrompt).not.toMatch(/\s{2}/);

    const restarted = new PublicShareService({ dataDir: testDir });
    await restarted.initialize();
    expect(restarted.getRecordBySecret(secret)).toMatchObject({
      title: record.title,
      initialPrompt: record.initialPrompt,
    });
  });

  it("binds opaque chunk cursors to the bearer grant and selected representation", async () => {
    const snapshot = makeRevisionSession(
      randomBytes(400_000).toString("base64"),
    );
    const capture = await captureSession(service, snapshot);
    const firstGrant = await service.createShare({
      mode: "frozen",
      source: { projectId, sessionId: "session-1" },
      capture,
    });
    const secondGrant = await service.createShare({
      mode: "frozen",
      source: { projectId, sessionId: "session-1" },
      capture,
    });

    const firstChunk = await service.getFrozenSessionChunk(firstGrant.record);
    expect(firstChunk?.bytes.byteLength).toBe(
      PUBLIC_SHARE_SESSION_CHUNK_MAX_BYTES,
    );
    expect(firstChunk?.cursor).toEqual(expect.any(String));
    await expect(
      service.getFrozenSessionChunk(
        firstGrant.record,
        undefined,
        firstChunk!.cursor!,
      ),
    ).resolves.toMatchObject({ index: 1, offset: firstChunk!.nextOffset });
    await expect(
      service.getFrozenSessionChunk(
        secondGrant.record,
        undefined,
        firstChunk!.cursor!,
      ),
    ).rejects.toBeInstanceOf(PublicShareChunkCursorError);
  });

  it("rejects compressed chunk reads above the shared bound", async () => {
    const created = await service.createShare({
      mode: "frozen",
      source: { projectId, sessionId: "session-1" },
      capture: await captureSession(service),
    });
    const store = new PublicShareStore(testDir);
    await store.initialize();

    await expect(
      store.readRevisionCompressedChunk(
        created.record,
        created.record.revisionId!,
        0,
        PUBLIC_SHARE_SESSION_CHUNK_MAX_BYTES + 1,
      ),
    ).rejects.toThrow("Invalid public share chunk bound");
  });

  it("fails closed when a viewer cursor is reused after viewer or capture change", async () => {
    const { secret } = await service.createShare({
      mode: "live",
      source: { projectId, sessionId: "session-1" },
    });
    const content = randomBytes(400_000).toString("base64");
    vi.useFakeTimers();
    try {
      vi.setSystemTime("2026-08-06T00:00:00.000Z");
      const firstCapture = await captureSession(
        service,
        makeRevisionSession(content),
      );
      await service.freezeSessionViewerToken(
        projectId,
        "session-1",
        "viewer-one",
        firstCapture,
      );
      await service.freezeSessionViewerToken(
        projectId,
        "session-1",
        "viewer-two",
        firstCapture,
      );
      const record = service.getRecordBySecret(secret)!;
      const firstChunk = await service.getFrozenSessionChunk(
        record,
        "viewer-one",
      );
      expect(firstChunk?.cursor).toEqual(expect.any(String));

      await expect(
        service.getFrozenSessionChunk(
          record,
          "viewer-two",
          firstChunk!.cursor!,
        ),
      ).rejects.toBeInstanceOf(PublicShareChunkCursorError);

      const firstRevision = record.viewerSnapshots?.["viewer-one"]?.revisionId;
      vi.setSystemTime("2026-08-06T00:01:00.000Z");
      await service.freezeSessionViewerToken(
        projectId,
        "session-1",
        "viewer-one",
        await captureSession(service, makeRevisionSession(content)),
      );
      const refrozen = service.getRecordBySecret(secret)!;
      expect(refrozen.viewerSnapshots?.["viewer-one"]?.revisionId).toBe(
        firstRevision,
      );
      expect(refrozen.viewerSnapshots?.["viewer-one"]?.capturedAt).not.toBe(
        record.viewerSnapshots?.["viewer-one"]?.capturedAt,
      );
      await expect(
        service.getFrozenSessionChunk(
          refrozen,
          "viewer-one",
          firstChunk!.cursor!,
        ),
      ).rejects.toBeInstanceOf(PublicShareChunkCursorError);
    } finally {
      vi.useRealTimers();
    }
  });

  it("removes only owned atomic control temps while opening", async () => {
    const dataDir = path.join(testDir, "atomic-temp-opening");
    const root = path.join(dataDir, "public-shares");
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    const ownedTemp = path.join(
      root,
      ".grants.json.12345.0123456789abcdef.tmp",
    );
    const unknownTemp = path.join(root, ".grants.json.bad.tmp");
    const unrelatedFile = path.join(root, ".notes.12345.0123456789abcdef.tmp");
    await fs.writeFile(ownedTemp, "partial", { mode: 0o600 });
    await fs.writeFile(unknownTemp, "preserve", { mode: 0o600 });
    await fs.writeFile(unrelatedFile, "preserve", { mode: 0o600 });

    const opened = new PublicShareService({ dataDir });
    await opened.initialize();

    await expect(fs.stat(ownedTemp)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readFile(unknownTemp, "utf8")).resolves.toBe("preserve");
    await expect(fs.readFile(unrelatedFile, "utf8")).resolves.toBe("preserve");
  });

  it.skipIf(process.platform === "win32")(
    "keeps persisted public-share paths owner-only",
    async () => {
      await service.createShare({
        mode: "frozen",
        source: { projectId, sessionId: "session-1" },
        capture: await captureSession(service),
      });
      const root = path.join(testDir, "public-shares");
      const pending = [root];
      while (pending.length > 0) {
        const current = pending.pop()!;
        const stats = await fs.lstat(current);
        if (stats.isDirectory()) {
          expect(stats.mode & 0o777, current).toBe(0o700);
          for (const child of await fs.readdir(current)) {
            pending.push(path.join(current, child));
          }
        } else {
          expect(stats.isFile(), current).toBe(true);
          expect(stats.mode & 0o777, current).toBe(0o600);
        }
      }
    },
  );

  it("rejects missing, short, and guessed secrets", async () => {
    await service.createShare({
      mode: "frozen",
      source: {
        projectId,
        sessionId: "session-1",
        projectName: "project",
        provider: "codex",
      },
      capture: await captureSession(service),
    });

    expect(service.getRecordBySecret("")).toBeNull();
    expect(service.getRecordBySecret("short")).toBeNull();
    expect(
      service.getRecordBySecret(Buffer.alloc(64, 1).toString("base64url")),
    ).toBeNull();
  });

  it("streams legacy aggregate records into independent revisions", async () => {
    const migrationDir = path.join(testDir, "migration");
    await fs.mkdir(migrationDir);
    const legacySecret = Buffer.alloc(64, 7).toString("base64url");
    const secretHash = createHash("sha512")
      .update(legacySecret, "utf8")
      .digest("base64url");
    const buildLegacyDocument = (content: string) => {
      const frozenSession = makeSession({
        title: 'Legacy "quoted" session',
        messages: [
          {
            type: "user",
            uuid: "legacy-message",
            message: { role: "user", content },
            timestamp: "2026-05-01T00:00:00.000Z",
          },
        ] as AppSession["messages"],
      });
      return {
        before: { ignored: true },
        shares: [
          {
            version: 1,
            secretHash,
            mode: "frozen",
            title: "Legacy",
            createdAt: "2026-05-01T00:00:00.000Z",
            updatedAt: "2026-05-01T00:01:00.000Z",
            capturedAt: "2026-05-01T00:01:00.000Z",
            source: {
              projectId,
              sessionId: "session-1",
              projectName: "project",
              provider: "codex",
            },
            frozenSession,
            viewerSnapshots: {
              ["__proto__"]: {
                capturedAt: "2026-05-01T00:02:00.000Z",
                frozenSession: makeSession({ title: "Legacy proto viewer" }),
              },
            },
          },
        ],
        after: ["trailing-field"],
      };
    };
    const boundarySentinel = "UTF8_BOUNDARY";
    const template = JSON.stringify(buildLegacyDocument(boundarySentinel));
    const sentinelIndex = template.indexOf(boundarySentinel);
    expect(sentinelIndex).toBeGreaterThan(0);
    const emojiOffset = 64 * 1024 - 1;
    const prefixBytes = Buffer.byteLength(template.slice(0, sentinelIndex));
    const exactContent = `${"x".repeat(emojiOffset - prefixBytes)}🙂 exact trailing text docs/guide.md`;
    const legacyDocument = buildLegacyDocument(exactContent);
    const serializedLegacy = JSON.stringify(legacyDocument);
    expect(Buffer.from(serializedLegacy).indexOf(Buffer.from("🙂"))).toBe(
      emojiOffset,
    );
    await fs.writeFile(
      path.join(migrationDir, "public-shares.json"),
      serializedLegacy,
      "utf8",
    );

    const migrated = new PublicShareService({ dataDir: migrationDir });
    await migrated.initialize();

    expect(migrated.getReadiness()).toEqual({ state: "ready", error: null });
    const migratedRecord = migrated.getRecordBySecret(legacySecret);
    expect(migratedRecord).toMatchObject({
      mode: "frozen",
      linkedFileMode: "live",
    });
    expect(migratedRecord).not.toHaveProperty("repairRequired");
    expect(migrated.hasViewerSnapshot(migratedRecord!, "__proto__")).toBe(true);
    await expect(
      migrated.getViewerSnapshotResponse(migratedRecord!, "__proto__"),
    ).resolves.toMatchObject({ session: { title: "Legacy proto viewer" } });
    const migratedShare = await migrated.getFrozenShareBySecret(legacySecret);
    expect(migratedShare).toMatchObject({
      session: { title: 'Legacy "quoted" session' },
    });
    const migratedMessage = migratedShare?.session.messages?.[0];
    expect(migratedMessage?.type).toBe("user");
    if (migratedMessage?.type !== "user") {
      throw new Error("Expected migrated user message");
    }
    expect(migratedMessage.message.content).toBe(exactContent);
    await expect(
      migrated.getFrozenPresentation(migratedRecord!),
    ).resolves.toEqual({
      version: 1,
      authorizedPaths: ["docs/guide.md"],
    });
    await expect(
      fs.stat(path.join(migrationDir, "public-shares.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      fs.stat(path.join(migrationDir, "public-shares.legacy-backup.json")),
    ).resolves.toMatchObject({});

    // The next start finds the marker complete and deletes the backup, so a
    // lost marker can no longer re-migrate from it.
    const restarted = new PublicShareService({ dataDir: migrationDir });
    await restarted.initialize();
    expect(restarted.getReadiness().state).toBe("ready");
    expect(restarted.getValidShareCount()).toBe(migrated.getValidShareCount());
    await expect(
      fs.stat(path.join(migrationDir, "public-shares.legacy-backup.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("bounds each migrated legacy representation independently", async () => {
    const migrationDir = path.join(testDir, "bounded-migration");
    await fs.mkdir(migrationDir);
    const frozenSecret = Buffer.alloc(64, 15).toString("base64url");
    const liveSecret = Buffer.alloc(64, 16).toString("base64url");
    const smallSession = makeSession({ title: "bounded viewer" });
    const oversizedSession = makeRevisionSession("x".repeat(1024));
    const smallSessionBytes = Buffer.byteLength(JSON.stringify(smallSession));
    const oversizedSessionBytes = Buffer.byteLength(
      JSON.stringify(oversizedSession),
    );
    const legacySessionMaxBytes = smallSessionBytes + 16;
    expect(oversizedSessionBytes).toBeGreaterThan(legacySessionMaxBytes);

    await fs.writeFile(
      path.join(migrationDir, "public-shares.json"),
      JSON.stringify({
        shares: [
          {
            version: 1,
            secretHash: createHash("sha512")
              .update(frozenSecret, "utf8")
              .digest("base64url"),
            mode: "frozen",
            title: "oversized primary",
            createdAt: "2026-05-01T00:00:00.000Z",
            updatedAt: "2026-05-01T00:01:00.000Z",
            capturedAt: "2026-05-01T00:01:00.000Z",
            source: { projectId, sessionId: "session-frozen" },
            frozenSession: oversizedSession,
            viewerSnapshots: {
              "viewer-small": {
                capturedAt: "2026-05-01T00:02:00.000Z",
                frozenSession: smallSession,
              },
            },
          },
          {
            version: 1,
            secretHash: createHash("sha512")
              .update(liveSecret, "utf8")
              .digest("base64url"),
            mode: "live",
            title: "oversized viewer",
            createdAt: "2026-05-01T00:00:00.000Z",
            updatedAt: "2026-05-01T00:01:00.000Z",
            source: { projectId, sessionId: "session-live" },
            viewerSnapshots: {
              "viewer-large": {
                capturedAt: "2026-05-01T00:02:00.000Z",
                frozenSession: oversizedSession,
              },
              "viewer-small": {
                capturedAt: "2026-05-01T00:03:00.000Z",
                frozenSession: smallSession,
              },
            },
          },
        ],
      }),
      "utf8",
    );

    const migrated = new PublicShareStore(migrationDir, {
      legacySessionMaxBytes,
    });
    await migrated.initialize();
    const frozenGrant = migrated.getGrantBySecretHash(
      secretHash(frozenSecret),
    )!;
    const liveGrant = migrated.getGrantBySecretHash(secretHash(liveSecret))!;

    expect(frozenGrant).toMatchObject({
      mode: "frozen",
      primaryAvailability: "repair-required",
      snapshotBytes: oversizedSessionBytes,
    });
    expect(frozenGrant.revisionId).toBeUndefined();
    expect(frozenGrant.linkedFileMode).toBeUndefined();
    expect(frozenGrant.viewerSnapshots?.["viewer-small"]).toMatchObject({
      availability: "available",
      snapshotBytes: smallSessionBytes,
    });
    expect(
      frozenGrant.viewerSnapshots?.["viewer-small"]?.revisionId,
    ).toBeDefined();

    expect(liveGrant.primaryAvailability).toBeUndefined();
    expect(liveGrant.viewerSnapshots?.["viewer-large"]).toEqual({
      capturedAt: "2026-05-01T00:02:00.000Z",
      snapshotBytes: oversizedSessionBytes,
      availability: "repair-required",
    });
    expect(liveGrant.viewerSnapshots?.["viewer-small"]).toMatchObject({
      availability: "available",
      snapshotBytes: smallSessionBytes,
    });
    expect(
      liveGrant.viewerSnapshots?.["viewer-small"]?.revisionId,
    ).toBeDefined();

    for (const grant of [frozenGrant, liveGrant]) {
      const revisions = await fs.readdir(
        path.join(
          migrationDir,
          "public-shares",
          "shares",
          grant.shareStateId,
          "frozen",
        ),
      );
      expect(revisions).toHaveLength(1);
    }

    const restarted = new PublicShareStore(migrationDir);
    await restarted.initialize();
    expect(
      restarted.getGrantBySecretHash(secretHash(frozenSecret)),
    ).toMatchObject({
      primaryAvailability: "repair-required",
      snapshotBytes: oversizedSessionBytes,
      viewerSnapshots: {
        "viewer-small": { availability: "available" },
      },
    });
    expect(
      restarted.getGrantBySecretHash(secretHash(liveSecret)),
    ).toMatchObject({
      viewerSnapshots: {
        "viewer-large": {
          availability: "repair-required",
          snapshotBytes: oversizedSessionBytes,
        },
        "viewer-small": { availability: "available" },
      },
    });
  });

  it("fails a malformed legacy migration without discarding its source", async () => {
    const migrationDir = path.join(testDir, "malformed-migration");
    await fs.mkdir(migrationDir);
    const legacyPath = path.join(migrationDir, "public-shares.json");
    await fs.writeFile(
      legacyPath,
      '{"shares":[{"version":1,"secretHash":"truncated"}',
      "utf8",
    );
    const migrated = new PublicShareService({ dataDir: migrationDir });

    await expect(migrated.initialize()).rejects.toThrow(
      /legacy|truncated|Invalid/i,
    );
    expect(migrated.getReadiness().state).toBe("failed");
    await expect(fs.stat(legacyPath)).resolves.toMatchObject({});
  });

  it.each([
    ["true literal", "truX"],
    ["null literal", "nulX"],
    ["number", "01"],
    ["string escape", '"bad\\q"'],
  ])(
    "rejects malformed ignored legacy %s without committing migration",
    async (_label, malformedValue) => {
      const migrationDir = path.join(
        testDir,
        `malformed-ignored-${String(_label).split(" ").join("-")}`,
      );
      await fs.mkdir(migrationDir);
      const legacyPath = path.join(migrationDir, "public-shares.json");
      const legacySecret = Buffer.alloc(64, 14).toString("base64url");
      const validRecord = {
        version: 1,
        secretHash: createHash("sha512")
          .update(legacySecret, "utf8")
          .digest("base64url"),
        mode: "live",
        title: "valid share",
        createdAt: "2026-05-01T00:00:00.000Z",
        updatedAt: "2026-05-01T00:01:00.000Z",
        source: { projectId, sessionId: "session-1" },
      };
      await fs.writeFile(
        legacyPath,
        `{"ignored":${malformedValue},"shares":[${JSON.stringify(validRecord)}]}`,
        "utf8",
      );
      const migrated = new PublicShareService({ dataDir: migrationDir });

      await expect(migrated.initialize()).rejects.toThrow(/invalid/i);
      expect(migrated.getReadiness().state).toBe("failed");
      await expect(fs.stat(legacyPath)).resolves.toMatchObject({});
      await expect(
        fs.stat(path.join(migrationDir, "public-shares.legacy-backup.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await expect(
        fs.stat(path.join(migrationDir, "public-shares", "migration.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("resumes a partially durable legacy migration without duplicate grants", async () => {
    const migrationDir = path.join(testDir, "resumed-migration");
    await fs.mkdir(migrationDir);
    const firstSecret = Buffer.alloc(64, 8).toString("base64url");
    const secondSecret = Buffer.alloc(64, 9).toString("base64url");
    const legacyRecord = (secret: string, title: string) => ({
      version: 1,
      secretHash: createHash("sha512")
        .update(secret, "utf8")
        .digest("base64url"),
      mode: "live",
      title,
      createdAt: "2026-05-01T00:00:00.000Z",
      updatedAt: "2026-05-01T00:01:00.000Z",
      source: {
        projectId,
        sessionId: "session-1",
        projectName: "project",
        provider: "codex",
      },
    });
    const legacyPath = path.join(migrationDir, "public-shares.json");
    await fs.writeFile(
      legacyPath,
      JSON.stringify({ shares: [legacyRecord(firstSecret, "first")] }),
      "utf8",
    );
    const firstPass = new PublicShareService({ dataDir: migrationDir });
    await firstPass.initialize();

    await fs.rm(path.join(migrationDir, "public-shares", "migration.json"));
    await fs.rename(
      path.join(migrationDir, "public-shares.legacy-backup.json"),
      legacyPath,
    );
    await fs.writeFile(
      legacyPath,
      JSON.stringify({
        shares: [
          legacyRecord(firstSecret, "first"),
          legacyRecord(secondSecret, "second"),
        ],
      }),
      "utf8",
    );

    const resumed = new PublicShareService({ dataDir: migrationDir });
    await resumed.initialize();
    expect(resumed.getValidShareCount()).toBe(2);
    expect(resumed.getRecordBySecret(firstSecret)?.title).toBe("first");
    expect(resumed.getRecordBySecret(secondSecret)?.title).toBe("second");
    const stateDirectories = await fs.readdir(
      path.join(migrationDir, "public-shares", "shares"),
    );
    expect(stateDirectories).toHaveLength(1);
  });

  it("keeps broken legacy frozen bodies explicitly unavailable", async () => {
    const migrationDir = path.join(testDir, "repair-migration");
    await fs.mkdir(migrationDir);
    const legacySecret = Buffer.alloc(64, 10).toString("base64url");
    await fs.writeFile(
      path.join(migrationDir, "public-shares.json"),
      JSON.stringify({
        shares: [
          {
            version: 1,
            secretHash: createHash("sha512")
              .update(legacySecret, "utf8")
              .digest("base64url"),
            mode: "frozen",
            title: "broken",
            createdAt: "2026-05-01T00:00:00.000Z",
            updatedAt: "2026-05-01T00:01:00.000Z",
            capturedAt: "2026-05-01T00:01:00.000Z",
            source: { projectId, sessionId: "session-1" },
            frozenSession: makeSession({ messageCount: 1, messages: [] }),
          },
        ],
      }),
      "utf8",
    );
    const migrated = new PublicShareService({ dataDir: migrationDir });
    await migrated.initialize();
    expect(migrated.getRecordBySecret(legacySecret)).toMatchObject({
      primaryAvailability: "repair-required",
      repairRequired: true,
    });
  });

  it("upgrades grant-wide repair flags by inspecting each gzip representation", async () => {
    const migrationDir = path.join(testDir, "repair-upgrade");
    await fs.mkdir(migrationDir);
    const legacySecret = Buffer.alloc(64, 12).toString("base64url");
    await fs.writeFile(
      path.join(migrationDir, "public-shares.json"),
      JSON.stringify({
        shares: [
          {
            version: 1,
            secretHash: createHash("sha512")
              .update(legacySecret, "utf8")
              .digest("base64url"),
            mode: "frozen",
            title: "scoped repair",
            createdAt: "2026-05-01T00:00:00.000Z",
            updatedAt: "2026-05-01T00:01:00.000Z",
            capturedAt: "2026-05-01T00:01:00.000Z",
            source: { projectId, sessionId: "session-1" },
            frozenSession: makeSession({ messageCount: 1, messages: [] }),
            viewerSnapshots: {
              "viewer-good": {
                capturedAt: "2026-05-01T00:02:00.000Z",
                frozenSession: makeSession(),
              },
            },
          },
        ],
      }),
      "utf8",
    );
    const migrated = new PublicShareService({ dataDir: migrationDir });
    await migrated.initialize();
    const scoped = migrated.getRecordBySecret(legacySecret)!;
    expect(scoped.primaryAvailability).toBe("repair-required");
    expect(scoped.viewerSnapshots?.["viewer-good"]?.availability).toBe(
      "available",
    );

    const grantsPath = path.join(migrationDir, "public-shares", "grants.json");
    const grantFile = JSON.parse(await fs.readFile(grantsPath, "utf8")) as {
      version: 2;
      grants: Array<Record<string, unknown>>;
    };
    for (const grant of grantFile.grants) {
      delete grant.primaryAvailability;
      grant.repairRequired = true;
      const snapshots = grant.viewerSnapshots as
        | Record<string, Record<string, unknown>>
        | undefined;
      for (const snapshot of Object.values(snapshots ?? {})) {
        delete snapshot.availability;
      }
    }
    await fs.writeFile(grantsPath, JSON.stringify(grantFile), "utf8");

    const upgraded = new PublicShareService({ dataDir: migrationDir });
    await upgraded.initialize();
    const record = upgraded.getRecordBySecret(legacySecret)!;
    expect(record.repairRequired).toBe(true);
    expect(record.primaryAvailability).toBe("repair-required");
    expect(record.viewerSnapshots?.["viewer-good"]?.availability).toBe(
      "available",
    );
    const persistedUpgrade = JSON.parse(
      await fs.readFile(grantsPath, "utf8"),
    ) as { grants: Array<{ repairRequired?: boolean }> };
    expect(persistedUpgrade.grants[0]?.repairRequired).toBe(true);

    await fs.writeFile(
      path.join(
        migrationDir,
        "public-shares",
        "shares",
        record.shareStateId,
        "frozen",
        record.revisionId!,
        "session.json.gz",
      ),
      "not gzip",
    );
    const secondStartup = new PublicShareService({ dataDir: migrationDir });
    await secondStartup.initialize();
    expect(secondStartup.getReadiness()).toEqual({
      state: "ready",
      error: null,
    });
    expect(secondStartup.getRecordBySecret(legacySecret)).toMatchObject({
      primaryAvailability: "repair-required",
      repairRequired: true,
    });
  });

  it("keeps a migrated live primary available when one viewer needs repair", async () => {
    const migrationDir = path.join(testDir, "live-viewer-repair-migration");
    await fs.mkdir(migrationDir);
    const legacySecret = Buffer.alloc(64, 13).toString("base64url");
    await fs.writeFile(
      path.join(migrationDir, "public-shares.json"),
      JSON.stringify({
        shares: [
          {
            version: 1,
            secretHash: createHash("sha512")
              .update(legacySecret, "utf8")
              .digest("base64url"),
            mode: "live",
            title: "live with broken viewer",
            createdAt: "2026-05-01T00:00:00.000Z",
            updatedAt: "2026-05-01T00:01:00.000Z",
            source: { projectId, sessionId: "session-1" },
            viewerSnapshots: {
              "viewer-broken": {
                capturedAt: "2026-05-01T00:02:00.000Z",
                frozenSession: makeSession({ messageCount: 1, messages: [] }),
              },
            },
          },
        ],
      }),
      "utf8",
    );

    const migrated = new PublicShareService({ dataDir: migrationDir });
    await migrated.initialize();
    const migratedRecord = migrated.getRecordBySecret(legacySecret)!;
    expect(migratedRecord).toMatchObject({
      mode: "live",
      repairRequired: true,
    });
    expect(migratedRecord.primaryAvailability).toBeUndefined();
    expect(
      migratedRecord.viewerSnapshots?.["viewer-broken"]?.availability,
    ).toBe("repair-required");
    expect(migrated.getSelectedRepresentationAvailability(migratedRecord)).toBe(
      "available",
    );
    expect(
      migrated.getSelectedRepresentationAvailability(
        migratedRecord,
        "viewer-broken",
      ),
    ).toBe("repair-required");

    const restarted = new PublicShareService({ dataDir: migrationDir });
    await restarted.initialize();
    const persistedRecord = restarted.getRecordBySecret(legacySecret)!;
    expect(persistedRecord.repairRequired).toBe(true);
    expect(
      restarted.getSelectedRepresentationAvailability(persistedRecord),
    ).toBe("available");
    expect(
      restarted.getSelectedRepresentationAvailability(
        persistedRecord,
        "viewer-broken",
      ),
    ).toBe("repair-required");
  });

  it("lets the kill switch win while legacy control state is opening", async () => {
    const migrationDir = path.join(testDir, "disabled-opening-migration");
    await fs.mkdir(migrationDir);
    const legacySecret = Buffer.alloc(64, 11).toString("base64url");
    await fs.writeFile(
      path.join(migrationDir, "public-shares.json"),
      JSON.stringify({
        shares: [
          {
            version: 1,
            secretHash: createHash("sha512")
              .update(legacySecret, "utf8")
              .digest("base64url"),
            mode: "live",
            title: "must stay revoked",
            createdAt: "2026-05-01T00:00:00.000Z",
            updatedAt: "2026-05-01T00:01:00.000Z",
            source: { projectId, sessionId: "session-1" },
          },
        ],
      }),
      "utf8",
    );
    const migrated = new PublicShareService({ dataDir: migrationDir });

    const opening = migrated.initialize();
    const disabling = migrated.disableAndRevoke();
    await Promise.all([opening, disabling]);

    expect(migrated.getReadiness().state).toBe("disabled");
    expect(migrated.getRecordBySecret(legacySecret)).toBeNull();
    await migrated.enable();
    expect(migrated.getRecordBySecret(legacySecret)).toBeNull();
    await expect(
      fs.stat(path.join(migrationDir, "public-shares.legacy-backup.json")),
    ).resolves.toMatchObject({});
  });

  it("reuses one state-local revision for identical frozen links", async () => {
    const source = {
      projectId,
      sessionId: "session-1",
      projectName: "project",
      provider: "codex" as const,
    };
    const first = await service.createShare({
      mode: "frozen",
      source,
      capture: await captureSession(service),
    });
    const second = await service.createShare({
      mode: "frozen",
      source,
      capture: await captureSession(service),
    });

    const stateDirectories = await fs.readdir(
      path.join(testDir, "public-shares", "shares"),
    );
    expect(stateDirectories).toHaveLength(1);
    const revisions = await fs.readdir(
      path.join(
        testDir,
        "public-shares",
        "shares",
        stateDirectories[0]!,
        "frozen",
      ),
    );
    expect(revisions).toHaveLength(1);
    const revisionPath = path.join(
      testDir,
      "public-shares",
      "shares",
      stateDirectories[0]!,
      "frozen",
      revisions[0]!,
      "session.json.gz",
    );

    await service.revokeShare(first.record.shareId);
    await expect(fs.stat(revisionPath)).resolves.toMatchObject({});
    await service.revokeShare(second.record.shareId);
    await expect(
      fs.stat(
        path.join(testDir, "public-shares", "shares", stateDirectories[0]!),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    "missing session",
    "symlink presentation",
    "invalid presentation",
    "wrong project kind",
  ])("rejects deduplicating a revision with %s", async (damage) => {
    if (damage === "symlink presentation" && process.platform === "win32") {
      return;
    }
    const source = { projectId, sessionId: `damaged-${damage}` };
    const first = await service.createShare({
      mode: "frozen",
      source,
      capture: await captureSession(service),
    });
    const revisionDirectory = path.join(
      testDir,
      "public-shares",
      "shares",
      first.record.shareStateId,
      "frozen",
      first.record.revisionId!,
    );
    if (damage === "missing session") {
      await fs.rm(path.join(revisionDirectory, "session.json.gz"));
    } else if (damage === "symlink presentation") {
      const presentationPath = path.join(
        revisionDirectory,
        "presentation.json",
      );
      await fs.rm(presentationPath);
      await fs.symlink(
        path.join(revisionDirectory, "session.json.gz"),
        presentationPath,
      );
    } else if (damage === "invalid presentation") {
      await fs.writeFile(
        path.join(revisionDirectory, "presentation.json"),
        JSON.stringify({ version: 1, authorizedPaths: [42] }),
      );
    } else {
      await fs.writeFile(
        path.join(revisionDirectory, "project"),
        "not a directory",
      );
    }

    await expect(
      service.createShare({
        mode: "frozen",
        source,
        capture: await captureSession(service),
      }),
    ).rejects.toThrow(
      /ENOENT|owner-only|symbolic link|not a directory|invalid public share/i,
    );
    expect(service.getValidShareCount()).toBe(1);
  });

  it("rejects same-size gzip corruption before deduplicated authority", async () => {
    const source = { projectId, sessionId: "same-size-corruption" };
    const first = await service.createShare({
      mode: "frozen",
      source,
      capture: await captureSession(service, makeRevisionSession("original")),
    });
    const sessionPath = path.join(
      testDir,
      "public-shares",
      "shares",
      first.record.shareStateId,
      "frozen",
      first.record.revisionId!,
      "session.json.gz",
    );
    const corrupted = await fs.readFile(sessionPath);
    corrupted[Math.floor(corrupted.length / 2)]! ^= 1;
    await fs.writeFile(sessionPath, corrupted);
    expect((await fs.stat(sessionPath)).size).toBe(corrupted.length);

    await expect(
      service.createShare({
        mode: "frozen",
        source,
        capture: await captureSession(service, makeRevisionSession("original")),
      }),
    ).rejects.toThrow();
    expect(service.getValidShareCount()).toBe(1);
  });

  it("rejects an over-limit compressed revision before decompression", async () => {
    const created = await service.createShare({
      mode: "frozen",
      source: { projectId, sessionId: "oversized-compressed-revision" },
      capture: await captureSession(service),
    });
    const store = new PublicShareStore(testDir);
    await store.initialize();
    const grant = store.getAllGrants()[0]!;
    const sessionPath = path.join(
      store.getRevisionDirectory(grant, created.record.revisionId!),
      "session.json.gz",
    );
    await fs.truncate(
      sessionPath,
      PUBLIC_SHARE_SESSION_COMPRESSED_MAX_BYTES + 1,
    );

    await expect(
      store.getRevisionSessionStream(grant, created.record.revisionId!),
    ).rejects.toThrow(/transfer limit/i);
  });

  it("meters revision decoding against its persisted byte count", async () => {
    const created = await service.createShare({
      mode: "frozen",
      source: { projectId, sessionId: "revision-byte-count" },
      capture: await captureSession(
        service,
        makeRevisionSession("exact byte count"),
      ),
    });
    const store = new PublicShareStore(testDir);
    await store.initialize();
    const grant = store.getAllGrants()[0]!;
    const revisionId = created.record.revisionId!;
    await expect(
      store.readRevisionSession(grant, revisionId),
    ).resolves.toMatchObject({
      title: "Test session",
      messages: [{ message: { content: "exact byte count" } }],
    });

    const statePath = path.join(
      testDir,
      "public-shares",
      "shares",
      grant.shareStateId,
      "state.json",
    );
    const state = JSON.parse(await fs.readFile(statePath, "utf8")) as {
      revisions: Record<string, { snapshotBytes: number }>;
    };
    state.revisions[revisionId]!.snapshotBytes -= 1;
    await fs.writeFile(statePath, JSON.stringify(state), "utf8");

    await expect(store.readRevisionSession(grant, revisionId)).rejects.toThrow(
      /size mismatch/i,
    );
  });

  it.skipIf(process.platform === "win32")(
    "remediates a deduplicated revision before granting new authority",
    async () => {
      const source = { projectId, sessionId: "unsafe-revision-mode" };
      const first = await service.createShare({
        mode: "frozen",
        source,
        capture: await captureSession(service),
      });
      const revisionDirectory = path.join(
        testDir,
        "public-shares",
        "shares",
        first.record.shareStateId,
        "frozen",
        first.record.revisionId!,
      );
      const sessionPath = path.join(revisionDirectory, "session.json.gz");
      const presentationPath = path.join(
        revisionDirectory,
        "presentation.json",
      );
      await fs.chmod(revisionDirectory, 0o777);
      await fs.chmod(sessionPath, 0o666);
      await fs.chmod(presentationPath, 0o666);

      await expect(
        service.createShare({
          mode: "frozen",
          source,
          capture: await captureSession(service),
        }),
      ).resolves.toMatchObject({ secretBits: 128 });
      expect((await fs.lstat(revisionDirectory)).mode & 0o777).toBe(0o700);
      expect((await fs.lstat(sessionPath)).mode & 0o777).toBe(0o600);
      expect((await fs.lstat(presentationPath)).mode & 0o777).toBe(0o600);
    },
  );

  it("freezes project files only when the filesystem supports CoW", async () => {
    const projectRoot = path.join(testDir, "project");
    const outsideRoot = path.join(testDir, "outside");
    await fs.mkdir(projectRoot);
    await fs.mkdir(outsideRoot);
    await fs.writeFile(path.join(projectRoot, "note.txt"), "before", "utf8");
    await fs.writeFile(path.join(outsideRoot, "secret.txt"), "outside", "utf8");
    await fs.symlink(
      path.join(outsideRoot, "secret.txt"),
      path.join(projectRoot, "external-link.txt"),
    );
    const { secret } = await service.createShare({
      mode: "frozen",
      source: {
        projectId,
        sessionId: "session-1",
        projectName: "project",
        provider: "codex",
      },
      capture: {
        ...(await captureSession(service)),
        projectRoot,
      },
    });
    const record = service.getRecordBySecret(secret)!;

    if (record.linkedFileMode === "cow") {
      const frozenProjectRoot = await service.getFrozenProjectRoot(record);
      await fs.writeFile(path.join(projectRoot, "note.txt"), "after", "utf8");
      await expect(
        fs.readFile(path.join(frozenProjectRoot!, "note.txt"), "utf8"),
      ).resolves.toBe("before");
      await expect(
        fs.lstat(path.join(frozenProjectRoot!, "external-link.txt")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } else {
      expect(record.linkedFileMode).toBe("live");
    }
  });

  it.each(["file", "directory"] as const)(
    "rejects a project %s swapped to a symlink during CoW capture",
    async (entryKind) => {
      if (process.platform !== "linux") return;
      const projectRoot = path.join(testDir, `project-${entryKind}-swap`);
      const outsideRoot = path.join(testDir, `outside-${entryKind}-swap`);
      const entryName = entryKind === "file" ? "report.md" : "assets";
      const sourcePath = path.join(projectRoot, entryName);
      const outsidePath = path.join(outsideRoot, entryName);
      await fs.mkdir(projectRoot);
      await fs.mkdir(outsideRoot);
      if (entryKind === "file") {
        await fs.writeFile(sourcePath, "project bytes", "utf8");
        await fs.writeFile(outsidePath, "outside secret", "utf8");
      } else {
        await fs.mkdir(sourcePath);
        await fs.mkdir(outsidePath);
        await fs.writeFile(
          path.join(sourcePath, "safe.txt"),
          "project bytes",
          "utf8",
        );
        await fs.writeFile(
          path.join(outsidePath, "secret.txt"),
          "outside secret",
          "utf8",
        );
      }

      let swapped = false;
      const raceStore = new PublicShareStore(
        path.join(testDir, `race-store-${entryKind}`),
        {
          beforeCowEntryOpen: async (candidatePath) => {
            if (candidatePath !== sourcePath || swapped) return;
            swapped = true;
            await fs.rename(sourcePath, `${sourcePath}.original`);
            await fs.symlink(
              outsidePath,
              sourcePath,
              entryKind === "directory" ? "dir" : "file",
            );
          },
        },
      );
      await raceStore.initialize();
      const capture = await captureSession(
        service,
        makeRevisionSession(`See ${entryName}`),
      );

      await expect(
        raceStore.createGrant({
          secretHash: secretHash(`cow-${entryKind}-swap`),
          mode: "frozen",
          title: null,
          initialPrompt: null,
          source: { projectId, sessionId: "session-1" },
          capture: {
            ...capture,
            projectRoot,
            presentation: { version: 1, authorizedPaths: [entryName] },
          },
        }),
      ).rejects.toThrow(/ELOOP|symbolic link|too many symbolic links/i);
      expect(swapped).toBe(true);
      expect(raceStore.getAllGrants()).toEqual([]);
    },
  );

  it("derives viewer file authority from the completed project clone", async () => {
    const projectRoot = path.join(testDir, "project-presentation");
    await fs.mkdir(projectRoot);
    await fs.writeFile(
      path.join(projectRoot, "report.md"),
      "![secret](secret.png)\n",
      "utf8",
    );
    await fs.writeFile(path.join(projectRoot, "secret.png"), "secret", "utf8");
    await fs.writeFile(
      path.join(projectRoot, "current.png"),
      "current",
      "utf8",
    );
    const source = { projectId, sessionId: "session-1" };
    const { secret } = await service.createShare({ mode: "live", source });
    const capture = await captureSession(
      service,
      makeRevisionSession("See report.md"),
    );

    await fs.writeFile(
      path.join(projectRoot, "report.md"),
      "![current](current.png)\n",
      "utf8",
    );
    await service.freezeSessionViewerToken(
      projectId,
      "session-1",
      "viewer-clone",
      {
        ...capture,
        projectRoot,
        presentation: { version: 1, authorizedPaths: ["report.md"] },
        derivePresentationFromProjectRoot: async (capturedProjectRoot) => {
          const report = await fs.readFile(
            path.join(capturedProjectRoot, "report.md"),
            "utf8",
          );
          return {
            version: 1,
            authorizedPaths: [
              "report.md",
              ...(report.includes("current.png") ? ["current.png"] : []),
              ...(report.includes("secret.png") ? ["secret.png"] : []),
            ].sort(),
          };
        },
      },
    );
    const record = service.getRecordBySecret(secret)!;
    const viewer = record.viewerSnapshots?.["viewer-clone"];

    if (viewer?.linkedFileMode === "cow") {
      const capturedProjectRoot = await service.getFrozenProjectRoot(
        record,
        "viewer-clone",
      );
      await expect(
        fs.readFile(path.join(capturedProjectRoot!, "report.md"), "utf8"),
      ).resolves.toBe("![current](current.png)\n");
      await expect(
        fs.readFile(path.join(capturedProjectRoot!, "secret.png"), "utf8"),
      ).resolves.toBe("secret");
      await expect(
        service.getFrozenPresentation(record, "viewer-clone"),
      ).resolves.toEqual({
        version: 1,
        authorizedPaths: ["current.png", "report.md"],
      });
    } else {
      expect(viewer?.linkedFileMode).toBe("live");
      await expect(
        service.getFrozenPresentation(record, "viewer-clone"),
      ).resolves.toEqual({
        version: 1,
        authorizedPaths: ["report.md"],
      });
    }
  });

  it("does not reuse an older project snapshot for an unchanged transcript", async () => {
    const projectRoot = path.join(testDir, "project-revisions");
    await fs.mkdir(projectRoot);
    await fs.writeFile(path.join(projectRoot, "note.txt"), "first", "utf8");
    const source = {
      projectId,
      sessionId: "session-1",
      projectName: "project",
      provider: "codex" as const,
    };
    const first = await service.createShare({
      mode: "frozen",
      source,
      capture: {
        ...(await captureSession(service)),
        projectRoot,
      },
    });

    await fs.writeFile(path.join(projectRoot, "note.txt"), "second", "utf8");
    const second = await service.createShare({
      mode: "frozen",
      source,
      capture: {
        ...(await captureSession(service)),
        projectRoot,
      },
    });

    expect(second.record.revisionId).not.toBe(first.record.revisionId);
    const state = JSON.parse(
      await fs.readFile(
        path.join(
          testDir,
          "public-shares",
          "shares",
          first.record.shareStateId,
          "state.json",
        ),
        "utf8",
      ),
    ) as {
      revisions: Record<string, { integrityWitness?: string }>;
    };
    const firstWitness =
      state.revisions[first.record.revisionId!]?.integrityWitness;
    expect(firstWitness).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(state.revisions[second.record.revisionId!]?.integrityWitness).toBe(
      firstWitness,
    );
    if (
      first.record.linkedFileMode === "cow" &&
      second.record.linkedFileMode === "cow"
    ) {
      const firstProjectRoot = await service.getFrozenProjectRoot(first.record);
      const secondProjectRoot = await service.getFrozenProjectRoot(
        second.record,
      );
      await expect(
        fs.readFile(path.join(firstProjectRoot!, "note.txt"), "utf8"),
      ).resolves.toBe("first");
      await expect(
        fs.readFile(path.join(secondProjectRoot!, "note.txt"), "utf8"),
      ).resolves.toBe("second");
    }
  });

  it("adopts a complete revision left before its state commit", async () => {
    const source = {
      projectId,
      sessionId: "session-1",
      projectName: "project",
      provider: "codex" as const,
    };
    await service.createShare({ mode: "live", source });
    await service.createShare({
      mode: "frozen",
      source,
      capture: await captureSession(service),
    });

    const grantsPath = path.join(testDir, "public-shares", "grants.json");
    const grantFile = JSON.parse(await fs.readFile(grantsPath, "utf8")) as {
      version: number;
      grants: Array<{
        mode: string;
        shareStateId: string;
        revisionId?: string;
      }>;
    };
    const liveGrant = grantFile.grants.find((grant) => grant.mode === "live")!;
    const frozenGrant = grantFile.grants.find(
      (grant) => grant.mode === "frozen",
    )!;
    const statePath = path.join(
      testDir,
      "public-shares",
      "shares",
      liveGrant.shareStateId,
      "state.json",
    );
    const state = JSON.parse(await fs.readFile(statePath, "utf8")) as {
      revisions: Record<string, unknown>;
    };
    await fs.writeFile(
      grantsPath,
      JSON.stringify({ version: 2, grants: [liveGrant] }),
      "utf8",
    );
    await fs.writeFile(
      statePath,
      JSON.stringify({ ...state, revisions: {} }),
      "utf8",
    );

    const recovered = new PublicShareService({ dataDir: testDir });
    await recovered.initialize();
    await expect(
      recovered.createShare({
        mode: "frozen",
        source,
        capture: await captureSession(recovered),
      }),
    ).resolves.toMatchObject({ secretBits: 128 });
    const recoveredState = JSON.parse(await fs.readFile(statePath, "utf8")) as {
      revisions: Record<string, { integrityWitness?: string }>;
    };
    expect(Object.keys(recoveredState.revisions)).toEqual([
      frozenGrant.revisionId,
    ]);
    expect(
      recoveredState.revisions[frozenGrant.revisionId!]?.integrityWitness,
    ).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("rejects body-only orphan adoption with an extraneous project clone", async () => {
    const source = {
      projectId,
      sessionId: "orphan-with-project",
    };
    await service.createShare({ mode: "live", source });
    const orphan = await service.createShare({
      mode: "frozen",
      source,
      capture: await captureSession(
        service,
        makeRevisionSession("body-only orphan"),
      ),
    });
    const root = path.join(testDir, "public-shares");
    const grantsPath = path.join(root, "grants.json");
    const grantFile = JSON.parse(await fs.readFile(grantsPath, "utf8")) as {
      version: 2;
      grants: Array<{ shareId: string }>;
    };
    grantFile.grants = grantFile.grants.filter(
      (grant) => grant.shareId !== orphan.record.shareId,
    );
    await fs.writeFile(grantsPath, JSON.stringify(grantFile), "utf8");
    const statePath = path.join(
      root,
      "shares",
      orphan.record.shareStateId,
      "state.json",
    );
    const state = JSON.parse(await fs.readFile(statePath, "utf8")) as {
      revisions: Record<string, unknown>;
    };
    delete state.revisions[orphan.record.revisionId!];
    await fs.writeFile(statePath, JSON.stringify(state), "utf8");
    await fs.mkdir(
      path.join(
        root,
        "shares",
        orphan.record.shareStateId,
        "frozen",
        orphan.record.revisionId!,
        "project",
      ),
      { mode: 0o700 },
    );

    const recovered = new PublicShareService({ dataDir: testDir });
    await recovered.initialize();
    await expect(
      recovered.createShare({
        mode: "frozen",
        source,
        capture: await captureSession(
          recovered,
          makeRevisionSession("body-only orphan"),
        ),
      }),
    ).rejects.toThrow(/unexpected project clone/i);
    expect(recovered.getValidShareCount()).toBe(1);
  });

  it.each(["session body", "presentation"])(
    "rejects substituted orphan %s before adoption",
    async (damage) => {
      const source = {
        projectId,
        sessionId: `substituted-orphan-${damage}`,
      };
      await service.createShare({ mode: "live", source });
      const orphan = await service.createShare({
        mode: "frozen",
        source,
        capture: await captureSession(
          service,
          makeRevisionSession("expected orphan body"),
        ),
      });
      const substitute = await service.createShare({
        mode: "frozen",
        source: { projectId, sessionId: `substitute-${damage}` },
        capture: await captureSession(
          service,
          makeRevisionSession("substitute orphan body"),
        ),
      });
      const root = path.join(testDir, "public-shares");
      const grantsPath = path.join(root, "grants.json");
      const grantFile = JSON.parse(await fs.readFile(grantsPath, "utf8")) as {
        version: 2;
        grants: Array<{ shareId: string }>;
      };
      grantFile.grants = grantFile.grants.filter(
        (grant) => grant.shareId !== orphan.record.shareId,
      );
      await fs.writeFile(grantsPath, JSON.stringify(grantFile), "utf8");

      const statePath = path.join(
        root,
        "shares",
        orphan.record.shareStateId,
        "state.json",
      );
      const state = JSON.parse(await fs.readFile(statePath, "utf8")) as {
        revisions: Record<string, unknown>;
      };
      delete state.revisions[orphan.record.revisionId!];
      await fs.writeFile(statePath, JSON.stringify(state), "utf8");
      const orphanDirectory = path.join(
        root,
        "shares",
        orphan.record.shareStateId,
        "frozen",
        orphan.record.revisionId!,
      );
      if (damage === "session body") {
        await fs.copyFile(
          path.join(
            root,
            "shares",
            substitute.record.shareStateId,
            "frozen",
            substitute.record.revisionId!,
            "session.json.gz",
          ),
          path.join(orphanDirectory, "session.json.gz"),
        );
      } else {
        await fs.writeFile(
          path.join(orphanDirectory, "presentation.json"),
          JSON.stringify({ version: 1, authorizedPaths: ["substitute.md"] }),
          "utf8",
        );
      }

      const recovered = new PublicShareService({ dataDir: testDir });
      await recovered.initialize();
      await expect(
        recovered.createShare({
          mode: "frozen",
          source,
          capture: await captureSession(
            recovered,
            makeRevisionSession("expected orphan body"),
          ),
        }),
      ).rejects.toThrow(/content verification/i);
      expect(recovered.getValidShareCount()).toBe(2);
    },
  );

  it("collects crash-orphaned revisions and temporary directories from disk", async () => {
    const source = {
      projectId,
      sessionId: "cleanup-crash-session",
      projectName: "project",
      provider: "codex" as const,
    };
    await service.createShare({ mode: "live", source });
    const orphaned = await service.createShare({
      mode: "frozen",
      source,
      capture: await captureSession(
        service,
        makeSession({ title: "orphaned revision" }),
      ),
    });
    const retained = await service.createShare({
      mode: "frozen",
      source,
      capture: await captureSession(
        service,
        makeSession({ title: "retained revision" }),
      ),
    });
    const root = path.join(testDir, "public-shares");
    const grantsPath = path.join(root, "grants.json");
    const grantFile = JSON.parse(await fs.readFile(grantsPath, "utf8")) as {
      version: 2;
      grants: Array<{ shareId: string }>;
    };
    grantFile.grants = grantFile.grants.filter(
      (grant) => grant.shareId !== orphaned.record.shareId,
    );
    await fs.writeFile(grantsPath, JSON.stringify(grantFile), "utf8");

    const statePath = path.join(
      root,
      "shares",
      retained.record.shareStateId,
      "state.json",
    );
    const state = JSON.parse(await fs.readFile(statePath, "utf8")) as {
      revisions: Record<string, unknown>;
    };
    delete state.revisions[orphaned.record.revisionId!];
    await fs.writeFile(statePath, JSON.stringify(state), "utf8");
    await fs.writeFile(
      path.join(root, "cleanup.json"),
      JSON.stringify({
        version: 1,
        shareStateIds: [retained.record.shareStateId],
      }),
      "utf8",
    );
    const frozenRoot = path.join(
      root,
      "shares",
      retained.record.shareStateId,
      "frozen",
    );
    const temporaryDirectory = path.join(frozenRoot, ".tmp-crash-leftover");
    await fs.mkdir(temporaryDirectory);
    await fs.writeFile(path.join(temporaryDirectory, "partial"), "partial");

    const recovered = new PublicShareService({ dataDir: testDir });
    await recovered.initialize();

    expect(recovered.getValidShareCount()).toBe(2);
    await expect(
      fs.stat(path.join(frozenRoot, orphaned.record.revisionId!)),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(temporaryDirectory)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      fs.stat(path.join(frozenRoot, retained.record.revisionId!)),
    ).resolves.toMatchObject({});
    const recoveredState = JSON.parse(await fs.readFile(statePath, "utf8")) as {
      revisions: Record<string, unknown>;
    };
    expect(Object.keys(recoveredState.revisions)).toEqual([
      retained.record.revisionId,
    ]);
  });

  it.skipIf(cowDescriptorRoot() === null)(
    "aborts a frozen share when project capture fails unexpectedly",
    async () => {
      await expect(
        service.createShare({
          mode: "frozen",
          source: {
            projectId,
            sessionId: "session-1",
            projectName: "project",
            provider: "codex",
          },
          capture: {
            ...(await captureSession(service)),
            projectRoot: path.join(testDir, "missing-project"),
          },
        }),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect(service.getValidShareCount()).toBe(0);
      await expect(
        fs.readdir(path.join(testDir, "public-shares", "shares")),
      ).resolves.toEqual([]);
      await expect(
        fs.readFile(
          path.join(testDir, "public-shares", "cleanup.json"),
          "utf8",
        ),
      ).resolves.toContain('"shareStateIds": []');
    },
  );

  it.each([
    ["beforeAtomicRename", false],
    ["afterAtomicRename", true],
  ] as const)(
    "mirrors cleanup journal memory after a %s failure",
    async (hookName, committed) => {
      let failCleanupWrite = false;
      const store = new PublicShareStore(testDir, {
        [hookName]: (filePath: string) => {
          if (
            failCleanupWrite &&
            filePath === path.join(testDir, "public-shares", "cleanup.json")
          ) {
            throw new Error("injected cleanup journal failure");
          }
        },
      });
      await store.initialize();
      await store.createGrant({
        secretHash: secretHash(`journal-${hookName}`),
        mode: "live",
        title: null,
        initialPrompt: null,
        source: { projectId, sessionId: "journal-session" },
      });

      failCleanupWrite = true;
      await expect(store.revokeMatching(() => true)).rejects.toThrow(
        /private JSON/,
      );
      expect(store.isCleanupPending()).toBe(committed);
      const persisted = JSON.parse(
        await fs.readFile(
          path.join(testDir, "public-shares", "cleanup.json"),
          "utf8",
        ),
      ) as { shareStateIds: string[] };
      expect(persisted.shareStateIds.length > 0).toBe(committed);
    },
  );

  it.each([
    ["beforeAtomicRename", true],
    ["afterAtomicRename", false],
  ] as const)(
    "mirrors cleanup journal removal after a %s failure",
    async (hookName, cleanupPending) => {
      let cleanupWrites = 0;
      let injectFailure = false;
      const cleanupPath = path.join(testDir, "public-shares", "cleanup.json");
      const store = new PublicShareStore(testDir, {
        [hookName]: (filePath: string) => {
          if (injectFailure && filePath === cleanupPath) {
            cleanupWrites += 1;
            if (cleanupWrites === 2) {
              throw new Error("injected cleanup journal removal failure");
            }
          }
        },
      });
      await store.initialize();
      await store.createGrant({
        secretHash: secretHash(`journal-removal-${hookName}`),
        mode: "live",
        title: null,
        initialPrompt: null,
        source: { projectId, sessionId: "journal-removal-session" },
      });

      injectFailure = true;
      await expect(store.revokeMatching(() => true)).resolves.toHaveLength(1);
      expect(store.isCleanupPending()).toBe(cleanupPending);
      const persisted = JSON.parse(await fs.readFile(cleanupPath, "utf8")) as {
        shareStateIds: string[];
      };
      expect(persisted.shareStateIds.length > 0).toBe(cleanupPending);
    },
  );

  it("does not resurrect grants after disable and re-enable", async () => {
    const { secret } = await service.createShare({
      mode: "live",
      source: {
        projectId,
        sessionId: "session-1",
        projectName: "project",
        provider: "codex",
      },
    });

    await expect(service.disableAndRevoke()).resolves.toBe(1);
    expect(service.getReadiness().state).toBe("disabled");
    expect(service.getRecordBySecret(secret)).toBeNull();

    await service.enable();
    expect(service.getReadiness().state).toBe("ready");
    expect(service.getRecordBySecret(secret)).toBeNull();
  });

  it("finishes disable before a newer enable reaches ready", async () => {
    const { secret } = await service.createShare({
      mode: "live",
      source: { projectId, sessionId: "session-1" },
    });
    const restarted = new PublicShareService({ dataDir: testDir });

    const disabling = restarted.initialize(false);
    const enabling = restarted.enable();
    await Promise.all([disabling, enabling]);

    expect(restarted.getReadiness()).toEqual({ state: "ready", error: null });
    expect(restarted.getRecordBySecret(secret)).toBeNull();
    await expect(
      fs.readFile(
        path.join(testDir, "public-shares", "migration.json"),
        "utf8",
      ),
    ).resolves.toContain('"status": "complete"');
  });

  it("replays a failed disable before a later enable reaches ready", async () => {
    const { secret } = await service.createShare({
      mode: "live",
      source: { projectId, sessionId: "session-1" },
    });
    const migrationPath = path.join(testDir, "public-shares", "migration.json");
    await fs.rm(migrationPath);
    await fs.mkdir(migrationPath);

    await expect(service.disableAndRevoke()).rejects.toThrow(
      /commit private JSON/,
    );
    expect(service.getRecordBySecret(secret)).not.toBeNull();

    await fs.rmdir(migrationPath);
    await service.enable();

    expect(service.getReadiness()).toEqual({ state: "ready", error: null });
    expect(service.getRecordBySecret(secret)).toBeNull();
    await expect(fs.readFile(migrationPath, "utf8")).resolves.toContain(
      '"status": "complete"',
    );
  });

  it("lets a newer disable supersede an enable request", async () => {
    const { secret } = await service.createShare({
      mode: "live",
      source: { projectId, sessionId: "session-1" },
    });

    const enabling = service.enable();
    const disabling = service.disableAndRevoke();
    await Promise.all([enabling, disabling]);

    expect(service.getReadiness()).toEqual({ state: "disabled", error: null });
    expect(service.getRecordBySecret(secret)).toBeNull();
  });

  it.skipIf(process.platform === "win32")(
    "resumes interrupted disable cleanup in a new service before re-enable",
    async () => {
      const { secret, record } = await service.createShare({
        mode: "frozen",
        source: { projectId, sessionId: "session-1" },
        capture: await captureSession(service),
      });
      const sharesRoot = path.join(testDir, "public-shares", "shares");
      await fs.chmod(sharesRoot, 0o500);
      try {
        await expect(service.disableAndRevoke()).resolves.toBe(1);
        expect(service.getRecordBySecret(secret)).toBeNull();
        expect(service.isCleanupPending()).toBe(true);
      } finally {
        await fs.chmod(sharesRoot, 0o700);
      }

      const restarted = new PublicShareService({ dataDir: testDir });
      await restarted.initialize(true);

      expect(restarted.getReadiness()).toEqual({ state: "ready", error: null });
      expect(restarted.isCleanupPending()).toBe(false);
      expect(restarted.getRecordBySecret(secret)).toBeNull();
      await expect(
        fs.stat(
          path.join(testDir, "public-shares", "shares", record.shareStateId),
        ),
      ).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("stores frozen shares as sanitized read-only snapshots", async () => {
    const session = makeSession({
      messages: [
        {
          type: "user",
          uuid: "message-1",
          message: { role: "user", content: "hello" },
          timestamp: "2026-05-01T00:00:00.000Z",
        },
      ] as AppSession["messages"],
    }) as AppSession & {
      heartbeatTurnText?: string;
      heartbeatTurnsAfterMinutes?: number;
      heartbeatTurnsEnabled?: boolean;
    };
    session.heartbeatTurnsEnabled = true;
    session.heartbeatTurnsAfterMinutes = 5;
    session.heartbeatTurnText = "heartbeat";

    const { secret } = await service.createShare({
      mode: "frozen",
      title: "Frozen",
      source: {
        projectId,
        sessionId: "session-1",
        projectName: "project",
        provider: "codex",
      },
      capture: await captureSession(service, session),
    });

    const share = await service.getFrozenShareBySecret(secret);
    expect(share?.share.mode).toBe("frozen");
    expect(share?.session.ownership).toEqual({ owner: "none" });
    expect(share?.session.messages).toHaveLength(1);
    expect(share?.session.pendingInputType).toBeUndefined();
    expect(share?.session.activity).toBeUndefined();
    expect(share?.session.lastSeenAt).toBeUndefined();
    expect(share?.session.hasUnread).toBeUndefined();
    expect(
      (share?.session as typeof session | undefined)?.heartbeatTurnsEnabled,
    ).toBeUndefined();
  });

  it("strips transcript display objects from frozen and live shares", async () => {
    const session = makeSession({
      transcriptDisplayObjects: [
        {
          id: "bang-1",
          kind: "bang-command",
          createdAt: "2026-05-01T00:00:30.000Z",
          placementAfterMessageId: "",
          command: "cat .env",
          cwd: "/private/project",
          status: "done",
          exitCode: 0,
          stdoutPreview: "SECRET=value",
        },
      ],
    });
    const frozen = await service.createShare({
      mode: "frozen",
      source: {
        projectId,
        sessionId: "session-1",
        projectName: "project",
        provider: "codex",
      },
      capture: await captureSession(service, session),
    });
    const live = await service.createShare({
      mode: "live",
      source: {
        projectId,
        sessionId: "session-1",
        projectName: "project",
        provider: "codex",
      },
    });

    expect(
      (await service.getFrozenShareBySecret(frozen.secret))?.session
        .transcriptDisplayObjects,
    ).toBeUndefined();
    expect(
      service.buildLiveResponse(
        service.getRecordBySecret(live.secret)!,
        session,
      ).session.transcriptDisplayObjects,
    ).toBeUndefined();
  });

  it("builds live responses from the current session", async () => {
    const { secret } = await service.createShare({
      mode: "live",
      title: "Live",
      source: {
        projectId,
        sessionId: "session-1",
        projectName: "project",
        provider: "codex",
      },
    });
    const record = service.getRecordBySecret(secret);

    expect(record).not.toHaveProperty("revisionId");
    const response = service.buildLiveResponse(
      record!,
      makeSession({ updatedAt: "2026-05-01T00:02:00.000Z" }),
    );

    expect(response.share.mode).toBe("live");
    expect(response.share.updatedAt).toBe("2026-05-01T00:02:00.000Z");
    expect(response.session.ownership).toEqual({ owner: "none" });
  });

  it("summarizes and revokes all shares for a source session", async () => {
    await service.createShare({
      mode: "frozen",
      title: "Frozen",
      source: {
        projectId,
        sessionId: "session-1",
        projectName: "project",
        provider: "codex",
      },
      capture: await captureSession(service),
    });
    await service.createShare({
      mode: "live",
      title: "Live",
      source: {
        projectId,
        sessionId: "session-1",
        projectName: "project",
        provider: "codex",
      },
    });
    await service.createShare({
      mode: "live",
      title: "Other",
      source: {
        projectId,
        sessionId: "session-2",
        projectName: "project",
        provider: "codex",
      },
    });

    expect(service.getSessionShareStatus(projectId, "session-1")).toEqual({
      activeCount: 2,
      frozenCount: 1,
      liveCount: 1,
      activeViewerCount: 0,
      viewers: [],
    });

    await expect(
      service.revokeSessionShares(projectId, "session-1"),
    ).resolves.toEqual({
      activeCount: 0,
      frozenCount: 0,
      liveCount: 0,
      activeViewerCount: 0,
      viewers: [],
      revokedCount: 2,
    });
    expect(service.getSessionShareStatus(projectId, "session-2")).toEqual({
      activeCount: 1,
      frozenCount: 0,
      liveCount: 1,
      activeViewerCount: 0,
      viewers: [],
    });
  });

  it("publishes no frozen grant when the source changes before authority", async () => {
    await expect(
      service.createShare({
        mode: "frozen",
        title: "Must not publish",
        source: { projectId, sessionId: "changed-create" },
        capture: await captureChangingSession(service),
      }),
    ).rejects.toMatchObject({ code: "source-changed", retryable: true });

    expect(service.getValidShareCount()).toBe(0);
    await expect(
      fs.readdir(path.join(testDir, "public-shares", "shares")),
    ).resolves.toEqual([]);
    await expect(
      fs.readFile(path.join(testDir, "public-shares", "cleanup.json"), "utf8"),
    ).resolves.toContain('"shareStateIds": []');
  });

  it("publishes the requested prefix when later turns complete before authority", async () => {
    const { secret } = await service.createShare({
      mode: "frozen",
      title: "Point-in-time prefix",
      source: { projectId, sessionId: "growing-create" },
      capture: await captureGrowingSession(service),
    });

    const stored = await service.getFrozenShareBySecret(secret);
    expect(stored?.session.messages).toHaveLength(1);
    expect(stored?.session.messages[0]?.uuid).toBe("stable-message-id");
  });

  it("keeps live grants unchanged and collects the failed whole-freeze revision", async () => {
    const { secret, record: original } = await service.createShare({
      mode: "live",
      title: "Still live",
      source: { projectId, sessionId: "changed-whole-freeze" },
    });

    await expect(
      service.freezeSessionLiveShares(
        projectId,
        "changed-whole-freeze",
        await captureChangingSession(service),
      ),
    ).rejects.toMatchObject({ code: "source-changed", retryable: true });

    expect(service.getRecordBySecret(secret)).toEqual(original);
    await expect(
      fs.readdir(
        path.join(
          testDir,
          "public-shares",
          "shares",
          original.shareStateId,
          "frozen",
        ),
      ),
    ).resolves.toEqual([]);
    await expect(
      fs.readFile(path.join(testDir, "public-shares", "cleanup.json"), "utf8"),
    ).resolves.toContain('"shareStateIds": []');
  });

  it("keeps viewer authority unchanged when its source verification fails", async () => {
    const { secret, record: original } = await service.createShare({
      mode: "live",
      title: "Still live for viewer",
      source: { projectId, sessionId: "changed-viewer-freeze" },
    });

    await expect(
      service.freezeSessionViewerToken(
        projectId,
        "changed-viewer-freeze",
        "viewer-stays-live",
        await captureChangingSession(service),
      ),
    ).rejects.toMatchObject({ code: "source-changed", retryable: true });

    expect(service.getRecordBySecret(secret)).toEqual(original);
    expect(original.viewerSnapshots).toBeUndefined();
    await expect(
      fs.readdir(
        path.join(
          testDir,
          "public-shares",
          "shares",
          original.shareStateId,
          "frozen",
        ),
      ),
    ).resolves.toEqual([]);
  });

  it("freezes live shares as snapshots without changing their secrets", async () => {
    const { secret } = await service.createShare({
      mode: "live",
      title: "Live",
      source: {
        projectId,
        sessionId: "session-1",
        projectName: "project",
        provider: "codex",
      },
    });

    await expect(
      service.freezeSessionLiveShares(
        projectId,
        "session-1",
        await captureSession(
          service,
          makeSession({ updatedAt: "2026-05-01T00:03:00.000Z" }),
        ),
      ),
    ).resolves.toMatchObject({
      activeCount: 1,
      frozenCount: 1,
      liveCount: 0,
      convertedCount: 1,
    });

    const response = await service.getFrozenShareBySecret(secret);
    expect(response?.share.mode).toBe("frozen");
    expect(response?.session.updatedAt).toBe("2026-05-01T00:03:00.000Z");
  });

  it("freezes and disconnects individual viewer tokens", async () => {
    const { secret } = await service.createShare({
      mode: "live",
      title: "Live",
      source: {
        projectId,
        sessionId: "session-1",
        projectName: "project",
        provider: "codex",
      },
    });
    const record = service.getRecordBySecret(secret);
    expect(record).not.toBeNull();
    service.recordViewerHeartbeat(record!, "viewer-one");

    await service.freezeSessionViewerToken(
      projectId,
      "session-1",
      "viewer-one",
      await captureSession(
        service,
        makeSession({ updatedAt: "2026-05-01T00:04:00.000Z" }),
      ),
    );
    const frozenRecord = service.getRecordBySecret(secret);
    expect(
      (await service.getViewerSnapshotResponse(frozenRecord!, "viewer-one"))
        ?.session.updatedAt,
    ).toBe("2026-05-01T00:04:00.000Z");
    expect(
      service.getSessionShareStatus(projectId, "session-1").viewers,
    ).toEqual([]);

    const firstViewerRevision =
      frozenRecord?.viewerSnapshots?.["viewer-one"]?.revisionId;
    expect(firstViewerRevision).toBeTruthy();
    await service.freezeSessionViewerToken(
      projectId,
      "session-1",
      "viewer-one",
      await captureSession(
        service,
        makeSession({ updatedAt: "2026-05-01T00:05:00.000Z" }),
      ),
    );
    const refrozenRecord = service.getRecordBySecret(secret)!;
    expect(refrozenRecord.viewerSnapshots?.["viewer-one"]?.revisionId).not.toBe(
      firstViewerRevision,
    );
    await expect(
      fs.stat(
        path.join(
          testDir,
          "public-shares",
          "shares",
          refrozenRecord.shareStateId,
          "frozen",
          firstViewerRevision!,
        ),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });

    await service.disconnectSessionViewerToken(
      projectId,
      "session-1",
      "viewer-one",
    );
    const disconnectedRecord = service.getRecordBySecret(secret);
    expect(
      service.isViewerDisconnected(disconnectedRecord!, "viewer-one"),
    ).toBe(true);
    expect(
      await service.getViewerSnapshotResponse(
        disconnectedRecord!,
        "viewer-one",
      ),
    ).toBeNull();
  });

  it("counts active viewers by share secret", async () => {
    const first = await service.createShare({
      mode: "live",
      title: "Live",
      source: {
        projectId,
        sessionId: "session-1",
        projectName: "project",
        provider: "codex",
      },
    });
    const second = await service.createShare({
      mode: "frozen",
      title: "Frozen",
      source: {
        projectId,
        sessionId: "session-1",
        projectName: "project",
        provider: "codex",
      },
      capture: await captureSession(service),
    });

    const firstRecord = service.getRecordBySecret(first.secret);
    const secondRecord = service.getRecordBySecret(second.secret);
    expect(firstRecord).not.toBeNull();
    expect(secondRecord).not.toBeNull();

    expect(service.recordViewerHeartbeat(firstRecord!, "viewer-one")).toBe(1);
    expect(service.recordViewerHeartbeat(firstRecord!, "viewer-two")).toBe(2);
    expect(service.recordViewerHeartbeat(firstRecord!, "bad id")).toBe(2);
    expect(service.recordViewerHeartbeat(secondRecord!, "viewer-three")).toBe(
      1,
    );

    expect(
      service.buildLiveResponse(firstRecord!, makeSession()).share
        .activeViewerCount,
    ).toBe(2);
    expect(service.getSessionShareStatus(projectId, "session-1")).toMatchObject(
      {
        activeViewerCount: 3,
      },
    );
  });

  it("bounds viewer telemetry and evicts the least recently seen identity", async () => {
    const { secret } = await service.createShare({
      mode: "live",
      title: "Bounded viewers",
      source: {
        projectId,
        sessionId: "session-1",
        projectName: "project",
        provider: "codex",
      },
    });
    const record = service.getRecordBySecret(secret)!;

    for (
      let index = 0;
      index <= PUBLIC_SHARE_VIEWER_TELEMETRY_MAX_ENTRIES;
      index += 1
    ) {
      service.recordViewerHeartbeat(
        record,
        `viewer-${index.toString().padStart(8, "0")}`,
      );
    }

    const status = service.getSessionShareStatus(projectId, "session-1");
    expect(status.activeViewerCount).toBe(
      PUBLIC_SHARE_VIEWER_TELEMETRY_MAX_ENTRIES,
    );
    expect(status.viewers).toHaveLength(
      PUBLIC_SHARE_VIEWER_TELEMETRY_MAX_ENTRIES,
    );
    expect(
      status.viewers.some((viewer) => viewer.viewerId === "viewer-00000000"),
    ).toBe(false);
    expect(
      status.viewers.some((viewer) => viewer.viewerId === "viewer-00004096"),
    ).toBe(true);
  });

  it("expires telemetry in recency order while retaining refreshed viewers", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-05-01T00:00:00.000Z"));
      const { secret } = await service.createShare({
        mode: "live",
        title: "Aging viewers",
        source: {
          projectId,
          sessionId: "session-1",
          projectName: "project",
          provider: "codex",
        },
      });
      const record = service.getRecordBySecret(secret)!;
      service.recordViewerHeartbeat(record, "viewer-old");
      service.recordViewerHeartbeat(record, "viewer-refreshed");

      vi.setSystemTime(new Date("2026-05-01T00:01:59.000Z"));
      service.recordViewerHeartbeat(record, "viewer-refreshed");
      vi.setSystemTime(new Date("2026-05-01T00:02:01.000Z"));
      service.recordViewerHeartbeat(record, "viewer-new");

      expect(
        service.getSessionShareStatus(projectId, "session-1"),
      ).toMatchObject({
        activeViewerCount: 2,
        viewers: [
          { viewerId: "viewer-new", accessCount: 1 },
          { viewerId: "viewer-refreshed", accessCount: 2 },
        ],
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps viewers active until they miss a session update grace period", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-05-01T00:00:00.000Z"));
      const { secret } = await service.createShare({
        mode: "live",
        title: "Live",
        source: {
          projectId,
          sessionId: "session-1",
          projectName: "project",
          provider: "codex",
        },
      });
      const record = service.getRecordBySecret(secret);
      expect(record).not.toBeNull();
      service.recordViewerHeartbeat(record!, "viewer-one");

      vi.setSystemTime(new Date("2026-05-01T00:01:00.000Z"));
      expect(
        service.getSessionShareStatus(projectId, "session-1").activeViewerCount,
      ).toBe(1);
      expect(
        service.getSessionShareStatus(projectId, "session-1", {
          sessionUpdatedAt: "2026-05-01T00:00:40.000Z",
        }).activeViewerCount,
      ).toBe(1);
      expect(
        service.getSessionShareStatus(projectId, "session-1", {
          sessionUpdatedAt: "2026-05-01T00:00:20.000Z",
        }).activeViewerCount,
      ).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
