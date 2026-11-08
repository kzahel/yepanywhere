import {
  canonicalInvocationName,
  canonicalizeSkillInvocations,
  type SlashCommand,
} from "@yep-anywhere/shared";
import type {
  SkillMetadata,
  ThreadGoalSetResponse,
  UserInput,
} from "./codex-protocol/index.js";
import { CODEX_BUILTIN_COMMANDS } from "./staticSlashCommands.js";

export const CODEX_DESKTOP_BROWSER_SKILL_NAME =
  "browser:control-in-app-browser";

export function createCodexSlashCommands(
  skills: readonly SkillMetadata[],
  inventoryState: "current" | "stale" = "current",
  goalObjective?: string | null,
  goalStatus?: ThreadGoalSetResponse["goal"]["status"] | null,
): SlashCommand[] {
  const commands: SlashCommand[] = CODEX_BUILTIN_COMMANDS.map((command) =>
    command.name === "goal" && goalObjective !== undefined
      ? {
          ...command,
          providerDetails: { codex: { goalObjective, goalStatus } },
          argumentCompletions: [
            ...(goalObjective
              ? [{ value: goalObjective, description: "Current goal" }]
              : []),
            ...(command.argumentCompletions ?? []),
          ],
        }
      : command,
  );
  // Dedup on the exact spelling: Codex recognizes case-distinct skill names
  // as distinct, so `Foo` and `foo` must both surface rather than collapse.
  const seenSkills = new Set<string>();
  for (const skill of skills) {
    const name = skill.name.trim();
    if (
      !skill.enabled ||
      name === CODEX_DESKTOP_BROWSER_SKILL_NAME ||
      !name ||
      seenSkills.has(name)
    ) {
      continue;
    }
    seenSkills.add(name);
    commands.push({
      name,
      description:
        skill.interface?.shortDescription ??
        skill.shortDescription ??
        skill.description,
      invocation: { kind: "skill", prefix: "$", inventoryState },
    });
  }
  return commands;
}

export function createCodexUserInputs(
  text: string,
  skills: readonly SkillMetadata[],
  inventoryState: "current" | "stale",
): { text: string; input: UserInput[] } {
  const canonical = canonicalizeSkillInvocations(
    text,
    createCodexSlashCommands(skills, inventoryState),
  );
  // Keyed by `canonicalInvocationName`, which preserves case unlike its
  // `normalize` sibling, so case-distinct skills keep their own paths.
  const skillByName = new Map<string, SkillMetadata>();
  for (const skill of skills) {
    if (!skill.enabled || skill.name === CODEX_DESKTOP_BROWSER_SKILL_NAME) {
      continue;
    }
    const name = canonicalInvocationName(skill.name);
    if (name && !skillByName.has(name)) {
      skillByName.set(name, skill);
    }
  }
  const structuredSkills: UserInput[] = [];
  const seenPaths = new Set<string>();
  for (const match of canonical.matches) {
    const skill = skillByName.get(canonicalInvocationName(match.command.name));
    if (!skill || seenPaths.has(skill.path)) continue;
    seenPaths.add(skill.path);
    structuredSkills.push({
      type: "skill",
      name: skill.name,
      path: skill.path,
    });
  }
  return {
    text: canonical.text,
    input: [
      { type: "text", text: canonical.text, text_elements: [] },
      ...structuredSkills,
    ],
  };
}
