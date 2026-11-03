import type { ProviderName } from "./types.js";

export type SteeringMode = "gentle" | "immediate";
export type SteeringModeSettings = Partial<Record<ProviderName, SteeringMode>>;

/** Native urgency selection, distinct from YA regular/patient scheduling. */
export interface ProviderSteeringCapabilities {
  selection: "per-message" | "launch";
  modes: readonly SteeringMode[];
  defaultMode: SteeringMode;
}

/** Configuration captured by one owner; native config can remain opaque. */
export interface ProviderSteeringState {
  mode: SteeringMode | "native-config";
  source: "ya-default" | "ya-setting" | "native-config";
}

export function parseProviderSteeringState(
  value: unknown,
): ProviderSteeringState | undefined {
  if (!value || typeof value !== "object") return undefined;
  const state = value as Partial<ProviderSteeringState>;
  if (
    (state.mode === "gentle" ||
      state.mode === "immediate" ||
      state.mode === "native-config") &&
    (state.source === "ya-default" ||
      state.source === "ya-setting" ||
      state.source === "native-config")
  )
    return { mode: state.mode, source: state.source };
  return undefined;
}

export function parseSteeringModeSettings(
  value: unknown,
): SteeringModeSettings | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const result: SteeringModeSettings = {};
  for (const [key, mode] of Object.entries(value)) {
    // Codex is the only qualified launch-scoped implementation. Do not accept
    // settings for an adapter just because it has a name in the registry.
    if (key !== "codex" || (mode !== "gentle" && mode !== "immediate"))
      return null;
    result[key] = mode;
  }
  return result;
}
