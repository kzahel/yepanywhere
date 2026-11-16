import { format } from "node:util";
import { afterAll, afterEach, beforeEach, expect } from "vitest";
import allowlist from "./unasserted-diagnostics.json";

/**
 * Fails a client unit test that emits a React or jsdom diagnostic nobody
 * asserted, and fails an allowlisted file that no longer emits its recorded
 * kind. Console output is still forwarded unchanged. A test that deliberately
 * produces a diagnostic spies on `console.error` and asserts it, which keeps
 * the call from reaching this gate.
 * See docs/development/code-quality.md#zero-warning-commits.
 */

const REACT_DIAGNOSTICS = {
  act: /not wrapped in act\(|not configured to support act\(/,
  "render-update":
    /^Cannot update a component .* while rendering a different component/,
  "dom-prop":
    /^(?:Invalid value for prop |React does not recognize the |Received `[^`]*` for a non-boolean attribute|Unknown event handler property )/,
  key: /^Each child in a list should have a unique "key" prop|^Encountered two children with the same key/,
};
const JSDOM_NOT_IMPLEMENTED = "jsdom-not-implemented";

export const DIAGNOSTIC_KINDS: readonly string[] = [
  ...Object.keys(REACT_DIAGNOSTICS),
  JSDOM_NOT_IMPLEMENTED,
];
export const ALLOWLIST_PATH =
  "packages/client/test/unasserted-diagnostics.json";
const PACKAGE_DIR = "packages/client/";
const ORIGINAL_ERROR = Symbol.for("yep-anywhere.unassertedDiagnostics.error");

type Emission = { kind: string; text: string; test: string | null };
type RunnerTask = {
  type: string;
  mode: string;
  result?: { state?: string };
  tasks?: RunnerTask[];
};
type JsdomHandle = {
  virtualConsole: {
    on(event: "jsdomError", listener: (error: Error) => void): void;
  };
};

function reactDiagnostic(args: unknown[]): string | undefined {
  const [message] = args;
  if (typeof message !== "string") return undefined;
  return Object.entries(REACT_DIAGNOSTICS).find(([, pattern]) =>
    pattern.test(message),
  )?.[0];
}

/** Every test ran and passed, so a missing diagnostic is evidence. */
function ranCompletely(task: RunnerTask): boolean {
  if (task.type === "test") {
    return task.mode === "run" && task.result?.state === "pass";
  }
  return (task.tasks ?? []).every(ranCompletely);
}

export function installUnassertedDiagnosticsGate(): void {
  const pending: Emission[] = [];
  const emitted = new Set<string>();
  let file = "";
  let fileTask: RunnerTask | undefined;
  let allowed = new Set<string>();
  let currentTest: string | null = null;
  let lastTest: string | null = null;

  const record = (kind: string, text: string) => {
    pending.push({
      kind,
      text: text.split("\n", 1)[0] ?? "",
      test: currentTest,
    });
  };

  // The setup file runs once per test file; should a worker reuse its console,
  // the symbol keeps the wrappers from stacking.
  const target = console as Console & { [ORIGINAL_ERROR]?: Console["error"] };
  const originalError = target[ORIGINAL_ERROR] ?? target.error;
  target[ORIGINAL_ERROR] = originalError;
  target.error = function error(this: Console, ...args: unknown[]) {
    const kind = reactDiagnostic(args);
    if (kind) record(kind, format(...args));
    return originalError.apply(this, args);
  };

  // jsdom's default virtual console writes to the worker's original console,
  // bypassing Vitest's per-test console and therefore the wrapper above.
  const dom =
    typeof window === "undefined"
      ? undefined
      : (window as Window & { jsdom?: JsdomHandle }).jsdom;
  dom?.virtualConsole.on("jsdomError", (error) => {
    if (error.message.startsWith("Not implemented:")) {
      record(JSDOM_NOT_IMPLEMENTED, error.message);
    }
  });

  const failOnUnasserted = (prefix: string) => {
    const emissions = pending.splice(0);
    for (const { kind } of emissions) emitted.add(kind);
    const unasserted = emissions.filter(({ kind }) => !allowed.has(kind));
    if (unasserted.length === 0) return;
    const lines = unasserted.map(
      ({ kind, text, test }) =>
        `  [${kind}]${test === null ? ` (after ${lastTest ?? "file setup"})` : ""} ${text}`,
    );
    throw new Error(
      `${prefix}unasserted diagnostic in ${file}:\n${lines.join("\n")}\n` +
        "Join the update through React's test boundary (await the async work, or act() around the call that triggers it), or spy on console.error and assert a deliberate diagnostic. " +
        `Adding an entry to ${ALLOWLIST_PATH} needs maintainer approval.`,
    );
  };

  beforeEach((context) => {
    if (!fileTask) {
      fileTask = context.task.file;
      file = `${PACKAGE_DIR}${context.task.file.name}`;
      const entries = allowlist.files as Record<
        string,
        { diagnostics: string[] }
      >;
      allowed = new Set(entries[file]?.diagnostics);
    }
    // Emissions since the previous test's afterEach, such as a late timer.
    failOnUnasserted("");
    currentTest = context.task.fullTestName ?? context.task.name;
  });

  afterEach(() => {
    lastTest = currentTest;
    currentTest = null;
    failOnUnasserted(`${lastTest}: `);
  });

  // Captured before any test can install fake timers.
  const realSetTimeout = globalThis.setTimeout;

  afterAll(async () => {
    // jsdom queues link navigation on a zero-delay timer; let one from the
    // file's last test report before judging the file.
    await new Promise((resolve) => realSetTimeout(resolve, 0));
    file ||= expect.getState().testPath ?? "a test file";
    failOnUnasserted("");
    if (!fileTask || allowed.size === 0 || !ranCompletely(fileTask)) return;
    const stale = [...allowed].filter((kind) => !emitted.has(kind));
    if (stale.length > 0) {
      throw new Error(
        `${file} no longer emits ${stale.join(", ")}. Remove ${stale.length === 1 ? "it" : "them"} from the file's entry in ${ALLOWLIST_PATH}, and delete the entry once its list is empty.`,
      );
    }
  });
}
