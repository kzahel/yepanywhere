import { useCallback, useEffect, useRef, useState } from "react";
import {
  SERVER_CAPABILITIES,
  serverHasCapability,
  type VhostOauthStatus,
} from "@yep-anywhere/shared";
import { useCurrentSourceRuntime } from "../contexts/SourceRuntimeContext";
import { useRetainedVersionInfo } from "./useVersion";

export function useVhostOauth() {
  const { sourceKey, transport } = useCurrentSourceRuntime();
  const version = useRetainedVersionInfo(sourceKey);
  const supported = serverHasCapability(
    version,
    SERVER_CAPABILITIES.vhostOauthAccess.name,
  );
  const [state, setState] = useState<{
    source: string;
    value: VhostOauthStatus;
  }>();
  const [error, setError] = useState<string>();
  const pending = useRef(Promise.resolve());
  const generation = useRef(0);
  useEffect(() => {
    if (!supported) return;
    const current = ++generation.current;
    transport.fetch<VhostOauthStatus>("/artifacts/vhosts/oauth").then(
      (value) => {
        if (current === generation.current)
          setState({ source: sourceKey, value });
      },
      (failure: unknown) => {
        if (current === generation.current) setError(String(failure));
      },
    );
    return () => {
      generation.current++;
    };
  }, [supported, sourceKey, transport]);
  const update = useCallback(
    (path: string, body: unknown, method: "PUT" | "DELETE" = "PUT") => {
      const current = generation.current;
      const operation = pending.current.then(async () => {
        const value = await transport.fetch<VhostOauthStatus>(path, {
          method,
          body: JSON.stringify(body),
        });
        if (current === generation.current) {
          setState({ source: sourceKey, value });
          setError(undefined);
        }
      });
      pending.current = operation.catch(() => {});
      return operation;
    },
    [sourceKey, transport],
  );
  return {
    supported,
    multipleProviders: serverHasCapability(
      version,
      SERVER_CAPABILITIES.vhostOauthProviders.name,
    ),
    status: state?.source === sourceKey ? state.value : undefined,
    error,
    update,
  };
}
