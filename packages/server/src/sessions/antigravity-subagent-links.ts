import * as fs from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import type { AntigravityUpdate } from "../sdk/providers/antigravity-runtime.js";
import { ANTIGRAVITY_SESSION_ID } from "./antigravity-metadata.js";
import {
  readLinesBackwardFromHandle,
  TRANSCRIPT_TAIL_POINT_BYTE_BUDGET,
} from "./transcript-tail.js";

export interface AntigravitySubagentCall {
  toolUseId: string;
  role?: string;
  typeName?: string;
  prompt?: string;
  completed?: boolean;
  failed?: boolean;
}

export interface AntigravitySubagentLaunch {
  childId: string;
  role?: string;
  typeName?: string;
  prompt?: string;
  stepIndex: number;
  /** Step index of the paired `PLANNER_RESPONSE` call, when present. */
  plannerStepIndex?: number;
  /** True when the GENERIC result step directly pairs with a PLANNER_RESPONSE `invoke_subagent` call. */
  pairedWithInvokeSubagent: boolean;
}

export function isAntigravityInvokeSubagent(
  update: Pick<AntigravityUpdate, "name" | "title">,
): boolean {
  return (
    update.name === "invoke_subagent" ||
    update.title === "Run invoke_subagent" ||
    update.title === "Running invoke_subagent"
  );
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

/** Unwrap JSON-quoted strings stored inside `agy`'s `transcript.jsonl` tool_calls.args. */
function decodeTranscriptArg(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  let decoded = value;
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (typeof parsed === "string") decoded = parsed;
    } catch {
      // Keep raw string if not valid JSON string literal.
    }
  }
  const trimmed = decoded.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Normalize Antigravity's `invoke_subagent` args (`Role`, `TypeName`, `Prompt`,
 * `Model`) to the shared `spawn_agent` display contract so existing web/mobile
 * clients render inline expansion and Open links with zero wire break.
 */
export function normalizeInvokeSubagentInput(
  rawInput: unknown,
): Record<string, unknown> {
  if (!rawInput || typeof rawInput !== "object" || Array.isArray(rawInput)) {
    return {};
  }
  const record = rawInput as Record<string, unknown>;
  const role =
    asNonEmptyString(record.Role) ?? asNonEmptyString(record.description);
  const typeName =
    asNonEmptyString(record.TypeName) ??
    asNonEmptyString(record.subagent_type) ??
    asNonEmptyString(record.role);
  const prompt =
    asNonEmptyString(record.Prompt) ?? asNonEmptyString(record.prompt);
  const model =
    asNonEmptyString(record.Model) ?? asNonEmptyString(record.model);
  const out: Record<string, unknown> = {};
  if (role) out.description = role;
  if (typeName) {
    out.subagent_type = typeName;
    out.role = typeName;
  }
  if (prompt) out.prompt = prompt;
  if (model && model !== "inherit") out.model = model;
  return out;
}

export function formatSpawnAgentResult(
  childId: string,
  nickname?: string,
): string {
  return JSON.stringify({
    agent_id: childId,
    ...(nickname ? { nickname } : {}),
  });
}

export function parseSpawnAgentResultId(content: unknown): string | undefined {
  let obj: Record<string, unknown> | undefined;
  if (typeof content === "string") {
    try {
      const parsed: unknown = JSON.parse(content);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        obj = parsed as Record<string, unknown>;
      }
    } catch {
      return undefined;
    }
  } else if (
    content &&
    typeof content === "object" &&
    !Array.isArray(content)
  ) {
    obj = content as Record<string, unknown>;
  }
  if (!obj) return undefined;
  const candidate =
    typeof obj.agent_id === "string"
      ? obj.agent_id
      : typeof obj.agentId === "string"
        ? obj.agentId
        : undefined;
  return candidate && ANTIGRAVITY_SESSION_ID.test(candidate)
    ? candidate
    : undefined;
}

/**
 * Extract the child UUID from an `agy` `invoke_subagent` result payload:
 * `Created the following subagent:\n{\n  "conversationId": "<uuid>", ...}`.
 */
