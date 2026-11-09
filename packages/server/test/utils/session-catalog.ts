import { SessionCatalogService } from "../../src/services/SessionCatalogService.js";
import type { NativeSessionCatalogAdapter } from "../../src/sessions/catalog-types.js";
import { openDiscoveryDatabase } from "../../src/storage/discovery-sqlite.js";
import { openTestDiscoveryDatabase } from "./session-metadata-database.js";

/**
 * A catalog on a new connection to `dataDir`'s database; close it with
 * `closeTestDiscoveryDatabases` before removing the directory.
 */
export function openTestCatalog(
  dataDir: string,
  options: Omit<
    ConstructorParameters<typeof SessionCatalogService>[0],
    "database"
  > = {},
): SessionCatalogService {
  return new SessionCatalogService({
    database: openTestDiscoveryDatabase(dataDir),
    ...options,
  });
}

/**
 * Publish one generation into `dataDir`'s database, as an earlier server run
 * would have, and close the connection.
 */
export async function seedTestCatalog(
  dataDir: string,
  adapters: readonly NativeSessionCatalogAdapter[],
): Promise<void> {
  const database = openDiscoveryDatabase({
    dataDir,
    probeNetworkFilesystem: () => undefined,
  });
  try {
    const catalog = new SessionCatalogService({ database });
    await catalog.initialize();
    await catalog.reconcile(adapters);
    catalog.stop();
  } finally {
    database.close();
  }
}
