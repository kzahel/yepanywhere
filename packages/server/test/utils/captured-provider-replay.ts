import {
  mkdtemp,
  readFile,
  readdir,
  mkdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { toUrlProjectId } from "@yep-anywhere/shared";
import { z } from "zod";
import { ClaudeProvider } from "../../src/sdk/providers/claude.js";
import { CodexProvider } from "../../src/sdk/providers/codex.js";
import { ClaudeSessionReader } from "../../src/sessions/reader.js";
import { CodexSessionReader } from "../../src/sessions/codex-reader.js";
import {
  runPersistedPipeline,
  runStreamPipeline,
} from "./render-parity-harness.js";

export const captureRoot = fileURLToPath(
  new URL("../fixtures/captured/", import.meta.url),
);
const manifestSchema = z.object({
  provider: z.enum(["claude", "codex"]),
  sessionId: z.string().uuid(),
  projectPath: z.literal("/fixture/project"),
  provenance: z.literal("sanitized-real-capture"),
  capturedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  platform: z.string().min(1),
  yaCommit: z.string().regex(/^[0-9a-f]{40}$/),
  providerVersion: z.string().min(1),
  sdkVersion: z.string().nullable(),
  model: z.string().min(1),
  effort: z.string().min(1),
  seam: z.string().min(1),
  requests: z.array(z.object({ message: z.string().min(1) })).min(1),
  captureScope: z.object({
    native: z.string().min(1),
    live: z.string().min(1),
    redactions: z.string().min(1),
    limitations: z.array(z.string()).min(1),
  }),
  nativeRecords: z.number().int().positive(),
  liveRecords: z.number().int().positive(),
  expected: z.object({
    userMessages: z.number().int(),
    finalTexts: z.array(z.string()),
    tools: z.array(
      z.object({
        name: z.string(),
        status: z.enum(["complete", "error"]),
        resultIncludes: z.object({
          native: z.string().min(1),
          live: z.string().min(1),
        }),
        display: z.object({
          native: z.enum(["rich", "partial"]),
          live: z.enum(["rich", "partial"]),
        }),
      }),
    ),
  }),
});

export async function discoverCaptures(root = captureRoot): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

export async function loadCapture(name: string, root = captureRoot) {
  const directory = join(root, name);
  const manifest = manifestSchema.parse(
    JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")),
  );
  const readRows = async (file: string, count: number) => {
    const text = await readFile(join(directory, file), "utf8");
    if (Buffer.byteLength(text) > 512_000)
      throw new Error(`${name}/${file}: capture exceeds size budget`);
    const rows = text
      .trim()
      .split("\n")
      .map((line) => z.record(z.string(), z.unknown()).parse(JSON.parse(line)));
    if (rows.length !== count)
      throw new Error(
        `${name}/${file}: expected ${count} records, got ${rows.length}`,
      );
    return rows;
  };
  const [native, live] = await Promise.all([
    readRows("native.jsonl", manifest.nativeRecords),
    readRows("live.jsonl", manifest.liveRecords),
  ]);
  return { manifest, native, live };
}
export type Capture = Awaited<ReturnType<typeof loadCapture>>;

/** Cold reads use only the declared recording, in disposable reader storage. */
export async function replayNative(capture: Capture) {
  const directory = await mkdtemp(join(tmpdir(), "ya-captured-reader-"));
  const { provider, sessionId, projectPath } = capture.manifest;
  const sessionsDir = join(directory, "sessions");
  const file =
    provider === "claude"
      ? join(sessionsDir, `${sessionId}.jsonl`)
      : join(
          sessionsDir,
          "2026",
          "09",
          "12",
          `rollout-2026-09-12T00-00-00-${sessionId}.jsonl`,
        );
  const reader =
    provider === "claude"
      ? new ClaudeSessionReader({ sessionDir: sessionsDir })
      : new CodexSessionReader({
          sessionsDir,
          dataDir: join(directory, "data"),
        });
  try {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(
      file,
      `${capture.native.map((row) => JSON.stringify(row)).join("\n")}\n`,
    );
    const session = await reader.getSession(
      sessionId,
      toUrlProjectId(projectPath),
    );
    if (!session)
      throw new Error(`Production reader did not load ${provider} capture`);
    return await runPersistedPipeline(session);
  } finally {
    await reader.close();
    await rm(directory, { recursive: true, force: true });
  }
}

/** Replay the actual adapter input, not an SDKMessage reconstructed from UI data.
 * This deliberately does not claim to exercise the provider RPC/session loop.
 */
export async function replayLive(capture: Capture, end = capture.live.length) {
  const rows = capture.live.slice(0, end);
  if (capture.manifest.provider === "claude") {
    const provider = new ClaudeProvider();
    return await runStreamPipeline(
      rows.map((row) =>
        // biome-ignore lint/complexity/useLiteralKeys: Exercise the private production conversion seam without making it public.
        provider["convertMessage"](
          row as Parameters<ClaudeProvider["convertMessage"]>[0],
        ),
      ),
    );
  }
  const provider = new CodexProvider();
  // biome-ignore lint/complexity/useLiteralKeys: Reuse the private production state initializer, not a reconstructed test state.
  const state = provider["createLiveEventState"]();
  const usage = new Map();
  return await runStreamPipeline(
    rows.flatMap((row) =>
      // biome-ignore lint/complexity/useLiteralKeys: Exercise the private production conversion seam without making it public.
      provider["convertNotificationToSDKMessages"](
        z
          .object({ method: z.string(), params: z.unknown().optional() })
          .parse(row),
        capture.manifest.sessionId,
        usage,
        state,
      ),
    ),
  );
}
