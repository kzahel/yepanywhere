import type { SessionCreationProvenance } from "@yep-anywhere/shared";

export function parseCreationProvenance(
  value: unknown,
): SessionCreationProvenance | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const input = value as Record<string, unknown>;
  if (
    input.surface !== "web" &&
    input.surface !== "desktop" &&
    input.surface !== "api"
  ) {
    return undefined;
  }
  const boundedString = (field: unknown): string | undefined => {
    if (typeof field !== "string") return undefined;
    const trimmed = field.trim();
    return trimmed && trimmed.length <= 120 ? trimmed : undefined;
  };
  let clientOrigin: string | undefined;
  if (
    typeof input.clientOrigin === "string" &&
    input.clientOrigin.length <= 512
  ) {
    try {
      const url = new URL(input.clientOrigin);
      if (url.protocol === "http:" || url.protocol === "https:") {
        clientOrigin = url.origin;
      }
    } catch {
      // Provenance is an optional hint; a malformed origin must not block launch.
    }
  }
  return {
    surface: input.surface,
    ...(clientOrigin ? { clientOrigin } : {}),
    ...(boundedString(input.clientVersion)
      ? { clientVersion: boundedString(input.clientVersion) }
      : {}),
    ...(boundedString(input.clientCommit)
      ? { clientCommit: boundedString(input.clientCommit) }
      : {}),
  };
}

/**
 * Provenance of a session this HTTP request creates: what the body declares,
 * else the UI its headers identify, else `api`. Every YA UI request carries
 * `X-Yep-Client-Version` (the relay adds it from the connection), so a
 * request without one came from an agent or script.
 */
export function creationProvenanceForHeaders(
  headers: Headers,
  declared?: unknown,
): SessionCreationProvenance {
  const parsed = parseCreationProvenance(declared);
  if (parsed) return parsed;
  const surface = headers.get("X-Yep-Client-Surface");
  const clientVersion = headers.get("X-Yep-Client-Version");
  if (!clientVersion && surface !== "web" && surface !== "desktop") {
    return { surface: "api" };
  }
  return (
    parseCreationProvenance({
      surface: surface === "desktop" ? "desktop" : "web",
      clientVersion,
    }) ?? { surface: "web" }
  );
}
