import { useCallback, useEffect, useRef, useState } from "react";
import { useCurrentSourceRuntime } from "../contexts/SourceRuntimeContext";

/** Installed Machine Control readiness and the server's default advertisement. */
export interface MachineControlStatus {
  /** False until this source has answered; nothing below is known before. */
  known: boolean;
  available: boolean;
  version?: string;
  /** An install location is occupied by something that failed verification. */
  found: boolean;
  /** Eligible launches advertise Machine Control unless one declines. */
  enabled: boolean;
}

const UNKNOWN: MachineControlStatus = {
  known: false,
  available: false,
  found: false,
  enabled: false,
};

/**
 * Reads readiness from the current source while `active`. Older servers omit
 * `found` and `enabled`; both then read as false.
 */
export function useMachineControlStatus(active: boolean) {
  const { transport } = useCurrentSourceRuntime();
  const [status, setStatus] = useState(UNKNOWN);
  // Only the newest read may publish; a departed source's reply is dropped.
  const generation = useRef(0);
  const reload = useCallback(() => {
    const current = ++generation.current;
    if (!active) return;
    void transport
      .fetch<Partial<MachineControlStatus>>("/machine-control")
      .then((reply) => {
        if (generation.current !== current) return;
        setStatus({
          known: true,
          available: reply.available === true,
          version: reply.version,
          found: reply.found === true,
          enabled: reply.enabled === true,
        });
      })
      .catch(() => {
        /* Optional readiness remains unknown. */
      });
  }, [transport, active]);
  useEffect(() => {
    setStatus(UNKNOWN);
    reload();
    return () => {
      generation.current++;
    };
  }, [reload]);
  return { status, reload };
}
