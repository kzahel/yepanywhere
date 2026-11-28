import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TemplateLibrary } from "../../src/projects/template-library.js";

describe("project template composition", () => {
  let root: string;
  let bases: string[];
  let templates: string[];
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "ya-template-"));
    bases = [];
    templates = [];
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function node(
    id: string,
    parents: string[] = [],
    files: Record<string, string> = {},
    options: {
      template?: boolean;
      status?: string;
      overrides?: unknown[];
      executable?: boolean;
    } = {},
  ) {
    (options.template ? templates : bases).push(id);
    const directory = join(
      root,
      "library",
      options.template ? "templates" : "bases",
      id,
    );
    await mkdir(directory, { recursive: true });
    const entries: { from: string; to: string; executable: boolean }[] = [];
    for (const [to, content] of Object.entries(files)) {
      const from = `file-${entries.length}`;
      await writeFile(join(directory, from), content);
      entries.push({ to, from, executable: options.executable ?? false });
    }
    await writeFile(
      join(directory, "template.json"),
      JSON.stringify({
        formatVersion: 1,
        id,
        kind: options.template ? "template" : "base",
        status: options.status ?? "ready",
        title: id,
        description: id,
        extends: parents,
        files: entries,
        overrides: options.overrides ?? [],
      }),
    );
    return directory;
  }
  async function load() {
    await writeFile(
      join(root, "library/library.json"),
      JSON.stringify({ formatVersion: 1, bases, templates }),
    );
    return TemplateLibrary.load(root, "library");
  }

  it("coalesces a diamond and deduplicates whole root fragments only", async () => {
    await node("base", [], { "AGENTS.md": "Universal" });
    await node("left", ["base"], {
      "AGENTS.md": "Shared",
      "guide.md": "Guide",
    });
    await node("right", ["base"], {
      "AGENTS.md": "Shared",
      "guide.md": "Guide",
      "other.md": "Guide",
    });
    await node(
      "app",
      ["left", "right"],
      { "AGENTS.md": "App" },
      { template: true },
    );
    const result = (await load()).readyComposition("app");
    expect(result.order).toEqual(["base", "left", "right", "app"]);
    expect(result.files.get("AGENTS.md")?.content.toString()).toBe(
      "Universal\n\nShared\n\nApp",
    );
    expect(result.files.get("guide.md")?.sources).toHaveLength(2);
    expect(result.files.get("other.md")?.content.toString()).toBe("Guide");
  });

  it("interleaves dependencies to satisfy sibling order", async () => {
    for (const id of ["x", "y", "z"]) await node(id);
    await node("a", ["x", "y"]);
    await node("b", ["z", "y"]);
    await node("app", ["a", "b"], {}, { template: true });
    expect((await load()).compose("app").order).toEqual([
      "x",
      "z",
      "y",
      "a",
      "b",
      "app",
    ]);
  });

  it("rejects opposing order constraints", async () => {
    await node("x");
    await node("y");
    await node("a", ["x", "y"]);
    await node("b", ["y", "x"]);
    await node("app", ["a", "b"], {}, { template: true });
    await expect(load()).rejects.toThrow("cycle");
  });
  it("rejects cycles even in unused bases", async () => {
    await node("a", ["b"]);
    await node("b", ["a"]);
    await expect(load()).rejects.toThrow("cycle");
  });
  it("rejects unknown transitive bases before traversal", async () => {
    await node("a", ["b"]);
    await node("b", ["missing"]);
    await expect(load()).rejects.toThrow("Unknown or repeated base");
  });

  it.each(["config.json", "nested/AGENTS.md"])(
    "rejects different bytes at %s",
    async (path) => {
      await node("left", [], { [path]: "left" });
      await node("right", [], { [path]: "right" });
      await node("app", ["left", "right"], {}, { template: true });
      await expect(load()).rejects.toThrow("file conflicts");
    },
  );
  it("rejects identical bytes with different executable modes", async () => {
    await node("left", [], { script: "same" });
    await node("right", [], { script: "same" }, { executable: true });
    await node("app", ["left", "right"], {}, { template: true });
    await expect(load()).rejects.toThrow("file conflicts");
  });

  it("resolves conflicts explicitly before text edits", async () => {
    await node("left", [], { "README.md": "left" });
    await node("right", [], { "README.md": "right", obsolete: "old" });
    const directory = await node(
      "app",
      ["left", "right"],
      {},
      {
        template: true,
        overrides: [
          { op: "replace", to: "README.md", from: "replacement" },
          { op: "prepend", to: "README.md", from: "before" },
          { op: "append", to: "README.md", from: "after" },
          { op: "omit", to: "obsolete" },
        ],
      },
    );
    for (const name of ["replacement", "before", "after"])
      await writeFile(join(directory, name), name);
    const result = (await load()).compose("app");
    expect(result.files.get("README.md")?.content.toString()).toBe(
      "before\nreplacement\nafter",
    );
    expect(result.files.has("obsolete")).toBe(false);
  });
  it("cannot choose a conflicting predecessor by appending", async () => {
    await node("left", [], { text: "left" });
    await node("right", [], { text: "right" });
    await node(
      "app",
      ["left", "right"],
      { extra: "tail" },
      {
        template: true,
        overrides: [{ op: "append", to: "text", from: "file-0" }],
      },
    );
    await expect(load()).rejects.toThrow("Unresolved template conflict");
  });
  it("refuses an append after omit", async () => {
    await node(
      "app",
      [],
      { text: "text" },
      {
        template: true,
        overrides: [
          { op: "omit", to: "text" },
          { op: "append", to: "text", from: "file-0" },
        ],
      },
    );
    await expect(load()).rejects.toThrow("existing file");
  });

  it.each([
    "../outside",
    "/absolute",
    ".git/config",
    "CON.txt",
    "dir/../escape",
    "dir\\escape",
  ])("rejects destination %s", async (path) => {
    await node("app", [], { [path]: "bad" }, { template: true });
    await expect(load()).rejects.toThrow(
      "Invalid portable template destination",
    );
  });
  it.each([
    ["a", "a/b"],
    ["A", "a"],
    ["Straße", "STRASSE"],
  ])("rejects portable path collisions %s / %s", async (first, second) => {
    await node(
      "app",
      [],
      { [first]: "first", [second]: "second" },
      { template: true },
    );
    await expect(load()).rejects.toThrow(/collision/);
  });
  it("validates drafts but refuses them for creation", async () => {
    await node(
      "app",
      [],
      { "README.md": "draft" },
      { template: true, status: "draft" },
    );
    const library = await load();
    expect(library.compose("app").files.size).toBe(1);
    expect(() => library.readyComposition("app")).toThrow("draft");
  });
  it("refuses ready templates inheriting draft bases", async () => {
    await node("base", [], {}, { status: "draft" });
    await node("app", ["base"], {}, { template: true });
    await expect(load()).rejects.toThrow("inherits draft");
  });
  it("rejects unknown manifest fields", async () => {
    const directory = await node("app", [], {}, { template: true });
    const value = JSON.parse(
      await readFile(join(directory, "template.json"), "utf8"),
    );
    await writeFile(
      join(directory, "template.json"),
      JSON.stringify({ ...value, shell: "execute me" }),
    );
    await expect(load()).rejects.toThrow();
  });

  it.skipIf(process.platform === "win32")(
    "dereferences contained links and retains validated bytes after source removal",
    async () => {
      const directory = await node(
        "app",
        [],
        { text: "original" },
        { template: true },
      );
      await writeFile(join(root, "shared"), "shared content");
      await rm(join(directory, "file-0"));
      await symlink("../../../shared", join(directory, "file-0"));
      const library = await load();
      await rm(join(root, "shared"));
      expect(
        library.readyComposition("app").files.get("text")?.content.toString(),
      ).toBe("shared content");
      await expect(load()).rejects.toThrow();
    },
  );
  it.skipIf(process.platform === "win32")(
    "refuses escaping source symlinks",
    async () => {
      const directory = await node(
        "app",
        [],
        { text: "original" },
        { template: true },
      );
      await rm(join(directory, "file-0"));
      await symlink(tmpdir(), join(directory, "file-0"));
      await expect(load()).rejects.toThrow("escapes repository");
    },
  );
  it("reports a missing content directory", async () => {
    await expect(TemplateLibrary.load(root, "missing")).rejects.toThrow();
  });

  it("materializes retained bytes and context into a fresh directory only", async () => {
    await node(
      "app",
      [],
      { "README.md": "Starter", "nested/file": "payload" },
      { template: true },
    );
    const library = await load();
    const target = join(root, "project");
    await library.materialize("app", target, {
      name: "My app",
      description: "My intent",
    });
    expect(await readFile(join(target, "nested/file"), "utf8")).toBe("payload");
    expect(
      JSON.parse(
        await readFile(join(target, ".project-template/project.json"), "utf8"),
      ),
    ).toMatchObject({
      name: "My app",
      description: "My intent",
      origin: { template: "app", order: ["app"] },
    });
    await writeFile(join(target, "README.md"), "User edit");
    await expect(
      library.materialize("app", target, {
        name: "Again",
        description: "Again",
      }),
    ).rejects.toThrow();
    expect(await readFile(join(target, "README.md"), "utf8")).toBe("User edit");
  });
});