export function extractCreatedSubagentId(text: unknown): string | undefined {
  if (typeof text !== "string") return undefined;
  const marker = "Created the following subagent:";
  const idx = text.indexOf(marker);
  if (idx < 0) return undefined;
  const braceStart = text.indexOf("{", idx + marker.length);
  if (braceStart < 0) return undefined;
  // Find the matching JSON object end within a small bounded slice.
  const slice = text.slice(braceStart, braceStart + 4096);
  const match = /"conversationId"\s*:\s*"([^"]+)"/.exec(slice);
  const id = match?.[1];
  return id && ANTIGRAVITY_SESSION_ID.test(id) ? id : undefined;
}

function isInsideDir(dir: string, candidate: string): boolean {
  const rel = relative(dir, candidate);
  return (
    rel !== "" &&
    rel !== ".." &&
    !rel.startsWith(`..${sep}`) &&
    !rel.startsWith("/")
  );
}

/** Opens a conversation's log read-only, anchored to the physical store. */
export async function openPhysicalBrainTranscript(
  physicalScope: string,
  conversationId: string,
  filename: "transcript.jsonl" | "transcript_full.jsonl" = "transcript.jsonl",
): Promise<
  | {
      status: "ok";
      handle: FileHandle;
      path: string;
      size: number;
      dev: number;
      ino: number;
    }
  | { status: "missing" }
  | { status: "invalid" }
  /** The file at the path was replaced while it was opened. */
  | { status: "changed" }
> {
  if (!ANTIGRAVITY_SESSION_ID.test(conversationId))
    return { status: "invalid" };
  let handle: FileHandle | undefined;
  try {
    // Anchor BOTH the brain directory and transcript file to the physical
    // native store root so a symlink on `brain/` or `brain/<id>` cannot escape.
    const storeRoot = await fs.promises.realpath(dirname(physicalScope));
    const brainRoot = join(storeRoot, "brain");
    const brainDir = join(brainRoot, conversationId);
    const transcriptPath = join(
      brainDir,
      ".system_generated",
      "logs",
      filename,
    );
    let physicalBrainRoot: string;
    try {
      physicalBrainRoot = await fs.promises.realpath(brainRoot);
    } catch (error) {
      return (error as NodeJS.ErrnoException)?.code === "ENOENT"
        ? { status: "missing" }
        : { status: "invalid" };
    }
    if (physicalBrainRoot !== brainRoot) return { status: "invalid" };
    let physicalConversationBrain: string;
    try {
      physicalConversationBrain = await fs.promises.realpath(brainDir);
    } catch (error) {
      return (error as NodeJS.ErrnoException)?.code === "ENOENT"
        ? { status: "missing" }
        : { status: "invalid" };
    }
    if (physicalConversationBrain !== brainDir) return { status: "invalid" };
    let physicalTranscript: string;
    try {
      physicalTranscript = await fs.promises.realpath(transcriptPath);
    } catch (error) {
      return (error as NodeJS.ErrnoException)?.code === "ENOENT"
        ? { status: "missing" }
        : { status: "invalid" };
    }
    if (!isInsideDir(physicalConversationBrain, physicalTranscript)) {
      return { status: "invalid" };
    }
    const openFlags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
    handle = await fs.promises.open(physicalTranscript, openFlags);
    const info = await handle.stat();
    if (!info.isFile()) {
      await handle.close().catch(() => {});
      return { status: "invalid" };
    }
    if (info.size === 0) {
      await handle.close().catch(() => {});
      return { status: "missing" };
    }
    // Re-verify the opened inode still belongs to the anchored store path.
    const currentPath = await fs.promises.realpath(transcriptPath);
    const currentStat = await fs.promises.lstat(currentPath);
    if (currentPath !== physicalTranscript) {
      await handle.close().catch(() => {});
      return { status: "invalid" };
    }
    if (currentStat.dev !== info.dev || currentStat.ino !== info.ino) {
      // Replaced between opening and checking: a transient change.
      await handle.close().catch(() => {});
      return { status: "changed" };
    }
    return {
      status: "ok",
      handle,
      path: physicalTranscript,
      size: info.size,
      dev: info.dev,
      ino: info.ino,
    };
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    return (error as NodeJS.ErrnoException)?.code === "ENOENT"
      ? { status: "missing" }
      : { status: "invalid" };
  }
}

export interface AntigravityTurnBoundary {
  step: number;
  dev?: number;
  ino?: number;
  size?: number;
}

/**
 * Snapshot the latest `USER_INPUT` step boundary (and file identity `dev`/`ino`
 * when the file already exists) BEFORE submitting a new live prompt.
 * Returns `{ step: -1 }` when `transcript.jsonl` does not exist yet on a fresh
 * session, or `undefined` when the transcript path is invalid/unreadable.
 */
