import { sep } from "node:path";

export async function installFreshnessProbe(
  { target, startupControl },
  mark,
  packageStack,
) {
  let portListFinished = false;
  const { FileWatcher } = await import(
    "../../packages/server/src/watcher/FileWatcher.ts"
  );
  const { RetainedSessionCollections } = await import(
    "../../packages/server/src/services/RetainedSessionCollections.ts"
  );
  const { ProjectScanner } = await import(
    "../../packages/server/src/projects/scanner.ts"
  );
  const list = ProjectScanner.prototype.listProjects;
  ProjectScanner.prototype.listProjects = async function (...args) {
    const stack = packageStack();
    if (!stack.some((frame) => frame.includes("holdDeclaredHostPorts")))
      return list.apply(this, args);
    mark("port-list-start", true);
    try {
      return startupControl === "empty-ports"
        ? []
        : await list.apply(this, args);
    } finally {
      mark("port-list-end");
      portListFinished = true;
    }
  };
  const { ProjectDiscoveryFacts } = await import(
    "../../packages/server/src/projects/project-discovery-facts.ts"
  );
  let firstObservation = true;
  const begin = ProjectDiscoveryFacts.prototype.beginObservation;
  ProjectDiscoveryFacts.prototype.beginObservation = async function (...args) {
    if (firstObservation && startupControl === "observe-first") {
      firstObservation = false;
      const until = Date.now() + 20000;
      while (readyFreshnessWatchers().length !== 2 && Date.now() < until)
        await new Promise((resolve) => setTimeout(resolve, 25));
      if (readyFreshnessWatchers().length !== 2)
        throw new Error("Startup control did not obtain both watchers");
      mark("observed-order-control");
    }
    const proof = await begin.apply(this, args);
    for (const root of proof.roots)
      mark(
        "discovery-" +
          root.family +
          (root.epoch === null ? "-unobserved" : "-observed"),
      );
    return proof;
  };
  const watchers = new Map();
  const readyFreshnessWatchers = () =>
    [...watchers]
      .filter(([, watcher]) => watcher.getObservationEpoch() !== null)
      .map(([family]) => family)
      .sort();
  let claudeWatcher;
  const start = FileWatcher.prototype.start;
  FileWatcher.prototype.start = function (...args) {
    const value = start.apply(this, args);
    if (["claude", "codex"].includes(this.provider))
      watchers.set(this.provider, this);
    if (this.provider === "claude" && target.startsWith(this.watchDir + sep))
      claudeWatcher = this;
    return value;
  };
  let injected = false;
  const deliverFreshnessHint = () => {
    if (!claudeWatcher?.isWatching) return false;
    injected = true;
    try {
      claudeWatcher.handleFileEvent(
        "change",
        target.slice(claudeWatcher.watchDir.length + 1),
      );
    } finally {
      injected = false;
    }
    return true;
  };
  const raw = FileWatcher.prototype.handleAbsoluteFileEvent;
  FileWatcher.prototype.handleAbsoluteFileEvent = function (
    type,
    path,
    ...args
  ) {
    if (path === target) mark(injected ? "injected" : "native");
    return raw.call(this, type, path, ...args);
  };
  const changed = FileWatcher.prototype.emitFileChangeEvent;
  FileWatcher.prototype.emitFileChangeEvent = function (
    path,
    kind,
    metrics,
    ...args
  ) {
    if (path === target) mark("file-event-" + (metrics?.reason ?? "direct"));
    return changed.call(this, path, kind, metrics, ...args);
  };
  const invalidate = RetainedSessionCollections.prototype.invalidate;
  RetainedSessionCollections.prototype.invalidate = function (path) {
    if (path === target || !path)
      mark(path ? "invalidate-file" : "invalidate-all", !path);
    return invalidate.call(this, path);
  };
  const reconcile = RetainedSessionCollections.prototype.reconcile;
  RetainedSessionCollections.prototype.reconcile = async function (paths) {
    const kind = paths ? (paths.has(target) ? "file" : "other") : "all";
    mark("start-" + kind);
    try {
      return await reconcile.call(this, paths);
    } finally {
      mark("end-" + kind);
    }
  };
  return {
    status: () => ({ ready: readyFreshnessWatchers(), portListFinished }),
    hint: deliverFreshnessHint,
  };
}
