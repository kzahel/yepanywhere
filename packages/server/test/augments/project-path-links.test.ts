import { EventEmitter } from "node:events";
import { execFile } from "node:child_process";
import type { Dirent, FSWatcher } from "node:fs";
import {
  mkdtemp,
  mkdir,
  lstat,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  linkifyProjectPaths,
  resolveProjectPathTextLinks,
} from "../../src/augments/project-path-links.js";
import {
  __test__,
  getProjectPathIndex,
  projectPathCacheDiagnostics,
  type PathIndexIo,
  type ProjectPathIndex,
} from "../../src/projects/projectPathIndex.js";
import { waitForSharedDirectoryWatchCloses } from "../../src/watcher/SharedDirectoryWatcher.js";

const execFileAsync = promisify(execFile);
const repos: string[] = [];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function createRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ya-path-index-"));
  repos.push(dir);
  return dir;
}

async function createGitRepo(): Promise<string> {
  const dir = await createRepo();
  await execFileAsync("git", ["-C", dir, "init"]);
  await execFileAsync("git", ["-C", dir, "config", "user.email", "t@example"]);
  await execFileAsync("git", ["-C", dir, "config", "user.name", "T"]);
  return dir;
}

interface RecordedIo extends PathIndexIo {
  readonly listed: string[];
  readonly probed: string[];
  readonly watched: string[];
  failWatch(path: string): void;
  emitError(path: string): void;
  emitEvent(path: string, filename: string): void;
  liveWatchers(): number;
}

/**
 * Filesystem adapter that records which paths each lookup touches, so a test
 * can assert the absence of I/O under an unrelated subtree rather than only
 * counting calls.
 */
function recordingIo(root: string): RecordedIo {
  const listed: string[] = [];
  const probed: string[] = [];
  const watched: string[] = [];
  const watchers = new Map<string, EventEmitter[]>();
  const unwatchable = new Set<string>();
  const relativeToRoot = (path: string) => relative(root, path) || ".";

  return {
    listed,
    probed,
    watched,
    failWatch(path) {
      unwatchable.add(path);
    },
    emitError(path) {
      for (const watcher of watchers.get(path) ?? []) {
        watcher.emit("error", new Error("watch overflow"));
      }
    },
    emitEvent(path, filename) {
      for (const watcher of watchers.get(path) ?? []) {
        watcher.emit("test:change", filename);
      }
    },
    liveWatchers() {
      let count = 0;
      for (const entries of watchers.values()) count += entries.length;
      return count;
    },
    lstat(path) {
      probed.push(relativeToRoot(path));
      return lstat(path);
    },
    readdir(path): Promise<Dirent[]> {
      listed.push(relativeToRoot(path));
      return readdir(path, { withFileTypes: true });
    },
    watch(path, listener) {
      const key = relativeToRoot(path);
      if (unwatchable.has(key)) throw new Error("watch unavailable");
      watched.push(key);
      const emitter = new EventEmitter();
      emitter.on("test:change", (filename: string) =>
        listener("rename", filename),
      );
      const existing = watchers.get(key) ?? [];
      existing.push(emitter);
      watchers.set(key, existing);
      return Object.assign(emitter, {
        close: () => {
          watchers.set(
            key,
            (watchers.get(key) ?? []).filter((entry) => entry !== emitter),
          );
        },
      }) as unknown as FSWatcher;
    },
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  __test__.reset();
  await waitForSharedDirectoryWatchCloses();
  await Promise.all(repos.splice(0).map((dir) => rm(dir, { recursive: true })));
});