export async function readAntigravityTurnBoundary(
  physicalScope: string,
  conversationId: string,
  maxBytes = TRANSCRIPT_TAIL_POINT_BYTE_BUDGET,
): Promise<AntigravityTurnBoundary | undefined> {
  const opened = await openPhysicalBrainTranscript(
    physicalScope,
    conversationId,
  );
  if (opened.status === "missing") return { step: -1 };
  if (opened.status !== "ok") return undefined;
  let lastUserInputStep = -1;
  let maxStepIndex = -1;
  try {
    for await (const batch of readLinesBackwardFromHandle(opened.handle, {
      endByte: opened.size,
      maxBytes,
      label: `brain/${conversationId}/transcript.jsonl`,
    })) {
      for (const line of batch.lines) {
        let step: unknown;
        try {
          step = JSON.parse(line);
        } catch {
          continue;
        }
        if (!step || typeof step !== "object") continue;
        const r = step as Record<string, unknown>;
        const stepIndex = r.step_index;
        if (typeof stepIndex !== "number" || !Number.isSafeInteger(stepIndex)) {
          continue;
        }
        if (stepIndex > maxStepIndex) maxStepIndex = stepIndex;
        if (r.type === "USER_INPUT" && stepIndex > lastUserInputStep) {
          lastUserInputStep = stepIndex;
        }
      }
      if (lastUserInputStep >= 0) break;
    }
  } catch {
    return undefined;
  } finally {
    await opened.handle.close().catch(() => {});
  }
  return {
    step: lastUserInputStep >= 0 ? lastUserInputStep : maxStepIndex,
    dev: opened.dev,
    ino: opened.ino,
    size: opened.size,
  };
}

interface ParsedSubagentTail {
  launches: AntigravitySubagentLaunch[];
  userInputs: Array<{ stepIndex: number; content?: string }>;
  reachedStart: boolean;
  minStepSeen?: number;
  tailStartByte: number;
}

function normalizePromptText(text: string | undefined): string {
  return (text ?? "").trim();
}

async function readAntigravitySubagentTailFromHandle(
  handle: FileHandle,
  fileSize: number,
  parentId: string,
  maxBytes = TRANSCRIPT_TAIL_POINT_BYTE_BUDGET,
): Promise<ParsedSubagentTail> {
  interface PlannerCallInfo {
    plannerStepIndex: number;
    role?: string;
    typeName?: string;
    prompt?: string;
  }
  // Map expected result step_index -> invoke_subagent args from PLANNER_RESPONSE.
  const plannedByResultStep = new Map<number, PlannerCallInfo>();
  const genericResults: Array<{ stepIndex: number; childId: string }> = [];
  const userInputsByStep = new Map<number, string | undefined>();
  let reachedStart = false;
  let minStepSeen: number | undefined;
  let tailStartByte = fileSize;

  try {
    for await (const batch of readLinesBackwardFromHandle(handle, {
      endByte: fileSize,
      maxBytes,
      label: `brain/${parentId}/transcript.jsonl`,
    })) {
      if (batch.reachedStart) reachedStart = true;
      if (batch.startByte < tailStartByte) tailStartByte = batch.startByte;
      for (const line of batch.lines) {
        if (!line.includes("step_index")) {
          continue;
        }
        let step: unknown;
        try {
          step = JSON.parse(line);
        } catch {
          continue;
        }
        if (!step || typeof step !== "object" || Array.isArray(step)) continue;
        const record = step as Record<string, unknown>;
        const stepIndex = record.step_index;
        if (typeof stepIndex !== "number" || !Number.isSafeInteger(stepIndex)) {
          continue;
        }
        // Track coverage strictly from validated top-level step_index values so
        // nested `"step_index": 0` text inside tool output cannot forge coverage.
        if (minStepSeen === undefined || stepIndex < minStepSeen) {
          minStepSeen = stepIndex;
        }
        if (record.type === "USER_INPUT") {
          userInputsByStep.set(
            stepIndex,
            typeof record.content === "string" ? record.content : undefined,
          );
        } else if (
          record.type === "PLANNER_RESPONSE" &&
          Array.isArray(record.tool_calls)
        ) {
          record.tool_calls.forEach((call, index) => {
            if (!call || typeof call !== "object") return;
            const c = call as Record<string, unknown>;
            if (c.name !== "invoke_subagent") return;
            const args =
              c.args && typeof c.args === "object"
                ? (c.args as Record<string, unknown>)
                : {};
            plannedByResultStep.set(stepIndex + 1 + index, {
              plannerStepIndex: stepIndex,
              role: decodeTranscriptArg(args.Role),
              typeName: decodeTranscriptArg(args.TypeName),
              prompt: decodeTranscriptArg(args.Prompt),
            });
          });
        } else if (record.type === "GENERIC" && record.status === "DONE") {
          const childId = extractCreatedSubagentId(record.content);
          if (childId) {
            genericResults.push({ stepIndex, childId });
          }
        }
      }
    }
  } catch {
    // Disappearance or concurrent truncation is treated as unavailable data so
    // it never aborts resume or discards a successful ACP replay.
    return {
      launches: [],
      userInputs: [],
      reachedStart: false,
      tailStartByte: 0,
    };
  }

  genericResults.sort((a, b) => a.stepIndex - b.stepIndex);
  const userInputs = [...userInputsByStep.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([stepIndex, content]) => ({
      stepIndex,
      ...(content !== undefined ? { content } : {}),
    }));
  const seen = new Set<string>();
  const launches: AntigravitySubagentLaunch[] = [];
  for (const result of genericResults) {
    if (seen.has(result.childId)) continue;
    seen.add(result.childId);
    const planned = plannedByResultStep.get(result.stepIndex);
    launches.push({
      childId: result.childId,
      ...(planned?.role ? { role: planned.role } : {}),
      ...(planned?.typeName ? { typeName: planned.typeName } : {}),
      ...(planned?.prompt ? { prompt: planned.prompt } : {}),
      stepIndex: result.stepIndex,
      ...(planned ? { plannerStepIndex: planned.plannerStepIndex } : {}),
      pairedWithInvokeSubagent: planned !== undefined,
    });
  }
  return {
    launches,
    userInputs,
    reachedStart,
    ...(minStepSeen !== undefined ? { minStepSeen } : {}),
    tailStartByte,
  };
}

