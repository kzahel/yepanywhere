/**
 * Session boot instructions: what replaces a session's user-level instruction
 * layer, and the API client that asked for it. Contract:
 * topics/session-boot-instructions.md.
 */

/** Replacement for the provider's user-level instructions; empty text is a virgin session. */
export type BootInstructions = { text: string } | { path: string };

/** Longest boot instruction text, inline or read from a path, in characters. */
export const BOOT_INSTRUCTIONS_MAX_CHARACTERS = 200_000;

/** An API client name: also a directory name, so no separators or dot-only names. */
export const API_CLIENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** The boot-home directory name used when a session names no API client. */
export const DEFAULT_BOOT_HOME_NAME = "_default";

/**
 * What a session records at creation and every later launch reapplies.
 * Both fields are immutable once saved.
 */
export interface SessionBootSettings {
  apiClient?: string;
  bootInstructions?: BootInstructions;
}

/** What a provider launch needs to apply boot instructions. */
export interface BootInstructionsLaunch {
  source: BootInstructions;
  apiClient?: string;
  /** Directory holding per-provider boot homes, `{dataDir}/boot-homes`. */
  homeRoot?: string;
}

/** Validate a saved or submitted API client name; throws on anything else. */
export function parseApiClient(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !API_CLIENT_PATTERN.test(value))
    throw new Error(
      "Invalid apiClient: use 1-64 letters, digits, '.', '_' or '-', starting with a letter or digit",
    );
  return value;
}

/** Validate saved or submitted boot instructions; `null` means none. */
export function parseBootInstructions(
  value: unknown,
): BootInstructions | undefined {
  if (value === undefined || value === null) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid bootInstructions: expected {text} or {path}");
  const keys = Object.keys(value);
  if (keys.length !== 1)
    throw new Error(
      "Invalid bootInstructions: give exactly one of text or path",
    );
  if ("text" in value) {
    if (typeof value.text !== "string")
      throw new Error("Invalid bootInstructions text: expected a string");
    if (value.text.length > BOOT_INSTRUCTIONS_MAX_CHARACTERS)
      throw new Error(
        `Invalid bootInstructions text: longer than ${BOOT_INSTRUCTIONS_MAX_CHARACTERS} characters`,
      );
    return { text: value.text };
  }
  if ("path" in value) {
    if (typeof value.path !== "string" || !value.path.startsWith("/"))
      throw new Error(
        "Invalid bootInstructions path: expected an absolute path",
      );
    return { path: value.path };
  }
  throw new Error("Invalid bootInstructions: expected {text} or {path}");
}

/**
 * The boot settings a launch uses. What the session saved wins over what a
 * launch request carries, because the fields are fixed at creation; the
 * request's value applies only to a session that saved none, a new one.
 */
export function settledSessionBoot(
  saved: SessionBootSettings | undefined,
  requested: SessionBootSettings | undefined,
): SessionBootSettings {
  const apiClient = saved?.apiClient ?? requested?.apiClient;
  const bootInstructions =
    saved?.bootInstructions ?? requested?.bootInstructions;
  return {
    ...(apiClient ? { apiClient } : {}),
    ...(bootInstructions ? { bootInstructions } : {}),
  };
}
