import { open } from "node:fs/promises";
import { join } from "node:path";
import {
  GOAL_COMMAND_NAME,
  type SlashCommand,
  type SlashCommandGoalDetails,
} from "@yep-anywhere/shared";
import { CLAUDE_PROJECTS_DIR } from "../../projects/paths.js";
import type { ProviderCommandResult } from "../types.js";

// Preserve the local transcript-folder spelling independently of retired sync.
function getProjectDirFromCwd(cwd: string): string {
  return cwd.replace(/[/\\:]/g, "-");
}

/**
 * Claude goal state (topics/emulated-slash-commands.md § Claude goal commands).
 *
 * Claude Code owns `/goal` as a session-scoped Stop hook and offers no query
 * for it, so YA reads the state the CLI records in the session transcript:
 * every set, clear, met, and impossible transition appends a `goal_status`
 * attachment row. Pause has no Claude equivalent; YA clears the hook and
 * remembers the objective itself, which is why a paused goal lives in YA
 * session metadata rather than in the provider.
 */

/** How far back the first read of a transcript looks for the last goal row. */
const SEED_TAIL_BYTES = 4 * 1024 * 1024;

/** Minimum spacing between transcript reads while a command is unconfirmed. */
const PENDING_REFRESH_INTERVAL_MS = 200;

/**
 * Spacing between reads at any other time. A goal loop runs many iterations
 * inside one turn, and Claude's own auto-clear lands mid-turn, so the flag
 * cannot wait for a turn boundary.
 */
const STREAMING_REFRESH_INTERVAL_MS = 2000;

/** How long a dispatched command keeps the faster read cadence. */
const PENDING_WINDOW_MS = 60_000;

/** How long a dispatched goal command waits for its transcript confirmation. */
const CONFIRMATION_TIMEOUT_MS = 6000;

export type ClaudeGoalStatus = "active" | "paused";

export interface ClaudeGoalSnapshot {
  objective: string | null;
  status: ClaudeGoalStatus | null;
}

export type ClaudeGoalControl =
  | { kind: "read" }
  | { kind: "clear" }
  | { kind: "pause" }
  | { kind: "resume" }
  | { kind: "set"; objective: string };

/** Arguments Claude Code itself treats as "clear the goal". */
const CLEAR_ARGUMENTS = new Set([
  "clear",
  "stop",
  "off",
  "reset",
  "none",
  "cancel",
]);

export function parseClaudeGoalControl(
  argument: string | undefined,
): ClaudeGoalControl {
  const objective = argument?.trim() ?? "";
  if (!objective) return { kind: "read" };
  const control = objective.toLowerCase();
  if (CLEAR_ARGUMENTS.has(control)) return { kind: "clear" };
  if (control === "pause") return { kind: "pause" };
  if (control === "resume") return { kind: "resume" };
  return { kind: "set", objective };
}

interface ClaudeGoalRow {
  condition: string;
  /** True while the Stop hook is installed; false once it is gone. */
  installed: boolean;
}

/**
 * Read one transcript line as a goal transition. A `met: false` row without
 * `failed` is either the set sentinel or a not-yet-met iteration; both mean the
 * hook is installed. `met: true` (satisfied or cleared) and `failed: true`
 * (judged impossible) both mean Claude removed it.
 */
function parseClaudeGoalTranscriptLine(line: string): ClaudeGoalRow | null {
  if (!line.includes('"goal_status"')) return null;
  let entry: unknown;
  try {
    entry = JSON.parse(line);
  } catch {
    return null;
  }
  const attachment = (
    entry as {
      attachment?: {
        type?: unknown;
        condition?: unknown;
        met?: unknown;
        failed?: unknown;
      };
    }
  )?.attachment;
  if (attachment?.type !== "goal_status") return null;
  if (typeof attachment.condition !== "string") return null;
  return {
    condition: attachment.condition,
    installed: attachment.met === false && attachment.failed !== true,
  };
}

/** Incremental reader over one session transcript's goal rows. */
class GoalTranscriptTail {
  #path: string | null = null;
  #offset = 0;
  #partial = "";
  #seeded = false;

