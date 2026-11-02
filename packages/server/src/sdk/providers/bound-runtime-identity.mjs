import { isAbsolute } from "node:path";

// Shared by the loader-free host and TS worker. This is an existing native
// binding, not authority to create a conversation or consume its first input.
export const BOUND_RUNTIME_FEATURE = "session-native-binding-v1";
export const BOUND_RUNTIME_PROTOCOL_VERSION = 3;
const families = ["claude", "codex", "gemini", "opencode", "pi", "grok"];

function controls(value) {
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
    controls(value)
  )
    throw new Error("Invalid bound runtime session id");
  return value;
}

export function parseBoundRuntimeIdentity(value) {
  const native = value?.native;
  if (
    value?.version !== 1 ||
    !native ||
    !families.includes(native.family) ||
    typeof native.storageScope !== "string" ||
    !isAbsolute(native.storageScope) ||
    native.storageScope.length > 4096 ||
    controls(native.storageScope)
  )
    throw new Error("Invalid bound runtime identity");
  return Object.freeze({
    version: 1,
    sessionId: id(value.sessionId),
    native: Object.freeze({
      family: native.family,
      storageScope: native.storageScope,
      id: id(native.id),
    }),
  });
}

export function sameBoundRuntimeIdentity(expected, received) {
  try {
    return (
      JSON.stringify(parseBoundRuntimeIdentity(expected)) ===
      JSON.stringify(parseBoundRuntimeIdentity(received))
    );
  } catch {
    return false;
  }
}
