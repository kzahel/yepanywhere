/** Open-work data is live in dev and frozen into the playground build. */
import { relative, sep } from "node:path";
import type { Plugin } from "vite";
import { collectOpenCensus } from "./openCensus";

const VIRTUAL_ID = "virtual:ya-design-data";
const RESOLVED_ID = `\0${VIRTUAL_ID}`;

export function designDataPlugin(srcDir: string): Plugin {
  return {
    name: "ya-design-data",
    resolveId(id) {
      return id === VIRTUAL_ID ? RESOLVED_ID : undefined;
    },
    async load(id) {
      if (id !== RESOLVED_ID) return undefined;
      return `export const openCensus = ${JSON.stringify(await collectOpenCensus(srcDir))};`;
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
        const censusInput =
          /(?:allowlist|composer-classes|css-runtime-families)\.json$/.test(
            file,
          );
        if (!censusInput && (inside.startsWith(`..${sep}`) || inside === ".."))
          return;
        const module = server.moduleGraph.getModuleById(RESOLVED_ID);
        if (module) server.moduleGraph.invalidateModule(module);
      });
    },
  };
}
