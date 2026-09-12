type CodexLegacySetupSource = {
  _source?: unknown;
  codexUserTurnProvenance?: unknown;
};

const LEGACY_CODEX_SETUP_BLOCKS = [
  /^<recommended_plugins>[\s\S]*?<\/recommended_plugins>/iu,
  /^# AGENTS\.md instructions[^\r\n]*(?:\r?\n)+\s*<INSTRUCTIONS>[\s\S]*?<\/INSTRUCTIONS>/iu,
  /^<environment_context>[\s\S]*?<\/environment_context>/iu,
];

function hasServerUserTurnProvenance(
  sources: readonly CodexLegacySetupSource[],
): boolean {
  return sources.some(
    (source) => typeof source.codexUserTurnProvenance === "string",
  );
}

function hasLiveSdkSource(sources: readonly CodexLegacySetupSource[]): boolean {
  return sources.some((source) => source._source === "sdk");
}

function isEntireLegacyCodexSetupSequence(text: string): boolean {
  let remaining = text.trim();
  let matched = false;

  while (remaining) {
    const match = LEGACY_CODEX_SETUP_BLOCKS.map((pattern) =>
      pattern.exec(remaining),
    ).find((candidate) => candidate?.index === 0);
    if (!match?.[0]) return false;
    matched = true;
    remaining = remaining.slice(match[0].length).trimStart();
  }

  return matched;
}

/**
 * Compatibility fallback for transcripts materialized by servers that did not
 * expose Codex user-turn provenance. Current server-classified user turns and
 * live SDK echoes must never be reclassified from their text.
 */
export function isLegacyCodexSetupText(
  text: string,
  sources: readonly CodexLegacySetupSource[] = [],
): boolean {
  if (hasServerUserTurnProvenance(sources) || hasLiveSdkSource(sources)) {
    return false;
  }
  return isEntireLegacyCodexSetupSequence(text);
}

export function isLegacyCodexEnvironmentContextText(
  text: string,
  sources: readonly CodexLegacySetupSource[] = [],
): boolean {
  if (!isLegacyCodexSetupText(text, sources)) return false;
  return text.trimStart().startsWith("<environment_context>");
}