describe("project path index", () => {
  it("links allowed absolute files through private project viewer routes", async () => {
    const repo = await createRepo();
    const index = await getProjectPathIndex(repo);
    const punctuationPath = "/tmp/report:name,final(1)&notes.md";
    const resolveAbsoluteFilePaths = vi.fn(
      async (paths: readonly string[]) =>
        new Set(
          paths.filter(
            (path) => path === "/tmp/report.md" || path === punctuationPath,
          ),
        ),
    );

    const html = await linkifyProjectPaths(
      "<span>/tmp/report.md /x /tmp/missing.md /tmp/report:name,final(1)&amp;notes.md</span>",
      {
        projectId: "project-1",
        projectPath: repo,
        index,
        resolveAbsoluteFilePaths,
      },
    );

    expect(resolveAbsoluteFilePaths).toHaveBeenCalledWith([
      "/tmp/report.md",
      "/tmp/missing.md",
      punctuationPath,
    ]);
    expect(html).toContain(
      'href="/projects/project-1/file?path=%2Ftmp%2Freport.md"',
    );
    expect(html).toContain('data-ya-private-project-file-link="true"');
    expect(html).toContain(
      "path=%2Ftmp%2Freport%3Aname%2Cfinal%281%29%26notes.md",
    );
    expect(html).toContain("/tmp/report:name,final(1)&amp;notes.md</a>");
    expect(html).toContain("/x");
    expect(html).not.toContain("path=%2Ftmp%2Fmissing.md");
    index.release();
  });

  it("links exact authorized Windows drive paths", async () => {
    const repo = await createRepo();
    const index = await getProjectPathIndex(repo);
    const allowed = "C:\\work\\report.md";
    const missing = "D:/work/missing.md";
    const resolveAbsoluteFilePaths = vi.fn(
      async (paths: readonly string[]) =>
        new Set(paths.filter((path) => path === allowed)),
    );

    const html = await linkifyProjectPaths(
      `<span>${allowed} ${missing}</span>`,
      {
        projectId: "project-1",
        projectPath: repo,
        index,
        resolveAbsoluteFilePaths,
      },
    );

    expect(resolveAbsoluteFilePaths).toHaveBeenCalledWith([allowed, missing]);
    expect(html).toContain("path=C%3A%5Cwork%5Creport.md");
    expect(html).toContain(`${allowed}</a>`);
    expect(html).not.toContain("path=D%3A%2Fwork%2Fmissing.md");
    index.release();
  });

  it("links home-relative paths to the file under the server's home", async () => {
    const repo = await createRepo();
    const index = await getProjectPathIndex(repo);
    const home = homedir();
    const report = join(home, "promotion/build/review.pdf");
    const resolveAbsoluteFilePaths = vi.fn(
      async (paths: readonly string[]) =>
        new Set(paths.filter((path) => path === report)),
    );
    const options = {
      projectId: "project-1",
      projectPath: repo,
      index,
      resolveAbsoluteFilePaths,
    };

    const html = await linkifyProjectPaths(
      "<code>~/promotion/build/review.pdf</code> <span>~/missing/file.md</span>",
      options,
    );
    expect(resolveAbsoluteFilePaths).toHaveBeenCalledWith([
      report,
      join(home, "missing/file.md"),
    ]);
    expect(html).toContain(`path=${encodeURIComponent(report)}`);
    expect(html).toContain("~/promotion/build/review.pdf</a>");
    expect(html).toContain("<span>~/missing/file.md</span>");

    expect(
      await resolveProjectPathTextLinks(
        "wrote ~/promotion/build/review.pdf",
        options,
      ),
    ).toEqual([{ text: "~/promotion/build/review.pdf", filePath: report }]);
    index.release();
  });

  it("links an absolute path cited with a line suffix, keeping the suffix", async () => {
    const repo = await createRepo();
    const index = await getProjectPathIndex(repo);
    const verify = join(homedir(), "agents/topics/verify.md");
    const literal = "/tmp/odd.md:12";
    const resolveAbsoluteFilePaths = vi.fn(
      async (paths: readonly string[]) =>
        new Set(
          paths.filter(
            (path) =>
              path === verify ||
              path === "/tmp/a.ts" ||
              path === literal ||
              path === "/tmp/odd.md",
          ),
        ),
    );
    const options = {
      projectId: "project-1",
      projectPath: repo,
      index,
      resolveAbsoluteFilePaths,
    };

    const html = await linkifyProjectPaths(
      `<p>see ~/agents/topics/verify.md:29-56 and /tmp/a.ts:4:7 and ${literal}</p>`,
      options,
    );
    expect(html).toContain(`path=${encodeURIComponent(verify)}&amp;line=29"`);
    expect(html).toContain("~/agents/topics/verify.md:29-56</a>");
    expect(html).toContain("path=%2Ftmp%2Fa.ts&amp;line=4&amp;column=7");
    // A file really named with the suffix wins over the citation reading.
    expect(html).toContain(`path=${encodeURIComponent(literal)}"`);

    expect(
      await resolveProjectPathTextLinks(
        "read ~/agents/topics/verify.md:29-56",
        options,
      ),
    ).toEqual([{ text: "~/agents/topics/verify.md:29-56", filePath: verify }]);
    index.release();
  });

  it("does not link an existing prefix of a longer absolute token", async () => {
    const repo = await createRepo();
    const index = await getProjectPathIndex(repo);
    const resolveAbsoluteFilePaths = vi.fn(async () =>
      Promise.resolve(new Set(["/tmp/report.md"])),
    );
    const source = "<span>/tmp/report.md,</span>";

    expect(
      await linkifyProjectPaths(source, {
        projectId: "project-1",
        projectPath: repo,
        index,
        resolveAbsoluteFilePaths,
      }),
    ).toBe(source);
    expect(resolveAbsoluteFilePaths).toHaveBeenCalledWith(["/tmp/report.md,"]);
    index.release();
  });

  it("does not probe or link absolute paths without an authenticated resolver", async () => {
    const repo = await createRepo();
    const index = await getProjectPathIndex(repo);
    const source = "<span>/tmp/report.md</span>";

    expect(
      await linkifyProjectPaths(source, {
        projectId: "project-1",
        projectPath: repo,
        index,
      }),
    ).toBe(source);
    index.release();
  });

  it("finds files inside gitignored directories", async () => {
    const repo = await createGitRepo();
    await writeFile(join(repo, "tracked.md"), "# tracked\n");
    await writeFile(join(repo, ".gitignore"), "untracked/\n");
    await execFileAsync("git", ["-C", repo, "add", "tracked.md", ".gitignore"]);
    await execFileAsync("git", ["-C", repo, "commit", "-m", "add"]);
    await mkdir(join(repo, "untracked/runs"), { recursive: true });
    await writeFile(join(repo, "untracked/runs/eval-v2.jsonl"), "{}\n");

    const index = await getProjectPathIndex(repo);

    expect(await index.has("tracked.md")).toBe(true);
    // The reported case: an agent hands over a path under an untracked
    // results directory, which `git ls-files` would never report.
    expect(await index.has("untracked/runs/eval-v2.jsonl")).toBe(true);
    expect(await index.has("does/not/exist.json")).toBe(false);
    expect(
      await linkifyProjectPaths("<span>untracked/runs/eval-v2.jsonl</span>", {
        projectPath: repo,
        index,
      }),
    ).toContain('data-ya-resource="local-file"');
    index.release();
  });

  it("creates an index without reading the project", async () => {
    const repo = await createRepo();
    await mkdir(join(repo, "runs"), { recursive: true });
    const io = recordingIo(repo);

    __test__.createIndex(repo, { io });
    await new Promise((done) => setTimeout(done, 20));

    expect(io.listed).toEqual([]);
    expect(io.probed).toEqual([]);
    expect(io.watched).toEqual([]);
  });

  it("links only cached path facts in known-only mode", async () => {
    const repo = await createRepo();
    await writeFile(join(repo, "known.md"), "# known\n");
    await writeFile(join(repo, "not-yet-known.md"), "# cold\n");
    const io = recordingIo(repo);
    const index = __test__.createIndex(repo, { io });
    expect(await index.has("known.md")).toBe(true);
    io.listed.length = 0;
    io.probed.length = 0;
    const knownAbsoluteFilePaths = vi.fn(
      (paths: readonly string[]) =>
        new Set(paths.filter((path) => path === "/tmp/report.md")),
    );
    const resolveAbsoluteFilePaths = vi.fn(async () =>
      Promise.resolve(new Set<string>()),
    );

    const html = await linkifyProjectPaths(
      "<span>known.md not-yet-known.md /tmp/report.md</span>",
      {
        projectId: "project-1",
        projectPath: repo,
        index,
        knownAbsoluteFilePaths,
        pathDiscovery: "known-only",
        resolveAbsoluteFilePaths,
      },
    );

    expect(html).toContain(`data-ya-path="${join(repo, "known.md")}"`);
    expect(html).toContain("path=%2Ftmp%2Freport.md");
    expect(html).toContain("not-yet-known.md");
    expect(html).not.toContain(
      `data-ya-path="${join(repo, "not-yet-known.md")}"`,
    );
    expect(knownAbsoluteFilePaths).toHaveBeenCalledWith(["/tmp/report.md"]);
    expect(resolveAbsoluteFilePaths).not.toHaveBeenCalled();
    expect(io.listed).toEqual([]);
    expect(io.probed).toEqual([]);
    index.dispose();
  });

  it("advances the public source revision when membership becomes uncertain", async () => {
    const repo = await createRepo();
    await writeFile(join(repo, "one.json"), "{}\n");
    const io = recordingIo(repo);
    const index = __test__.createIndex(repo, { io });

    expect(await index.has("one.json")).toBe(true);
    const observedRevision = index.sourceRevision();
    io.emitEvent(".", "one.json");

    expect(index.sourceRevision()).toBeGreaterThan(observedRevision);
    expect(index.knownFile("one.json")).toBeUndefined();
  });

  it("reads only the component chain a candidate uses", async () => {
    const repo = await createRepo();
    await mkdir(join(repo, "src/deep/nested"), { recursive: true });
    await writeFile(join(repo, "src/deep/nested/server.ts"), "export {};\n");
    // An unrelated subtree the size of a run-artifact directory.
    await mkdir(join(repo, "runs/eval"), { recursive: true });
    await Promise.all(
      Array.from({ length: 40 }, (_, entry) =>
        writeFile(join(repo, "runs/eval", `${entry}.jsonl`), "{}\n"),
      ),
    );
    const io = recordingIo(repo);
    const index = __test__.createIndex(repo, { io });

    expect(await index.has("src/deep/nested/server.ts")).toBe(true);

    expect(io.probed).toEqual([
      "src",
      join("src", "deep"),
      join("src", "deep", "nested"),
      join("src", "deep", "nested", "server.ts"),
    ]);
    expect(io.listed).toEqual([]);
    expect(io.watched.some((path) => path.startsWith("runs"))).toBe(false);
    index.dispose();
  });

  it("lists one directory for a wide batch, then answers it with no I/O", async () => {
    const repo = await createRepo();
    await mkdir(join(repo, "runs"), { recursive: true });
    await writeFile(join(repo, "runs/first.json"), "{}\n");
    const io = recordingIo(repo);
    const index = __test__.createIndex(repo, { io });

    const found = await index.findExisting([
      "runs/first.json",
      "runs/missing-a.json",
      "runs/missing-b.json",
      "runs/missing-c.json",
    ]);

    expect(found).toEqual(new Set(["runs/first.json"]));
    expect(io.listed).toEqual(["runs"]);
    // Only the `runs` component itself was probed; its children came from the
    // one listing.
    expect(io.probed).toEqual(["runs"]);

    __test__.resetDiagnostics(index);
    io.listed.length = 0;
    io.probed.length = 0;

    expect(
      await index.findExisting([
        "runs/first.json",
        "runs/missing-a.json",
        "runs/missing-z.json",
      ]),
    ).toEqual(new Set(["runs/first.json"]));
    expect(io.listed).toEqual([]);
    expect(io.probed).toEqual([]);
    expect(__test__.diagnostics(index)).toMatchObject({
      cachedAnswers: 4,
      completeDirectories: 1,
      directoryListings: 0,
      exactProbes: 0,
    });
    index.dispose();
  });

  it("answers knownFile from cache without any filesystem call", async () => {
    const repo = await createRepo();
    await mkdir(join(repo, "runs"), { recursive: true });
    await writeFile(join(repo, "runs/first.json"), "{}\n");
    await writeFile(join(repo, "Makefile"), "all:\n");
    const io = recordingIo(repo);
    const index = __test__.createIndex(repo, { io });

    // Nothing is hydrated yet, so nothing is proven either way.
    expect(index.knownFile("runs/first.json")).toBeUndefined();
    expect(index.knownFile("Makefile")).toBeUndefined();
    // A path that is not project-relative needs no filesystem call to rule out.
    expect(index.knownFile("/etc/passwd")).toBe(false);
    expect(index.knownFile("../outside.txt")).toBe(false);
    expect(io.probed).toEqual([]);
    expect(io.listed).toEqual([]);

    // One wide batch lists the project root, which proves every root name.
    await index.findExisting([
      "Makefile",
      "missing-a.json",
      "missing-b.json",
      "missing-c.json",
    ]);
    io.probed.length = 0;
    io.listed.length = 0;

    // An extensionless name the shape gate would never spend I/O on is now
    // free, because the directory holding it is complete.
    expect(index.knownFile("Makefile")).toBe(true);
    expect(index.knownFile("LICENSE")).toBe(false);
    // `runs` is a directory, not a file, and its children stay unproven.
    expect(index.knownFile("runs")).toBe(false);
    expect(index.knownFile("runs/first.json")).toBeUndefined();
    expect(io.probed).toEqual([]);
    expect(io.listed).toEqual([]);
    index.dispose();
  });

  it("refuses a cached knownFile answer once the watcher is gone", async () => {
    const repo = await createRepo();
    await writeFile(join(repo, "one.json"), "{}\n");
    const io = recordingIo(repo);
    const index = __test__.createIndex(repo, { io });

    expect(await index.has("one.json")).toBe(true);
    expect(index.knownFile("one.json")).toBe(true);

    // Losing the watch must degrade to "ask properly", never to a stale answer.
    io.emitError(".");
    expect(index.knownFile("one.json")).toBeUndefined();
    index.dispose();
  });

  it("probes a sparse candidate set instead of listing its directory", async () => {
    const repo = await createRepo();
    await mkdir(join(repo, "runs"), { recursive: true });
    await writeFile(join(repo, "runs/first.json"), "{}\n");
    const io = recordingIo(repo);
    const index = __test__.createIndex(repo, { io });

    expect(await index.findExisting(["runs/first.json"])).toEqual(
      new Set(["runs/first.json"]),
    );

    expect(io.listed).toEqual([]);
    expect(io.probed).toEqual(["runs", join("runs", "first.json")]);
    // A proven exact answer is cached without claiming the directory is
    // completely known.
    expect(__test__.diagnostics(index).completeDirectories).toBe(0);
    io.probed.length = 0;
    expect(await index.has("runs/first.json")).toBe(true);
    expect(io.probed).toEqual([]);
    index.dispose();
  });

  it("lists a directory a stream of small batches keeps probing", async () => {
    const repo = await createRepo();
    await mkdir(join(repo, "runs"), { recursive: true });
    for (const name of ["a.json", "b.json", "c.json", "d.json"]) {
      await writeFile(join(repo, "runs", name), "{}\n");
    }
    const io = recordingIo(repo);
    const index = __test__.createIndex(repo, { io });

    // Turn-text annotation asks about a couple of names per rendered body, so
    // no single batch is ever wide enough to earn a listing on its own.
    await index.findExisting(["runs/a.json", "runs/b.json"]);
    expect(io.listed).toEqual([]);
    await index.findExisting(["runs/c.json", "runs/d.json"]);

    // The directory's probes have accumulated past the threshold, so it is read
    // once instead of paying an `lstat` per name for the rest of the session.
    expect(io.listed).toEqual(["runs"]);
    expect(__test__.diagnostics(index).completeDirectories).toBe(1);
    io.probed.length = 0;
    io.listed.length = 0;

    // Every later name in it — present or absent — is now free.
    expect(await index.findExisting(["runs/e.json", "runs/a.json"])).toEqual(
      new Set(["runs/a.json"]),
    );
    expect(io.probed).toEqual([]);
    expect(io.listed).toEqual([]);
    index.dispose();
  });

  it("coalesces concurrent probes of the same candidate", async () => {
    const repo = await createRepo();
    await writeFile(join(repo, "one.json"), "{}\n");
    const io = recordingIo(repo);
    const index = __test__.createIndex(repo, { io });

    const [first, second] = await Promise.all([
      index.has("one.json"),
      index.has("one.json"),
    ]);

    expect([first, second]).toEqual([true, true]);
    expect(io.probed).toEqual(["one.json"]);
    index.dispose();
  });

  it.each(["EACCES", "EPERM"])(
    "releases an uncached watcher after %s",
    async (code) => {
      const repo = await createRepo();
      const io = recordingIo(repo);
      io.lstat = async (path) => {
        io.probed.push(relative(repo, path) || ".");
        throw Object.assign(new Error(code), { code });
      };
      const index = __test__.createIndex(repo, { io, maxIndexBytes: 0 });

      expect(await index.has("denied.txt")).toBe(false);
      expect(index.knownFile("denied.txt")).toBeUndefined();
      expect(io.liveWatchers()).toBe(0);
      expect(__test__.diagnostics(index)).toMatchObject({
        retainedBytes: 0,
        watchers: 0,
      });

      expect(await index.has("denied.txt")).toBe(false);
      expect(io.liveWatchers()).toBe(0);
      index.dispose();
    },
  );

  it("does not retain a watcher after invalidating its only child", async () => {
    const repo = await createRepo();
    const io = recordingIo(repo);
    const originalLstat = io.lstat;
    io.lstat = async (path) => {
      if (path.endsWith("denied.txt")) {
        io.probed.push(relative(repo, path) || ".");
        throw Object.assign(new Error("denied"), { code: "EACCES" });
      }
      return originalLstat(path);
    };
    const index = __test__.createIndex(repo, { io });

    expect(await index.has("changed.txt")).toBe(false);
    io.emitEvent(".", "changed.txt");
    expect(index.knownFile("changed.txt")).toBeUndefined();
    expect(io.liveWatchers()).toBe(0);

    expect(await index.has("denied.txt")).toBe(false);
    expect(io.liveWatchers()).toBe(0);
    expect(__test__.diagnostics(index)).toMatchObject({
      retainedBytes: 0,
      watchers: 0,
    });
    index.dispose();
  });

  it("prunes the only sparse child and closes its factless watcher", async () => {
    const repo = await createRepo();
    await writeFile(join(repo, "only.txt"), "only");
    const io = recordingIo(repo);
    const index = __test__.createIndex(repo, { io });

    expect(await index.has("only.txt")).toBe(true);
    expect(__test__.rootChildCount(index)).toBe(1);
    expect(__test__.diagnostics(index)).toMatchObject({ watchers: 1 });

    await rm(join(repo, "only.txt"));
    io.emitEvent(".", "only.txt");

    expect(__test__.rootChildCount(index)).toBe(0);
    expect(index.knownFile("only.txt")).toBeUndefined();
    expect(__test__.diagnostics(index)).toMatchObject({
      retainedBytes: 0,
      watchers: 0,
    });
    expect(io.liveWatchers()).toBe(0);

    expect(await index.has("only.txt")).toBe(false);
    expect(index.knownFile("only.txt")).toBe(false);
    expect(__test__.rootChildCount(index)).toBe(1);
    expect(io.liveWatchers()).toBe(1);

    index.dispose();
    expect(io.liveWatchers()).toBe(0);
  });

  it("does not let a stale W1 claim pin a factless replacement W2", async () => {
    const repo = await createRepo();
    const io = recordingIo(repo);
    const firstStarted = deferred<void>();
    const releaseFirst = deferred<void>();
    io.lstat = async (path) => {
      io.probed.push(relative(repo, path) || ".");
      if (path.endsWith("first.txt")) {
        firstStarted.resolve(undefined);
        await releaseFirst.promise;
      }
      throw Object.assign(new Error("denied"), { code: "EACCES" });
    };
    const index = __test__.createIndex(repo, { io });

    const first = index.has("first.txt");
    await firstStarted.promise;
    expect(io.liveWatchers()).toBe(1);

    // W1 fails while its probe still owns a stale observation. The second probe
    // installs W2, then releases its uncached result before the W1 probe exits.
    io.emitError(".");
    expect(io.liveWatchers()).toBe(0);
    expect(await index.has("second.txt")).toBe(false);
    expect(io.watched).toEqual([".", "."]);
    expect(io.liveWatchers()).toBe(0);
    expect(__test__.diagnostics(index).watchers).toBe(0);

    releaseFirst.resolve(undefined);
    expect(await first).toBe(false);
    expect(io.liveWatchers()).toBe(0);
    expect(__test__.diagnostics(index).watchers).toBe(0);

    index.dispose();
  });

  it("releases an exact-probe watcher when lstat throws", async () => {
    const repo = await createRepo();
    const io = recordingIo(repo);
    io.lstat = async (path) => {
      io.probed.push(relative(repo, path) || ".");
      throw new Error("lstat failed");
    };
    const index = __test__.createIndex(repo, { io, maxIndexBytes: 0 });

    await expect(index.has("broken.txt")).rejects.toThrow("lstat failed");
    expect(index.knownFile("broken.txt")).toBeUndefined();
    expect(io.liveWatchers()).toBe(0);
    expect(__test__.diagnostics(index)).toMatchObject({
      retainedBytes: 0,
      watchers: 0,
    });
    index.dispose();
  });

  it("does not accumulate uncached watchers across distinct projects", async () => {
    const indexes: ReturnType<typeof __test__.createIndex>[] = [];
    const adapters: RecordedIo[] = [];
    for (let project = 0; project < 18; project += 1) {
      const repo = await createRepo();
      const io = recordingIo(repo);
      const mode = project % 3;
      io.lstat = async () => {
        if (mode === 2) throw new Error("lstat failed");
        const code = mode === 0 ? "EACCES" : "EPERM";
        throw Object.assign(new Error(code), { code });
      };
      const index = __test__.createIndex(repo, { io, maxIndexBytes: 0 });
      indexes.push(index);
      adapters.push(io);

      if (mode === 2) {
        await expect(index.has("denied.txt")).rejects.toThrow("lstat failed");
      } else {
        expect(await index.has("denied.txt")).toBe(false);
      }
      expect(io.liveWatchers()).toBe(0);
    }

    expect(adapters.reduce((total, io) => total + io.liveWatchers(), 0)).toBe(
      0,
    );
    expect(
      indexes.reduce(
        (total, index) => total + __test__.diagnostics(index).watchers,
        0,
      ),
    ).toBe(0);
    for (const index of indexes) index.dispose();
  });

  it("retries a probe whose watcher generation changes during lstat", async () => {
    const repo = await createRepo();
    await writeFile(join(repo, "one.json"), "{}\n");
    const io = recordingIo(repo);
    const originalLstat = io.lstat;
    let calls = 0;
    io.lstat = async (path) => {
      calls += 1;
      expect(io.liveWatchers()).toBe(1);
      if (calls === 1) {
        const stale = await originalLstat(path);
        io.emitEvent(".", "one.json");
        return stale;
      }
      return originalLstat(path);
    };
    const index = __test__.createIndex(repo, { io });

    expect(await index.has("one.json")).toBe(true);
    expect(calls).toBe(2);
    expect(index.knownFile("one.json")).toBe(true);

    expect(await index.has("one.json")).toBe(true);
    expect(calls).toBe(2);
    index.dispose();
    expect(io.liveWatchers()).toBe(0);
  });

  it("returns a final uncached probe after two generation changes", async () => {
    const repo = await createRepo();
    const io = recordingIo(repo);
    let calls = 0;
    io.lstat = async (path) => {
      io.probed.push(relative(repo, path) || ".");
      calls += 1;
      if (calls === 1) {
        io.emitEvent(".", "one.json");
        return { isDirectory: () => false };
      }
      if (calls === 2) {
        io.emitEvent(".", "one.json");
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      }
      return { isDirectory: () => false };
    };
    const index = __test__.createIndex(repo, { io });

    expect(await index.has("one.json")).toBe(true);
    expect(calls).toBe(3);
    expect(index.knownFile("one.json")).toBeUndefined();
    expect(io.liveWatchers()).toBe(0);
    expect(__test__.diagnostics(index).watchers).toBe(0);

    index.dispose();
    expect(io.liveWatchers()).toBe(0);
  });

  it("holds and generation-fences a watcher while readdir is pending", async () => {
    const repo = await createRepo();
    await mkdir(join(repo, "runs"));
    for (const name of ["a.txt", "b.txt", "c.txt", "stale.txt"]) {
      await writeFile(join(repo, "runs", name), "x");
    }
    const io = recordingIo(repo);
    const originalLstat = io.lstat;
    const originalReaddir = io.readdir;
    const deniedStarted = deferred<void>();
    const releaseDenied = deferred<void>();
    const listingStarted = deferred<void>();
    const releaseListing = deferred<void>();
    io.lstat = async (path) => {
      if (path.endsWith("denied.txt")) {
        io.probed.push(relative(repo, path) || ".");
        deniedStarted.resolve(undefined);
        await releaseDenied.promise;
        throw Object.assign(new Error("denied"), { code: "EACCES" });
      }
      return originalLstat(path);
    };
    io.readdir = async (path) => {
      const staleEntries = await originalReaddir(path);
      listingStarted.resolve(undefined);
      await releaseListing.promise;
      return staleEntries;
    };
    const index = __test__.createIndex(repo, { io });

    // Cache only the root's `runs` edge, then make the exact probe install W1
    // for the otherwise-factless child directory.
    expect(await index.has("runs")).toBe(false);
    const denied = index.has("runs/denied.txt");
    await deniedStarted.promise;
    const listing = index.findExisting([
      "runs/a.txt",
      "runs/b.txt",
      "runs/c.txt",
      "runs/stale.txt",
    ]);
    await listingStarted.promise;

    releaseDenied.resolve(undefined);
    expect(await denied).toBe(false);
    // Root plus W1: releasing the exact probe cannot close the listing's claim.
    expect(io.liveWatchers()).toBe(2);
    expect(io.watched.filter((path) => path === "runs")).toHaveLength(1);

    await rm(join(repo, "runs", "stale.txt"));
    io.emitEvent("runs", "stale.txt");
    releaseListing.resolve(undefined);

    expect(await listing).toEqual(
      new Set(["runs/a.txt", "runs/b.txt", "runs/c.txt"]),
    );
    // The stale listing was not published. Exact fallback probes attach W2 and
    // cache the current negative fact instead.
    expect(index.knownFile("runs/stale.txt")).toBe(false);
    expect(io.watched.filter((path) => path === "runs")).toHaveLength(2);
    expect(io.liveWatchers()).toBe(2);

    index.dispose();
    expect(io.liveWatchers()).toBe(0);
  });

  it("does not reattach a detached parent while an exact probe is pending", async () => {
    const repo = await createRepo();
    await mkdir(join(repo, "outer/runs"), { recursive: true });
    await writeFile(join(repo, "outer/runs/seed.txt"), "seed");
    await writeFile(join(repo, "outer/runs/pending.txt"), "current");
    const io = recordingIo(repo);
    const index = __test__.createIndex(repo, { io });

    expect(await index.has("outer/runs/seed.txt")).toBe(true);
    const originalLstat = io.lstat;
    const firstProbeStarted = deferred<void>();
    const releaseFirstProbe = deferred<void>();
    let pendingCalls = 0;
    io.lstat = async (path) => {
      if (!path.endsWith("pending.txt")) return originalLstat(path);
      io.probed.push(relative(repo, path) || ".");
      pendingCalls += 1;
      if (pendingCalls === 1) {
        firstProbeStarted.resolve(undefined);
        await releaseFirstProbe.promise;
        return { isDirectory: () => false };
      }
      return lstat(path);
    };

    const pending = index.has("outer/runs/pending.txt");
    await firstProbeStarted.promise;
    expect(io.liveWatchers()).toBe(3);

    // Invalidating `outer` removes `runs` from the trie while its child probe is
    // awaiting I/O. The retry must reacquire from the root, see no attached
    // parent, and fall back to an uncached read rather than rewatching `runs`.
    io.emitEvent(".", "outer");
    expect(io.liveWatchers()).toBe(0);
    releaseFirstProbe.resolve(undefined);

    expect(await pending).toBe(true);
    expect(pendingCalls).toBe(2);
    expect(
      io.watched.filter((path) => path === join("outer", "runs")),
    ).toHaveLength(1);
    expect(index.knownFile("outer/runs/pending.txt")).toBeUndefined();
    expect(io.liveWatchers()).toBe(0);

    index.dispose();
    expect(io.liveWatchers()).toBe(0);
  });

  it("observes only the existing parent of a missing component", async () => {
    const repo = await createRepo();
    const io = recordingIo(repo);
    const index = __test__.createIndex(repo, { io });

    expect(await index.has("missing/child.txt")).toBe(false);
    expect(io.probed).toEqual(["missing"]);
    expect(io.watched).toEqual(["."]);
    expect(io.liveWatchers()).toBe(1);

    io.probed.length = 0;
    expect(await index.has("missing/child.txt")).toBe(false);
    expect(io.probed).toEqual([]);

    index.dispose();
    expect(io.liveWatchers()).toBe(0);
  });

  it("rejects absolute and parent-traversal paths before filesystem I/O", async () => {
    const repo = await createRepo();
    const io = recordingIo(repo);
    const index = __test__.createIndex(repo, { io });

    expect(
      await index.findExisting([
        "/etc/passwd",
        "../outside.txt",
        "runs/../../outside.txt",
      ]),
    ).toEqual(new Set());
    expect(io.probed).toEqual([]);
    expect(io.listed).toEqual([]);
    index.dispose();
  });

  it("invalidates a cached answer when the watched directory changes", async () => {
    const repo = await createRepo();
    await mkdir(join(repo, "runs"), { recursive: true });
    const io = recordingIo(repo);
    const index = __test__.createIndex(repo, { io });

    expect(await index.has("runs/late.json")).toBe(false);
    expect(io.watched).toContain("runs");

    await writeFile(join(repo, "runs/late.json"), "{}\n");
    io.emitEvent("runs", "late.json");

    expect(await index.has("runs/late.json")).toBe(true);
    expect(__test__.diagnostics(index).watcherInvalidations).toBe(1);

    await rm(join(repo, "runs/late.json"));
    io.emitEvent("runs", "late.json");

    expect(await index.has("runs/late.json")).toBe(false);
    index.dispose();
  });

  it("does not materialize edges for absent-name event churn", async () => {
    const repo = await createRepo();
    await writeFile(join(repo, "kept.json"), "{}\n");
    const io = recordingIo(repo);
    const index = __test__.createIndex(repo, { io });

    await index.findExisting([
      "kept.json",
      "missing-a.json",
      "missing-b.json",
      "missing-c.json",
    ]);
    const baselineBytes = __test__.diagnostics(index).retainedBytes;
    expect(__test__.rootChildCount(index)).toBe(1);
    expect(__test__.diagnostics(index).completeDirectories).toBe(1);

    for (let event = 0; event < 2_000; event += 1) {
      io.emitEvent(".", `untracked-${event}.json`);
    }

    // The first event invalidates completeness; later unqueried names retain no
    // edge, so both the child map and its byte estimate stay at the one fact the
    // listing actually observed.
    expect(__test__.rootChildCount(index)).toBe(1);
    expect(__test__.diagnostics(index)).toMatchObject({
      completeDirectories: 0,
      retainedBytes: baselineBytes,
      watchers: 1,
    });
    expect(index.knownFile("kept.json")).toBe(true);
    expect(index.knownFile("untracked-1999.json")).toBeUndefined();

    await writeFile(join(repo, "late.json"), "{}\n");
    io.emitEvent(".", "late.json");
    io.probed.length = 0;
    expect(await index.has("late.json")).toBe(true);
    expect(io.probed).toEqual(["late.json"]);
    expect(index.knownFile("late.json")).toBe(true);
    expect(__test__.rootChildCount(index)).toBe(2);

    index.dispose();
  });

  it("invalidates a complete listing entry by entry", async () => {
    const repo = await createRepo();
    await mkdir(join(repo, "runs"), { recursive: true });
    await writeFile(join(repo, "runs/kept.json"), "{}\n");
    const io = recordingIo(repo);
    const index = __test__.createIndex(repo, { io });

    await index.findExisting([
      "runs/kept.json",
      "runs/a.json",
      "runs/b.json",
      "runs/c.json",
    ]);
    expect(io.listed).toEqual(["runs"]);
    io.probed.length = 0;
    io.listed.length = 0;

    await writeFile(join(repo, "runs/a.json"), "{}\n");
    io.emitEvent("runs", "a.json");

    expect(
      await index.findExisting([
        "runs/kept.json",
        "runs/a.json",
        "runs/b.json",
      ]),
    ).toEqual(new Set(["runs/kept.json", "runs/a.json"]));
    // The named entry and arbitrary prior absences are re-probed: the event
    // invalidated listing completeness without retaining an unknown edge.
    expect(io.probed).toEqual([join("runs", "a.json"), join("runs", "b.json")]);
    expect(io.listed).toEqual([]);
    index.dispose();
  });

  it("preserves hydrated descendant watchers when re-listing a parent after a sibling change", async () => {
    const repo = await createRepo();
    await mkdir(join(repo, "packages/server/src"), { recursive: true });
    await writeFile(join(repo, "packages/server/src/app.ts"), "export {};\n");
    await writeFile(join(repo, "README.md"), "# repo\n");
    const io = recordingIo(repo);
    const index = __test__.createIndex(repo, { io });

    // Hydrate deep subtree + complete root listing.
    await index.findExisting([
      "packages/server/src/app.ts",
      "README.md",
      "a.txt",
      "b.txt",
      "c.txt",
    ]);
    expect(io.listed).toEqual(["."]);
    expect(index.knownFile("packages/server/src/app.ts")).toBe(true);
    const initialWatchers = __test__.diagnostics(index).watchers;
    expect(initialWatchers).toBe(4);
    const watchedBefore = io.watched.length;
    io.listed.length = 0;
    io.probed.length = 0;

    // An unrelated sibling edit in root invalidates root completeness, then a
    // wide root lookup triggers a fresh root listing (`replaceChildren`).
    await writeFile(join(repo, "tmp.txt"), "x\n");
    io.emitEvent(".", "tmp.txt");
    const revAfterEvent = index.sourceRevision();

    const found = await index.findExisting([
      "tmp.txt",
      "m1.txt",
      "m2.txt",
      "m3.txt",
    ]);
    expect(found).toEqual(new Set(["tmp.txt"]));
    expect(io.listed).toEqual(["."]);
    // Descendant directory watchers under `packages/server/src` stayed intact:
    // no re-watching, no lost cached facts, and no spurious revision bump.
    expect(io.watched.length).toBe(watchedBefore);
    expect(__test__.diagnostics(index).watchers).toBe(initialWatchers);
    expect(index.sourceRevision()).toBe(revAfterEvent);
    expect(index.knownFile("packages/server/src/app.ts")).toBe(true);
    expect(io.probed).toEqual([]);
    index.dispose();
  });

  it("invalidates a hydrated subtree when a parent relist detects a same-name inode replacement", async () => {
    const repo = await createRepo();
    await mkdir(join(repo, "runs"), { recursive: true });
    await writeFile(join(repo, "runs/old.json"), "{}\n");
    await writeFile(join(repo, "README.md"), "# repo\n");
    const io = recordingIo(repo);
    const index = __test__.createIndex(repo, { io });

    await index.findExisting(["runs/old.json", "README.md", "a", "b", "c"]);
    expect(index.knownFile("runs/old.json")).toBe(true);
    const revBefore = index.sourceRevision();

    // Replace `runs` with a fresh directory inode without delivering a `runs`
    // rename event; only a sibling change forces a parent relist.
    await rm(join(repo, "runs"), { recursive: true });
    await mkdir(join(repo, "runs"));
    await writeFile(join(repo, "sibling.txt"), "x\n");
    io.emitEvent(".", "sibling.txt");
    const revAfterSibling = index.sourceRevision();

    await index.findExisting(["sibling.txt", "m1", "m2", "m3"]);
    expect(index.sourceRevision()).toBeGreaterThan(revAfterSibling);
    expect(index.sourceRevision()).toBeGreaterThan(revBefore);
    expect(index.knownFile("runs/old.json")).toBeUndefined();
    expect(await index.has("runs/old.json")).toBe(false);

    // Replace a hydrated directory with a regular file between readdir and
    // identity verification: the contradicted listing must not publish it as a
    // directory or mark the parent complete.
    await writeFile(join(repo, "runs/new.json"), "{}\n");
    await index.findExisting(["runs/new.json"]);
    let mutateOnNextReaddir = true;
    const baseReaddir = io.readdir;
    io.readdir = async (path) => {
      const entries = await baseReaddir(path);
      if (mutateOnNextReaddir && path === repo) {
        mutateOnNextReaddir = false;
        await rm(join(repo, "runs"), { recursive: true });
        await writeFile(join(repo, "runs"), "now a file\n");
      }
      return entries;
    };
    io.emitEvent(".", "sibling.txt");
    expect(await index.findExisting(["runs", "x1", "x2", "x3", "x4"])).toEqual(
      new Set(["runs"]),
    );
    expect(mutateOnNextReaddir).toBe(false);
    expect(await index.has("runs")).toBe(true);
    index.dispose();
  });

  it.runIf(process.platform === "darwin")(
    "degrades warm caches during a stalled macOS close, clears stale facts on recovery, and does not spin on open failure",
    async () => {
      const { FocusedDirectoryWorker } = await import(
        "../../src/watcher/FocusedDirectoryWorker.js"
      );
      const { SharedDirectoryWatcher } = await import(
        "../../src/watcher/SharedDirectoryWatcher.js"
      );
      const handles: EventEmitter[] = [];
      let failOpen = false;
      const watchSpy = vi
        .spyOn(FocusedDirectoryWorker.prototype, "watch")
        .mockImplementation((_path, _retire) => {
          const handle = Object.assign(new EventEmitter(), {
            close: vi.fn(),
            ref: vi.fn().mockReturnThis(),
            unref: vi.fn().mockReturnThis(),
          });
          handles.push(handle);
          queueMicrotask(() => {
            if (failOpen) {
              handle.emit(
                "error",
                Object.assign(new Error("no space"), { code: "ENOSPC" }),
              );
            } else {
              handle.emit("ready");
            }
          });
          return handle as unknown as FSWatcher;
        });
      const blockedSpy = vi
        .spyOn(FocusedDirectoryWorker.prototype, "isBlockedInClose")
        .mockReturnValue(false);

      const registry = new SharedDirectoryWatcher();
      const repo = await createRepo();
      await writeFile(join(repo, "live.txt"), "ok\n");
      const listed: string[] = [];
      const io: PathIndexIo = {
        lstat: (path) => lstat(path),
        readdir: (path) => {
          listed.push(path);
          return readdir(path, { withFileTypes: true });
        },
        watch: (path, listener) =>
          registry.watch(
            path,
            { asyncReady: true, persistent: false },
            listener,
          ),
      };
      const index = __test__.createIndex(repo, { io });
      try {
        expect(await index.has("live.txt")).toBe(true);
        const warmRev = index.sourceRevision();

        // While the worker is stalled in a close, delete the file without
        // delivering the event: warm cache must degrade to direct lstat and
        // sourceRevision() must advance once and stay stable for the episode.
        await rm(join(repo, "live.txt"));
        blockedSpy.mockReturnValue(true);
        expect(index.knownFile("live.txt")).toBeUndefined();
        expect(await index.has("live.txt")).toBe(false);
        const stallRev = index.sourceRevision();
        expect(stallRev).toBeGreaterThan(warmRev);
        expect(index.sourceRevision()).toBe(stallRev);

        // Joining an already-ready focused watch on a fresh index during a
        // stall must not leave a factless lease retained.
        const freshDuringStall = __test__.createIndex(repo, { io });
        try {
          expect(await freshDuringStall.has("live.txt")).toBe(false);
          expect(__test__.diagnostics(freshDuringStall).watchers).toBe(0);
        } finally {
          freshDuringStall.dispose();
        }

        // Recovery clears cached facts without closing the healthy watcher, so
        // deleted files are never trusted again before delayed events arrive.
        // Replacing a hydrated subdirectory during the stall also invalidates
        // its old watcher on the next probe rather than reusing the old inode.
        await mkdir(join(repo, "sub"));
        await writeFile(join(repo, "sub/a.txt"), "ok\n");
        blockedSpy.mockReturnValue(false);
        expect(await index.has("sub/a.txt")).toBe(true);
        const subHandleBefore = handles.at(-1);
        blockedSpy.mockReturnValue(true);
        await rm(join(repo, "sub"), { recursive: true });
        await mkdir(join(repo, "sub"));
        await writeFile(join(repo, "sub/b.txt"), "ok\n");
        blockedSpy.mockReturnValue(false);
        for (const handle of [...handles]) handle.emit("stall-recovered");
        expect(index.knownFile("live.txt")).toBeUndefined();
        expect(index.sourceRevision()).toBeGreaterThan(stallRev);
        expect(await index.has("sub/b.txt")).toBe(true);
        expect(handles.at(-1)).not.toBe(subHandleBefore);

        // Persistent open failure must not trigger background reconcile loops
        // or bump uncertainGenerations / sourceRevision.
        failOpen = true;
        const repo2 = await createRepo();
        await writeFile(join(repo2, "only.txt"), "ok\n");
        const index2 = __test__.createIndex(repo2, { io });
        const rev2Before = index2.sourceRevision();
        try {
          expect(await index2.has("only.txt")).toBe(true);
          await new Promise((resolve) => setTimeout(resolve, 150));
          expect(__test__.diagnostics(index2).uncertainGenerations).toBe(0);
          expect(index2.sourceRevision()).toBe(rev2Before);
          expect(listed).toEqual([]);
        } finally {
          index2.dispose();
        }
      } finally {
        index.dispose();
        blockedSpy.mockRestore();
        watchSpy.mockRestore();
      }
    },
  );

  it("discards a generation the watcher can no longer vouch for", async () => {
    const repo = await createRepo();
    await mkdir(join(repo, "runs"), { recursive: true });
    await writeFile(join(repo, "runs/kept.json"), "{}\n");
    const io = recordingIo(repo);
    const index = __test__.createIndex(repo, { io });

    expect(await index.has("runs/missing.json")).toBe(false);
    io.probed.length = 0;

    // A watch error can hide any number of changes, so nothing it covered may
    // stay trusted.
    await writeFile(join(repo, "runs/missing.json"), "{}\n");
    io.emitError("runs");

    expect(__test__.diagnostics(index).uncertainGenerations).toBe(1);
    expect(await index.has("runs/missing.json")).toBe(true);

    // The scheduled reconciliation re-establishes the directory on its own.
    await vi.waitFor(() => expect(io.listed).toContain("runs"));
    index.dispose();
  });

  it("invalidates a replaced directory's own watcher and reconciliation", async () => {
    const repo = await createRepo();
    await mkdir(join(repo, "runs"));
    for (const name of ["old-a.txt", "old-b.txt", "old-c.txt"]) {
      await writeFile(join(repo, "runs", name), "old");
    }
    const io = recordingIo(repo);
    const index = __test__.createIndex(repo, { io });
    expect(await index.has("runs/old-a.txt")).toBe(true);

    const originalReaddir = io.readdir;
    const listingStarted = deferred<void>();
    const releaseListing = deferred<void>();
    io.readdir = async (path) => {
      const staleEntries = await originalReaddir(path);
      listingStarted.resolve(undefined);
      await releaseListing.promise;
      return staleEntries;
    };

    vi.useFakeTimers();
    try {
      // Losing W1 schedules reconciliation. The wide lookup attaches W2 while
      // retaining that timer, then pauses with an old-inode listing in flight.
      io.emitError("runs");
      const listing = index.findExisting([
        "runs/old-a.txt",
        "runs/old-b.txt",
        "runs/old-c.txt",
        "runs/replacement.txt",
      ]);
      await listingStarted.promise;
      expect(io.watched.filter((path) => path === "runs")).toHaveLength(2);
      expect(io.liveWatchers()).toBe(2);

      await rm(join(repo, "runs"), { recursive: true });
      await mkdir(join(repo, "runs"));
      await writeFile(join(repo, "runs/replacement.txt"), "replacement");
      io.emitEvent(".", "runs");

      // The parent event invalidates the child node itself, not only its cached
      // descendants: W2 closes and its old-inode reconciliation is cancelled.
      expect(io.liveWatchers()).toBe(0);
      releaseListing.resolve(undefined);
      expect(await listing).toEqual(new Set(["runs/replacement.txt"]));
      expect(index.knownFile("runs/replacement.txt")).toBeUndefined();

      await vi.advanceTimersByTimeAsync(__test__.RECONCILE_DELAY_MS * 2);
      expect(io.listed).toEqual(["runs"]);
      expect(io.liveWatchers()).toBe(0);

      // A later traversal reacquires the replacement from the root and installs
      // its own watcher before publishing the new fact.
      expect(await index.has("runs/replacement.txt")).toBe(true);
      expect(index.knownFile("runs/replacement.txt")).toBe(true);
      expect(io.watched.filter((path) => path === "runs")).toHaveLength(3);
      expect(io.liveWatchers()).toBe(2);
    } finally {
      index.dispose();
      vi.useRealTimers();
    }
    expect(io.liveWatchers()).toBe(0);
  });

  it("cancels reconciliation when budget eviction removes its ancestor", async () => {
    const repo = await createRepo();
    for (let cycle = 0; cycle < 4; cycle += 1) {
      await mkdir(join(repo, `runs-${cycle}`));
      await mkdir(join(repo, `other-${cycle}`));
    }
    const io = recordingIo(repo);
    const index = __test__.createIndex(repo, { io, maxIndexBytes: 300 });
    vi.useFakeTimers();
    try {
      for (let cycle = 0; cycle < 4; cycle += 1) {
        const watchedDirectory = `runs-${cycle}`;
        expect(await index.has(`${watchedDirectory}/missing.txt`)).toBe(false);
        io.emitError(watchedDirectory);

        // This second subtree pushes the root over budget. Evicting the root also
        // removes the watched child that owns the pending reconciliation.
        expect(await index.has(`other-${cycle}/missing.txt`)).toBe(false);
        expect(__test__.diagnostics(index)).toMatchObject({
          retainedBytes: 0,
          watchers: 0,
        });
        expect(
          index.knownFile(`${watchedDirectory}/missing.txt`),
        ).toBeUndefined();
      }

      await vi.advanceTimersByTimeAsync(__test__.RECONCILE_DELAY_MS * 2);
      expect(io.listed).toEqual([]);
      expect(io.liveWatchers()).toBe(0);
      expect(__test__.diagnostics(index)).toMatchObject({
        retainedBytes: 0,
        watchers: 0,
      });
    } finally {
      index.dispose();
      vi.useRealTimers();
    }
  });

  it("answers correctly when a directory cannot be watched", async () => {
    const repo = await createRepo();
    await mkdir(join(repo, "runs"), { recursive: true });
    await writeFile(join(repo, "runs/first.json"), "{}\n");
    const io = recordingIo(repo);
    io.failWatch("runs");
    const index = __test__.createIndex(repo, { io });

    expect(await index.has("runs/first.json")).toBe(true);
    io.probed.length = 0;

    // Nothing keeps an unwatched directory's answers true, so they are re-read
    // rather than trusted.
    expect(await index.has("runs/first.json")).toBe(true);
    expect(io.probed).toEqual([join("runs", "first.json")]);
    index.dispose();
  });

  it("keeps the queried names from an oversized listing without claiming it", async () => {
    const repo = await createRepo();
    await mkdir(join(repo, "wide"), { recursive: true });
    await Promise.all(
      Array.from({ length: 8 }, (_, entry) =>
        writeFile(join(repo, "wide", `${entry}.txt`), "x"),
      ),
    );
    const io = recordingIo(repo);
    const index = __test__.createIndex(repo, { io, maxRetainedEntries: 4 });

    const names = Array.from({ length: 8 }, (_, entry) => `wide/${entry}.txt`);
    expect((await index.findExisting(names)).size).toBe(8);

    const diagnostics = __test__.diagnostics(index);
    expect(diagnostics.oversizedListings).toBe(1);
    // Too wide to answer arbitrary absence, but the eight names it did prove
    // are worth exactly what the batch asked for.
    expect(diagnostics.completeDirectories).toBe(0);
    io.listed.length = 0;
    io.probed.length = 0;

    expect((await index.findExisting(names)).size).toBe(8);
    expect(io.listed).toEqual([]);
    expect(io.probed).toEqual([]);

    // A name outside that batch was never proven, so it costs one probe rather
    // than a second full read of the directory.
    expect(await index.has("wide/unqueried.txt")).toBe(false);
    expect(io.listed).toEqual([]);
    expect(io.probed).toEqual([join("wide", "unqueried.txt")]);
    index.dispose();
  });

  it("keeps claimed watchers while enforcing a per-index watcher ceiling", async () => {
    const repo = await createRepo();
    await mkdir(join(repo, "a"));
    await mkdir(join(repo, "b"));
    await writeFile(join(repo, "a/seed.txt"), "seed");
    await writeFile(join(repo, "a/pending.txt"), "pending");
    const io = recordingIo(repo);
    const originalLstat = io.lstat;
    const probeStarted = deferred<void>();
    const releaseProbe = deferred<void>();
    io.lstat = async (path) => {
      if (!path.endsWith("pending.txt")) return originalLstat(path);
      io.probed.push(relative(repo, path) || ".");
      probeStarted.resolve(undefined);
      await releaseProbe.promise;
      return originalLstat(path);
    };
    const index = __test__.createIndex(repo, { io, maxIndexWatchers: 2 });

    expect(await index.has("a/seed.txt")).toBe(true);
    const pending = index.has("a/pending.txt");
    await probeStarted.promise;
    expect(io.liveWatchers()).toBe(2);

    // Watching `b` would exceed the ceiling. The LRU candidate under `a` owns
    // the pending observation and the root is this traversal's ancestor, so the
    // lookup remains correct but uncached instead of closing either watcher.
    expect(await index.has("b/missing.txt")).toBe(false);
    expect(__test__.diagnostics(index).watchers).toBe(2);
    expect(io.liveWatchers()).toBe(2);

    releaseProbe.resolve(undefined);
    expect(await pending).toBe(true);
    expect(index.knownFile("a/pending.txt")).toBe(true);
    expect(__test__.diagnostics(index).watchers).toBe(2);

    index.dispose();
    expect(io.liveWatchers()).toBe(0);
  });

  it("drops least-recently-used subtrees over the project byte ceiling", async () => {
    const repo = await createRepo();
    for (const directory of ["one", "two", "three"]) {
      await mkdir(join(repo, directory), { recursive: true });
      await Promise.all(
        Array.from({ length: 6 }, (_, entry) =>
          writeFile(join(repo, directory, `${entry}.txt`), "x"),
        ),
      );
    }
    const io = recordingIo(repo);
    const index = __test__.createIndex(repo, { io, maxIndexBytes: 900 });

    for (const directory of ["one", "two", "three"]) {
      await index.findExisting(
        Array.from({ length: 6 }, (_, entry) => `${directory}/${entry}.txt`),
      );
    }

    const diagnostics = __test__.diagnostics(index);
    expect(diagnostics.evictedDirectories).toBeGreaterThan(0);
    expect(diagnostics.retainedBytes).toBeLessThanOrEqual(900);
    // Evicted state is rebuildable, so the answer is unchanged.
    expect(await index.has("one/0.txt")).toBe(true);
    index.dispose();
  });
});

