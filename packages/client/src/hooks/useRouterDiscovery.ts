import type { AgentAuthRouterOverview } from "@yep-anywhere/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import { useClientSummarySourceKey } from "../lib/clientSummaryStore";

const pending = new Map<string, Promise<AgentAuthRouterOverview | null>>();
export function useRouterDiscovery(provider: string | null, enabled: boolean) {
  const source = useClientSummarySourceKey();
  const key = `${source}:${provider}`;
  const [state, setState] = useState<{
    key: string;
    data: AgentAuthRouterOverview | null;
    busy: boolean;
    error: boolean;
  }>({ key, data: null, busy: false, error: false });
  const generation = useRef(0);
  const reload = useCallback(async () => {
    if (!enabled || (provider !== "claude" && provider !== "codex")) return;
    const id = ++generation.current;
    setState((old) => ({
      key,
      data: old.key === key ? old.data : null,
      busy: true,
      error: false,
    }));
    let job = pending.get(key);
    if (!job) {
      job = api.routerSelection(provider).finally(() => pending.delete(key));
      pending.set(key, job);
    }
    try {
      const data = await job;
      if (id === generation.current)
        setState({ key, data, busy: false, error: false });
    } catch {
      if (id === generation.current)
        setState((old) => ({ ...old, key, busy: false, error: true }));
    }
  }, [enabled, provider, key]);
  useEffect(() => {
    void reload();
    const visible = () => {
      if (document.visibilityState === "visible") void reload();
    };
    window.addEventListener("focus", visible);
    window.addEventListener("pageshow", visible);
    window.addEventListener("online", visible);
    window.addEventListener("router-connection-changed", visible);
    document.addEventListener("visibilitychange", visible);
    return () => {
      generation.current++;
      window.removeEventListener("focus", visible);
      window.removeEventListener("pageshow", visible);
      window.removeEventListener("online", visible);
      window.removeEventListener("router-connection-changed", visible);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [reload]);
  return {
    ...(enabled && state.key === key
      ? state
      : { data: null, busy: false, error: false }),
    reload,
  };
}