async function readAntigravitySubagentTail(
  physicalScope: string,
  parentId: string,
  maxBytes = TRANSCRIPT_TAIL_POINT_BYTE_BUDGET,
): Promise<ParsedSubagentTail> {
  const opened = await openPhysicalBrainTranscript(physicalScope, parentId);
  if (opened.status !== "ok") {
    return {
      launches: [],
      userInputs: [],
      reachedStart: false,
      tailStartByte: 0,
    };
  }
  try {
    return await readAntigravitySubagentTailFromHandle(
      opened.handle,
      opened.size,
      parentId,
      maxBytes,
    );
  } finally {
    await opened.handle.close().catch(() => {});
  }
}

/**
 * Bounded tail reader over `agy`'s `brain/<parentId>/.system_generated/logs/transcript.jsonl`.
 * Pairs `PLANNER_RESPONSE` `invoke_subagent` calls with their following `GENERIC`
 * creation steps within `TRANSCRIPT_TAIL_POINT_BYTE_BUDGET` (never a whole-file
 * read). Callers MUST cross-check every returned `childId` against
 * `conversation_summaries.db` parent ownership before exposing or acting on it.
 */
export async function readAntigravitySubagentLaunches(
  physicalScope: string,
  parentId: string,
  maxBytes = TRANSCRIPT_TAIL_POINT_BYTE_BUDGET,
): Promise<AntigravitySubagentLaunch[]> {
  return (await readAntigravitySubagentTail(physicalScope, parentId, maxBytes))
    .launches;
}

/**
 * Snapshot the current byte size of `transcript.jsonl` before submitting a
 * live prompt so anchor verification can perform a bounded forward read from
 * `startByte` if a single turn flushes `USER_INPUT` and >4 MiB of output
 * together, pushing `USER_INPUT` past the backward tail budget.
 * Returns `0` when the transcript does not exist yet, or `undefined` if invalid.
 */
export interface AntigravityTranscriptPosition {
  /** Byte offset in `transcript.jsonl` before prompt submission (`0` when file did not yet exist). */
  byte: number;
  /** File identity (`dev`/`ino`) when the file already existed, used to detect atomic replacement. */
  dev?: number;
  ino?: number;
}

/**
 * Snapshot the current byte position and file identity of `transcript.jsonl`
 * before submitting a live prompt so anchor verification can perform a bounded
 * forward read from `byte` on the same inode (invalidating the saved offset if
 * the transcript is atomically replaced or truncated).
 */