describe("project path cache ownership", () => {
  it("shares one cache per project and releases each claim", async () => {
    const repo = await createRepo();
    await writeFile(join(repo, "one.json"), "{}\n");

    const first = await getProjectPathIndex(repo);
    const second = await getProjectPathIndex(repo);
    expect(__test__.registryEntry(repo)?.refs).toBe(2);

    expect(await first.has("one.json")).toBe(true);
    expect(await second.has("one.json")).toBe(true);
    expect(projectPathCacheDiagnostics().projects).toBe(1);

    first.release();
    first.release();
    expect(__test__.registryEntry(repo)?.refs).toBe(1);
    second.release();
    expect(__test__.registryEntry(repo)?.refs).toBe(0);
  });

  it("fences an exact probe across last release and reclaim", async () => {
    const repo = await createRepo();
    const projectPath = join(repo, "exact-activity");
    const io = recordingIo(repo);
    const probeStarted = deferred<void>();
    const releaseProbe = deferred<void>();
    io.lstat = async (path) => {
      io.probed.push(relative(repo, path) || ".");
      probeStarted.resolve(undefined);
      await releaseProbe.promise;
      return { isDirectory: () => false };
    };
    const oldClaim = __test__.claimIndex(projectPath, { io });

    const pending = oldClaim.has("pending.txt");
    await probeStarted.promise;
    oldClaim.release();
    const reclaimed = __test__.claimIndex(projectPath, { io });
    releaseProbe.resolve(undefined);

    expect(await pending).toBe(true);
    expect(io.probed).toEqual([join("exact-activity", "pending.txt")]);
    expect(reclaimed.knownFile("pending.txt")).toBeUndefined();
    expect(projectPathCacheDiagnostics().watchers).toBe(0);
    expect(io.liveWatchers()).toBe(0);

    reclaimed.release();
  });

  it("fences an ordinary listing across last release and reclaim", async () => {
    const repo = await createRepo();
    const projectPath = join(repo, "listing-activity");
    await mkdir(projectPath);
    for (const name of ["a", "b", "c", "d"]) {
      await writeFile(join(projectPath, name), name);
    }
    const io = recordingIo(repo);
    const originalReaddir = io.readdir;
    const listingStarted = deferred<void>();
    const releaseListing = deferred<void>();
    io.readdir = async (path) => {
      const entries = await originalReaddir(path);
      listingStarted.resolve(undefined);
      await releaseListing.promise;
      return entries;
    };
    io.lstat = async (path) => {
      io.probed.push(relative(repo, path) || ".");
      return { isDirectory: () => false };
    };
    const oldClaim = __test__.claimIndex(projectPath, { io });

    const pending = oldClaim.findExisting(["a", "b", "c", "d"]);
    await listingStarted.promise;
    oldClaim.release();
    const reclaimed = __test__.claimIndex(projectPath, { io });
    releaseListing.resolve(undefined);

    expect(await pending).toEqual(new Set(["a", "b", "c", "d"]));
    for (const name of ["a", "b", "c", "d"]) {
      expect(reclaimed.knownFile(name)).toBeUndefined();
    }
    expect(io.watched).toEqual(["listing-activity"]);
    expect(projectPathCacheDiagnostics().watchers).toBe(0);
    expect(io.liveWatchers()).toBe(0);

    reclaimed.release();
  });

  it("bounds thousands of released small-project indexes by inactive LRU count", async () => {
    const repo = await createRepo();
    const io = recordingIo(repo);
    io.lstat = async (path) => {
      io.probed.push(relative(repo, path) || ".");
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    };

    for (let project = 0; project < 2_000; project += 1) {
      const handle = __test__.claimIndex(join(repo, `project-${project}`), {
        io,
      });
      expect(await handle.has("missing.txt")).toBe(false);
      handle.release();
    }

    const diagnostics = projectPathCacheDiagnostics();
    expect(diagnostics.projects).toBeLessThanOrEqual(
      __test__.MAX_PROCESS_PROJECTS,
    );
    expect(diagnostics.watchers).toBeLessThanOrEqual(
      __test__.MAX_PROCESS_PROJECTS,
    );
    expect(diagnostics.watchers).toBe(io.liveWatchers());
    expect(diagnostics.retainedBytes).toBeLessThan(__test__.MAX_PROCESS_BYTES);
    expect(diagnostics.evictedProjects).toBeGreaterThan(1_000);
  });

  it("cancels reconciliation before released indexes can regrow", async () => {
    const repo = await createRepo();
    const io = recordingIo(repo);
    io.lstat = async (path) => {
      io.probed.push(relative(repo, path) || ".");
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    };

    vi.useFakeTimers();
    try {
      for (let project = 0; project < 1_500; project += 1) {
        const projectPath = join(repo, `reconcile-${project}`);
        const handle = __test__.claimIndex(projectPath, { io });
        expect(await handle.has("missing.txt")).toBe(false);
        io.emitError(relative(repo, projectPath));
        handle.release();
      }

      await vi.advanceTimersByTimeAsync(__test__.RECONCILE_DELAY_MS * 2);
      const diagnostics = projectPathCacheDiagnostics();
      expect(diagnostics).toMatchObject({ retainedBytes: 0, watchers: 0 });
      expect(diagnostics.projects).toBeLessThanOrEqual(
        __test__.MAX_PROCESS_PROJECTS,
      );
      expect(io.listed).toEqual([]);
      expect(io.liveWatchers()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fences reconciliation already reading when its last claim releases", async () => {
    const repo = await createRepo();
    const projectPath = join(repo, "in-flight-reconcile");
    const io = recordingIo(repo);
    io.lstat = async (path) => {
      io.probed.push(relative(repo, path) || ".");
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    };
    const listingStarted = deferred<void>();
    const releaseListing = deferred<void>();
    io.readdir = async (path) => {
      io.listed.push(relative(repo, path) || ".");
      listingStarted.resolve(undefined);
      await releaseListing.promise;
      return [];
    };

    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      const handle = __test__.claimIndex(projectPath, { io });
      expect(await handle.has("missing.txt")).toBe(false);
      io.emitError(relative(repo, projectPath));
      await vi.advanceTimersByTimeAsync(__test__.RECONCILE_DELAY_MS);
      await listingStarted.promise;
      expect(io.liveWatchers()).toBe(1);

      handle.release();
      releaseListing.resolve(undefined);
      for (let attempts = 0; io.liveWatchers() > 0; attempts += 1) {
        if (attempts >= 1_000) throw new Error("Reconciliation did not settle");
        await new Promise<void>((resolve) => setImmediate(resolve));
      }

      expect(__test__.registryEntry(projectPath)?.refs).toBe(0);
      expect(projectPathCacheDiagnostics()).toMatchObject({
        retainedBytes: 0,
        watchers: 0,
      });
      expect(io.listed).toEqual(["in-flight-reconcile"]);
    } finally {
      releaseListing.resolve(undefined);
      vi.useRealTimers();
    }
  });

  it("evicts inactive projects as an active index publishes watchers", async () => {
    const repo = await createRepo();
    const inactivePath = join(repo, "inactive-victim");
    const activePath = join(repo, "active-growth");
    const io = recordingIo(repo);
    io.lstat = async (path) => {
      io.probed.push(relative(repo, path) || ".");
      if (path.endsWith("missing.txt")) {
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      }
      return { isDirectory: () => true };
    };
    const inactive = __test__.claimIndex(inactivePath, { io });
    expect(await inactive.has("missing.txt")).toBe(false);
    inactive.release();
    expect(__test__.registryEntry(inactivePath)?.refs).toBe(0);

    const active = __test__.claimIndex(activePath, { io });
    const candidate = `${"d/".repeat(__test__.MAX_INDEX_WATCHERS - 1)}missing.txt`;
    expect(await active.has(candidate)).toBe(false);

    // The final active watcher crosses the process ceiling. Its publication,
    // rather than a later claim/release, immediately evicts the inactive victim.
    expect(__test__.registryEntry(inactivePath)).toBeUndefined();
    expect(__test__.registryEntry(activePath)?.refs).toBe(1);
    expect(projectPathCacheDiagnostics().watchers).toBe(
      __test__.MAX_INDEX_WATCHERS,
    );
    expect(io.liveWatchers()).toBe(__test__.MAX_INDEX_WATCHERS);

    active.release();
    __test__.enforceProcessLimits({ maxWatchers: 0 });
    expect(io.liveWatchers()).toBe(0);
  });

  it("caps one active watcher-heavy index at its own ceiling", async () => {
    const repo = await createRepo();
    const projectPath = join(repo, "watcher-heavy");
    const io = recordingIo(repo);
    io.lstat = async (path) => {
      io.probed.push(relative(repo, path) || ".");
      if (path.endsWith("missing.txt")) {
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      }
      return { isDirectory: () => true };
    };
    const held = __test__.claimIndex(projectPath, { io });
    const candidate = `${"d/".repeat(__test__.MAX_INDEX_WATCHERS)}missing.txt`;

    expect(await held.has(candidate)).toBe(false);
    expect(projectPathCacheDiagnostics().watchers).toBe(
      __test__.MAX_INDEX_WATCHERS,
    );
    __test__.enforceProcessLimits();
    expect(__test__.registryEntry(projectPath)?.refs).toBe(1);
    expect(io.liveWatchers()).toBe(__test__.MAX_INDEX_WATCHERS);

    held.release();
    expect(__test__.registryEntry(projectPath)?.refs).toBe(0);
    __test__.enforceProcessLimits({ maxWatchers: 0 });
    expect(__test__.registryEntry(projectPath)).toBeUndefined();
    expect(projectPathCacheDiagnostics()).toMatchObject({
      projects: 0,
      retainedBytes: 0,
      watchers: 0,
    });
    expect(io.liveWatchers()).toBe(0);
  });

  it("evicts unclaimed projects under process pressure and rebuilds on demand", async () => {
    const repo = await createRepo();
    await writeFile(join(repo, "one.json"), "{}\n");
    const claimed = await createRepo();
    await writeFile(join(claimed, "two.json"), "{}\n");

    const cold = await getProjectPathIndex(repo);
    expect(await cold.has("one.json")).toBe(true);
    cold.release();
    const held = await getProjectPathIndex(claimed);
    expect(await held.has("two.json")).toBe(true);

    // Force the pressure decision rather than retaining 32 MiB of names.
    __test__.enforceProcessLimits({ maxBytes: 0 });

    expect(projectPathCacheDiagnostics().projects).toBe(1);
    expect(__test__.registryEntry(repo)).toBeUndefined();
    // A claimed project is never evicted out from under its holder.
    expect(__test__.registryEntry(claimed)).toBeDefined();

    // The discarded project still answers; it simply rebuilds what it needs.
    const rebuilt = await getProjectPathIndex(repo);
    expect(await rebuilt.has("one.json")).toBe(true);
    rebuilt.release();
    held.release();
  });
});

describe("linkifyProjectPaths", () => {
  const index: ProjectPathIndex = {
    findExisting: async (paths: readonly string[]) =>
      new Set(paths.filter((path) => existsInFake(path))),
    has: async (path: string) => existsInFake(path),
    knownFile: (path: string) => existsInFake(path),
    release: () => undefined,
    sourceRevision: () => 1,
  };

  function existsInFake(path: string): boolean {
    return (
      path === "untracked/pii-eval/prod/nl-final20-control.jsonl" ||
      path === "scripts/run.py" ||
      path === "topics/performance-regression-suite.md"
    );
  }

  it("links a path that is a project file and leaves the rest alone", async () => {
    const html =
      '<span class="line">  &quot;path&quot;: ' +
      "&quot;untracked/pii-eval/prod/nl-final20-control.jsonl&quot;,</span>";

    const out = await linkifyProjectPaths(html, {
      projectPath: "/repo",
      index,
    });

    expect(out).toContain('data-ya-resource="local-file"');
    expect(out).toContain(
      "/repo/untracked/pii-eval/prod/nl-final20-control.jsonl",
    );
    // The JSON punctuation around the value is not swallowed into the link.
    expect(out).toContain("&quot;,</span>");
  });

  it("links paths relative to the viewed file directory", async () => {
    const existing = new Set([
      "RegressionTests/xmt/Privacy/input/aip2705-boundary.txt",
      "RegressionTests/xmt/Privacy/output/baseline.stdout",
      "scripts/run.py",
    ]);
    const asked: string[][] = [];
    const fileIndex: ProjectPathIndex = {
      findExisting: async (paths: readonly string[]) => {
        asked.push([...paths]);
        return new Set(paths.filter((path) => existing.has(path)));
      },
      has: async (path: string) => existing.has(path),
      knownFile: (path: string) => existing.has(path),
      release: () => undefined,
      sourceRevision: () => 1,
    };
    const html =
      "<span>$ROOT/input/aip2705-boundary.txt " +
      "output/baseline.stdout scripts/run.py missing.txt</span>";

    const out = await linkifyProjectPaths(html, {
      projectPath: "/repo",
      index: fileIndex,
      selfRelativePath:
        "RegressionTests/xmt/Privacy/regtest-aip2705-boundary.yml",
    });

    expect(out).toContain(
      'data-ya-path="/repo/RegressionTests/xmt/Privacy/input/aip2705-boundary.txt"',
    );
    expect(out).toContain(">$ROOT/input/aip2705-boundary.txt</a>");
    expect(out).toContain(
      'data-ya-path="/repo/RegressionTests/xmt/Privacy/output/baseline.stdout"',
    );
    expect(out).toContain('data-ya-path="/repo/scripts/run.py"');
    expect(out).not.toContain(
      "/repo/RegressionTests/xmt/Privacy/scripts/run.py",
    );
    expect(out).not.toContain("missing.txt</a>");
    expect(asked).toHaveLength(1);
  });

  it("directly resolves deduplicated words beside a short external file", async () => {
    const projectPath = await createRepo();
    const externalRoot = await createRepo();
    const viewedFile = join(externalRoot, "config", "view.yml");
    const sibling = join(externalRoot, "config", "XMTConfig-ont.yml");
    const model = join(externalRoot, "models", "boundary-refiner.onnx");
    const findExisting = vi.fn(async () => new Set<string>());
    const externalIndex: ProjectPathIndex = {
      findExisting,
      has: async () => false,
      knownFile: () => undefined,
      release: () => undefined,
      sourceRevision: () => 1,
    };
    const resolveAbsoluteFilePaths = vi.fn(
      async (paths: readonly string[]) =>
        new Set(paths.filter((path) => path === sibling || path === model)),
    );

    const out = await linkifyProjectPaths(
      "<span>basis XMTConfig-ont.yml ../models/boundary-refiner.onnx " +
        "call call</span>",
      {
        projectId: "project-1",
        projectPath,
        index: externalIndex,
        selfAbsolutePath: viewedFile,
        selfRelativePath: viewedFile,
        resolveAbsoluteFilePaths,
      },
    );

    expect(findExisting).not.toHaveBeenCalled();
    expect(resolveAbsoluteFilePaths).toHaveBeenCalledTimes(1);
    expect(resolveAbsoluteFilePaths.mock.calls[0]?.[0]).toEqual([
      join(externalRoot, "config", "basis"),
      sibling,
      model,
      join(externalRoot, "config", "call"),
    ]);
    expect(out).toContain(`path=${encodeURIComponent(sibling)}`);
    expect(out).toContain(">XMTConfig-ont.yml</a>");
    expect(out).toContain(`path=${encodeURIComponent(model)}`);
    expect(out).toContain(">../models/boundary-refiner.onnx</a>");
    expect(out).not.toContain(">call</a>");
  });

  it("checks only path-shaped words when an external file exceeds the cap", async () => {
    const projectPath = await createRepo();
    const externalRoot = await createRepo();
    const viewedFile = join(externalRoot, "config", "view.yml");
    const model = join(externalRoot, "models", "refiner.onnx");
    const settings = join(externalRoot, "config", "settings.json");
    const resolveAbsoluteFilePaths = vi.fn(async () => new Set([model]));
    const words = Array.from({ length: 70 }, (_, index) => `word${index}`);

    const out = await linkifyProjectPaths(
      `<span>${words.join(" ")} ../models/refiner.onnx settings.json ` +
        "../models/refiner.onnx</span>",
      {
        projectId: "project-1",
        projectPath,
        index,
        selfAbsolutePath: viewedFile,
        selfRelativePath: viewedFile,
        resolveAbsoluteFilePaths,
      },
    );

    expect(resolveAbsoluteFilePaths).toHaveBeenCalledWith([model, settings]);
    expect(out).toContain(">../models/refiner.onnx</a>");
    expect(out).not.toContain(">settings.json</a>");
  });

  it("prefers a project-relative path over a file-relative collision", async () => {
    const existing = new Set(["shared.txt", "configs/shared.txt"]);
    const collisionIndex: ProjectPathIndex = {
      findExisting: async (paths: readonly string[]) =>
        new Set(paths.filter((path) => existing.has(path))),
      has: async (path: string) => existing.has(path),
      knownFile: (path: string) => existing.has(path),
      release: () => undefined,
      sourceRevision: () => 1,
    };

    const out = await linkifyProjectPaths("<span>shared.txt</span>", {
      projectPath: "/repo",
      index: collisionIndex,
      selfRelativePath: "configs/view.yml",
    });

    expect(out).toContain('data-ya-path="/repo/shared.txt"');
    expect(out).not.toContain('data-ya-path="/repo/configs/shared.txt"');
  });

  it("resolves only exact existing tokens in raw command text", async () => {
    const targets = await resolveProjectPathTextLinks(
      "cat topics/performance-regression-suite.md topics/commits.md",
      {
        projectId: "project-1",
        projectPath: "/repo",
        index,
        gateLookupsByShape: true,
      },
    );

    expect(targets).toEqual([
      {
        filePath: "topics/performance-regression-suite.md",
        text: "topics/performance-regression-suite.md",
      },
    ]);
  });

  it("keeps viewed-file root markers literal outside a file viewer", async () => {
    const rootMarkerIndex: ProjectPathIndex = {
      findExisting: async (paths: readonly string[]) =>
        new Set(paths.filter((path) => path === "input/request.txt")),
      has: async (path: string) => path === "input/request.txt",
      knownFile: (path: string) => path === "input/request.txt",
      release: () => undefined,
      sourceRevision: () => 1,
    };

    await expect(
      resolveProjectPathTextLinks("$ROOT/input/request.txt", {
        projectId: "project-1",
        projectPath: "/repo",
        index: rootMarkerIndex,
        gateLookupsByShape: true,
      }),
    ).resolves.toEqual([]);
  });

  it("does not link a string that merely looks like a path", async () => {
    const html =
      '<span class="line">"media": "application/json", "v": "1.2.3", ' +
      '"missing": "runs/absent.jsonl"</span>';

    expect(
      await linkifyProjectPaths(html, { projectPath: "/repo", index }),
    ).toBe(html);
  });

  it("never rewrites markup, only text between tags", async () => {
    // A tag attribute happens to contain a real project path.
    const html = '<span class="scripts/run.py">plain</span>';

    expect(
      await linkifyProjectPaths(html, { projectPath: "/repo", index }),
    ).toBe(html);
  });

  it("does not link the file being viewed to itself", async () => {
    const html = '<span class="line">scripts/run.py</span>';

    expect(
      await linkifyProjectPaths(html, {
        projectPath: "/repo",
        index,
        selfRelativePath: "scripts/run.py",
      }),
    ).toBe(html);
  });

  it("returns content unchanged when nothing is indexed", async () => {
    const html = '<span class="line">scripts/run.py</span>';
    const empty: ProjectPathIndex = {
      findExisting: async () => new Set<string>(),
      has: async () => false,
      knownFile: () => false,
      release: () => undefined,
      sourceRevision: () => 1,
    };

    expect(
      await linkifyProjectPaths(html, { projectPath: "/repo", index: empty }),
    ).toBe(html);
  });

  it("leaves text inside an existing anchor alone", async () => {
    // Turn text carries anchors the markdown renderer and the inline-code file
    // linker already emitted; an `<a>` nested inside one renders as neither.
    const html =
      '<p>See <a href="/x" data-ya-resource="local-file">scripts/run.py</a> ' +
      "and scripts/run.py</p>";

    const out = await linkifyProjectPaths(html, {
      projectPath: "/repo",
      index,
    });

    expect(out).toContain('data-ya-resource="local-file">scripts/run.py</a>');
    // Exactly one new link: the bare occurrence outside the anchor.
    expect(out.match(/<a /g)).toHaveLength(2);
    expect(out).toContain("/repo/scripts/run.py");
  });

  it("spends lookups only on path-shaped tokens when gated", async () => {
    const asked: string[][] = [];
    const gatedIndex: ProjectPathIndex = {
      findExisting: async (paths: readonly string[]) => {
        asked.push([...paths]);
        return new Set(paths.filter((path) => existsInFake(path)));
      },
      has: async (path: string) => existsInFake(path),
      knownFile: () => undefined,
      release: () => undefined,
      sourceRevision: () => 1,
    };
    const html =
      "<p>The run wrote scripts/run.py after reading config, which the " +
      "operator kept at version 1.2.3 and reviewed before merging.</p>";

    const out = await linkifyProjectPaths(html, {
      projectPath: "/repo",
      index: gatedIndex,
      gateLookupsByShape: true,
    });

    expect(out).toContain("/repo/scripts/run.py");
    // Ordinary prose costs nothing: only the separator-bearing token is asked
    // about. `1.2.3` has no letter in its trailing run, so it stays a version,
    // and every bare word is skipped without a lookup.
    expect(asked).toEqual([["scripts/run.py"]]);
  });

  it("links an extensionless name the cache already proves", async () => {
    const asked: string[][] = [];
    const cachedIndex: ProjectPathIndex = {
      findExisting: async (paths: readonly string[]) => {
        asked.push([...paths]);
        return new Set<string>();
      },
      has: async () => false,
      // Stands in for a listed, complete root: `Makefile` is proven present and
      // `LICENSE` proven absent, both without I/O.
      knownFile: (path: string) =>
        path === "Makefile" ? true : path === "LICENSE" ? false : undefined,
      release: () => undefined,
      sourceRevision: () => 1,
    };
    const html = "<p>Run Makefile, not LICENSE.</p>";

    const out = await linkifyProjectPaths(html, {
      projectPath: "/repo",
      index: cachedIndex,
      gateLookupsByShape: true,
    });

    expect(out).toContain("/repo/Makefile");
    expect(out).not.toContain("/repo/LICENSE");
    // Neither name is path-shaped, so neither was allowed to cost a lookup.
    expect(asked).toEqual([[]]);
  });

  it("does lookup I/O per referenced directory, not per token", async () => {
    const repo = await createRepo();
    await mkdir(join(repo, "runs"));
    await writeFile(join(repo, "runs/exists.json"), "{}\n");
    const io = recordingIo(repo);
    const realIndex = __test__.createIndex(repo, { io });

    const tokens = Array.from({ length: 4_000 }, (_, tokenIndex) =>
      tokenIndex % 20 === 0
        ? "runs/exists.json"
        : `runs/missing-${tokenIndex % 200}.json`,
    );
    const out = await linkifyProjectPaths(`<span>${tokens.join(" ")}</span>`, {
      projectPath: repo,
      index: realIndex,
    });

    expect(out).toContain('data-ya-resource="local-file"');
    // 191 distinct candidates in one directory: one probe for the directory
    // component and one listing that answers every name in it.
    expect(__test__.diagnostics(realIndex)).toMatchObject({
      directoryListings: 1,
      exactProbes: 1,
      lookupCandidates: 191,
    });
    realIndex.dispose();
  });
});
