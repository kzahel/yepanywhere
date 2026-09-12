import { toolDisplayContracts } from "../../client/src/components/renderers/tools/toolDisplayContracts.js";
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as zlib from "node:zlib";
import { afterEach, expect, it, vi } from "vitest";
import {
  auditId,
  auditRows,
  safeShape,
  auditTranscript,
} from "../../../scripts/tool-display-audit.js";
import {
  discoverAuditFiles,
  parseAuditArgs,
  runAudit,
  runAuditWorker,
} from "../../../scripts/audit-tool-displays.js";
import type { ToolCallItem } from "@yep-anywhere/shared/transcript/items";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function directory() {
  const root = await mkdtemp(join(tmpdir(), "ya-tool-audit-"));
  roots.push(root);
  return root;
}
const id = "11111111-1111-7111-8111-111111111111";
const childId = "22222222-2222-7222-8222-222222222222";
const timestamp = "2026-09-10T00:00:00.000Z";
function entry(payload: unknown) {
  return { timestamp, type: "response_item", payload };
}
function meta(sessionId = id) {
  return {
    timestamp,
    type: "session_meta",
    payload: {
      id: sessionId,
      timestamp,
      cwd: "/private/project",
      originator: "codex_cli_rs",
      cli_version: "0.154.0",
    },
  };
}
function imagePair(callId: string, path: unknown = "/private/secret.png") {
  return [
    entry({
      type: "function_call",
      name: "view_image",
      call_id: callId,
      arguments: JSON.stringify({ path }),
    }),
    entry({
      type: "function_call_output",
      call_id: callId,
      output: [
        { type: "input_text", text: "CONFIDENTIAL" },
        { type: "input_image", image_url: "data:image/png;base64,YQ==" },
      ],
    }),
  ];
}
function jsonl(entries: unknown[]) {
  return `${entries.map((value) => JSON.stringify(value)).join("\n")}\n`;
}
function row(
  toolName: string,
  input: unknown,
  result: unknown,
  status: ToolCallItem["status"] = "complete",
): ToolCallItem {
  return {
    type: "tool_call",
    id: "private-call",
    sourceMessages: [],
    toolName,
    toolInput: input,
    status,
    ...(result === undefined
      ? {}
      : {
          toolResult: {
            content: "",
            structured: result,
            isError: status === "error",
          },
        }),
  };
}

it("separates successful, failed and unfinished fallback without leaking payloads", () => {
  const result = auditRows(
    [
      row("view_image", { path: 42 }, [
        { type: "input_image", image_url: "SECRET" },
      ]),
      row("Write", { content: "SECRET" }, "rejected SECRET", "error"),
      row("Read", {}, undefined, "incomplete"),
      row("Bash", { command: "SECRET" }, { stdout: "SECRET" }),
      row("private-secret-tool", {}, {}),
    ],
    { fileId: "hash", provider: "codex", version: "0.154.0" },
  );
  expect(result.counts).toEqual({
    toolRows: 5,
    registeredRows: 4,
    "successful-raw": 1,
    "error-raw": 1,
    "unfinished-raw": 1,
    rich: 1,
    unregisteredRows: 1,
  });
  expect(JSON.stringify(result)).not.toMatch(/SECRET|secret|private-call/);
  expect(result.groups[0]?.resultShape).toContain("input_image");
});

it("bounds structural examples and redacts arbitrary keys and type values", () => {
  const shape = safeShape({
    secretCustomer: "SECRET",
    type: "SECRET",
    content: Array.from({ length: 100 }, () => ({ text: "SECRET" })),
  });
  expect(shape).not.toMatch(/SECRET|secretCustomer/);
  expect(shape.length).toBeLessThan(200);
  const result = auditRows(
    Array.from({ length: 8 }, () => row("ViewImage", { path: "SECRET" }, [])),
    { fileId: "hash", provider: "codex", version: "unknown" },
  );
  expect(result.groups[0]?.count).toBe(8);
  expect(result.groups[0]?.examples).toHaveLength(3);
});

it("does not report supported aliases retained by display preparation", () => {
  const result = auditRows(
    [
      row("WriteStdin", { cellId: "SECRET", command: "SECRET" }, "done"),
      row("create_goal", { objective: "SECRET", tokenBudget: 100 }, "done"),
      row(
        "WriteStdin",
        { cell_id: "known", linked_command: "known", command: "alias" },
        "done",
      ),
    ],
    { fileId: "hash", provider: "codex", version: "unknown" },
  );
  expect(result.counts["projection-loss"]).toBeUndefined();
  expect(result.counts.rich).toBe(3);
  expect(result.groups).toEqual([]);
});

