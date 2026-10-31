import { SUPERUSER } from "../auth/principal.js";
import type { ApiReadPort } from "../core-api/service.js";
import {
  createAgentApiRuntime,
  type AgentApiRuntime,
  type AgentApiLease,
} from "./runtime.js";

interface SharedRuntime {
  promise: Promise<AgentApiRuntime>;
  users: number;
  read?: ApiReadPort;
  detach?: () => void;
}
// At most 16 live logical profiles; leases/listeners are removed on owner end.
const runtimes = new Map<string, SharedRuntime>();

export async function createAgentApiLaunch(options: {
  serverId: string;
  sessionId: () => string | null;
  management?: boolean;
  peerAccess?: boolean;
  peerGrantId?: string;
  read?: ApiReadPort;
}) {
  let shared = runtimes.get(options.serverId);
  if (!shared) {
    if (runtimes.size >= 16)
      throw new Error("Agent API profile capacity exceeded");
    shared = {
      promise: createAgentApiRuntime({ serverId: options.serverId }),
      users: 0,
    };
    runtimes.set(options.serverId, shared);
  }
  const record = shared;
  let runtime: AgentApiRuntime;
  let lease: AgentApiLease;
  try {
    runtime = await record.promise;
    lease = runtime.issue({
      principal: SUPERUSER,
      sessionId: options.sessionId,
      management: options.management,
      peerAccess: options.peerAccess,
      peerGrantId: options.peerGrantId,
    });
  } catch (error) {
    if (!record.users && runtimes.get(options.serverId) === record) {
      runtimes.delete(options.serverId);
      await record.promise.then(
        (value) => value.close(),
        () => {},
      );
    }
    throw error;
  }
  record.users++;
  let disposed = false;
  const setAttached = (attached: boolean) => {
    if (disposed) return;
    if (!attached) {
      record.detach?.();
      record.detach = undefined;
      record.read = undefined;
    } else if (options.read && record.read !== options.read) {
      record.detach?.();
      record.read = options.read;
      record.detach = runtime.attachController({
        serverId: options.serverId,
        read: options.read,
      });
    }
  };
  setAttached(true);
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    lease.dispose();
    record.users--;
    if (record.users === 0) {
      if (runtimes.get(options.serverId) === record)
        runtimes.delete(options.serverId);
      record.detach?.();
      await runtime.close();
    }
  };
  return {
    environment: lease.environment,
    renew: lease.renew,
    setAttached,
    dispose,
  };
}
