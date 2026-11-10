import { join } from "node:path";
import type { Locator, Page, Route } from "@playwright/test";
import {
  decodeJsonFrame,
  type RemoteClientMessage,
} from "@yep-anywhere/shared";
import { e2ePaths, expect } from "../fixtures.js";

/**
 * Opens the seeded `mock-session-001` session with its transcript, owner and
 * queue replaced, and records the requests a case answers. Shared by the
 * session-page pin specs so each case states only what it changes.
 */

export const projectId = Buffer.from(
  join(e2ePaths.tempDir, "mockproject"),
).toString("base64url");
export const sessionId = "mock-session-001";

const turnTime = (minute: number) =>
  new Date(Date.UTC(2026, 0, 2, 10, minute)).toISOString();

export function userTurn(
  uuid: string,
  text: string,
  minute: number,
  parentUuid: string | null = null,
) {
  return {
    type: "user",
    uuid,
    parentUuid,
    timestamp: turnTime(minute),
    message: { role: "user", content: text },
  };
}

export function agentReply(
  uuid: string,
  text: string,
  minute: number,
  parentUuid: string,
) {
  return {
    type: "assistant",
    uuid,
    parentUuid,
    timestamp: turnTime(minute),
    message: { role: "assistant", content: [{ type: "text", text }] },
  };
}

/** Two complete turns, so a later turn offers "Before" as well as "After". */
export const twoTurns = [
  userTurn("turn-1", "First request about the parser", 0),
  agentReply("reply-1", "The parser reads tokens.", 1, "turn-1"),
  userTurn("turn-2", "Second request about the lexer", 2, "reply-1"),
  agentReply("reply-2", "The lexer splits words.", 3, "turn-2"),
];

export interface ApiCall {
  method: string;
  path: string;
  body: unknown;
}
export type Reply = (route: Route, body: unknown) => Promise<void> | void;

export const json = (route: Route, status: number, body: object) =>
  route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });

interface OpenOptions {
  owner: "self" | "none";
  processState?: "idle" | "in-turn" | "waiting-input";
  /** The pending approval or question the session read reports. */
  pendingInputRequest?: Record<string, unknown>;
  /** Skip waiting for the composer, which a pending approval replaces. */
  composerHidden?: boolean;
  /** Replaces the fixture's one-row transcript. */
  messages?: unknown[];
  /** Queue entries the session stream and session reads report. */
  deferredMessages?: unknown[];
  /** Fields merged into the session the reads return. */
  session?: Record<string, unknown>;
  /** Text that shows the transcript has rendered. */
  ready?: string;
  /** Navigate here instead of the session URL (for arrival paths). */
  arrive?: (page: Page) => Promise<unknown>;
  /** Holds the session read (not the metadata read) until this settles. */
  holdSessionRead?: Promise<unknown>;
}