it("detects alias loss by comparing the successful checked projection", () => {
  // Simulate the pre-fix gate, which accepted these inputs and stripped aliases.
  vi.spyOn(toolDisplayContracts.WriteStdin.input, "safeParse").mockReturnValue({
    success: true,
    data: {},
  });
  vi.spyOn(toolDisplayContracts.create_goal.input, "safeParse").mockReturnValue(
    { success: true, data: {} },
  );
  const result = auditRows(
    [
      row("WriteStdin", { cellId: "SECRET", command: "SECRET" }, "done"),
      row("create_goal", { objective: "SECRET", tokenBudget: 100 }, "done"),
    ],
    { fileId: "hash", provider: "codex", version: "unknown" },
  );
  expect(result.counts["projection-loss"]).toBe(3);
  expect(result.groups.map((group) => group.reason)).toEqual([
    "cellId",
    "command/cmd",
    "tokenBudget",
  ]);
  expect(JSON.stringify(result)).not.toContain("SECRET");
});

it("discovers overlapping roots once and prefers plain over compressed twins", async () => {
  const root = await directory();
  const file = join(root, `rollout-${id}.jsonl`);
  await writeFile(file, jsonl([meta()]));
  await writeFile(`${file}.zst`, "not read when the plain twin exists");
  const result = await discoverAuditFiles([
    { provider: "codex", path: root },
    { provider: "codex", path: file },
  ]);
  expect(result.files.map((file) => file.path)).toEqual([await realpath(file)]);
  expect(result.duplicateRepresentations).toBe(1);
  expect(result.errors).toEqual([]);
});

it("uses full Codex history across compaction and keeps the source tree unchanged", async () => {
  const root = await directory();
  const path = join(root, `rollout-${id}.jsonl`);
  const contents = jsonl([
    meta(),
    ...imagePair("before"),
    { timestamp, type: "compacted", payload: { message: "summary" } },
    ...imagePair("after"),
  ]);
  await writeFile(path, contents);
  const result = await runAuditWorker(
    {
      file: { path, fileId: auditId(path), provider: "codex" },
      rolloutPaths: {},
    },
    20_000,
  );
  expect(result).not.toHaveProperty("failure");
  if ("failure" in result) throw new Error(result.failure);
  expect(result.entries).toBe(6);
  expect(result.counts.rich).toBe(2);
  expect(result.counts["successful-raw"]).toBeUndefined();
  expect(result.malformedLines).toBe(0);
  expect(JSON.stringify(result)).not.toMatch(
    /CONFIDENTIAL|private|secret\.png|data:image/,
  );
  expect(await readFile(path, "utf8")).toBe(contents);
  expect(await readdir(root)).toEqual([`rollout-${id}.jsonl`]);
}, 30_000);

it("resolves inherited Codex history and reports missing parents as failures", async () => {
  const root = await directory();
  const parentPath = join(root, `rollout-${id}.jsonl`);
  const parentMeta = meta();
  const parent = jsonl(
    [
      {
        ...parentMeta,
        payload: { ...parentMeta.payload, history_mode: "paginated" },
      },
      ...imagePair("inherited"),
    ].map((value, ordinal) => ({
      ...value,
      ordinal,
    })),
  );
  await writeFile(parentPath, parent);
  const path = join(root, `rollout-${childId}.jsonl`);
  const childMeta = meta(childId);
  await writeFile(
    path,
    jsonl([
      {
        ...childMeta,
        ordinal: 0,
        payload: {
          ...childMeta.payload,
          history_mode: "paginated",
          history_base: {
            thread_id: id,
            end_ordinal_exclusive: 3,
            end_byte_offset: Buffer.byteLength(parent),
          },
        },
      },
    ]),
  );
  const request = {
    file: { path, fileId: auditId(path), provider: "codex" as const },
    rolloutPaths: { [id]: parentPath },
  };
  const result = await auditTranscript(request);
  expect(result.referenceBacked).toBe(true);
  expect(result.counts.rich).toBe(1);
  expect(result.counts["successful-raw"]).toBeUndefined();
  await expect(
    auditTranscript({ ...request, rolloutPaths: {} }),
  ).rejects.toThrow();
});

