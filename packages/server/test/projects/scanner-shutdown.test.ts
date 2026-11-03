import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createApp } from "../setup/create-app.js";
import { ScriptedClaudeProvider } from "../support/scripted-provider.js";

const writes = vi.hoisted(() => ({
  entered: () => {},
  resume: Promise.resolve(),
  finished: false,
  count: 0,
}));

vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return {
    ...fs,
    writeFile: async (...args: Parameters<typeof fs.writeFile>) => {
      if (String(args[0]).includes("project-scanner-cache.json.tmp-")) {
        writes.count++;
        writes.entered();
        await writes.resume;
        await fs.writeFile(...args);
        writes.finished = true;
        return;
      }
      return fs.writeFile(...args);
    },
  };
});

it("app disposal settles the scanner writer and drops its trailing snapshot", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ya-scanner-shutdown-"));
  let release = () => {};
  const entered = new Promise<void>((resolve) => {
    writes.entered = resolve;
  });
  writes.resume = new Promise<void>((resolve) => {
    release = resolve;
  });
  writes.finished = false;
  writes.count = 0;
  const instance = createApp({
    dataDir: directory,
    projectsDir: join(directory, "projects"),
    provider: new ScriptedClaudeProvider(),
  });
  // App disposal awaits other services before reaching the scanner. Observe
  // that boundary explicitly rather than releasing the writer after one turn.
  let markScannerDisposing = () => {};
  const scannerDisposing = new Promise<void>((resolve) => {
    markScannerDisposing = resolve;
  });
  const disposeScanner = instance.scanner.dispose.bind(instance.scanner);
  vi.spyOn(instance.scanner, "dispose").mockImplementation(() => {
    const result = disposeScanner();
    markScannerDisposing();
    return result;
  });
  let disposal: Promise<void> | undefined;
  try {
    await instance.scanner.listProjects();
    await entered;
    instance.scanner.invalidateCache();
    await instance.scanner.listProjects();
    let finishedAtDisposal = false;
    disposal = instance.disposeSessionReaders().then(() => {
      finishedAtDisposal = writes.finished;
    });
    await scannerDisposing;
    release();
    await disposal;
    expect(finishedAtDisposal).toBe(true);
    expect(writes.count).toBe(1);
    await expect(instance.scanner.listProjects()).rejects.toThrow(
      "Project scanner is disposed",
    );
    await expect(
      readFile(join(directory, "indexes", "project-scanner-cache.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    release();
    instance.stopNotifications();
    await (disposal ?? instance.disposeSessionReaders());
    await rm(directory, { recursive: true, force: true });
  }
});
