import {
  type NativeSessionCatalogAdapter,
  type SessionCatalogRow,
  SESSION_CATALOG_TITLE_MAX_LENGTH,
} from "../sessions/catalog-types.js";

/**
 * Validates one adapter row against the catalog's bounds and returns a copy
 * with a fixed property order, which the shard lines and the SQLite row hash
 * both rely on.
 */
export function normalizeRow(
  row: SessionCatalogRow,
  adapter: Pick<NativeSessionCatalogAdapter, "catalogFamily" | "storeKey">,
): SessionCatalogRow {
  if (row.catalogFamily !== adapter.catalogFamily) {
    throw new Error(
      `Catalog adapter ${adapter.catalogFamily}:${adapter.storeKey} yielded ${row.catalogFamily}`,
    );
  }
  if (row.storeKey !== adapter.storeKey) {
    throw new Error(
      `Catalog adapter ${adapter.catalogFamily}:${adapter.storeKey} yielded store ${row.storeKey}`,
    );
  }
  requireBoundedString(row.sessionId, "row sessionId", 4_096);
  if (row.nativeStorageScope !== undefined)
    requireBoundedString(
      row.nativeStorageScope,
      "row nativeStorageScope",
      4_096,
    );
  if (row.nativeDirectoryProjectId !== undefined)
    requireBoundedString(
      row.nativeDirectoryProjectId,
      "row nativeDirectoryProjectId",
      32_768,
    );
  requireBoundedString(row.projectId, "row projectId", 32_768);
  requireBoundedString(row.projectPath, "row projectPath", 32_768);
  requireBoundedString(
    row.projectIdentityKey,
    "row projectIdentityKey",
    32_768,
  );
  requireTimestamp(row.updatedAt, "row updatedAt");
  if (row.createdAt !== undefined)
    requireTimestamp(row.createdAt, "row createdAt");
  if (row.lastHumanTurnAt !== undefined)
    requireTimestamp(row.lastHumanTurnAt, "row lastHumanTurnAt");
  if (row.title !== undefined && row.title !== null) {
    requireBoundedString(
      row.title,
      "row title",
      SESSION_CATALOG_TITLE_MAX_LENGTH,
      true,
    );
  }
  if (!(["identity", "head", "tail"] as const).includes(row.fidelity)) {
    throw new Error(
      `Invalid session catalog fidelity: ${String(row.fidelity)}`,
    );
  }
  requireBoundedString(row.sourceVersion, "row sourceVersion", 16_384);
  if (
    row.rowFormat !== undefined &&
    !(Number.isSafeInteger(row.rowFormat) && row.rowFormat > 0)
  ) {
    throw new Error(
      `Invalid session catalog rowFormat: ${String(row.rowFormat)}`,
    );
  }
  validateLocation(row);
  return withWellFormedTitle(cloneRow(row));
}

/**
 * A title cut at its bound can end in half a surrogate pair, which SQLite
 * text cannot hold; it reads back as U+FFFD. Rows are published and stored in
 * that form, so the files, memory and the database agree.
 */
export function withWellFormedTitle<Row extends Readonly<SessionCatalogRow>>(
  row: Row,
): Row {
  if (typeof row.title !== "string") return row;
  const title = (
    row.title as unknown as { toWellFormed(): string }
  ).toWellFormed();
  return title === row.title ? row : { ...row, title };
}

function validateLocation(row: SessionCatalogRow): void {
  const location = row.location;
  switch (location.kind) {
    case "file":
      requireBoundedString(location.path, "row file path", 32_768);
      return;
    case "database":
      requireBoundedString(location.path, "row database path", 32_768);
      requireBoundedString(location.recordId, "row database recordId", 4_096);
      return;
    case "provider":
      requireBoundedString(location.recordId, "row provider recordId", 4_096);
      return;
  }
}

export function cloneRow(row: SessionCatalogRow): SessionCatalogRow {
  return {
    catalogFamily: row.catalogFamily,
    storeKey: row.storeKey,
    sessionId: row.sessionId,
    ...(row.nativeStorageScope !== undefined
      ? { nativeStorageScope: row.nativeStorageScope }
      : {}),
    ...(row.nativeDirectoryProjectId !== undefined
      ? { nativeDirectoryProjectId: row.nativeDirectoryProjectId }
      : {}),
    projectId: row.projectId,
    projectPath: row.projectPath,
    projectIdentityKey: row.projectIdentityKey,
    updatedAt: row.updatedAt,
    ...(row.createdAt !== undefined ? { createdAt: row.createdAt } : {}),
    ...(row.lastHumanTurnAt !== undefined
      ? { lastHumanTurnAt: row.lastHumanTurnAt }
      : {}),
    ...(row.title !== undefined ? { title: row.title } : {}),
    ...(row.provider !== undefined ? { provider: row.provider } : {}),
    ...(row.projectName !== undefined ? { projectName: row.projectName } : {}),
    ...(row.asyncQuestions !== undefined
      ? { asyncQuestions: structuredClone(row.asyncQuestions) }
      : {}),
    fidelity: row.fidelity,
    sourceVersion: row.sourceVersion,
    ...(row.rowFormat !== undefined ? { rowFormat: row.rowFormat } : {}),
    location: { ...row.location },
  };
}

export function requireNonEmpty(
  value: unknown,
  name: string,
): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
}

function requireBoundedString(
  value: unknown,
  name: string,
  maxLength: number,
  allowEmpty = false,
): asserts value is string {
  if (
    typeof value !== "string" ||
    (!allowEmpty && value.length === 0) ||
    value.length > maxLength
  ) {
    throw new Error(`${name} must be a string of at most ${maxLength} chars`);
  }
}

export function requireTimestamp(
  value: unknown,
  name: string,
): asserts value is string {
  requireNonEmpty(value, name);
  if (!Number.isFinite(Date.parse(value))) {
    throw new Error(`${name} must be an ISO-compatible timestamp`);
  }
}
