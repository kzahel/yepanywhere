import type { Trace } from "./cases.js";

export function isDocumentationPath(path: string) {
  return /^\/v0\/(?:servers\/[^/]+\/)?(?:help|schema)$/.test(
    path.split("?")[0]!,
  );
}
export function isFullSchemaPath(path: string) {
  const url = new URL(path, "http://fixture");
  return (
    /^\/v0\/(?:servers\/[^/]+\/)?schema$/.test(url.pathname) &&
    !url.searchParams.has("operation")
  );
}
/** Derive from recorded HTTP bytes, including historical reports with old aggregates. */
export function fetchedDocumentationBytes(trace: Trace[]) {
  return trace
    .filter((entry) => entry.status === 200 && isDocumentationPath(entry.path))
    .reduce((total, entry) => total + entry.bytes, 0);
}
