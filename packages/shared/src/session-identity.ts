import type { ProviderName } from "./types.js";

/** Public YA resource identity, including preserved pre-migration ids. */
export type YaSessionId = string & { readonly __brand: "YaSessionId" };
/** An address meaningful only inside a provider's scoped native store. */
export type NativeSessionId = string & {
  readonly __brand: "NativeSessionId";
};

export const NATIVE_SESSION_FAMILIES = [
  "claude",
  "codex",
  "gemini",
  "opencode",
  "pi",
  "grok",
  "antigravity",
] as const;
export type NativeSessionFamily = (typeof NATIVE_SESSION_FAMILIES)[number];

export interface NativeSessionRef {
  readonly family: NativeSessionFamily;
  /** Canonical native storage root, supplied by trusted server discovery. */
  readonly storageScope: string;
  readonly id: NativeSessionId;
}

function isOpaqueSessionId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 512 &&
    !/[/\\]/.test(value) &&
    !hasControlCharacters(value)
  );
}

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

export function isYaSessionId(value: unknown): value is YaSessionId {
  return isOpaqueSessionId(value);
}

/** Use at a public route/persisted-record boundary, never to guess native ids. */
export function parseYaSessionId(value: unknown): YaSessionId {
  if (!isYaSessionId(value)) throw new Error("Invalid YA session id");
  return value;
}

/** Use only for provider responses or native discovery facts. */
export function parseNativeSessionId(value: unknown): NativeSessionId {
  if (!isOpaqueSessionId(value)) throw new Error("Invalid native session id");
  return value as NativeSessionId;
}

export function nativeSessionFamily(
  provider: ProviderName,
): NativeSessionFamily {
  switch (provider) {
    case "claude":
    case "claude-gateway":
    case "claude-ollama":
      return "claude";
    case "codex":
    case "codex-oss":
      return "codex";
    case "gemini":
    case "gemini-acp":
      return "gemini";
    case "antigravity":
    case "opencode":
    case "pi":
    case "grok":
      return provider;
  }
}

/** Decode a trusted native reference; callers still own scope canonicalization. */
export function nativeSessionRef(
  family: NativeSessionFamily,
  storageScope: string,
  id: NativeSessionId,
): NativeSessionRef {
  if (
    !NATIVE_SESSION_FAMILIES.includes(family) ||
    !storageScope ||
    storageScope.length > 4096 ||
    hasControlCharacters(storageScope)
  ) {
    throw new Error("Invalid native session storage scope");
  }
  return { family, storageScope, id: parseNativeSessionId(id) };
}
