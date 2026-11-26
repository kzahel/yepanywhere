// Loaded only by the isolated navigation fixture's server. Attribute catalog
// reads to the actual badge request, independently of background indexing.
import { AsyncLocalStorage } from "node:async_hooks";
import { appendFileSync } from "node:fs";
import { Server } from "node:http";
import { join } from "node:path";
import { RetainedSessionCollections } from "../../packages/server/src/services/RetainedSessionCollections.ts";

const current = new AsyncLocalStorage();
const emit = Server.prototype.emit;
Server.prototype.emit = function (name, ...args) {
  if (name !== "request" || !args[0].url.startsWith("/api/issues?"))
    return emit.call(this, name, ...args);
  const [request, response] = args;
  const url = new URL(request.url, "http://localhost");
  const counts = {
    sessionId: url.searchParams.get("sessionId"),
    sort: url.searchParams.get("sort"),
    fullReads: 0,
    rows: 0,
  };
  response.once("finish", () =>
    appendFileSync(
      join(process.env.YEP_DATA_DIR, "badge-reads.jsonl"),
      JSON.stringify(counts) + "\n",
    ),
  );
  return current.run(counts, () => emit.call(this, name, ...args));
};
for (const method of ["read", "readNativeRows"]) {
  const original = RetainedSessionCollections.prototype[method];
  RetainedSessionCollections.prototype[method] = async function (...args) {
    const counts = current.getStore();
    const result = await original.apply(this, args);
    if (counts) {
      if (method === "read") counts.fullReads++;
      counts.rows += (method === "read" ? result.rows : result).length;
    }
    return result;
  };
}