export async function readAntigravityTranscriptPosition(
  physicalScope: string,
  conversationId: string,
): Promise<AntigravityTranscriptPosition | undefined> {
  const opened = await openPhysicalBrainTranscript(
    physicalScope,
    conversationId,
  );
  if (opened.status === "missing") return { byte: 0 };
  if (opened.status !== "ok") return undefined;
  const pos: AntigravityTranscriptPosition = {
    byte: opened.size,
    dev: opened.dev,
    ino: opened.ino,
  };
  await opened.handle.close().catch(() => {});
  return pos;
}

/**
 * Synchronous counterpart to `readAntigravityTranscriptPosition` used right
 * before synchronous steering submissions so steered prompts also capture their
 * pre-submission byte position and inode.
 */
export function readAntigravityTranscriptPositionSync(
  physicalScope: string,
  conversationId: string,
): AntigravityTranscriptPosition | undefined {
  if (!ANTIGRAVITY_SESSION_ID.test(conversationId)) return undefined;
  try {
    const storeRoot = fs.realpathSync(dirname(physicalScope));
    const brainRoot = join(storeRoot, "brain");
    const brainDir = join(brainRoot, conversationId);
    const transcriptPath = join(
      brainDir,
      ".system_generated",
      "logs",
      "transcript.jsonl",
    );
    let physicalBrainRoot: string;
    try {
      physicalBrainRoot = fs.realpathSync(brainRoot);
    } catch (error) {
      return (error as NodeJS.ErrnoException)?.code === "ENOENT"
        ? { byte: 0 }
        : undefined;
    }
    if (physicalBrainRoot !== brainRoot) return undefined;
    let physicalConversationBrain: string;
    try {
      physicalConversationBrain = fs.realpathSync(brainDir);
    } catch (error) {
      return (error as NodeJS.ErrnoException)?.code === "ENOENT"
        ? { byte: 0 }
        : undefined;
    }
    if (physicalConversationBrain !== brainDir) return undefined;
    let physicalTranscript: string;
    try {
      physicalTranscript = fs.realpathSync(transcriptPath);
    } catch (error) {
      return (error as NodeJS.ErrnoException)?.code === "ENOENT"
        ? { byte: 0 }
        : undefined;
    }
    if (!isInsideDir(physicalConversationBrain, physicalTranscript)) {
      return undefined;
    }
    const info = fs.statSync(physicalTranscript);
    if (!info.isFile()) return undefined;
    return info.size === 0
      ? { byte: 0 }
      : { byte: info.size, dev: info.dev, ino: info.ino };
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "ENOENT"
      ? { byte: 0 }
      : undefined;
  }
}

/**
 * Bounded forward scan from `startByte` collecting `USER_INPUT` steps strictly
 * after `afterStepExclusive` until `neededCount` inputs are found or `maxBytes`
 * have been read. Keeps partial lines as raw bytes until newline splitting so
 * multi-byte UTF-8 characters straddling chunk boundaries are never corrupted.
 */
