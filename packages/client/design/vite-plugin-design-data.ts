/**
 * Dev-server data for the design playground's census pages.
 *
 * `virtual:ya-design-data` exports every class selector declared in the
 * legacy global stylesheets, with how many times production TypeScript
 * sources spell it as a whole class token and in how many files. Counting is
 * textual, like `pnpm css:unused`: a class assembled at runtime from parts is
 * not seen. The module is recomputed when a client source changes, so the
 * census tracks a migration as it lands.
 *
 * It also appends Storybook's `__namedExportsOrder` to each *.specimen.tsx.
 *
 * `apply: "serve"` keeps it out of every build; only design.html imports it.
 */
import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import type { Plugin } from "vite";

const VIRTUAL_ID = "virtual:ya-design-data";
const RESOLVED_ID = `\0${VIRTUAL_ID}`;
const GLOBAL_STYLESHEETS = [
  "styles/index.css",
  "styles/renderers.css",
  "styles/tool-rows.css",
];

export interface DesignClassUsage {
  /** Global stylesheets that declare the class, relative to src/. */
  stylesheets: string[];
  uses: number;
  files: number;
}

async function sourceFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "__tests__") files.push(...(await sourceFiles(path)));
    } else if (
      /\.tsx?$/.test(entry.name) &&
      !/\.test\.tsx?$/.test(entry.name)
    ) {
      files.push(path);
    }
  }
  return files;
}

export async function collectDesignData(srcDir: string) {
  const classes = new Map<string, DesignClassUsage>();
  for (const stylesheet of GLOBAL_STYLESHEETS) {
    const text = (await readFile(join(srcDir, stylesheet), "utf8")).replace(
      /\/\*[\s\S]*?\*\//g,
      "",
    );
    // Selectors only: the text before each declaration block.
    for (const selector of text.matchAll(/([^{};]+)\{/g)) {
      for (const match of (selector[1] ?? "").matchAll(
        /\.(-?[A-Za-z_][\w-]*)/g,
      )) {
        const name = match[1] ?? "";
        const entry = classes.get(name) ?? {
          stylesheets: [],
          uses: 0,
          files: 0,
        };
        if (!entry.stylesheets.includes(stylesheet))
          entry.stylesheets.push(stylesheet);
        classes.set(name, entry);
      }
    }
  }
  for (const file of await sourceFiles(srcDir)) {
    const counts = new Map<string, number>();
    for (const token of (await readFile(file, "utf8")).split(/[^\w-]+/)) {
      if (classes.has(token)) counts.set(token, (counts.get(token) ?? 0) + 1);
    }
    for (const [name, count] of counts) {
      const entry = classes.get(name);
      if (!entry) continue;
      entry.uses += count;
      entry.files += 1;
    }
  }
  return Object.fromEntries(
    [...classes].sort(([a], [b]) => a.localeCompare(b)),
  );
}

export function designDataPlugin(srcDir: string): Plugin {
  return {
    name: "ya-design-data",
    apply: "serve",
    resolveId(id) {
      return id === VIRTUAL_ID ? RESOLVED_ID : undefined;
    },
    async load(id) {
      if (id !== RESOLVED_ID) return undefined;
      const classUsage = await collectDesignData(srcDir);
      return `export const classUsage = ${JSON.stringify(classUsage)};`;
    },
    /*
     * Module namespaces list exports alphabetically; Storybook's
     * `__namedExportsOrder` convention carries source order, so states keep
     * the order their author wrote them in, as design:index reports.
     */
    transform(code, id) {
      if (!id.endsWith(".specimen.tsx")) return undefined;
      const names = [
        ...code.matchAll(/^export\s+(?:function|const)\s+([A-Za-z_$][\w$]*)/gm),
      ].map((match) => match[1]);
      return {
        code: `${code}\nexport const __namedExportsOrder = ${JSON.stringify(names)};\n`,
        map: null,
      };
    },
    configureServer(server) {
      server.watcher.on("change", (file) => {
        const inside = relative(srcDir, file);
        if (inside.startsWith(`..${sep}`) || inside === "..") return;
        const module = server.moduleGraph.getModuleById(RESOLVED_ID);
        if (module) server.moduleGraph.invalidateModule(module);
      });
    },
  };
}