export async function openSessionPage(
  page: Page,
  baseURL: string,
  options: OpenOptions,
) {
  const calls: ApiCall[] = [];
  let subscribes = 0;
  let sessionLoads = 0;
  let deferredMessages = options.deferredMessages ?? [];
  let send: ((eventType: string, data: object) => void) | undefined;
  let processState =
    options.owner === "self" ? (options.processState ?? "idle") : "idle";
  let ownership: Record<string, string> =
    options.owner === "self"
      ? { owner: "self", processId: "pin-process" }
      : { owner: "none" };

  // Onboarding is server state; answer it so no case waits on its dialog.
  await page.route("**/api/onboarding", (route) =>
    route.request().method() === "GET"
      ? route.fulfill({ json: { complete: true } })
      : route.fallback(),
  );
  await page.route(
    new RegExp(
      `/api/projects/[^/]+/sessions/${sessionId}(?:/metadata)?(?:\\?|$)`,
    ),
    async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      // A read under another project (after a canonical redirect) still
      // fetches the fixture from its real project.
      const url = new URL(route.request().url());
      url.pathname = url.pathname.replace(
        /\/projects\/[^/]+\//,
        `/projects/${projectId}/`,
      );
      if (options.holdSessionRead && !url.pathname.endsWith("/metadata"))
        await options.holdSessionRead;
      const response = await route.fetch({ url: url.toString() });
      const body = await response.json();
      await route.fulfill({
        response,
        json: {
          ...body,
          session: { ...body.session, ownership, ...options.session },
          ...(options.messages && body.messages
            ? { messages: options.messages }
            : {}),
          ownership,
          processState,
          deferredMessages,
          ...(options.pendingInputRequest
            ? { pendingInputRequest: options.pendingInputRequest }
            : {}),
        },
      });
      sessionLoads += 1;
    },
  );
  await page.routeWebSocket("**/api/ws", (socket) => {
    const upstream = socket.connectToServer();
    socket.onMessage((message) => {
      const request =
        typeof message === "string"
          ? (JSON.parse(message) as RemoteClientMessage)
          : decodeJsonFrame<RemoteClientMessage>(message);
      if (
        request.type === "subscribe" &&
        request.channel === "session" &&
        request.sessionId === sessionId
      ) {
        subscribes += 1;
        let eventId = 0;
        send = (eventType, data) =>
          socket.send(
            JSON.stringify({
              type: "event",
              subscriptionId: request.subscriptionId,
              eventType,
              eventId: `pin-${subscribes}-${eventId++}`,
              data,
            }),
          );
        send("connected", {
          sessionId,
          processId: "pin-process",
          state: processState,
          permissionMode: "default",
          modeVersion: 1,
          deferredMessages,
          ...(options.pendingInputRequest
            ? { request: options.pendingInputRequest }
            : {}),
        });
        return;
      }
      upstream.send(message);
    });
  });

  const answer = (method: string, path: string, reply: Reply) =>
    page.route(
      (url) => url.pathname === `/api${path}`,
      async (route) => {
        const request = route.request();
        if (request.method() !== method) return route.fallback();
        let body: unknown;
        try {
          body = request.postDataJSON() ?? undefined;
        } catch {
          body = request.postData() ?? undefined;
        }
        calls.push({ method, path, body });
        await reply(route, body);
      },
    );

  if (options.arrive) await options.arrive(page);
  else
    await page.goto(`${baseURL}/projects/${projectId}/sessions/${sessionId}`);
  const composer = page.locator(
    `[data-composer-input][data-draft-key="draft-message-${sessionId}"]`,
  );
  if (!options.composerHidden)
    await expect(composer).toBeVisible({ timeout: 30_000 });
  const ready =
    options.ready ??
    (options.messages ? "First request about the parser" : "Previous message");
  await expect(
    page.locator("[data-message-list]").getByText(ready).first(),
  ).toBeVisible();
  await expect.poll(() => sessionLoads).toBeGreaterThan(0);
  if (options.owner === "self")
    await expect.poll(() => subscribes).toBeGreaterThan(0);
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );

  return {
    composer,
    calls,
    /** "METHOD /path" for each answered request, in order. */
    requests: () => calls.map((call) => `${call.method} ${call.path}`),
    answer,
    toast: (text: string) => page.getByRole("alert").filter({ hasText: text }),
    /** Sends a session stream event on the current subscription. */
    emit: (eventType: string, data: object) => send?.(eventType, data),
    setDeferredMessages: (next: unknown[]) => {
      deferredMessages = next;
    },
    /** What later session reads and stream connects report. */
    setOwner: (processId: string, state: "idle" | "in-turn") => {
      ownership = { owner: "self", processId };
      processState = state;
    },
    header: page.locator("[data-session-header]"),
    /**
     * Waits until the page offers forks. Fork support arrives with the
     * server's version after the page loads; until then the fork shortcut,
     * `/fork` and bare `/title` do nothing, so a case that types one first
     * waits here. The turn notch's fork button appears only once forks are
     * offered.
     */
    forksOffered: () =>
      expect(
        page.getByRole("button", { name: /^Fork from this turn/ }).first(),
      ).toBeVisible(),
  };
}

export type SessionPageHarness = Awaited<ReturnType<typeof openSessionPage>>;

/**
 * Types `text` into an empty `field` one key at a time, calling `between`
 * before each key (to deliver a live update), and checks every key shows in
 * the field within 100 ms of its keydown, painted (AGENTS.md).
 */
export async function typeEachKeyWithin100ms(
  field: Locator,
  text: string,
  between: (typedSoFar: string) => void = () => {},
) {
  await field.evaluate((element) => {
    element.addEventListener("keydown", () => performance.mark("pin-key"));
    element.addEventListener("input", () => {
      requestAnimationFrame(() => performance.measure("pin-ack", "pin-key"));
    });
  });
  let typed = "";
  for (const character of text) {
    between(typed);
    await field.pressSequentially(character);
    typed += character;
    await expect(field).toHaveValue(typed, { timeout: 100 });
  }
  const page = field.page();
  await expect
    .poll(() =>
      page.evaluate(() => performance.getEntriesByName("pin-ack").length),
    )
    .toBe(text.length);
  const acknowledgementMs = await page.evaluate(() =>
    performance.getEntriesByName("pin-ack").map((entry) => entry.duration),
  );
  expect(Math.max(...acknowledgementMs)).toBeLessThan(100);
}

/** A streaming assistant row, for live updates while a case types. */
export const liveUpdate = (count: number) => ({
  uuid: "pin-live",
  id: "pin-live",
  type: "assistant",
  _isStreaming: true,
  timestamp: new Date(Date.UTC(2026, 0, 2, 10, 30)).toISOString(),
  message: { role: "assistant", content: `Live update ${count}.` },
});