async function scanForwardUserInputsFromHandle(
  handle: FileHandle,
  fileSize: number,
  startByte: number,
  afterStepExclusive: number,
  neededCount: number,
  maxBytes: number,
): Promise<{
  inputs: Array<{ stepIndex: number; content?: string }>;
  endByte: number;
}> {
  const found = new Map<number, string | undefined>();
  if (startByte < 0 || startByte >= fileSize || maxBytes <= 0) {
    return { inputs: [], endByte: Math.max(0, startByte) };
  }
  let offset = startByte;
  let bytesRead = 0;
  let chunkBytes = 64 * 1024;
  let carried: Buffer = Buffer.alloc(0);
  const parseLine = (line: string) => {
    if (!line.includes("USER_INPUT")) return;
    let step: unknown;
    try {
      step = JSON.parse(line);
    } catch {
      return;
    }
    if (!step || typeof step !== "object") return;
    const record = step as Record<string, unknown>;
    const stepIndex = record.step_index;
    if (
      record.type === "USER_INPUT" &&
      typeof stepIndex === "number" &&
      Number.isSafeInteger(stepIndex) &&
      stepIndex > afterStepExclusive
    ) {
      found.set(
        stepIndex,
        typeof record.content === "string" ? record.content : undefined,
      );
    }
  };
  while (
    offset < fileSize &&
    bytesRead < maxBytes &&
    found.size < neededCount
  ) {
    const length = Math.min(
      chunkBytes,
      fileSize - offset,
      maxBytes - bytesRead,
    );
    if (length <= 0) break;
    chunkBytes = Math.min(chunkBytes * 2, 1024 * 1024);
    const buf = Buffer.alloc(length);
    const { bytesRead: read } = await handle.read(buf, 0, length, offset);
    if (read <= 0) break;
    offset += read;
    bytesRead += read;
    const chunk = buf.subarray(0, read);
    const combined =
      carried.length > 0 ? Buffer.concat([carried, chunk]) : chunk;
    let lineStart = 0;
    let newline = combined.indexOf(0x0a, lineStart);
    while (newline >= 0) {
      const line = combined.subarray(lineStart, newline).toString("utf8");
      if (line.trim()) parseLine(line);
      lineStart = newline + 1;
      if (found.size >= neededCount) break;
      newline = combined.indexOf(0x0a, lineStart);
    }
    carried =
      lineStart < combined.length
        ? Buffer.from(combined.subarray(lineStart))
        : Buffer.alloc(0);
  }
  if (carried.length > 0 && offset >= fileSize && found.size < neededCount) {
    const tailLine = carried.toString("utf8");
    if (tailLine.trim()) parseLine(tailLine);
  }
  return {
    inputs: [...found.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([stepIndex, content]) => ({
        stepIndex,
        ...(content !== undefined ? { content } : {}),
      })),
    endByte: offset,
  };
}

export interface AntigravityTurnScope {
  /** Highest `USER_INPUT` step (or `-1` on a fresh session) before this anchor. */
  afterStepExclusive: number;
  /** File identity (`dev`/`ino`/`size`) where `afterStepExclusive` / `verifiedUserStep` was established. */
  anchorDev?: number;
  anchorIno?: number;
  anchorSize?: number;
  /** 0-based count of prompts submitted since `afterStepExclusive` before this prompt. */
  promptOffset: number;
  /** Exact user prompt text submitted for this prompt. */
  promptText: string;
  /** Transcript byte offset (and inode identity) captured before this prompt was submitted. */
  startByte?: number;
  startDev?: number;
  startIno?: number;
  /** Verified `USER_INPUT` step index once confirmed on disk for this prompt. */
  verifiedUserStep?: number;
}

export interface AntigravityTurnLaunchesResult {
  launches: AntigravitySubagentLaunch[];
  /** Present only when this prompt's exact `USER_INPUT` step was verified on disk. */
  verifiedUserStep?: number;
  /** File identity (`dev`/`ino`/`size`) on which `verifiedUserStep` was verified. */
  verifiedDev?: number;
  verifiedIno?: number;
  verifiedSize?: number;
  /** True when the transcript's `(dev, ino)` changed or shrank since the anchor/start position was captured. */
  replaced?: boolean;
}

/**
 * Turn-bounded live subagent launch reader: opens the validated transcript file
 * handle ONCE and runs both the backward tail scan and (when needed) the
 * bounded forward anchor scan against that single handle and snapshot size so
 * atomic replacement can never mix evidence from two different files. Rejects
 * all paths (verified-step, tail-ordinal, and forward-offset) if the file's
 * `(dev, ino)` changed or its size shrank below the anchor/start byte offset.
 */