it("reads Claude parent and subagent files through production parsing", async () => {
  const root = await directory();
  const subdir = join(root, "parent", "subagents");
  await mkdir(subdir, { recursive: true });
  const path = join(subdir, "agent-child.jsonl");
  await writeFile(
    path,
    jsonl([
      {
        type: "assistant",
        uuid: "a",
        parentUuid: null,
        timestamp,
        version: "2.1.258",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "w",
              name: "Write",
              input: { content: "SECRET" },
            },
          ],
        },
      },
      {
        type: "user",
        uuid: "b",
        parentUuid: "a",
        timestamp,
        toolUseResult: "rejected",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "w",
              content: "rejected",
              is_error: true,
            },
          ],
        },
      },
    ]),
  );
  const discovered = await discoverAuditFiles([
    { provider: "claude", path: root },
  ]);
  expect(discovered.files).toHaveLength(1);
  const result = await auditTranscript({
    file: discovered.files[0]!,
    rolloutPaths: {},
  });
  expect(result.version).toBe("2.1.258");
  expect(result.counts["error-raw"]).toBe(1);
});

it("writes a partial report for malformed records, limits, and missing roots", async () => {
  const root = await directory();
  const path = join(root, `rollout-${id}.jsonl`);
  await writeFile(path, `${jsonl([meta(), ...imagePair("one")])}{broken\n`);
  await writeFile(
    join(root, `rollout-${childId}.jsonl`),
    jsonl([meta(childId)]),
  );
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
  const output = join(root, "report.json");
  const options = parseAuditArgs([
    "--codex",
    root,
    "--codex",
    join(root, "missing"),
    "--limit",
    "1",
    "--output",
    output,
  ]);
  expect(await runAudit(options)).toBe(2);
  const report = JSON.parse(await readFile(output, "utf8"));
  expect(report.complete).toBe(false);
  expect(report.files[0].malformedLines).toBe(1);
  expect(report.discoveryErrors).toHaveLength(1);
  expect(report.selectedFiles).toBe(1);
  expect(report.discoveredFiles).toBe(2);
  expect(JSON.stringify(report)).not.toContain(root);
  await expect(runAudit(options)).rejects.toThrow("Output already exists");
}, 30_000);

it("returns a bounded worker timeout instead of hanging the scan", async () => {
  const result = await runAuditWorker(
    {
      file: { provider: "codex", path: "unused", fileId: "hash" },
      rolloutPaths: {},
    },
    1,
  );
  expect(result).toEqual({ fileId: "hash", failure: "timeout" });
});

it("reports findings through opt-in exit 1 and isolates unreadable files", async () => {
  const root = await directory();
  const path = join(root, `rollout-${id}.jsonl`);
  await writeFile(path, jsonl([meta(), ...imagePair("one", 42)]));
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
  const output = join(root, "report.json");
  const locations = join(root, "locations.json");
  expect(
    await runAudit(
      parseAuditArgs([
        "--codex",
        root,
        "--output",
        output,
        "--locations",
        locations,
        "--fail-on-findings",
      ]),
    ),
  ).toBe(1);
  const report = JSON.parse(await readFile(output, "utf8"));
  const mapping = JSON.parse(await readFile(locations, "utf8"));
  expect(report.complete).toBe(true);
  expect(mapping[report.files[0].fileId]).toBe(await realpath(path));
  expect(JSON.stringify(report)).not.toContain(root);
  const result = await runAuditWorker(
    {
      file: { provider: "codex", path: join(root, "missing"), fileId: "hash" },
      rolloutPaths: {},
    },
    20_000,
  );
  expect(result).toEqual({
    fileId: "hash",
    failure: "read-or-projection-failed",
  });
}, 30_000);

const compress = (
  zlib as typeof zlib & { zstdCompressSync?: (input: Buffer) => Buffer }
).zstdCompressSync;
it.skipIf(!compress)(
  "audits zstd rollouts without materializing decompressed files",
  async () => {
    const root = await directory();
    const path = join(root, `rollout-${id}.jsonl.zst`);
    await writeFile(
      path,
      compress!(Buffer.from(jsonl([meta(), ...imagePair("compressed")]))),
    );
    const result = await auditTranscript({
      file: { provider: "codex", path, fileId: "hash" },
      rolloutPaths: {},
    });
    expect(result.counts.rich).toBe(1);
    expect(result.counts["successful-raw"]).toBeUndefined();
    expect(await readdir(root)).toEqual([`rollout-${id}.jsonl.zst`]);
  },
);

it("rejects misspelled or missing options instead of silently auditing defaults", () => {
  expect(() => parseAuditArgs(["--codxe", "file"])).toThrow();
  expect(() => parseAuditArgs(["--codex"])).toThrow();
  expect(() => parseAuditArgs(["--limit", "0"])).toThrow();
  expect(
    parseAuditArgs(["--", "--codex", ".", "--timeout-seconds", "5"]).timeoutMs,
  ).toBe(5000);
});
