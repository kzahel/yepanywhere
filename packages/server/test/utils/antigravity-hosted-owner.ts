import {
  hostedAntigravityOwnerLink,
  ownAntigravitySession,
} from "../../src/sdk/providers/antigravity-owners.js";

const crossed = <T>(value: T): T =>
  value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);

/**
 * An Antigravity owner as a Provider Host worker holds it (plan 195 step
 * 9), in one test process: the worker side registers under a key of its
 * own, and this process's readers see it only through the backend link,
 * every publication and answer crossing as JSON as it does on the socket.
 * The owner code is the production one; only the transport is in-process.
 */
export function ownHostedAntigravitySession(scope: string, id: string) {
  const link = hostedAntigravityOwnerLink();
  let served:
    | { snapshot(): unknown; read(query: unknown): unknown }
    | undefined;
  const read = async (query: unknown) => {
    await Promise.resolve();
    return crossed(served?.read(crossed(query)) ?? null);
  };
  const asBackend = (publication: unknown) =>
    publication && typeof publication === "object" && "scope" in publication
      ? { ...publication, scope }
      : publication;
  link.expect({ storageScope: scope, id });
  return ownAntigravitySession(`${scope}\0worker`, id, {
    publish: (change) => link.update(crossed(asBackend(change)), read),
    serve: (owner) => {
      served = owner;
      link.update(crossed(asBackend(owner.snapshot())), read);
    },
  });
}
