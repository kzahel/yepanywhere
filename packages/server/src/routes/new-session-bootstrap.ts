import {
  ALL_PROVIDERS,
  DEFAULT_PROVIDER,
  type NewSessionBootstrapFrame,
  type NewSessionBootstrapPart,
  type ProviderName,
} from "@yep-anywhere/shared";
import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import { readAuthenticatedJson } from "./authenticated-json-read.js";

/** Bundle canonical authenticated reads without waiting for the slowest part. */
export function streamNewSessionBootstrap(
  context: Context,
  read: (path: string, signal: AbortSignal) => Promise<Response>,
) {
  const requested = context.req.query("provider");
  const preferred = ALL_PROVIDERS.find((provider) => provider === requested);
  if (requested && !preferred)
    return context.json({ error: "Invalid bootstrap provider" }, 400);
  context.header("Cache-Control", "private, no-store");
  context.header("Vary", "Accept");
  return streamSSE(context, async (stream) => {
    const controller = new AbortController();
    stream.onAbort(() => controller.abort());
    const publish = async (frame: NewSessionBootstrapFrame) => {
      await stream.writeSSE({
        event: "bootstrap",
        data: JSON.stringify(frame),
      });
      return frame;
    };
    const acquire = async (part: NewSessionBootstrapPart, path: string) => {
      const response = await read(path, controller.signal);
      const body: unknown = response.headers
        .get("Content-Type")
        ?.includes("application/json")
        ? await response.json()
        : { error: `Bootstrap request failed: HTTP ${response.status}` };
      return publish({ part, status: response.status, body });
    };
    const settings = acquire("settings", "/api/settings");
    const provider = settings.then((frame) => {
      if (frame.status !== 200) return publish({ ...frame, part: "provider" });
      const body = frame.body as {
        settings: { newSessionDefaults?: { provider?: ProviderName } };
      };
      const name =
        preferred ??
        body.settings.newSessionDefaults?.provider ??
        DEFAULT_PROVIDER;
      return acquire("provider", `/api/providers/${name}`);
    });
    const results = await Promise.allSettled([
      settings,
      acquire("projects", "/api/projects?summaryMode=retained"),
      acquire("recents", "/api/recents?limit=100&summaryMode=retained"),
      acquire("version", "/api/version"),
      provider,
    ]);
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  });
}

export function createNewSessionBootstrapRead(
  app: Parameters<typeof readAuthenticatedJson>[0],
) {
  return (context: Context) =>
    streamNewSessionBootstrap(context, (path, signal) =>
      readAuthenticatedJson(app, context, path, signal),
    );
}
