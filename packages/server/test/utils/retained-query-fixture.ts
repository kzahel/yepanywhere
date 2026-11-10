import { RetainedSessionCollections } from "../../src/services/RetainedSessionCollections.js";
import type {
  SessionCatalogRow,
  NativeSessionCatalogAdapter,
} from "../../src/sessions/catalog-types.js";
import { openTestCatalog } from "./session-catalog.js";
import { openTestDiscoveryDatabase } from "./session-metadata-database.js";

/** Real SQL/publication fixture; caller disposes it before closing test databases. */
export async function seedRetainedCollection(
  dataDir: string,
  rows: SessionCatalogRow[],
) {
  const groups = new Map<string, SessionCatalogRow[]>();
  for (const row of rows) {
    const key = JSON.stringify([row.catalogFamily, row.storeKey]);
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  const adapters: NativeSessionCatalogAdapter[] = [...groups.values()].map(
    (group) => ({
      catalogFamily: group[0]!.catalogFamily,
      storeKey: group[0]!.storeKey,
      scan: async () => ({ sourceVersion: "fixture", rows: group }),
    }),
  );
  const seed = openTestCatalog(dataDir);
  await seed.initialize();
  await seed.reconcile(adapters);
  seed.stop();
  return new RetainedSessionCollections({
    dataDir,
    database: openTestDiscoveryDatabase(dataDir),
    adapters: async () => adapters,
  });
}
