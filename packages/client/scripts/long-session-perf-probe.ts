import { decodeJsonFrame } from "@yep-anywhere/shared";
import {
  chromium,
  type CDPSession,
  type Page,
  type Response,
  type WebSocket,
} from "@playwright/test";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const DEFAULT_URL =
  "http://127.0.0.1:3400/projects/L2xvY2FsL2dyYWVobC90cnRsbG0tc3BlY3VsYXRpdmUvZHJhZnQ/sessions/019dc89f-9eff-7bb0-a170-769138d30842";

interface ProbeConfig {
  url: string;
  durationMs: number;
  intervalMs: number;
  outDir: string;
  headless: boolean;
  forceGcEachSample: boolean;
  allocationSampling: boolean;
  heapSnapshot: boolean;
  loadOlderClicks: number;
  waitAfterLoadOlderMs: number;
}

interface RuntimeMetrics {
  [name: string]: number;
}

interface ReloadPerfProbeMark {
  name: string;
  at: number;
  elapsedMs: number;
  detail?: Record<string, unknown>;
}

interface ProbeEvent {
  eventIndex: number;
  timestamp: string;
  elapsedMs: number;
  kind: "rest" | "websocket" | "console" | "pageerror";
  direction?: "sent" | "received";
  url?: string;
  path?: string;
  method?: string;
  status?: number;
  bytes?: number;
  resourceType?: string;
  query?: Record<string, string>;
  relayType?: string;
  eventType?: string;
  sdkType?: string;
  subtype?: string;
  role?: string;
  state?: string;
  id?: string;
  uuid?: string;
  isReplay?: boolean;
  messagesLength?: number;
  sessionMessagesLength?: number;
  sessionMessageCount?: number;
  firstMessageId?: string;
  lastMessageId?: string;
  pagination?: unknown;
  error?: string;
  text?: string;
}

interface PageStats {
  url: string;
  title: string;
  visibility: string;
  memory: {
    usedJSHeapSize?: number;
    totalJSHeapSize?: number;
    jsHeapSizeLimit?: number;
  } | null;
  dom: {
    nodes: number;
    messageRows: number;
    turnGroups: number;
    toolRows: number;
    streamingBlocks: number;
    searchPreviewLabels: number;
  };
  storage: {
    localStorageKeys: number;
    localStorageBytes: number;
    sessionStorageKeys: number;
    sessionStorageBytes: number;
  };
  probe: {
    elapsedMs: number;
    frameCount: number;
    maxRafGapMs: number;
    rafGapsOver50Ms: number;
    rafGapsOver100Ms: number;
    rafGapsOver250Ms: number;
    longTaskCount: number;
    longTaskTotalMs: number;
    longTaskMaxMs: number;
    recentLongTasks: Array<{
      startTime: number;
      duration: number;
      name: string;
    }>;
    marks: ReloadPerfProbeMark[];
  } | null;
}

interface Sample {
  sampleIndex: number;
  timestamp: string;
  elapsedMs: number;
  page: PageStats;
  cdp: {
    runtimeMetrics: RuntimeMetrics;
    domCounters: unknown;
  };
  browserProcess: {
    rootPid: number | null;
    rssBytes: number | null;
    processCount: number | null;
  };
  events: {
    total: number;
    recent: ProbeEvent[];
  };
}

