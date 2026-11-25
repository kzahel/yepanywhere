import type { ProjectAppView } from "@yep-anywhere/shared";

const PROBE_TIMEOUT_MS = 4_000;

/**
 * Whether this browser can reach an app's declared redirect address
 * (topics/project-service.md § Direct serving). Any HTTP response counts,
 * including a login challenge or a gateway error from a stopped app behind
 * Funnel: only a network failure or timeout means unreachable. The probe
 * omits credentials, so it never raises the app's own login prompt.
 */
export async function redirectReachable(
  url: string,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await fetch(url, {
      mode: "no-cors",
      credentials: "omit",
      cache: "no-store",
      referrerPolicy: "no-referrer",
      signal: controller.signal,
    });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** The canonical address as a view: framed like a served app. */
export function redirectView(projectId: string, url: string): ProjectAppView {
  return {
    id: `redirect:${projectId}`,
    kind: "service",
    url,
    label: new URL(url).host,
    transferable: true,
  };
}
