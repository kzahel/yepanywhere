import { isAbsolute } from "node:path";

// Private protocol 1 uses the existing opaque-id/family limits. Keep this
// decoder plain ESM: the headless host starts without a TypeScript loader.
const families = [
  "claude",
  "codex",
  "gemini",
  "opencode",
  "pi",
  "grok",
  "antigravity",
];
function hasControlCharacters(value) {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 32 || code === 127) return true;
  }
  return false;
}
function id(value) {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 512 ||
    /[/\\]/.test(value) ||
    hasControlCharacters(value)
  )
    throw new Error("Invalid creation identity id");
  return value;
}

export function parseCreationRuntimeIdentity(value) {
  if (!value || typeof value !== "object")
    throw new Error("Missing creation identity");
  const scope = value.nativeNamespace;
  if (
    value.version !== 1 ||
    !Number.isSafeInteger(value.generation) ||
    value.generation < 1 ||
    !scope ||
    !families.includes(scope.family) ||
    typeof scope.storageScope !== "string" ||
    scope.storageScope.length > 4096 ||
    hasControlCharacters(scope.storageScope) ||
    !isAbsolute(scope.storageScope)
  )
    throw new Error("Invalid creation identity");
  return Object.freeze({
    version: 1,
    sessionId: id(value.sessionId),
    creationId: id(value.creationId),
    attemptId: id(value.attemptId),
    generation: value.generation,
    nativeNamespace: Object.freeze({
      family: scope.family,
      storageScope: scope.storageScope,
    }),
    ...(value.nativeSessionId === undefined
      ? {}
      : { nativeSessionId: id(value.nativeSessionId) }),
    initialInputId: id(value.initialInputId),
  });
}

export function sameCreationRuntimeIdentity(expected, received) {
  try {
    return (
      JSON.stringify(parseCreationRuntimeIdentity(expected)) ===
      JSON.stringify(parseCreationRuntimeIdentity(received))
    );
  } catch {
    return false;
  }
}

export function parseCreationRuntimeEvidence(value) {
  if (
    !value ||
    typeof value !== "object" ||
    typeof value.initialInputConsumed !== "boolean"
  )
    throw new Error("Invalid creation owner evidence");
  const identity = parseCreationRuntimeIdentity(value.identity);
  const nativeSessionId =
    value.nativeSessionId === undefined ? undefined : id(value.nativeSessionId);
  if (
    (value.initialInputConsumed && !nativeSessionId) ||
    (nativeSessionId &&
      identity.nativeSessionId &&
      identity.nativeSessionId !== nativeSessionId)
  )
    throw new Error("Conflicting creation native evidence");
  return Object.freeze({
    identity,
    nativeSessionId,
    initialInputConsumed: value.initialInputConsumed,
  });
}
