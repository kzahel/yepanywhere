import { extname } from "node:path";
import { z } from "zod";
import type { SessionCatalogRow } from "../sessions/catalog-types.js";

/** Native locations are observations on the owning server, not download URLs. */
export const backingStoreSchema = z.object({
  serverId: z.string().optional(),
  kind: z.enum(["file", "database", "provider", "unavailable"]),
  provider: z.string(),
  nativeSessionId: z.string().nullable(),
  path: z.string().nullable(),
  format: z.string().nullable(),
  recordId: z.string().nullable(),
  shared: z.boolean().nullable(),
  history: z.enum(["unknown", "unavailable"]),
});
export type ApiBackingStore = z.infer<typeof backingStoreSchema>;

export function describeBackingStore(
  provider: string,
  row?: Readonly<SessionCatalogRow> & { nativeSessionId?: string },
): ApiBackingStore {
  const location = row?.location;
  const path = location && "path" in location ? location.path : null;
  const extension = path ? extname(path).toLowerCase() : "";
  return {
    kind: location?.kind ?? "unavailable",
    provider,
    nativeSessionId: row?.nativeSessionId ?? row?.sessionId ?? null,
    path,
    format:
      location?.kind === "database"
        ? "sqlite"
        : extension === ".jsonl"
          ? "jsonl"
          : extension === ".json"
            ? "json"
            : extension === ".gz"
              ? "gzip"
              : null,
    recordId: location && "recordId" in location ? location.recordId : null,
    shared: location?.kind === "database" ? true : null,
    // A leaf file may depend on ancestors, sidecars, or live unpersisted data.
    history: location ? "unknown" : "unavailable",
  };
}