  setPath(path: string): void {
    if (path === this.#path) return;
    this.#path = path;
    this.#offset = 0;
    this.#partial = "";
    this.#seeded = false;
  }

  get attached(): boolean {
    return this.#path !== null;
  }

  /** Goal rows appended since the previous read, in file order. */
  async read(): Promise<ClaudeGoalRow[]> {
    const path = this.#path;
    if (!path) return [];
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(path, "r");
    } catch {
      // A session whose transcript is not on this host (remote executor) or is
      // not written yet simply reports no transitions.
      return [];
    }
    try {
      const { size } = await handle.stat();
      let seedRead = false;
      if (!this.#seeded) {
        this.#seeded = true;
        this.#offset = Math.max(0, size - SEED_TAIL_BYTES);
        this.#partial = "";
        seedRead = this.#offset > 0;
      }
      // A rewritten or rotated transcript restarts the scan.
      if (size < this.#offset) {
        this.#offset = 0;
        this.#partial = "";
      }
      if (size === this.#offset) return [];
      const length = size - this.#offset;
      const buffer = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(buffer, 0, length, this.#offset);
      this.#offset += bytesRead;
      let text = this.#partial + buffer.toString("utf8", 0, bytesRead);
      if (seedRead) {
        // Started mid-file: drop the leading partial line.
        const firstNewline = text.indexOf("\n");
        text = firstNewline === -1 ? "" : text.slice(firstNewline + 1);
      }
      const lastNewline = text.lastIndexOf("\n");
      if (lastNewline === -1) {
        this.#partial = text;
        return [];
      }
      this.#partial = text.slice(lastNewline + 1);
      const rows: ClaudeGoalRow[] = [];
      for (const line of text.slice(0, lastNewline).split("\n")) {
        const row = parseClaudeGoalTranscriptLine(line);
        if (row) rows.push(row);
      }
      return rows;
    } finally {
      await handle.close();
    }
  }
}

/**
 * Tracks one Claude session's goal. Every visible transition comes from a
 * transcript row, so a refused `/goal` (untrusted workspace, restricted hooks)
 * never produces an optimistic flag. The one YA-owned state is `paused`: YA
 * asked Claude to clear a hook it intends to reinstall.
 */
export class ClaudeGoalTracker {
  readonly #tail = new GoalTranscriptTail();
  readonly #cwd: string;
  #objective: string | null = null;
  #status: ClaudeGoalStatus | null = null;
  /** Objective whose clear YA requested for a pause, awaiting confirmation. */
  #pauseObjective: string | null = null;
  #refreshing: Promise<boolean> | null = null;
  /** Deadline until which a dispatched command is still expected to land. */
  #pendingUntil = 0;
  #lastRefreshAt = 0;

  constructor(
    cwd: string,
    restored?: ClaudeGoalSnapshot | null,
    /** Transcript location override; production derives it from cwd + id. */
    resolveTranscriptPath?: (sessionId: string) => string,
  ) {
    this.#cwd = cwd;
    if (resolveTranscriptPath)
      this.#resolveTranscriptPath = resolveTranscriptPath;
    // Only a paused goal is restored: Claude reinstalls an active goal's Stop
    // hook on resume, and the transcript reports that authoritatively.
    if (restored?.status === "paused" && restored.objective) {
      this.#objective = restored.objective;
      this.#status = "paused";
      this.#pauseObjective = restored.objective;
    }
  }

  get snapshot(): ClaudeGoalSnapshot {
    return { objective: this.#objective, status: this.#status };
  }

  get attached(): boolean {
    return this.#tail.attached;
  }

  attachSession(sessionId: string): void {
    this.#tail.setPath(this.#resolveTranscriptPath(sessionId));
  }

  #resolveTranscriptPath = (sessionId: string): string =>
    join(
      CLAUDE_PROJECTS_DIR,
      getProjectDirFromCwd(this.#cwd),
      `${sessionId}.jsonl`,
    );

  /** Note that YA sent a goal command whose transcript row should follow. */
  expectTransition(): void {
    this.#pendingUntil = Date.now() + PENDING_WINDOW_MS;
  }

  /** Note the objective whose clear is a YA pause rather than a real clear. */
  notePauseRequested(objective: string): void {
    this.#pauseObjective = objective;
    this.expectTransition();
  }

  /** Clear a paused goal that only YA is holding; Claude has no hook to drop. */
  clearPaused(): boolean {
    if (this.#status !== "paused") return false;
    this.#objective = null;
    this.#status = null;
    this.#pauseObjective = null;
    this.#pendingUntil = 0;
    return true;
  }

  async refresh(): Promise<boolean> {
    if (this.#refreshing) return this.#refreshing;
    this.#lastRefreshAt = Date.now();
    const refreshing = this.#refreshOnce();
    this.#refreshing = refreshing;
    try {
      return await refreshing;
    } finally {
      if (this.#refreshing === refreshing) this.#refreshing = null;
    }
  }

  /**
   * Refresh at a turn boundary (`force`) or on the rate-limited cadence for
   * everything else, faster while a dispatched command is still unconfirmed.
   * A streaming turn produces far more messages than goal transitions.
   */
  async refreshIfDue(force: boolean): Promise<boolean> {
    if (!this.#tail.attached) return false;
    const now = Date.now();
    if (!force) {
      const interval =
        this.#pendingUntil > now
          ? PENDING_REFRESH_INTERVAL_MS
          : STREAMING_REFRESH_INTERVAL_MS;
      if (now - this.#lastRefreshAt < interval) return false;
    }
    return this.refresh();
  }

  async #refreshOnce(): Promise<boolean> {
    const rows = await this.#tail.read();
    const last = rows.at(-1);
    if (!last) return false;
    this.#pendingUntil = 0;
    const before = this.#stateKey();
    if (last.installed) {
      this.#objective = last.condition;
      this.#status = "active";
      // Claude keeps appending not-yet-met rows for the goal it still holds,
      // and one can land between YA's pause request and the clear YA sent.
      // Only a hook carrying some other objective means the pause is stale.
      if (this.#pauseObjective !== last.condition) this.#pauseObjective = null;
    } else if (this.#pauseObjective === last.condition) {
      this.#objective = last.condition;
      this.#status = "paused";
    } else {
      this.#objective = null;
      this.#status = null;
      this.#pauseObjective = null;
    }
    return this.#stateKey() !== before;
  }

  #stateKey(): string {
    return `${this.#status ?? ""} :: ${this.#objective ?? ""}`;
  }
}

export interface ClaudeGoalCommandDeps {
  tracker: ClaudeGoalTracker;
  /** Deliver one native `/goal ...` line to the Claude CLI. */
  send: (text: string) => void;
  /** Overridable for tests; production waits for the transcript row. */
  confirmationTimeoutMs?: number;
  wait?: (ms: number) => Promise<void>;
}

function goalStatusLabel(status: ClaudeGoalStatus | null): string {
  return status === "paused" ? "Goal paused" : "Goal active";
}

/**
 * Run one `/goal` submission for a Claude session.
 *
 * Set, clear, and read use Claude's own command; YA only reports what the
 * transcript then shows. Pause and resume have no Claude equivalent, so YA
 * clears the Stop hook and reinstalls the remembered objective. Every receipt
 * describes the confirmed state, or says the transition is still unconfirmed —
 * a refused command never reports success.
 *
 * Claude persists each line sent as a command row of its own. The result
 * names the last one so the receipt can stand in for that row on reload.
 */
export async function runClaudeGoalCommand(
  argument: string | undefined,
  deps: ClaudeGoalCommandDeps,
): Promise<ProviderCommandResult> {
  let providerCommandText: string | undefined;
  const result = await runGoalControl(argument, {
    ...deps,
    send: (text) => {
      providerCommandText = text;
      deps.send(text);
    },
  });
  return providerCommandText ? { ...result, providerCommandText } : result;
}

async function runGoalControl(
  argument: string | undefined,
  deps: ClaudeGoalCommandDeps,
): Promise<ProviderCommandResult> {
  const { tracker, send } = deps;
  const control = parseClaudeGoalControl(argument);
  await tracker.refresh();
  const current = tracker.snapshot;

  if (control.kind === "read") {
    return {
      handled: true,
      output: {
        summary: "/goal",
        details: current.objective
          ? [current.objective, goalStatusLabel(current.status)]
          : ["No goal set"],
      },
    };
  }

  if (control.kind === "clear") {
    if (!current.objective) {
      return {
        handled: true,
        output: { summary: "/goal", details: ["No goal to clear"] },
      };
    }
    // A paused goal exists only in YA: Claude has no hook left to remove.
    if (tracker.clearPaused()) {
      return {
        handled: true,
        output: { summary: "/goal", details: ["Goal cleared"] },
      };
    }
    tracker.expectTransition();
    send("/goal clear");
    const after = await confirmClaudeGoalTransition(
      deps,
      (snapshot) => !snapshot.objective,
    );
    return {
      handled: true,
      output: {
        summary: "/goal",
        details: after.objective
          ? [
              after.objective,
              "Clear requested; Claude has not released the goal yet",
            ]
          : ["Goal cleared"],
      },
    };
  }

  if (control.kind === "pause") {
    if (current.status === "paused") {
      return { handled: true, error: "The goal is already paused" };
    }
    if (!current.objective) {
      return { handled: true, error: "No active goal to pause" };
    }
    const objective = current.objective;
    tracker.notePauseRequested(objective);
    send("/goal clear");
    const after = await confirmClaudeGoalTransition(
      deps,
      (snapshot) => snapshot.status === "paused",
    );
    return {
      handled: true,
      output: {
        summary: "/goal",
        details: [
          objective,
          after.status === "paused"
            ? "Goal paused"
            : "Pause requested; Claude has not released the goal yet",
        ],
      },
    };
  }

  if (control.kind === "resume") {
    if (current.status !== "paused" || !current.objective) {
      return { handled: true, error: "No paused goal to resume" };
    }
    const objective = current.objective;
    tracker.expectTransition();
    send(`/goal ${objective}`);
    const after = await confirmClaudeGoalTransition(
      deps,
      (snapshot) => snapshot.status === "active",
    );
    return {
      handled: true,
      output: {
        summary: "/goal",
        details: [
          objective,
          after.status === "active"
            ? "Goal resumed"
            : "Resume requested; Claude has not confirmed the goal yet",
        ],
      },
    };
  }

  // Reissuing the live objective reads it. Re-sending would clear and reinstall
  // the same hook and spend a turn re-acknowledging it.
  if (current.status === "active" && current.objective === control.objective) {
    return {
      handled: true,
      output: { summary: "/goal", details: [current.objective, "Goal active"] },
    };
  }
  tracker.expectTransition();
  send(`/goal ${control.objective}`);
  const after = await confirmClaudeGoalTransition(
    deps,
    (snapshot) =>
      snapshot.status === "active" && snapshot.objective === control.objective,
  );
  return {
    handled: true,
    output: {
      summary: "/goal",
      details: [
        control.objective,
        after.status === "active" && after.objective === control.objective
          ? "Goal set"
          : "Goal requested; Claude has not confirmed it yet",
      ],
    },
  };
}

/** Poll the transcript until it shows the requested transition, or time out. */
async function confirmClaudeGoalTransition(
  deps: ClaudeGoalCommandDeps,
  satisfied: (snapshot: ClaudeGoalSnapshot) => boolean,
): Promise<ClaudeGoalSnapshot> {
  const timeout = deps.confirmationTimeoutMs ?? CONFIRMATION_TIMEOUT_MS;
  const wait =
    deps.wait ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ms);
        timer.unref?.();
      }));
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    await wait(PENDING_REFRESH_INTERVAL_MS);
    await deps.tracker.refresh();
    const snapshot = deps.tracker.snapshot;
    if (satisfied(snapshot)) return snapshot;
  }
  return deps.tracker.snapshot;
}

/**
 * Publish goal state on the native `goal` inventory entry. The emulated
 * `/loop wish` alias YA adds for Claude builds without native goals is left
 * alone: it has no goal state to report and no controls to offer.
 */
export function withClaudeGoalDetails(
  commands: SlashCommand[],
  snapshot: ClaudeGoalSnapshot,
): SlashCommand[] {
  return commands.map((command) => {
    if (
      command.name !== GOAL_COMMAND_NAME ||
      command.invocation?.kind === "emulated"
    ) {
      return command;
    }
    const details: SlashCommandGoalDetails = {
      goalObjective: snapshot.objective,
      goalStatus: snapshot.status,
    };
    return {
      ...command,
      providerDetails: { ...command.providerDetails, claude: details },
      argumentCompletions: [
        ...(snapshot.objective
          ? [{ value: snapshot.objective, description: "Current goal" }]
          : []),
        { value: "clear", description: "Remove the current goal" },
        ...(snapshot.status === "active"
          ? [{ value: "pause", description: "Pause the current goal" }]
          : []),
        ...(snapshot.status === "paused"
          ? [{ value: "resume", description: "Resume the current goal" }]
          : []),
        ...(command.argumentCompletions ?? []),
      ],
    };
  });
}
