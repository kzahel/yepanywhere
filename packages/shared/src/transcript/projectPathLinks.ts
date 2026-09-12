import type { ProjectPathLinkTarget } from "../project-path-links.js";

export function readProjectPathLinkTargets(
  value: unknown,
): ProjectPathLinkTarget[] | undefined {
  if (!Array.isArray(value)) return undefined;

  const targets = value.filter(
    (candidate): candidate is ProjectPathLinkTarget =>
      !!candidate &&
      typeof candidate === "object" &&
      typeof (candidate as Record<string, unknown>).text === "string" &&
      typeof (candidate as Record<string, unknown>).filePath === "string",
  );
  return targets.length > 0 ? targets : undefined;
}