function getArgValue(name: string): string | undefined {
  const prefix = `${name}=`;
  const arg = process.argv.slice(2).find((item) => item.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function numberOption(name: string, fallback: number): number {
  const raw = getArgValue(name);
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function buildConfig(): ProbeConfig {
  return {
    url: getArgValue("--url") ?? process.env.PERF_URL ?? DEFAULT_URL,
    durationMs: numberOption(
      "--duration-ms",
      Number(process.env.PERF_DURATION_MS) || 120_000,
    ),
    intervalMs: numberOption(
      "--interval-ms",
      Number(process.env.PERF_INTERVAL_MS) || 5_000,
    ),
    outDir: resolve(
      getArgValue("--out-dir") ?? process.env.PERF_OUT_DIR ?? ".tmp/perf",
    ),
    headless: !hasFlag("--headed") && process.env.HEADLESS !== "false",
    forceGcEachSample:
      hasFlag("--force-gc-each-sample") ||
      process.env.PERF_FORCE_GC_EACH_SAMPLE === "true",
    allocationSampling:
      !hasFlag("--no-allocation-sampling") &&
      process.env.PERF_ALLOCATION_SAMPLING !== "false",
    heapSnapshot:
      hasFlag("--heap-snapshot") || process.env.PERF_HEAP_SNAPSHOT === "true",
    loadOlderClicks: numberOption(
      "--load-older-clicks",
      Number(process.env.PERF_LOAD_OLDER_CLICKS) || 0,
    ),
    waitAfterLoadOlderMs: numberOption(
      "--wait-after-load-older-ms",
      Number(process.env.PERF_WAIT_AFTER_LOAD_OLDER_MS) || 2_000,
    ),
  };
}

function timestampForFile(date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function appendJsonl(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(value)}\n`);
}

function getRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function getMessageId(value: unknown): string | undefined {
  const record = getRecord(value);
  if (!record) return undefined;
  return getString(record.uuid) ?? getString(record.id);
}

function summarizeMessages(
  messages: unknown,
): Pick<ProbeEvent, "firstMessageId" | "lastMessageId" | "messagesLength"> {
  if (!Array.isArray(messages)) {
    return {};
  }
  return {
    messagesLength: messages.length,
    firstMessageId: getMessageId(messages[0]),
    lastMessageId: getMessageId(messages.at(-1)),
  };
}

function summarizeRelayPayload(
  payload: unknown,
): Pick<
  ProbeEvent,
  | "relayType"
  | "eventType"
  | "sdkType"
  | "subtype"
  | "role"
  | "state"
  | "id"
  | "uuid"
  | "isReplay"
  | "messagesLength"
  | "firstMessageId"
  | "lastMessageId"
> {
  const relay = getRecord(payload);
  if (!relay) return {};

  const relayType = getString(relay.type);
  const data = getRecord(relay.data);
  const body = getRecord(relay.body);
  const payloadRecord = data ?? body ?? relay;
  const messages = payloadRecord.messages;

  return {
    relayType,
    eventType: getString(relay.eventType),
    sdkType: getString(payloadRecord.type),
    subtype: getString(payloadRecord.subtype),
    role: getString(payloadRecord.role),
    state: getString(payloadRecord.state),
    id: getString(payloadRecord.id),
    uuid: getString(payloadRecord.uuid),
    isReplay:
      typeof payloadRecord.isReplay === "boolean"
        ? payloadRecord.isReplay
        : undefined,
    ...summarizeMessages(messages),
  };
}

function queryParams(url: URL): Record<string, string> | undefined {
  const entries = Array.from(url.searchParams.entries());
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function isInterestingRestResponse(url: URL): boolean {
  if (!url.pathname.startsWith("/api/")) {
    return false;
  }
  if (
    url.pathname.includes("/sessions/") ||
    url.pathname.endsWith("/sessions")
  ) {
    return true;
  }
  return (
    url.pathname.includes("/activity") ||
    url.pathname.includes("/connected-browsers")
  );
}

async function summarizeRestResponse(
  response: Response,
  eventIndex: number,
  startedAt: number,
): Promise<ProbeEvent | null> {
  const url = new URL(response.url());
  if (!isInterestingRestResponse(url)) {
    return null;
  }

  const request = response.request();
  const event: ProbeEvent = {
    eventIndex,
    timestamp: new Date().toISOString(),
    elapsedMs: Date.now() - startedAt,
    kind: "rest",
    url: response.url(),
    path: url.pathname,
    method: request.method(),
    status: response.status(),
    resourceType: request.resourceType(),
    query: queryParams(url),
  };

  const contentType = response.headers()["content-type"] ?? "";
  if (!contentType.includes("application/json")) {
    return event;
  }

  try {
    const text = await response.text();
    event.bytes = Buffer.byteLength(text);
    const json = JSON.parse(text) as unknown;
    const record = getRecord(json);
    const messages = record?.messages;
    const session = getRecord(record?.session);
    const sessionMessages = session?.messages;
    Object.assign(event, summarizeMessages(messages));
    if (Array.isArray(sessionMessages)) {
      event.sessionMessagesLength = sessionMessages.length;
      event.sessionMessageCount =
        typeof session?.messageCount === "number"
          ? session.messageCount
          : undefined;
    } else if (typeof session?.messageCount === "number") {
      event.sessionMessageCount = session.messageCount;
    }
    event.pagination = record?.pagination;
  } catch (error) {
    event.error = error instanceof Error ? error.message : String(error);
  }

  return event;
}

function decodeFramePayload(payload: string | Buffer): {
  bytes: number;
  decoded?: unknown;
  text?: string;
  error?: string;
} {
  if (typeof payload === "string") {
    try {
      return {
        bytes: Buffer.byteLength(payload),
        decoded: JSON.parse(payload) as unknown,
      };
    } catch (error) {
      return {
        bytes: Buffer.byteLength(payload),
        text: payload.slice(0, 200),
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  try {
    return {
      bytes: payload.byteLength,
      decoded: decodeJsonFrame(payload),
    };
  } catch (error) {
    return {
      bytes: payload.byteLength,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function summarizeWebSocketFrame(
  payload: string | Buffer,
  direction: "sent" | "received",
  url: string,
  eventIndex: number,
  startedAt: number,
): ProbeEvent {
  const decoded = decodeFramePayload(payload);
  const urlObject = new URL(url);
  const event: ProbeEvent = {
    eventIndex,
    timestamp: new Date().toISOString(),
    elapsedMs: Date.now() - startedAt,
    kind: "websocket",
    direction,
    url,
    path: urlObject.pathname,
    bytes: decoded.bytes,
    query: queryParams(urlObject),
    error: decoded.error,
    text: decoded.text,
    ...summarizeRelayPayload(decoded.decoded),
  };
  return event;
}

function installEventTracing(
  page: Page,
  eventsPath: string,
  startedAt: number,
): { events: ProbeEvent[]; flush: () => Promise<void> } {
  const events: ProbeEvent[] = [];
  let writeChain = Promise.resolve();

  const record = (event: Omit<ProbeEvent, "eventIndex"> | ProbeEvent) => {
    const fullEvent: ProbeEvent = { ...event, eventIndex: events.length };
    events.push(fullEvent);
    writeChain = writeChain.then(() => appendJsonl(eventsPath, fullEvent));
    return fullEvent;
  };

  page.on("response", (response) => {
    const index = events.length;
    void summarizeRestResponse(response, index, startedAt)
      .then((event) => {
        if (event) {
          const fullEvent = record(event);
          if (
            (fullEvent.messagesLength ?? 0) > 1_000 ||
            (fullEvent.bytes ?? 0) > 2_000_000
          ) {
            console.log(
              [
                "large-rest",
                `path=${fullEvent.path}`,
                `bytes=${fullEvent.bytes ?? "n/a"}`,
                `messages=${fullEvent.messagesLength ?? "n/a"}`,
                `after=${fullEvent.query?.afterMessageId ?? ""}`,
                `before=${fullEvent.query?.beforeMessageId ?? ""}`,
                `tail=${fullEvent.query?.tailCompactions ?? ""}`,
              ].join(" "),
            );
          }
        }
      })
      .catch((error) => {
        record({
          timestamp: new Date().toISOString(),
          elapsedMs: Date.now() - startedAt,
          kind: "rest",
          url: response.url(),
          error: error instanceof Error ? error.message : String(error),
        });
      });
  });

  page.on("websocket", (webSocket: WebSocket) => {
    const url = webSocket.url();
    record({
      timestamp: new Date().toISOString(),
      elapsedMs: Date.now() - startedAt,
      kind: "websocket",
      direction: "received",
      url,
      path: new URL(url).pathname,
      eventType: "open",
    });

    webSocket.on("framesent", ({ payload }) => {
      const event = summarizeWebSocketFrame(
        payload,
        "sent",
        url,
        events.length,
        startedAt,
      );
      record(event);
    });
    webSocket.on("framereceived", ({ payload }) => {
      const event = summarizeWebSocketFrame(
        payload,
        "received",
        url,
        events.length,
        startedAt,
      );
      const fullEvent = record(event);
      if (
        (fullEvent.messagesLength ?? 0) > 100 ||
        (fullEvent.bytes ?? 0) > 1_000_000
      ) {
        console.log(
          [
            "large-ws",
            `event=${fullEvent.eventType ?? fullEvent.relayType ?? ""}`,
            `sdk=${fullEvent.sdkType ?? ""}`,
            `bytes=${fullEvent.bytes ?? "n/a"}`,
            `messages=${fullEvent.messagesLength ?? "n/a"}`,
            `replay=${fullEvent.isReplay ?? ""}`,
          ].join(" "),
        );
      }
    });
    webSocket.on("close", () => {
      record({
        timestamp: new Date().toISOString(),
        elapsedMs: Date.now() - startedAt,
        kind: "websocket",
        direction: "received",
        url,
        path: new URL(url).pathname,
        eventType: "close",
      });
    });
  });

  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") {
      record({
        timestamp: new Date().toISOString(),
        elapsedMs: Date.now() - startedAt,
        kind: "console",
        text: `[${message.type()}] ${message.text().slice(0, 500)}`,
      });
    }
  });

  page.on("pageerror", (error) => {
    record({
      timestamp: new Date().toISOString(),
      elapsedMs: Date.now() - startedAt,
      kind: "pageerror",
      error: error.message,
    });
  });

  return {
    events,
    flush: () => writeChain,
  };
}

async function installPageProbe(page: Page): Promise<void> {
  await page.addInitScript({
    content: `
      (() => {
        const state = {
          startedAt: performance.now(),
          nextRequestId: 1,
          frameCount: 0,
          lastRafAt: null,
          maxRafGapMs: 0,
          rafGapsOver50Ms: 0,
          rafGapsOver100Ms: 0,
          rafGapsOver250Ms: 0,
          longTaskCount: 0,
          longTaskTotalMs: 0,
          longTaskMaxMs: 0,
          recentLongTasks: [],
          marks: [],
          firstMessageRowAt: null,
          firstToolRowAt: null,
          lastDomStableTimer: null,
        };

        const cloneDetail = (detail) => {
          if (!detail || typeof detail !== "object") return undefined;
          try {
            return JSON.parse(JSON.stringify(detail));
          } catch {
            return { error: "detail_not_serializable" };
          }
        };

        const mark = (name, detail) => {
          const at = performance.now();
          state.marks.push({
            name,
            at,
            elapsedMs: at - state.startedAt,
            ...(detail ? { detail: cloneDetail(detail) } : {}),
          });
          if (state.marks.length > 1000) {
            state.marks.splice(0, state.marks.length - 1000);
          }
        };

        const compactUrl = (input) => {
          try {
            const url = new URL(input, window.location.href);
            return url.pathname + url.search;
          } catch {
            return String(input);
          }
        };

        const requestUrl = (input) => {
          if (typeof input === "string") return input;
          if (input && typeof input.url === "string") return input.url;
          return String(input);
        };

        const requestMethod = (input, init) => {
          if (init?.method) return String(init.method).toUpperCase();
          if (input && typeof input.method === "string") {
            return input.method.toUpperCase();
          }
          return "GET";
        };

        const isSessionApiUrl = (input) => {
          try {
            const url = new URL(input, window.location.href);
            return (
              url.pathname.startsWith("/api/") &&
              url.pathname.includes("/sessions/")
            );
          } catch {
            return false;
          }
        };

        const summarizeSessionPayload = (data) => {
          if (!data || typeof data !== "object") return {};
          const messages = Array.isArray(data.messages) ? data.messages : null;
          const session = data.session && typeof data.session === "object"
            ? data.session
            : null;
          return {
            messages: messages ? messages.length : undefined,
            sessionMessages: Array.isArray(session?.messages)
              ? session.messages.length
              : undefined,
            sessionMessageCount:
              typeof session?.messageCount === "number"
                ? session.messageCount
                : undefined,
            totalMessages:
              typeof data.pagination?.totalMessageCount === "number"
                ? data.pagination.totalMessageCount
                : undefined,
            hasOlderMessages:
              typeof data.pagination?.hasOlderMessages === "boolean"
                ? data.pagination.hasOlderMessages
                : undefined,
          };
        };

        const responseMeta = new WeakMap();
        if (typeof window.fetch === "function") {
          const originalFetch = window.fetch.bind(window);
          window.fetch = async (...args) => {
            const input = args[0];
            const init = args[1];
            const url = requestUrl(input);
            const method = requestMethod(input, init);
            const relevant = isSessionApiUrl(url);
            const requestId = state.nextRequestId++;
            const startedAt = performance.now();
            if (relevant) {
              mark("fetch_start", {
                requestId,
                method,
                url: compactUrl(url),
              });
            }
            try {
              const response = await originalFetch(...args);
              if (relevant) {
                responseMeta.set(response, {
                  requestId,
                  method,
                  url: compactUrl(url),
                  startedAt,
                  responseHeadersAt: performance.now(),
                });
                mark("fetch_response_headers", {
                  requestId,
                  method,
                  url: compactUrl(url),
                  status: response.status,
                  durationMs: performance.now() - startedAt,
                });
              }
              return response;
            } catch (error) {
              if (relevant) {
                mark("fetch_error", {
                  requestId,
                  method,
                  url: compactUrl(url),
                  durationMs: performance.now() - startedAt,
                  message: String(error?.message || error),
                });
              }
              throw error;
            }
          };
        }

        if (
          typeof Response !== "undefined" &&
          typeof Response.prototype.json === "function"
        ) {
          const originalJson = Response.prototype.json;
          Response.prototype.json = function (...args) {
            const meta = responseMeta.get(this);
            const startedAt = performance.now();
            const result = originalJson.apply(this, args);
            if (!meta) return result;
            return Promise.resolve(result).then(
              (data) => {
                mark("response_json_complete", {
                  requestId: meta.requestId,
                  method: meta.method,
                  url: meta.url,
                  durationMs: performance.now() - startedAt,
                  sinceFetchStartMs: performance.now() - meta.startedAt,
                  ...summarizeSessionPayload(data),
                });
                return data;
              },
              (error) => {
                mark("response_json_error", {
                  requestId: meta.requestId,
                  method: meta.method,
                  url: meta.url,
                  durationMs: performance.now() - startedAt,
                  message: String(error?.message || error),
                });
                throw error;
              },
            );
          };
        }

        const rowSnapshot = () => ({
          nodes: document.getElementsByTagName("*").length,
          messageRows: document.querySelectorAll("[data-message-render-row]").length,
          turnGroups: document.querySelectorAll(".turn-group").length,
          toolRows: document.querySelectorAll("[data-tool-row]").length,
          loadOlderButtons: document.querySelectorAll(".load-older-button").length,
        });

        const noteDomMutation = () => {
          const snapshot = rowSnapshot();
          if (state.firstMessageRowAt === null && snapshot.messageRows > 0) {
            state.firstMessageRowAt = performance.now();
            mark("dom_first_message_row", snapshot);
          }
          if (state.firstToolRowAt === null && snapshot.toolRows > 0) {
            state.firstToolRowAt = performance.now();
            mark("dom_first_tool_row", snapshot);
          }
          if (state.lastDomStableTimer !== null) {
            clearTimeout(state.lastDomStableTimer);
          }
          state.lastDomStableTimer = setTimeout(() => {
            mark("dom_rows_stable", rowSnapshot());
          }, 500);
        };

        const installDomObserver = () => {
          const target = document.documentElement || document;
          if (!target) return;
          const observer = new MutationObserver(noteDomMutation);
          observer.observe(target, { childList: true, subtree: true });
          noteDomMutation();
        };

        const onFrame = (now) => {
          if (state.lastRafAt !== null) {
            const gap = now - state.lastRafAt;
            state.maxRafGapMs = Math.max(state.maxRafGapMs, gap);
            if (gap > 50) state.rafGapsOver50Ms += 1;
            if (gap > 100) state.rafGapsOver100Ms += 1;
            if (gap > 250) state.rafGapsOver250Ms += 1;
          }
          state.lastRafAt = now;
          state.frameCount += 1;
          window.requestAnimationFrame(onFrame);
        };
        window.requestAnimationFrame(onFrame);

        if (
          typeof PerformanceObserver !== "undefined" &&
          PerformanceObserver.supportedEntryTypes?.includes("longtask")
        ) {
          try {
            const observer = new PerformanceObserver((list) => {
              for (const entry of list.getEntries()) {
                state.longTaskCount += 1;
                state.longTaskTotalMs += entry.duration;
                state.longTaskMaxMs = Math.max(
                  state.longTaskMaxMs,
                  entry.duration,
                );
                state.recentLongTasks.push({
                  startTime: entry.startTime,
                  duration: entry.duration,
                  name: entry.name,
                });
                if (state.recentLongTasks.length > 20) {
                  state.recentLongTasks.splice(
                    0,
                    state.recentLongTasks.length - 20,
                  );
                }
              }
            });
            observer.observe({ type: "longtask", buffered: true });
          } catch {
          }
        }

        mark("probe_init", {
          url: compactUrl(window.location.href),
        });
        if (document.readyState === "loading") {
          document.addEventListener("DOMContentLoaded", installDomObserver, {
            once: true,
          });
        } else {
          installDomObserver();
        }

        Object.defineProperty(window, "__YA_PERF_PROBE__", {
          configurable: true,
          value: {
            snapshot() {
              return {
                elapsedMs: performance.now() - state.startedAt,
                frameCount: state.frameCount,
                maxRafGapMs: state.maxRafGapMs,
                rafGapsOver50Ms: state.rafGapsOver50Ms,
                rafGapsOver100Ms: state.rafGapsOver100Ms,
                rafGapsOver250Ms: state.rafGapsOver250Ms,
                longTaskCount: state.longTaskCount,
                longTaskTotalMs: state.longTaskTotalMs,
                longTaskMaxMs: state.longTaskMaxMs,
                recentLongTasks: state.recentLongTasks,
                marks: state.marks,
              };
            },
          },
        });
        Object.defineProperty(window, "__YA_RELOAD_PERF_PROBE__", {
          configurable: true,
          value: {
            mark,
          },
        });
      })();
    `,
  });
}

async function getPageStats(page: Page): Promise<PageStats> {
  return page.evaluate(`
    (() => {
      const estimateStorage = (storage) => {
        let bytes = 0;
        for (let index = 0; index < storage.length; index += 1) {
          const key = storage.key(index) || "";
          bytes += key.length;
          bytes += (storage.getItem(key) || "").length;
        }
        return { keys: storage.length, bytes };
      };
      const local = estimateStorage(localStorage);
      const session = estimateStorage(sessionStorage);
      const probe = window.__YA_PERF_PROBE__;

      return {
        url: window.location.href,
        title: document.title,
        visibility: document.visibilityState,
        memory: performance.memory
          ? {
              usedJSHeapSize: performance.memory.usedJSHeapSize,
              totalJSHeapSize: performance.memory.totalJSHeapSize,
              jsHeapSizeLimit: performance.memory.jsHeapSizeLimit,
            }
          : null,
        dom: {
          nodes: document.getElementsByTagName("*").length,
          messageRows: document.querySelectorAll(".message-render-row").length,
          turnGroups: document.querySelectorAll(".turn-group").length,
          toolRows: document.querySelectorAll(".tool-row").length,
          streamingBlocks: document.querySelectorAll(".streaming-block").length,
          searchPreviewLabels: document.querySelectorAll(
            ".user-turn-preview-label",
          ).length,
        },
        storage: {
          localStorageKeys: local.keys,
          localStorageBytes: local.bytes,
          sessionStorageKeys: session.keys,
          sessionStorageBytes: session.bytes,
        },
        probe: probe?.snapshot() ?? null,
      };
    })()
  `);
}

async function getRuntimeMetrics(cdp: CDPSession): Promise<RuntimeMetrics> {
  try {
    const response = (await cdp.send("Performance.getMetrics")) as {
      metrics?: Array<{ name: string; value: number }>;
    };
    return Object.fromEntries(
      (response.metrics ?? []).map((metric) => [metric.name, metric.value]),
    );
  } catch {
    return {};
  }
}

async function safeCdp(cdp: CDPSession, method: string): Promise<unknown> {
  try {
    return await cdp.send(method);
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function collectProcessTreeRss(
  rootPid: number | null,
): Promise<{ rssBytes: number | null; processCount: number | null }> {
  if (!rootPid) {
    return { rssBytes: null, processCount: null };
  }

  const queue = [rootPid];
  const seen = new Set<number>();
  let rssKb = 0;

  while (queue.length > 0) {
    const pid = queue.shift();
    if (!pid || seen.has(pid)) continue;
    seen.add(pid);

    try {
      const status = await readFile(`/proc/${pid}/status`, "utf8");
      const rssMatch = status.match(/^VmRSS:\s+(\d+)\s+kB/m);
      if (rssMatch?.[1]) {
        rssKb += Number(rssMatch[1]);
      }
    } catch {
      continue;
    }

    try {
      const children = await readFile(
        `/proc/${pid}/task/${pid}/children`,
        "utf8",
      );
      for (const child of children.trim().split(/\s+/)) {
        if (child) queue.push(Number(child));
      }
    } catch {
      // Ignore processes that exit between reads.
    }
  }

  return { rssBytes: rssKb * 1024, processCount: seen.size };
}

async function collectSample(
  page: Page,
  cdp: CDPSession,
  rootPid: number | null,
  sampleIndex: number,
  startedAt: number,
  forceGc: boolean,
  events: ProbeEvent[],
): Promise<Sample> {
  if (forceGc) {
    await safeCdp(cdp, "HeapProfiler.collectGarbage");
  }

  const [pageStats, runtimeMetrics, domCounters, processTree] =
    await Promise.all([
      getPageStats(page),
      getRuntimeMetrics(cdp),
      safeCdp(cdp, "Memory.getDOMCounters"),
      collectProcessTreeRss(rootPid),
    ]);

  return {
    sampleIndex,
    timestamp: new Date().toISOString(),
    elapsedMs: Date.now() - startedAt,
    page: pageStats,
    cdp: {
      runtimeMetrics,
      domCounters,
    },
    browserProcess: {
      rootPid,
      ...processTree,
    },
    events: {
      total: events.length,
      recent: events.slice(-20),
    },
  };
}

function summarizeEvents(events: ProbeEvent[]): Record<string, unknown> {
  const countByKey = new Map<string, number>();
  for (const event of events) {
    const key = [
      event.kind,
      event.direction ?? "",
      event.path ?? "",
      event.eventType ?? "",
      event.sdkType ?? "",
      event.status ?? "",
    ].join("|");
    countByKey.set(key, (countByKey.get(key) ?? 0) + 1);
  }

  return {
    count: events.length,
    byKind: Object.fromEntries(
      Object.entries(
        events.reduce<Record<string, number>>((acc, event) => {
          acc[event.kind] = (acc[event.kind] ?? 0) + 1;
          return acc;
        }, {}),
      ).sort(([left], [right]) => left.localeCompare(right)),
    ),
    topKeys: Array.from(countByKey.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 30)
      .map(([key, count]) => ({ key, count })),
    largestPayloads: [...events]
      .filter((event) => typeof event.bytes === "number")
      .sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0))
      .slice(0, 20),
    largeMessageBatches: events
      .filter((event) => (event.messagesLength ?? 0) > 100)
      .slice(-30),
  };
}

function markDetail(
  mark: ReloadPerfProbeMark | undefined,
): Record<string, unknown> {
  return mark?.detail && typeof mark.detail === "object" ? mark.detail : {};
}

function detailNumber(
  mark: ReloadPerfProbeMark | undefined,
  key: string,
): number | null {
  const value = markDetail(mark)[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function firstMark(
  marks: ReloadPerfProbeMark[],
  name: string,
  predicate?: (mark: ReloadPerfProbeMark) => boolean,
): ReloadPerfProbeMark | undefined {
  return marks.find(
    (mark) => mark.name === name && (!predicate || predicate(mark)),
  );
}

function firstMarkAfter(
  marks: ReloadPerfProbeMark[],
  name: string,
  afterElapsedMs: number,
): ReloadPerfProbeMark | undefined {
  return marks.find(
    (mark) => mark.name === name && mark.elapsedMs >= afterElapsedMs,
  );
}

function markForRequest(
  marks: ReloadPerfProbeMark[],
  name: string,
  requestId: unknown,
): ReloadPerfProbeMark | undefined {
  return marks.find(
    (mark) => mark.name === name && markDetail(mark).requestId === requestId,
  );
}

function durationBetween(
  start: ReloadPerfProbeMark | undefined,
  end: ReloadPerfProbeMark | undefined,
): number | null {
  return start && end ? end.elapsedMs - start.elapsedMs : null;
}

function milestone(
  mark: ReloadPerfProbeMark | undefined,
): Record<string, unknown> | null {
  if (!mark) return null;
  return {
    elapsedMs: mark.elapsedMs,
    detail: mark.detail ?? {},
  };
}

function summarizeReloadPhases(samples: Sample[]): Record<string, unknown> {
  const marks = samples.at(-1)?.page.probe?.marks ?? [];
  const initialFetch = firstMark(marks, "fetch_start", (mark) => {
    const url = markDetail(mark).url;
    return (
      typeof url === "string" &&
      url.includes("/sessions/") &&
      url.includes("tailCompactions=2")
    );
  });
  const requestId = markDetail(initialFetch).requestId;
  const fetchHeaders = markForRequest(
    marks,
    "fetch_response_headers",
    requestId,
  );
  const jsonComplete = markForRequest(
    marks,
    "response_json_complete",
    requestId,
  );
  const dataReady = firstMark(marks, "session_initial_load_data_ready");
  const stateQueued = firstMark(marks, "session_initial_messages_state_queued");
  const loadComplete = firstMark(marks, "session_initial_load_complete");
  const preprocessEnd = firstMark(
    marks,
    "message_list_preprocess_end",
    (mark) => {
      const messages = detailNumber(mark, "messages");
      return messages !== null && messages > 0;
    },
  );
  const preprocessStart = preprocessEnd
    ? firstMarkAfter(
        marks,
        "message_list_preprocess_start",
        Math.max(
          0,
          preprocessEnd.elapsedMs -
            (detailNumber(preprocessEnd, "durationMs") ?? 0) -
            1,
        ),
      )
    : undefined;
  const groupEnd = firstMark(marks, "message_list_group_end", (mark) => {
    const renderItems = detailNumber(mark, "renderItems");
    return renderItems !== null && renderItems > 0;
  });
  const commit = firstMark(marks, "message_list_commit_effect", (mark) => {
    const messages = detailNumber(mark, "messages");
    return messages !== null && messages > 0;
  });
  const firstRow = firstMark(marks, "dom_first_message_row");
  const stableRows = firstRow
    ? firstMarkAfter(marks, "dom_rows_stable", firstRow.elapsedMs)
    : firstMark(marks, "dom_rows_stable");

  return {
    markCount: marks.length,
    milestones: {
      initialFetch: milestone(initialFetch),
      fetchHeaders: milestone(fetchHeaders),
      jsonComplete: milestone(jsonComplete),
      dataReady: milestone(dataReady),
      stateQueued: milestone(stateQueued),
      loadComplete: milestone(loadComplete),
      preprocessEnd: milestone(preprocessEnd),
      groupEnd: milestone(groupEnd),
      commit: milestone(commit),
      firstRow: milestone(firstRow),
      stableRows: milestone(stableRows),
    },
    durationsMs: {
      fetchToHeaders: durationBetween(initialFetch, fetchHeaders),
      jsonBodyAndParse: detailNumber(jsonComplete, "durationMs"),
      fetchToJsonComplete: durationBetween(initialFetch, jsonComplete),
      jsonCompleteToDataReady: durationBetween(jsonComplete, dataReady),
      dataReadyToStateQueued: durationBetween(dataReady, stateQueued),
      stateQueuedToPreprocessStart: durationBetween(
        stateQueued,
        preprocessStart,
      ),
      stateQueuedToFirstRow: durationBetween(stateQueued, firstRow),
      stateQueuedToStableRows: durationBetween(stateQueued, stableRows),
      stateQueuedToCommitEffect: durationBetween(stateQueued, commit),
      preprocess: detailNumber(preprocessEnd, "durationMs"),
      preprocessEndToFirstRow: durationBetween(preprocessEnd, firstRow),
      grouping: detailNumber(groupEnd, "durationMs"),
      firstRowToCommitEffect: durationBetween(firstRow, commit),
      firstRowToStableRows: durationBetween(firstRow, stableRows),
      fetchToStableRows: durationBetween(initialFetch, stableRows),
    },
    recentMarks: marks.slice(-40),
    preprocessStart: milestone(preprocessStart),
  };
}

function summarize(
  samples: Sample[],
  events: ProbeEvent[],
): Record<string, unknown> {
  const first = samples[0];
  const last = samples.at(-1);
  const elapsedHours =
    first && last
      ? Math.max(1 / 3600, (last.elapsedMs - first.elapsedMs) / 3_600_000)
      : 0;
  const delta = (getter: (sample: Sample) => number | undefined | null) => {
    if (!first || !last) return null;
    const firstValue = getter(first);
    const lastValue = getter(last);
    if (typeof firstValue !== "number" || typeof lastValue !== "number") {
      return null;
    }
    return {
      first: firstValue,
      last: lastValue,
      delta: lastValue - firstValue,
      deltaPerHour: (lastValue - firstValue) / elapsedHours,
    };
  };

  return {
    sampleCount: samples.length,
    firstTimestamp: first?.timestamp,
    lastTimestamp: last?.timestamp,
    elapsedMs: first && last ? last.elapsedMs - first.elapsedMs : 0,
    deltas: {
      usedJSHeapSize: delta((sample) => sample.page.memory?.usedJSHeapSize),
      totalJSHeapSize: delta((sample) => sample.page.memory?.totalJSHeapSize),
      domNodes: delta((sample) => sample.page.dom.nodes),
      messageRows: delta((sample) => sample.page.dom.messageRows),
      toolRows: delta((sample) => sample.page.dom.toolRows),
      browserProcessRssBytes: delta((sample) => sample.browserProcess.rssBytes),
      jsEventListeners: delta((sample) => {
        const counters = sample.cdp.domCounters as
          | { jsEventListeners?: number }
          | undefined;
        return counters?.jsEventListeners;
      }),
    },
    worstFrame: Math.max(
      0,
      ...samples.map((sample) => sample.page.probe?.maxRafGapMs ?? 0),
    ),
    longTasks: {
      count: last?.page.probe?.longTaskCount ?? null,
      totalMs: last?.page.probe?.longTaskTotalMs ?? null,
      maxMs: last?.page.probe?.longTaskMaxMs ?? null,
    },
    reloadPhases: summarizeReloadPhases(samples),
    events: summarizeEvents(events),
  };
}

function topHeapSampleNodes(profile: unknown): Array<Record<string, unknown>> {
  const root = (profile as { head?: unknown } | undefined)?.head;
  const nodes: Array<Record<string, unknown>> = [];

  const visit = (node: unknown, stack: string[]) => {
    const typed = node as
      | {
          callFrame?: {
            functionName?: string;
            url?: string;
            lineNumber?: number;
          };
          selfSize?: number;
          children?: unknown[];
        }
      | undefined;
    if (!typed) return;
    const frame = typed.callFrame;
    const label = [
      frame?.functionName || "(anonymous)",
      frame?.url ? ` ${frame.url}` : "",
      typeof frame?.lineNumber === "number" ? `:${frame.lineNumber + 1}` : "",
    ].join("");
    const nextStack = [...stack, label];
    if (typeof typed.selfSize === "number" && typed.selfSize > 0) {
      nodes.push({
        selfSize: typed.selfSize,
        stack: nextStack.slice(-8).join(" <- "),
      });
    }
    for (const child of typed.children ?? []) {
      visit(child, nextStack);
    }
  };

  visit(root, []);
  return nodes
    .sort((a, b) => Number(b.selfSize) - Number(a.selfSize))
    .slice(0, 40);
}

async function writeHeapSnapshot(cdp: CDPSession, path: string): Promise<void> {
  const chunks: string[] = [];
  cdp.on("HeapProfiler.addHeapSnapshotChunk", ({ chunk }) => {
    chunks.push(chunk);
  });
  await cdp.send("HeapProfiler.takeHeapSnapshot", {
    reportProgress: false,
  });
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, chunks.join(""));
}

async function clickLoadOlderMessages(
  page: Page,
  clicks: number,
  waitAfterClickMs: number,
): Promise<void> {
  for (let clickIndex = 0; clickIndex < clicks; clickIndex += 1) {
    const button = page.locator(".load-older-button").first();
    const visible = await button.isVisible().catch(() => false);
    if (!visible) {
      console.log(`loadOlder=${clickIndex} unavailable`);
      return;
    }
    const disabled = await button.isDisabled().catch(() => true);
    if (disabled) {
      console.log(`loadOlder=${clickIndex} disabled`);
      return;
    }
    console.log(`loadOlder=${clickIndex} click`);
    await button.click();
    await page.waitForTimeout(waitAfterClickMs);
  }
}

async function main(): Promise<void> {
  const config = buildConfig();
  const runId = timestampForFile();
  const jsonlPath = join(config.outDir, `long-session-${runId}.jsonl`);
  const eventsPath = join(config.outDir, `long-session-${runId}.events.jsonl`);
  const summaryPath = join(config.outDir, `long-session-${runId}.summary.json`);
  const heapSamplePath = join(
    config.outDir,
    `long-session-${runId}.heap-sampling.json`,
  );
  const heapSnapshotPath = join(
    config.outDir,
    `long-session-${runId}.heapsnapshot`,
  );

  const browser = await chromium.launch({
    chromiumSandbox: true,
    headless: config.headless,
    args: ["--js-flags=--expose-gc"],
  });
  const browserWithProcess = browser as typeof browser & {
    process?: () => { pid?: number } | null;
  };
  const rootPid = browserWithProcess.process?.()?.pid ?? null;
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  const page = await context.newPage();
  await installPageProbe(page);
  const cdp = await context.newCDPSession(page);
  await cdp.send("Performance.enable");
  await cdp.send("HeapProfiler.enable");
  if (config.allocationSampling) {
    await cdp.send("HeapProfiler.startSampling", {
      samplingInterval: 32768,
      includeObjectsCollectedByMajorGC: false,
      includeObjectsCollectedByMinorGC: false,
    });
  }

  const startedAt = Date.now();
  const samples: Sample[] = [];
  const eventTracing = installEventTracing(page, eventsPath, startedAt);
  await writeJson(summaryPath, {
    status: "running",
    config,
    jsonlPath,
    eventsPath,
    heapSamplePath: config.allocationSampling ? heapSamplePath : null,
    heapSnapshotPath: config.heapSnapshot ? heapSnapshotPath : null,
    startedAt: new Date(startedAt).toISOString(),
  });

  try {
    await page.goto(config.url, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("[data-message-list]", { timeout: 30_000 });
    await page.waitForTimeout(2_000);
    if (config.loadOlderClicks > 0) {
      await clickLoadOlderMessages(
        page,
        config.loadOlderClicks,
        config.waitAfterLoadOlderMs,
      );
    }

    const sampleCount = Math.max(
      1,
      Math.floor(config.durationMs / config.intervalMs) + 1,
    );
    for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
      const sample = await collectSample(
        page,
        cdp,
        rootPid,
        sampleIndex,
        startedAt,
        config.forceGcEachSample,
        eventTracing.events,
      );
      samples.push(sample);
      await appendJsonl(jsonlPath, sample);
      const heapMb =
        typeof sample.page.memory?.usedJSHeapSize === "number"
          ? (sample.page.memory.usedJSHeapSize / 1024 / 1024).toFixed(1)
          : "n/a";
      const rssMb =
        typeof sample.browserProcess.rssBytes === "number"
          ? (sample.browserProcess.rssBytes / 1024 / 1024).toFixed(1)
          : "n/a";
      console.log(
        [
          `sample=${sampleIndex}`,
          `elapsed=${Math.round(sample.elapsedMs / 1000)}s`,
          `heap=${heapMb}MB`,
          `rss=${rssMb}MB`,
          `nodes=${sample.page.dom.nodes}`,
          `rows=${sample.page.dom.messageRows}`,
          `tools=${sample.page.dom.toolRows}`,
          `events=${sample.events.total}`,
          `maxRafGap=${Math.round(sample.page.probe?.maxRafGapMs ?? 0)}ms`,
          `longTasks=${sample.page.probe?.longTaskCount ?? "n/a"}`,
        ].join(" "),
      );
      if (sampleIndex < sampleCount - 1) {
        await page.waitForTimeout(config.intervalMs);
      }
    }

    let heapSamplingSummary: Array<Record<string, unknown>> | null = null;
    if (config.allocationSampling) {
      const result = (await cdp.send("HeapProfiler.stopSampling")) as {
        profile?: unknown;
      };
      await writeJson(heapSamplePath, result.profile ?? result);
      heapSamplingSummary = topHeapSampleNodes(result.profile ?? result);
    }
    if (config.heapSnapshot) {
      await writeHeapSnapshot(cdp, heapSnapshotPath);
    }

    await writeJson(summaryPath, {
      status: "completed",
      config,
      jsonlPath,
      eventsPath,
      heapSamplePath: config.allocationSampling ? heapSamplePath : null,
      heapSnapshotPath: config.heapSnapshot ? heapSnapshotPath : null,
      startedAt: new Date(startedAt).toISOString(),
      completedAt: new Date().toISOString(),
      summary: summarize(samples, eventTracing.events),
      topHeapSamplingNodes: heapSamplingSummary,
    });
    console.log(`summary=${summaryPath}`);
    console.log(`samples=${jsonlPath}`);
    console.log(`events=${eventsPath}`);
    if (config.allocationSampling)
      console.log(`heapSampling=${heapSamplePath}`);
    if (config.heapSnapshot) console.log(`heapSnapshot=${heapSnapshotPath}`);
  } finally {
    await eventTracing.flush();
    await cdp.detach().catch(() => {});
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
