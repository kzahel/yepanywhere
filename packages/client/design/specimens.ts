import {
  DESIGN_LAYERS,
  type LoadedSpecimen,
  type SpecimenMeta,
  type SpecimenState,
  stateId,
  stateName,
  toId,
} from "./specimen";

/*
 * Example files sit beside their component in src/ or, for playground-only
 * pages such as the census and token views, under design/. Eager loading is
 * deliberate: the index needs every title, and only the playground loads it.
 */
const modules = import.meta.glob<Record<string, unknown>>(
  ["../src/**/*.specimen.tsx", "./**/*.specimen.tsx"],
  { eager: true },
);

function isState(value: unknown): value is SpecimenState {
  return typeof value === "function";
}

function load(): LoadedSpecimen[] {
  const specimens: LoadedSpecimen[] = [];
  for (const [file, module] of Object.entries(modules)) {
    const meta = module.default as SpecimenMeta | undefined;
    if (!meta?.title || !DESIGN_LAYERS.includes(meta.parameters?.layer)) {
      throw new Error(
        `${file}: a specimen's default export needs a title and parameters.layer`,
      );
    }
    const id = toId(meta.title);
    const order = Array.isArray(module.__namedExportsOrder)
      ? (module.__namedExportsOrder as string[])
      : Object.keys(module);
    const states = order
      .map((name) => [name, module[name]] as const)
      .filter(([name, value]) => name !== "default" && isState(value))
      .map(([exportName, value]) => {
        const render = value as SpecimenState;
        return {
          id: stateId(id, exportName),
          exportName,
          name: render.storyName ?? stateName(exportName),
          render,
        };
      });
    specimens.push({
      id,
      title: meta.title,
      file: file.replace(/^\.\.\//, "").replace(/^\.\//, "design/"),
      parameters: meta.parameters,
      states,
    });
  }
  const ids = new Set<string>();
  for (const specimen of specimens) {
    if (ids.has(specimen.id))
      throw new Error(`Two specimens share the id ${specimen.id}`);
    ids.add(specimen.id);
  }
  return specimens.sort(
    (a, b) =>
      DESIGN_LAYERS.indexOf(a.parameters.layer) -
        DESIGN_LAYERS.indexOf(b.parameters.layer) ||
      a.title.localeCompare(b.title),
  );
}

export const specimens = load();

export function findTarget(id: string) {
  for (const specimen of specimens) {
    if (specimen.id === id) return { specimen, state: undefined };
    const state = specimen.states.find((candidate) => candidate.id === id);
    if (state) return { specimen, state };
  }
  return undefined;
}
