import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ApiAttachmentUploads } from "../../src/core-api/attachment-uploads.js";
import { AttachmentStagingService } from "../../src/uploads/AttachmentStagingService.js";
import { runIdleSweeps } from "../../src/lib/processIdleSweep.js";
import type { ApiCreator } from "../../src/core-api/command-contracts.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

const creator: ApiCreator = {
  principal: { kind: "superuser" },
  serverId: "target",
  sessionId: "caller",
  launchId: "launch",
};

const data = Buffer.from("two chunks for one staged file");
const metadata = {
  name: "notes.partial",
  mimeType: "text/plain",
  size: data.length,
  sha256: createHash("sha256").update(data).digest("hex"),
};

it("publishes verified reusable bytes, recovers the upload key after restart, and expires its scoped handle", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ya-v0-files-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  let now = Date.now();
  const makeUploads = () => {
    const uploads = new ApiAttachmentUploads(directory, 1024, () => now);
    cleanup.push(async () => {
      uploads.close();
      await uploads.idle();
    });
    return uploads;
  };
  let uploads = makeUploads();
  const key = "upload-one-file";
  const send = (offset: number, bytes: Buffer) =>
    uploads.upload(
      creator,
      "project-a",
      key,
      offset,
      {
        ...metadata,
        data: bytes.toString("base64"),
      },
      () => {},
    );
  await expect(send(5, data.subarray(5))).rejects.toMatchObject({
    code: "attachment_offset",
  });
  const part = await send(0, data.subarray(0, 5));
  expect(part).toMatchObject({ attachmentId: null, nextOffset: 5 });
  expect(await send(0, data.subarray(0, 5))).toEqual(part);
  await expect(send(0, Buffer.from("other"))).rejects.toMatchObject({
    code: "request_id_conflict",
  });
  const complete = await send(5, data.subarray(5));
  const id = complete.attachmentId!;
  expect(id).toMatch(/^[a-f0-9-]{36}$/);
  expect(await send(5, data.subarray(5))).toEqual(complete);

  uploads.close();
  await uploads.idle();
  uploads = makeUploads();
  expect(await send(5, data.subarray(5))).toEqual(complete);
  await expect(send(5, Buffer.alloc(data.length - 5))).rejects.toMatchObject({
    code: "request_id_conflict",
  });
  const [file] = await uploads.resolve(creator, "project-a", [id]);
  expect(await readFile(file!.path)).toEqual(data);
  await expect(
    uploads.resolve(creator, "project-b", [id]),
  ).rejects.toMatchObject({
    code: "attachment_not_found",
  });
  await expect(
    uploads.resolve({ ...creator, sessionId: "other" }, "project-a", [id]),
  ).rejects.toMatchObject({ code: "attachment_not_found" });
  now = Date.parse(complete.expiresAt) + 1;
  await expect(
    uploads.resolve(creator, "project-a", [id]),
  ).rejects.toMatchObject({
    code: "attachment_not_found",
  });
  runIdleSweeps(now);
  await uploads.idle();
  expect(await readdir(join(directory, "uploads/v0-staging/drafts"))).toEqual(
    [],
  );
});

it("discards bad digests and a transfer revoked during publication", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ya-v0-files-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const uploads = new ApiAttachmentUploads(directory);
  cleanup.push(async () => {
    uploads.close();
    await uploads.idle();
  });
  const chunk = { ...metadata, data: data.toString("base64") };
  await expect(
    uploads.upload(
      creator,
      "p",
      "upload-corrupt",
      0,
      {
        ...chunk,
        sha256: "0".repeat(64),
      },
      () => {},
    ),
  ).rejects.toThrow("checksum");
  let checks = 0;
  await expect(
    uploads.upload(creator, "p", "upload-revoked", 0, chunk, () => {
      if (++checks === 5) throw new Error("revoked");
    }),
  ).rejects.toThrow("revoked");
  expect(await readdir(join(directory, "uploads/v0-staging/drafts"))).toEqual(
    [],
  );
  const result = await uploads.upload(
    creator,
    "p",
    "upload-revoked",
    0,
    chunk,
    () => {},
  );
  expect(result.attachmentId).toEqual(expect.any(String));
});

it("retains acknowledged bytes when the response connection aborts during a chunk", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ya-v0-files-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const uploads = new ApiAttachmentUploads(directory);
  cleanup.push(async () => {
    uploads.close();
    await uploads.idle();
  });
  const request = new AbortController();
  const write = AttachmentStagingService.prototype.writeChunk;
  const interrupted = vi
    .spyOn(AttachmentStagingService.prototype, "writeChunk")
    .mockImplementationOnce(async function (
      this: AttachmentStagingService,
      ...args
    ) {
      const result = await write.apply(this, args);
      request.abort();
      return result;
    });
  const chunk = (bytes: Buffer) => ({
    ...metadata,
    data: bytes.toString("base64"),
  });
  const first = chunk(data.subarray(0, 5));
  const authorize = () => {};
  try {
    await uploads.upload(
      creator,
      "p",
      "connection-lost",
      0,
      first,
      authorize,
      request.signal,
    );
  } finally {
    interrupted.mockRestore();
  }
  expect(request.signal.aborted).toBe(true);
  expect(
    await uploads.upload(creator, "p", "connection-lost", 0, first, authorize),
  ).toMatchObject({ attachmentId: null, nextOffset: 5 });
  const complete = await uploads.upload(
    creator,
    "p",
    "connection-lost",
    5,
    chunk(data.subarray(5)),
    authorize,
  );
  expect(complete.attachmentId).toEqual(expect.any(String));
});

it("bounds uploads per peer credential across its attributed sessions and projects", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ya-v0-files-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const uploads = new ApiAttachmentUploads(directory);
  cleanup.push(async () => {
    uploads.close();
    await uploads.idle();
  });
  const peer: ApiCreator = {
    ...creator,
    principal: { kind: "peer" },
    authentication: {
      credentialId: "peer-credential",
      sessionAttribution: "source-attested",
    },
  };
  const partial = { ...metadata, size: 64 * 1024 * 1024, data: "AQ==" };
  const start = (scope: ApiCreator, project: string, key: string) =>
    uploads.upload(scope, project, key, 0, partial, () => {});
  await start(peer, "p", "capacity-001");
  await start({ ...peer, sessionId: "second" }, "other", "capacity-002");
  await expect(
    start({ ...peer, sessionId: "third" }, "p", "capacity-003"),
  ).rejects.toMatchObject({ code: "command_capacity" });
  expect(await start(creator, "p", "capacity-004")).toMatchObject({
    attachmentId: null,
    nextOffset: 1,
  });
});
