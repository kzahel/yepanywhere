/**
 * Runtime ownership of the server's listening sockets: the loopback listener
 * and the optional network socket configured in Local Access.
 *
 * A change binds every new socket before giving up an old one, so a port that
 * is already in use, or an address that cannot be bound, is reported and
 * leaves the server exactly as it was. Only a socket being replaced on the
 * same port is released first, because a wildcard bind cannot share a port
 * with a loopback bind on every platform; it is rebound if the change fails.
 * A replaced listener stops accepting at once and its existing connections,
 * WebSockets included, are closed after a short grace that lets the response
 * describing the change reach its client. See
 * topics/connection-safe-settings.md.
 */
import type { Socket } from "node:net";
import type { ServerType } from "@hono/node-server";

export interface ListenerAddress {
  host: string;
  port: number;
}

/** What the server listens on: the loopback port and the network socket. */
export interface ListenerPlan {
  localhostPort: number;
  network: ListenerAddress | null;
}

export type ListenerChangeResult =
  | { success: true }
  | { success: false; error: string };

/** The listener operations the network-binding routes and status reads use. */
export interface NetworkListenerControl {
  current(): ListenerPlan;
  /** Addresses bound right now, read from the live sockets. */
  activeAddresses(): ListenerAddress[];
  apply(plan: ListenerPlan): Promise<ListenerChangeResult>;
}

export interface ListenerFactoryOptions {
  /** Exit the process when the bind fails (startup only). */
  fatalOnError: boolean;
  onReady?: (info: { port: number }) => void;
}

/** Creates a server that has begun listening on `address`. */
export type ListenerFactory = (
  address: ListenerAddress,
  options: ListenerFactoryOptions,
) => ServerType;

export const LOOPBACK_HOST = "127.0.0.1";

/** How long a replaced listener's connections outlive the change. */
export const RETIRED_LISTENER_GRACE_MS = 1500;

export function isAllInterfacesHost(host: string): boolean {
  return host === "0.0.0.0" || host === "::";
}

/**
 * The sockets a plan binds. A wildcard network socket on the loopback port
 * also serves loopback, so it replaces the loopback listener.
 */
export function plannedListeners(plan: ListenerPlan): ListenerAddress[] {
  const loopback = { host: LOOPBACK_HOST, port: plan.localhostPort };
  const { network } = plan;
  if (!network) return [loopback];
  if (isAllInterfacesHost(network.host) && network.port === plan.localhostPort)
    return [network];
  return [loopback, network];
}

function normalizeAddress(address: string): string {
  const lower = address.toLowerCase();
  return lower.startsWith("::ffff:") && lower.includes(".")
    ? lower.slice("::ffff:".length)
    : lower;
}

/** Whether a socket bound to `listener` accepts connections to `local`. */
export function listenerServes(
  listener: ListenerAddress,
  local: ListenerAddress,
): boolean {
  if (listener.port !== local.port) return false;
  const host = normalizeAddress(listener.host);
  const address = normalizeAddress(local.host);
  if (host === "::") return true;
  if (host === "0.0.0.0") return !address.includes(":");
  return host === address;
}

export function formatListenerAddress(address: ListenerAddress): string {
  return address.host.includes(":")
    ? `[${address.host}]:${address.port}`
    : `${address.host}:${address.port}`;
}

function sameAddress(left: ListenerAddress, right: ListenerAddress): boolean {
  return (
    left.port === right.port &&
    normalizeAddress(left.host) === normalizeAddress(right.host)
  );
}

/** Resolves once the server is listening; rejects with its bind error. */
export function whenListening(server: ServerType): Promise<void> {
  if (server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    server.once("listening", onListening);
    server.once("error", onError);
  });
}

interface ManagedListener {
  address: ListenerAddress;
  server: ServerType;
  sockets: Set<Socket>;
}

function boundPort(listener: ManagedListener): number | null {
  const bound = listener.server.address();
  return bound && typeof bound === "object" ? bound.port : null;
}

export interface NetworkListenersOptions {
  create: ListenerFactory;
  retireGraceMs?: number;
  /** Called for each socket a successful change newly bound. */
  onBound?: (address: ListenerAddress) => void;
}

