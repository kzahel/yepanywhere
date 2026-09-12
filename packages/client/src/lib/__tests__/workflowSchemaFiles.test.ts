import { waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assistant,
  call,
  publishSchema,
  result,
} from "../../../test-fixtures/workflow";
import { buildSessionDetailRenderItems } from "../sessionDetail/renderItems";
import {
  readWorkflowSchema,
  workflowSchemaReference,
} from "@yep-anywhere/shared/transcript/workflowTags";
import {
  WORKFLOW_SCHEMA_TTL_MS,
  WorkflowSchemaFileStore,
} from "../workflowSchemaFiles";

const reference = "~/schemas/publish [v1].json#ya-publish/1";
const content = JSON.stringify(publishSchema);

function response(text = content, etag = 'W/"generation-1"'): Response {
  return new Response(text, { headers: { ETag: etag } });
}

describe("workflow schema file resolution", () => {
  afterEach(() => vi.restoreAllMocks());
  it.each(["assistant", "tool"])(
    "resolves a file-only %s announcement without changing source text",
    async (source) => {
      const announcement = `@@visualization-schema/1 ${reference}`;
      const messages = [
        ...(source === "tool"
          ? [call("schema"), result("schema", announcement)]
          : [assistant("schema", announcement)]),
        assistant(
          "start",
          "[workflow][start] id=example schema=ya-publish/1\n[publish][client] Prepare.",
        ),
      ];
      const original = JSON.stringify(messages);
      const read = vi.fn(async () => response());
      const store = new WorkflowSchemaFileStore(read, source, null);
      const compile = () =>
        buildSessionDetailRenderItems({
          messages,
          workflowTagsEnabled: true,
          workflowSchemaFiles: store.getSnapshot(),
        });
      const before = compile();
      expect(before[0]?.workflow?.markers[0]).toMatchObject({
        kind: "unresolved",
        schemaRef: reference,
      });
      store.request([reference, reference]);
      await waitFor(() => expect(store.getSnapshot()[reference]).toBe(content));
      const after = compile();
      expect(read).toHaveBeenCalledOnce();
      expect(read).toHaveBeenCalledWith(
        "~/schemas/publish [v1].json",
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      expect(after[0]?.workflow?.markers[0]?.kind).toBe("activation");
      expect(after.at(-1)?.workflow?.markers.at(-1)?.title).toBe(
        "Publish YA › Publish the hosted client",
      );
      expect(JSON.stringify(messages)).toBe(original);
      expect(original).not.toContain('"type":"tagged-stages/1"');
      store.dispose();
    },
  );

  it("accepts raw JSON and selects an exact declaration from a document", () => {
    const second = { ...publishSchema, id: "other/1", title: "Other" };
    const document = `# Schemas\n\`\`\`json\n${JSON.stringify(second)}\n\`\`\`\n\n\`\`\`json\n${content}\n\`\`\`\n`;
    expect(readWorkflowSchema(document, reference)?.title).toBe("Publish YA");
    expect(readWorkflowSchema(content, reference)?.title).toBe("Publish YA");
    expect(readWorkflowSchema(document, "/schemas.md")).toBeUndefined();
    expect(
      readWorkflowSchema(content, "/schemas.json#other/1"),
    ).toBeUndefined();
  });

  it.each([
    ["C:\\schemas\\publish.json#v1", "C:\\schemas\\publish.json"],
    ["\\\\host\\share\\schema.md#v1", "\\\\host\\share\\schema.md"],
    ["~/schemas/publish.md#v1", "~/schemas/publish.md"],
    ["/schemas/publish [v1].json", "/schemas/publish [v1].json"],
  ])("preserves the server's path syntax for %s", (operand, path) => {
    expect(workflowSchemaReference(operand)?.path).toBe(path);
  });

  it("never requests inline lists, unbased paths, or web URLs", () => {
    const read = vi.fn();
    const store = new WorkflowSchemaFileStore(read, "invalid", null);
    store.request(['["build"]', "schema.json", "https://example.com/schema"]);
    expect(read).not.toHaveBeenCalled();
    expect(store.getSnapshot()).toEqual({});
  });

  it("reuses a fresh cache after reload and isolates source/session keys", async () => {
    const storage = window.sessionStorage;
    const read = vi.fn(async () => response());
    const first = new WorkflowSchemaFileStore(
      read,
      "snapshot:source-a:session-a",
      storage,
    );
    first.request([reference]);
    await waitFor(() => expect(first.getSnapshot()[reference]).toBe(content));
    first.dispose();
    const reloaded = new WorkflowSchemaFileStore(
      read,
      "snapshot:source-a:session-a",
      storage,
    );
    reloaded.request([reference]);
    expect(reloaded.getSnapshot()[reference]).toBe(content);
    expect(read).toHaveBeenCalledOnce();
    const other = new WorkflowSchemaFileStore(
      read,
      "snapshot:source-b:session-a",
      storage,
    );
    other.request([reference]);
    await waitFor(() => expect(other.getSnapshot()[reference]).toBe(content));
    expect(read).toHaveBeenCalledTimes(2);
    reloaded.dispose();
    other.dispose();
    storage.clear();
  });

  it.each([
    { name: "missing", value: new Error("File not found") },
    { name: "denied", value: new Error("Invalid file path") },
    { name: "malformed", value: response("invalid json") },
    { name: "partial", value: new Response(content, { status: 206 }) },
    { name: "oversize", value: response(content + " ".repeat(1024 * 1024)) },
    { name: "uncached 304", value: new Response(null, { status: 304 }) },
    {
      name: "wrong id",
      value: response(JSON.stringify({ ...publishSchema, id: "wrong" })),
    },
  ])("keeps $name files unresolved without retry loops", async ({ value }) => {
    const read = vi.fn(async () => {
      if (value instanceof Error) throw value;
      return value;
    });
    const store = new WorkflowSchemaFileStore(read, "failures", null);
    store.request([reference]);
    await waitFor(() => expect(store.getSnapshot()[reference]).toBeNull());
    store.request([reference]);
    expect(read).toHaveBeenCalledOnce();
    store.dispose();
  });

  it("cancels pending reads and discards their late answers on disposal", async () => {
    let finish!: (value: Response) => void;
    const read = vi.fn(
      (_path: string, _init: RequestInit) =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
    const store = new WorkflowSchemaFileStore(read, "cancel", null);
    store.request([reference, "/another.json"]);
    store.dispose();
    expect(read.mock.calls[0]?.[1].signal?.aborted).toBe(true);
    finish(response());
    await Promise.resolve();
    expect(store.getSnapshot()).toEqual({});
    expect(read).toHaveBeenCalledOnce();
  });

  it("revalidates at five minutes, keeps 304 content, and adopts a new generation", async () => {
    let now = 1000000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const updated = JSON.stringify({
      ...publishSchema,
      title: "Updated publish",
    });
    const read = vi
      .fn()
      .mockResolvedValueOnce(response())
      .mockResolvedValueOnce(new Response(null, { status: 304 }))
      .mockResolvedValueOnce(response(updated, 'W/"generation-2"'));
    const store = new WorkflowSchemaFileStore(read, "ttl", null);
    store.request([reference]);
    await waitFor(() => expect(store.getSnapshot()[reference]).toBe(content));
    const snapshot = store.getSnapshot();
    now += WORKFLOW_SCHEMA_TTL_MS - 1;
    store.request([reference]);
    expect(read).toHaveBeenCalledOnce();
    now++;
    store.request([reference]);
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    expect(read.mock.calls[1]?.[1].headers).toEqual({
      "If-None-Match": 'W/"generation-1"',
    });
    expect(store.getSnapshot()).toBe(snapshot);
    now += WORKFLOW_SCHEMA_TTL_MS - 1;
    store.request([reference]);
    expect(read).toHaveBeenCalledTimes(2);
    now++;
    store.request([reference]);
    await waitFor(() => expect(store.getSnapshot()[reference]).toBe(updated));
    expect(read.mock.calls[2]?.[1].headers).toEqual({
      "If-None-Match": 'W/"generation-1"',
    });
    store.dispose();
  });

  it("sends a persisted validator when the first use after reload is expired", async () => {
    const read = vi.fn(async () => new Response(null, { status: 304 }));
    window.sessionStorage.setItem(
      `expired:${reference}`,
      JSON.stringify({
        content,
        checkedAt: Date.now() - WORKFLOW_SCHEMA_TTL_MS,
        etag: 'W/"persisted"',
      }),
    );
    const store = new WorkflowSchemaFileStore(
      read,
      "expired",
      window.sessionStorage,
    );
    store.request([reference]);
    await waitFor(() => expect(store.getSnapshot()[reference]).toBe(content));
    expect(read.mock.calls[0]).toEqual([
      "~/schemas/publish [v1].json",
      expect.objectContaining({
        headers: { "If-None-Match": 'W/"persisted"' },
      }),
    ]);
    store.dispose();
    window.sessionStorage.clear();
  });

  it("expires failed reads and drops formerly cached content after access is denied", async () => {
    let now = 1000000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const read = vi
      .fn()
      .mockResolvedValueOnce(response())
      .mockRejectedValueOnce(new Error("Denied"))
      .mockResolvedValueOnce(response());
    const store = new WorkflowSchemaFileStore(
      read,
      "deny",
      window.sessionStorage,
    );
    store.request([reference]);
    await waitFor(() => expect(store.getSnapshot()[reference]).toBe(content));
    now += WORKFLOW_SCHEMA_TTL_MS;
    store.request([reference]);
    await waitFor(() => expect(store.getSnapshot()[reference]).toBeNull());
    expect(window.sessionStorage.getItem(`deny:${reference}`)).toBeNull();
    store.request([reference]);
    expect(read).toHaveBeenCalledTimes(2);
    now += WORKFLOW_SCHEMA_TTL_MS;
    store.request([reference]);
    await waitFor(() => expect(store.getSnapshot()[reference]).toBe(content));
    expect(read.mock.calls[2]?.[1].headers).toEqual({});
    store.dispose();
    window.sessionStorage.clear();
  });
});