export async function readAntigravityTurnSubagentLaunches(
  physicalScope: string,
  parentId: string,
  turnScope: AntigravityTurnScope,
  maxBytes = TRANSCRIPT_TAIL_POINT_BYTE_BUDGET,
): Promise<AntigravityTurnLaunchesResult> {
  const expectedText = normalizePromptText(turnScope.promptText);
  if (!expectedText || turnScope.promptOffset < 0) return { launches: [] };
  const opened = await openPhysicalBrainTranscript(physicalScope, parentId);
  if (opened.status !== "ok") return { launches: [] };

  try {
    // Reject immediately if the transcript was atomically replaced OR truncated
    // in place (same inode, smaller size) since the anchor or start offset was captured.
    const anchorReplaced =
      (turnScope.anchorDev !== undefined &&
        (turnScope.anchorDev !== opened.dev ||
          turnScope.anchorIno !== opened.ino)) ||
      (turnScope.anchorSize !== undefined &&
        opened.size < turnScope.anchorSize);
    const startReplaced =
      (turnScope.startDev !== undefined &&
        (turnScope.startDev !== opened.dev ||
          turnScope.startIno !== opened.ino)) ||
      (turnScope.startByte !== undefined && opened.size < turnScope.startByte);
    if (anchorReplaced || startReplaced) {
      return { launches: [], replaced: true };
    }

    const { launches, userInputs, reachedStart, minStepSeen, tailStartByte } =
      await readAntigravitySubagentTailFromHandle(
        opened.handle,
        opened.size,
        parentId,
        maxBytes,
      );

    const tailReachedAnchor =
      reachedStart ||
      (minStepSeen !== undefined &&
        minStepSeen <= turnScope.afterStepExclusive);

    const resolveFromInputs = (
      inputs: ReadonlyArray<{ stepIndex: number; content?: string }>,
    ): {
      targetInput?: { stepIndex: number; content?: string };
      nextUserStep?: number;
    } => {
      if (turnScope.verifiedUserStep !== undefined) {
        const idx = inputs.findIndex(
          (entry) => entry.stepIndex === turnScope.verifiedUserStep,
        );
        if (idx < 0) return {};
        return {
          targetInput: inputs[idx],
          nextUserStep: inputs[idx + 1]?.stepIndex,
        };
      }
      const afterBaseline = inputs.filter(
        (entry) => entry.stepIndex > turnScope.afterStepExclusive,
      );
      return {
        targetInput: afterBaseline[turnScope.promptOffset],
        nextUserStep: afterBaseline[turnScope.promptOffset + 1]?.stepIndex,
      };
    };

    let targetInput: { stepIndex: number; content?: string } | undefined;
    let nextUserStep: number | undefined;
    let canReturnLaunches = false;

    const startOffsetValid =
      turnScope.startByte !== undefined &&
      turnScope.startByte >= 0 &&
      turnScope.startByte <= opened.size;

    if (turnScope.verifiedUserStep !== undefined) {
      ({ targetInput, nextUserStep } = resolveFromInputs(userInputs));
      // targetInput was found inside `userInputs`, so the backward tail covers
      // continuously from `verifiedUserStep` through EOF with no gap.
      canReturnLaunches = targetInput !== undefined;
    } else if (tailReachedAnchor) {
      // Backward tail provably covers every record strictly after
      // `afterStepExclusive`, so `afterBaseline[promptOffset]` and all launches
      // through EOF have continuous coverage.
      ({ targetInput, nextUserStep } = resolveFromInputs(userInputs));
      canReturnLaunches = targetInput !== undefined;
    } else if (turnScope.promptOffset === 0 && startOffsetValid) {
      // Tail was truncated before reaching `afterStepExclusive`: run the
      // bounded forward scan against the SAME validated FileHandle and snapshot
      // size (`opened.size`) so atomic replacement cannot combine two files.
      try {
        const forward = await scanForwardUserInputsFromHandle(
          opened.handle,
          opened.size,
          turnScope.startByte!,
          turnScope.afterStepExclusive,
          2,
          maxBytes,
        );
        const forwardFoundTarget = forward.inputs.length > 0;
        const forwardLocatedNextInput = forward.inputs.length >= 2;
        const noUnscannedGap = forward.endByte >= tailStartByte;
        if (forwardFoundTarget || noUnscannedGap) {
          const mergedByStep = new Map<number, string | undefined>();
          for (const entry of forward.inputs) {
            mergedByStep.set(entry.stepIndex, entry.content);
          }
          for (const entry of userInputs) {
            mergedByStep.set(entry.stepIndex, entry.content);
          }
          const merged = [...mergedByStep.entries()]
            .sort((a, b) => a[0] - b[0])
            .map(([stepIndex, content]) => ({
              stepIndex,
              ...(content !== undefined ? { content } : {}),
            }));
          ({ targetInput, nextUserStep } = resolveFromInputs(merged));
          // Return launches ONLY when reads continuously cover from startByte
          // through the tail OR when the forward read already located the next
          // USER_INPUT before any unscanned gap (otherwise an unscanned gap
          // could hide a steering USER_INPUT whose child sits in the tail).
          canReturnLaunches = noUnscannedGap || forwardLocatedNextInput;
        }
      } catch {
        // Treat transient I/O errors as unavailable data.
      }
    }
    if (!targetInput) return { launches: [] };
    if (normalizePromptText(targetInput.content) !== expectedText) {
      return { launches: [] };
    }
    const turnUserStep = targetInput.stepIndex;
    if (!canReturnLaunches) {
      return {
        launches: [],
        verifiedUserStep: turnUserStep,
        verifiedDev: opened.dev,
        verifiedIno: opened.ino,
        verifiedSize: opened.size,
      };
    }
    const boundedLaunches = launches.filter(
      (launch) =>
        launch.pairedWithInvokeSubagent &&
        launch.plannerStepIndex !== undefined &&
        launch.plannerStepIndex > turnUserStep &&
        launch.stepIndex > turnUserStep &&
        (nextUserStep === undefined ||
          (launch.plannerStepIndex < nextUserStep &&
            launch.stepIndex < nextUserStep)),
    );
    return {
      launches: boundedLaunches,
      verifiedUserStep: turnUserStep,
      verifiedDev: opened.dev,
      verifiedIno: opened.ino,
      verifiedSize: opened.size,
    };
  } finally {
    await opened.handle.close().catch(() => {});
  }
}

