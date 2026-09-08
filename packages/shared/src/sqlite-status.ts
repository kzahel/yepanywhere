/** Optional source-server diagnostic, not a session-discovery capability. */
export interface SqliteStatus {
  state: "disabled" | "unsupported" | "ready" | "error";
}
