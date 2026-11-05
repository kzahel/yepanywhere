import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { prepareBuiltClient } from "../../../../scripts/dev-built-client.mjs";

let root;
let builds;
const env = { ...process.env, VITE_TEST_VALUE: "before" };

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ya-client-cache-"));
  builds = 0;
  await mkdir(join(root, "packages/client/src"), { recursive: true });
  await mkdir(join(root, "packages/shared/src"), { recursive: true });
  await writeFile(join(root, "packages/client/src/app.js"), "before");
});
afterEach(async () => {
  await rm(root, { recursive: true });
});

async function build(directory) {
  builds += 1;
  await mkdir(join(directory, "assets"));
  await writeFile(
    join(directory, "assets", `app-${builds}.js`),
    `build ${builds}`,
  );
  await writeFile(join(directory, "index.html"), `build ${builds}`);
}

it("reuses unchanged output, detects same-size preserved-mtime edits, and bounds carried assets", async () => {
  const first = await prepareBuiltClient(root, build, undefined, env);
  expect(await prepareBuiltClient(root, build, first, env)).toBe(first);
  expect(builds).toBe(1);
  const source = join(root, "packages/client/src/app.js");
  const times = await stat(source);
  await writeFile(source, "edited");
  await utimes(source, times.atime, times.mtime);
  const second = await prepareBuiltClient(root, build, first, env);
  expect(second.directory).not.toBe(first.directory);
  expect(await readdir(join(second.directory, "assets"))).toEqual([
    "app-1.js",
    "app-2.js",
  ]);
  expect(await readFile(join(first.directory, "index.html"), "utf8")).toBe(
    "build 1",
  );
  const third = await prepareBuiltClient(root, build, second, {
    ...env,
    VITE_TEST_VALUE: "after",
  });
  expect(await readdir(join(third.directory, "assets"))).toEqual([
    "app-2.js",
    "app-3.js",
  ]);
});

it("invalidates shared sources, public and preboot files, configuration, dependencies, additions and deletions", async () => {
  let previous = await prepareBuiltClient(root, build, undefined, env);
  for (const name of [
    "packages/shared/src/model.ts",
    "packages/client/public/icon.svg",
    "packages/client/preboot/composer.js",
    "packages/client/.env.production",
    "packages/client/vite.config.ts",
    "pnpm-lock.yaml",
    "patches/dependency.patch",
    "node_modules/.pnpm/lock.yaml",
    "packages/client/src/new.js",
  ]) {
    const filename = join(root, name);
    await mkdir(join(filename, ".."), { recursive: true });
    await writeFile(filename, "new input");
    const added = await prepareBuiltClient(root, build, previous, env);
    expect(added.directory).not.toBe(previous.directory);
    await rm(filename);
    const removed = await prepareBuiltClient(root, build, added, env);
    expect(removed.directory).not.toBe(added.directory);
    previous = removed;
  }
});

it("rebuilds missing or altered output without trying to carry damaged assets", async () => {
  const first = await prepareBuiltClient(root, build, undefined, env);
  await rm(join(first.directory, "assets/app-1.js"));
  const second = await prepareBuiltClient(root, build, first, env);
  expect(second.directory).not.toBe(first.directory);
  await writeFile(join(second.directory, "index.html"), "corrupt");
  const third = await prepareBuiltClient(root, build, second, env);
  expect(await readFile(join(third.directory, "index.html"), "utf8")).toBe(
    "build 3",
  );
  await rm(third.directory, { recursive: true });
  const fourth = await prepareBuiltClient(root, build, third, env);
  expect(await readFile(join(fourth.directory, "index.html"), "utf8")).toBe(
    "build 4",
  );
});

it("rejects a source edit during build and leaves the incumbent reusable after retry", async () => {
  const first = await prepareBuiltClient(root, build, undefined, env);
  await writeFile(join(root, "packages/client/src/app.js"), "second");
  await expect(
    prepareBuiltClient(
      root,
      async (directory) => {
        await build(directory);
        await writeFile(join(root, "packages/client/src/app.js"), "third");
      },
      first,
      env,
    ),
  ).rejects.toThrow("inputs changed during build");
  expect(
    await readdir(join(root, "node_modules/.cache/ya-client")),
  ).toHaveLength(1);
  expect(await readFile(join(first.directory, "index.html"), "utf8")).toBe(
    "build 1",
  );
  const next = await prepareBuiltClient(root, build, first, env);
  expect(await prepareBuiltClient(root, build, next, env)).toBe(next);
});
