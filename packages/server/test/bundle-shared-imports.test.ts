import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { rewriteSharedImports } from "../../../scripts/rewrite-shared-imports.js";

it("loads rewritten root, flat, nested and dotted imports without workspace links", () => {
  const root = mkdtempSync(join(tmpdir(), "ya bundle imports "));
  try {
    writeFileSync(join(root, "package.json"), '{"type":"module"}');
    const modules = {
      "index.js": 'export const root = "root";',
      "sqlite.js": 'export const flat = "flat";',
      "experimental/simple-client.generated.js":
        'export const schema = "schema";',
      "experimental/conversation-protocol.js":
        'export const protocol = "protocol";',
      "transcript/compiler.js": 'export const compiler = "compiler";',
      "transcript/parsers/bash.js": 'export const parser = "parser";',
      "server-runtime.js": 'globalThis.sideEffect = "side effect";',
    };
    for (const [name, source] of Object.entries(modules)) {
      const file = join(root, "bundled/shared/dist", name);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, source);
    }
    const source = `
      import { root } from "@yep-anywhere/shared";
      import { flat } from '@yep-anywhere/shared/sqlite';
      import { schema } from "@yep-anywhere/shared/experimental/simple-client.generated";
      export { protocol } from "@yep-anywhere/shared/experimental/conversation-protocol";
      import { compiler } from "@yep-anywhere/shared/transcript/compiler";
      import "@yep-anywhere/shared/server-runtime";
      const { parser } = await import("@yep-anywhere/shared/transcript/parsers/bash");
      export const values = [root, flat, schema, compiler, parser, globalThis.sideEffect];
    `;
    const entry = join(root, "entry.js");
    writeFileSync(
      entry,
      rewriteSharedImports(source, "./bundled/shared/dist/index.js"),
    );
    const result = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `const result = await import(${JSON.stringify(pathToFileURL(entry).href)}); process.stdout.write(JSON.stringify(result));`,
      ],
      { encoding: "utf8" },
    );
    expect(JSON.parse(result)).toEqual({
      protocol: "protocol",
      values: ["root", "flat", "schema", "compiler", "parser", "side effect"],
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("leaves ordinary strings and other package names unchanged", () => {
  const source = `const name = "@yep-anywhere/shared/experimental/simple-client.generated";
import { value } from "@yep-anywhere/shared-other";`;
  expect(rewriteSharedImports(source, "../bundled/shared/dist/index.js")).toBe(
    source,
  );
});
