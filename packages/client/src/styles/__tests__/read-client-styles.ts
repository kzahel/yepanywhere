import { readFile } from "node:fs/promises";

/** Raw CSS fixtures name their required files in the entry's cascade order. */
export async function readClientStyles(...names: string[]): Promise<string> {
  const parts = await Promise.all(
    names.map((name) =>
      readFile(new URL(`../${name}.css`, import.meta.url), "utf8"),
    ),
  );
  return parts.join("\n");
}