export class NetworkListeners implements NetworkListenerControl {
  private plan: ListenerPlan = { localhostPort: 0, network: null };
  private listeners: ManagedListener[] = [];
  private changes: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: NetworkListenersOptions) {}

  /**
   * Bind the startup listeners and run `onReady` once the one serving
   * loopback is listening. A wildcard network socket on the loopback port is
   * bound directly, so readiness never announces a listener that is about to
   * be replaced; if it cannot bind, the loopback listener is used instead.
   * A loopback failure exits the process, as an unusable primary port always
   * has. A port of 0 records the port the system assigned.
   */
  async start(
    port: number,
    onReady?: (info: { port: number }) => void,
    network?: ListenerAddress | null,
  ): Promise<void> {
    if (network && isAllInterfacesHost(network.host) && network.port === port) {
      const wildcard = this.adopt(network, { fatalOnError: false, onReady });
      this.listeners = [wildcard];
      try {
        await whenListening(wildcard.server);
        const actualPort = boundPort(wildcard) ?? port;
        wildcard.address = { host: network.host, port: actualPort };
        this.plan = {
          localhostPort: actualPort,
          network: { host: network.host, port: actualPort },
        };
        this.options.onBound?.(wildcard.address);
        return;
      } catch (error) {
        console.error(
          `[NetworkBinding] ${formatListenerAddress(network)} not bound; serving loopback only:`,
          error instanceof Error ? error.message : error,
        );
      }
    }
    const managed = this.adopt(
      { host: LOOPBACK_HOST, port },
      { fatalOnError: true, onReady },
    );
    this.listeners = [managed];
    await whenListening(managed.server);
    const actualPort = boundPort(managed) ?? port;
    managed.address = { host: LOOPBACK_HOST, port: actualPort };
    this.plan = { localhostPort: actualPort, network: null };
  }

  /** Stop every listener and close its connections now. */
  close(): void {
    for (const listener of this.listeners) this.retire(listener, 0);
    this.listeners = [];
  }

  current(): ListenerPlan {
    return {
      localhostPort: this.plan.localhostPort,
      network: this.plan.network ? { ...this.plan.network } : null,
    };
  }

  activeAddresses(): ListenerAddress[] {
    const addresses: ListenerAddress[] = [];
    for (const { server } of this.listeners) {
      const bound = server.address();
      if (bound && typeof bound === "object")
        addresses.push({ host: bound.address, port: bound.port });
    }
    return addresses;
  }

  /** Changes run one at a time, each against the result of the last. */
  apply(plan: ListenerPlan): Promise<ListenerChangeResult> {
    const change = this.changes.then(() => this.reconcile(plan));
    this.changes = change.catch(() => undefined);
    return change;
  }

  private async reconcile(next: ListenerPlan): Promise<ListenerChangeResult> {
    const desired = plannedListeners(next);
    const kept = this.listeners.filter((listener) =>
      desired.some((address) => sameAddress(address, listener.address)),
    );
    const retiring = this.listeners.filter(
      (listener) => !kept.includes(listener),
    );
    const adding = desired.filter(
      (address) =>
        !kept.some((listener) => sameAddress(address, listener.address)),
    );
    const releasedFirst = retiring.filter((listener) =>
      adding.some((address) => address.port === listener.address.port),
    );
    for (const listener of releasedFirst) listener.server.close();

    const created = adding.map((address) =>
      this.adopt(address, { fatalOnError: false }),
    );
    const results = await Promise.allSettled(
      created.map((listener) => whenListening(listener.server)),
    );
    const failure = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failure) {
      for (const listener of created) this.retire(listener, 0);
      await this.restore(releasedFirst);
      const reason = failure.reason;
      return {
        success: false,
        error: reason instanceof Error ? reason.message : String(reason),
      };
    }

    for (const listener of retiring) this.retire(listener);
    this.listeners = [...kept, ...created];
    this.plan = {
      localhostPort: next.localhostPort,
      network: next.network ? { ...next.network } : null,
    };
    for (const listener of created) this.options.onBound?.(listener.address);
    return { success: true };
  }

  /** Rebind sockets released for a change that then failed. */
  private async restore(released: ManagedListener[]): Promise<void> {
    for (const previous of released) {
      const replacement = this.adopt(previous.address, { fatalOnError: false });
      for (const socket of previous.sockets) this.track(replacement, socket);
      previous.sockets.clear();
      this.listeners = this.listeners.map((listener) =>
        listener === previous ? replacement : listener,
      );
      try {
        await whenListening(replacement.server);
      } catch (error) {
        console.error(
          `[NetworkBinding] Could not restore ${formatListenerAddress(previous.address)}:`,
          error instanceof Error ? error.message : error,
        );
        this.listeners = this.listeners.filter(
          (listener) => listener !== replacement,
        );
      }
    }
  }

  private adopt(
    address: ListenerAddress,
    options: ListenerFactoryOptions,
  ): ManagedListener {
    const managed: ManagedListener = {
      address,
      server: this.options.create(address, options),
      sockets: new Set(),
    };
    managed.server.on("connection", (socket: Socket) =>
      this.track(managed, socket),
    );
    return managed;
  }

  private track(managed: ManagedListener, socket: Socket): void {
    managed.sockets.add(socket);
    socket.once("close", () => managed.sockets.delete(socket));
  }

  private retire(
    managed: ManagedListener,
    graceMs = this.options.retireGraceMs ?? RETIRED_LISTENER_GRACE_MS,
  ): void {
    managed.server.close();
    const closeConnections = () => {
      for (const socket of managed.sockets) socket.destroy();
      managed.sockets.clear();
    };
    if (graceMs <= 0) closeConnections();
    else setTimeout(closeConnections, graceMs).unref();
  }
}