function launchConflictsWithCall(
  call: AntigravitySubagentCall,
  launch: AntigravitySubagentLaunch,
): boolean {
  if (call.role && launch.role && call.role !== launch.role) return true;
  if (call.typeName && launch.typeName && call.typeName !== launch.typeName) {
    return true;
  }
  if (call.prompt && launch.prompt && call.prompt !== launch.prompt) {
    return true;
  }
  return false;
}

/**
 * Correlate normalized `spawn_agent` tool calls with native `transcript.jsonl`
 * launches, restricted strictly to paired `invoke_subagent` launches verified
 * under `parentId` in `conversation_summaries.db`. Failed calls are never
 * linked, conflicting metadata is never paired, unpaired launches are rejected,
 * and ambiguous matches (multiple compatible launches or multiple compatible
 * calls) are left unlinked rather than guessed.
 */
export function correlateAntigravitySubagentCalls(
  calls: readonly AntigravitySubagentCall[],
  launches: readonly AntigravitySubagentLaunch[],
  verifiedChildIds: ReadonlySet<string>,
): Map<string, AntigravitySubagentLaunch> {
  const result = new Map<string, AntigravitySubagentLaunch>();
  const eligibleCalls = calls.filter((call) => !call.failed);
  const verified = launches.filter(
    (launch) =>
      launch.pairedWithInvokeSubagent && verifiedChildIds.has(launch.childId),
  );
  if (!eligibleCalls.length || !verified.length) return result;

  const usedLaunchIndices = new Set<number>();

  const matchUnique = (
    candidates: readonly AntigravitySubagentCall[],
    predicate: (
      call: AntigravitySubagentCall,
      launch: AntigravitySubagentLaunch,
    ) => boolean,
  ): AntigravitySubagentCall[] => {
    const matchesByCall = new Map<string, number[]>();
    const callersByLaunch = new Map<number, number>();
    for (const call of candidates) {
      const matched: number[] = [];
      for (let i = 0; i < verified.length; i++) {
        if (usedLaunchIndices.has(i)) continue;
        const launch = verified[i]!;
        if (!launchConflictsWithCall(call, launch) && predicate(call, launch)) {
          matched.push(i);
          callersByLaunch.set(i, (callersByLaunch.get(i) ?? 0) + 1);
        }
      }
      matchesByCall.set(call.toolUseId, matched);
    }
    const remaining: AntigravitySubagentCall[] = [];
    for (const call of candidates) {
      const matched = matchesByCall.get(call.toolUseId) ?? [];
      if (matched.length === 1 && callersByLaunch.get(matched[0]!) === 1) {
        usedLaunchIndices.add(matched[0]!);
        result.set(call.toolUseId, verified[matched[0]!]!);
      } else {
        remaining.push(call);
      }
    }
    return remaining;
  };

  // Pass 1: unique exact (role + typeName + prompt) match.
  const afterFull = matchUnique(
    eligibleCalls,
    (call, launch) =>
      !!call.prompt &&
      call.prompt === launch.prompt &&
      call.role === launch.role &&
      call.typeName === launch.typeName,
  );
  // Pass 2: unique exact (role + typeName) match when at least one is present
  // and no other metadata conflicts. Ambiguous calls stay unlinked.
  matchUnique(
    afterFull,
    (call, launch) =>
      (!!call.role || !!call.typeName) &&
      call.role === launch.role &&
      call.typeName === launch.typeName,
  );
  return result;
}
