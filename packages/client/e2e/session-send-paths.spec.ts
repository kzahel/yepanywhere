import { join } from "node:path";
import type { Page, Route } from "@playwright/test";
import {
  decodeJsonFrame,
  type RemoteClientMessage,
} from "@yep-anywhere/shared";
import { e2ePaths, expect, test } from "./fixtures.js";

/**
 * Pins what the session page's send paths do today on their less common
 * outcomes, before plan 179 moves their decisions into plain functions
 * (docs/tactical/179-session-composer-send-decisions.md, slice 0). Each case
 * routes the session, its stream and the send endpoints, then checks the
 * requests, the toast and the composer.
 */

const projectId = Buffer.from(join(e2ePaths.tempDir, "mockproject")).toString(
  "base64url",
);
const sessionId = "mock-session-001";

test.use({ serviceWorkers: "block" });

type Endpoint = "messages" | "resume" | "stale-handoff" | "project-queue";
interface SentRequest {
  endpoint: Endpoint;
  body: Record<string, unknown>;
}
type Responder = (
  route: Route,
  body: Record<string, unknown>,
) => Promise<void> | void;

const json = (route: Route, status: number, body: object) =>
  route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });

const resumed = (route: Route) =>
  json(route, 200, {
    processId: "resumed-process",
    permissionMode: "default",
    modeVersion: 1,
    serverTimestamp: Date.now(),
  });

const handoffRefusal = {
  error: "This transcript cannot resume. Start a handoff session.",
  recovery: "handoff-required",
};

/**
 * Opens the fixture session with the given owner and stream state, routing
 * each send endpoint to its responder and recording every request.
 */
async function openSession(
  page: Page,
  baseURL: string,
  {
    owner,
    processState,
    respond,
    queueBacklog = false,
    routed = false,
  }: {
    owner: "self" | "none";
    processState: "idle" | "in-turn";
    respond: Partial<Record<Endpoint, Responder>>;
    /** A message already in the session's own queue, which shows the
     * Project Queue action. */
    queueBacklog?: boolean;
    /** A session bound to an Agent Auth Router account. */
    routed?: boolean;
  },
) {
  const requests: SentRequest[] = [];
  let subscribes = 0;
  let sessionLoads = 0;
  // Onboarding is server state; answer it so no case waits on its dialog.
  await page.route("**/api/onboarding", (route) =>
    route.request().method() === "GET"
      ? route.fulfill({ json: { complete: true } })
      : route.continue(),
  );
  if (queueBacklog) {
    // The current-session Project Queue button is hidden until pinned.
    await page.addInitScript(() => {
      localStorage.setItem(
        "yep-anywhere-session-toolbar-presence",
        JSON.stringify({ projectQueue: "pin" }),
      );
    });
  }
  const ownership =
    owner === "self"
      ? { owner: "self", processId: "send-paths-process" }
      : { owner: "none" };
  await page.route(
    new RegExp(
      `/api/projects/[^/]+/sessions/${sessionId}(?:/metadata)?(?:\\?|$)`,
    ),
    async (route) => {
      if (route.request().method() !== "GET") return route.continue();
      const response = await route.fetch();
      const body = await response.json();
      await route.fulfill({
        response,
        json: {
          ...body,
          session: {
            ...body.session,
            ownership,
            ...(routed ? { routerBinding: { poolId: "send-paths-pool" } } : {}),
          },
          ownership,
          processState: owner === "self" ? processState : "idle",
        },
      });
      sessionLoads += 1;
    },
  );
  const record =
    (endpoint: Endpoint) =>
    async (route: Route): Promise<void> => {
      if (route.request().method() !== "POST") return route.continue();
      const body = (route.request().postDataJSON() ?? {}) as Record<
        string,
        unknown
      >;
      requests.push({ endpoint, body });
      const responder = respond[endpoint];
      // A send this case does not expect must not reach the shared server.
      if (!responder) {
        await json(route, 599, {
          error: "unexpected send in session-send-paths",
        });
        return;
      }
      await responder(route, body);
    };
  await page.route(`**/api/sessions/${sessionId}/messages`, record("messages"));
  await page.route(
    `**/api/projects/*/sessions/${sessionId}/resume`,
    record("resume"),
  );
  await page.route(
    `**/api/projects/*/sessions/${sessionId}/stale-handoff`,
    record("stale-handoff"),
  );
  await page.route(
    `**/api/projects/${projectId}/queue`,
    record("project-queue"),
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
        socket.send(
          JSON.stringify({
            type: "event",
            subscriptionId: request.subscriptionId,
            eventType: "connected",
            eventId: `send-paths-${subscribes}`,
            data: {
              sessionId,
              processId: "send-paths-process",
              state: owner === "self" ? processState : "idle",
              permissionMode: "default",
              modeVersion: 1,
              deferredMessages: queueBacklog
                ? [
                    {
                      tempId: "send-paths-backlog",
                      content: "Earlier queued message",
                      timestamp: new Date().toISOString(),
                      kind: "deferred",
                    },
                  ]
                : [],
            },
          }),
        );
        return;
      }
      upstream.send(message);
    });
  });
  await page.goto(`${baseURL}/projects/${projectId}/sessions/${sessionId}`);
  // The session's own composer (a handoff dialog adds a second one).
  const composer = page.locator(
    `[data-composer-input][data-draft-key="draft-message-${sessionId}"]`,
  );
  await expect(composer).toBeVisible({ timeout: 30_000 });
  // Wait until the routed session (with its owner) has loaded and rendered:
  // an owned session queues to its process, an unowned one resumes.
  await expect(page.getByText("Previous message").first()).toBeVisible();
  await expect.poll(() => sessionLoads).toBeGreaterThan(0);
  if (owner === "self") await expect.poll(() => subscribes).toBeGreaterThan(0);
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  return {
    composer,
    requests,
    endpoints: () => requests.map((request) => request.endpoint),
    subscribes: () => subscribes,
    toast: (text: string) => page.getByRole("alert").filter({ hasText: text }),
    handoffDialog: page.getByRole("dialog", { name: "Handoff Session" }),
  };
}

test("a send that finds no process resumes and clears the composer", async ({
  page,
  baseURL,
}) => {
  const text = "Resume after the process went away.";
  const session = await openSession(page, baseURL, {
    owner: "self",
    processState: "idle",
    respond: {
      messages: (route) => json(route, 404, { error: "No active process" }),
      resume: resumed,
    },
  });
  await session.composer.fill(text);
  await session.composer.press("Enter");

  await expect.poll(session.endpoints).toEqual(["messages", "resume"]);
  const [queued, retried] = session.requests.map((request) => request.body);
  expect(queued?.tempId).toEqual(expect.any(String));
  expect(queued?.clientTimestamp).toEqual(expect.any(Number));
  expect(retried?.message).toBe(text);
  expect(retried?.tempId).toBe(queued?.tempId);
  expect(retried?.clientTimestamp).toBe(queued?.clientTimestamp);
  // The retried resume carries showThinking like a first attempt.
  expect(retried).toHaveProperty("showThinking");
  await expect(session.composer).toHaveValue("");
  await expect(page.getByText(/Failed to send message/)).toHaveCount(0);
});

test("a queued message whose process ended resumes and clears", async ({
  page,
  baseURL,
}) => {
  const text = "Queue this after the turn.";
  const session = await openSession(page, baseURL, {
    owner: "self",
    processState: "in-turn",
    respond: {
      messages: (route) => json(route, 410, { error: "Process terminated" }),
      resume: resumed,
    },
  });
  await session.composer.fill(text);
  await session.composer.press("Control+Enter");

  await expect.poll(session.endpoints).toEqual(["messages", "resume"]);
  expect(session.requests[0]?.body.deferred).toBe(true);
  expect(session.requests[1]?.body.message).toBe(text);
  await expect(session.composer).toHaveValue("");
  await expect(page.getByText(/Failed to queue message/)).toHaveCount(0);
});

test("a stale redirect hands the message to a new session and opens it", async ({
  page,
  baseURL,
}) => {
  const text = "Carry this into a fresh session.";
  const session = await openSession(page, baseURL, {
    owner: "self",
    processState: "idle",
    respond: {
      messages: (route) =>
        json(route, 403, {
          error: "This session has gone cold",
          reason: "stale-session",
          staleRedirect: "stale-handoff",
        }),
      "stale-handoff": (route) =>
        json(route, 200, {
          sessionId: "send-paths-handoff",
          projectId,
          processId: "handoff-process",
          permissionMode: "default",
          modeVersion: 0,
          title: "Fresh session",
        }),
    },
  });
  await session.composer.fill(text);
  await session.composer.press("Enter");

  await expect.poll(session.endpoints).toEqual(["messages", "stale-handoff"]);
  expect(session.requests[1]?.body.message).toBe(text);
  await expect(
    page.getByText(
      "That session had gone idle, so your message started a new session",
    ),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/sessions\/send-paths-handoff/);
});

test("a stale redirect with no free worker queues the new session", async ({
  page,
  baseURL,
}) => {
  const session = await openSession(page, baseURL, {
    owner: "self",
    processState: "idle",
    respond: {
      messages: (route) =>
        json(route, 403, {
          error: "This session has gone cold",
          reason: "stale-session",
          staleRedirect: "stale-handoff",
        }),
      "stale-handoff": (route) => json(route, 200, { queued: true }),
    },
  });
  await session.composer.fill("Start this when a worker is free.");
  await session.composer.press("Enter");

  await expect(
    page.getByText(
      "That session had gone idle, so your message will start a new session when a worker is free",
    ),
  ).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/sessions/${sessionId}`));
  await expect(session.composer).toHaveValue("");
});

test("a resume refused for a handoff restores the draft and offers one", async ({
  page,
  baseURL,
}) => {
  const text = "Try to resume a transcript that cannot continue.";
  // No error text: the message is the status line, which selects the
  // built-in handoff explanation.
  const session = await openSession(page, baseURL, {
    owner: "none",
    processState: "idle",
    respond: {
      resume: (route) => json(route, 409, { recovery: "handoff-required" }),
    },
  });
  await expect(session.handoffDialog).toHaveCount(0);
  await session.composer.fill(text);
  await session.composer.press("Enter");

  await expect.poll(session.endpoints).toEqual(["resume"]);
  // A first-attempt resume carries showThinking (plan 179 S4).
  expect(session.requests[0]?.body).toHaveProperty("showThinking");
  await expect(
    session.toast(
      "Claude session cannot be safely resumed because the Claude SDK recorded an API-error response as the latest assistant message. Start a handoff session instead.",
    ),
  ).toBeVisible();
  await expect(session.handoffDialog).toBeVisible();
  await expect(session.composer).toHaveValue(text);
});

test("a routed session refused for a handoff explains instead of offering one", async ({
  page,
  baseURL,
}) => {
  const text = "Resume a routed session that cannot continue.";
  const session = await openSession(page, baseURL, {
    owner: "none",
    processState: "idle",
    routed: true,
    respond: { resume: (route) => json(route, 409, handoffRefusal) },
  });
  await session.composer.fill(text);
  await session.composer.press("Enter");

  await expect.poll(session.endpoints).toEqual(["resume"]);
  await expect(
    session.toast(
      "This session's last response failed, so it cannot resume, and sessions that use an Agent Auth Router account cannot hand off yet. Start a new session to continue.",
    ),
  ).toBeVisible();
  await expect(session.handoffDialog).toHaveCount(0);
  await expect(session.composer).toHaveValue(text);
});

test("a queued message refused for a handoff restores the draft and offers one", async ({
  page,
  baseURL,
}) => {
  const text = "Queue onto a transcript that cannot continue.";
  const session = await openSession(page, baseURL, {
    owner: "self",
    processState: "in-turn",
    respond: { messages: (route) => json(route, 409, handoffRefusal) },
  });
  await expect(session.handoffDialog).toHaveCount(0);
  await session.composer.fill(text);
  await session.composer.press("Control+Enter");

  await expect.poll(session.endpoints).toEqual(["messages"]);
  expect(session.requests[0]?.body.deferred).toBe(true);
  await expect(session.toast(handoffRefusal.error)).toBeVisible();
  await expect(session.handoffDialog).toBeVisible();
  await expect(session.composer).toHaveValue(text);
});

test("a send that restarts the process reconnects, and queued compaction shows", async ({
  page,
  baseURL,
}) => {
  let beforeRestart = Number.POSITIVE_INFINITY;
  const session = await openSession(page, baseURL, {
    owner: "self",
    processState: "idle",
    respond: {
      messages: (route) => {
        // Only subscriptions after the restart response count.
        beforeRestart = session.subscribes();
        return json(route, 200, {
          queued: true,
          restarted: true,
          compactQueued: true,
          processId: "restarted-process",
          serverTimestamp: Date.now(),
        });
      },
    },
  });
  await session.composer.fill("Send into a restarted process.");
  await session.composer.press("Enter");

  await expect.poll(session.endpoints).toEqual(["messages"]);
  await expect.poll(session.subscribes).toBeGreaterThan(beforeRestart);
  await expect(page.getByText("Compacting context...")).toBeVisible();
  await expect(session.composer).toHaveValue("");
});

test("a turn-effort turn while busy goes to the deferred queue", async ({
  page,
  baseURL,
}) => {
  const session = await openSession(page, baseURL, {
    owner: "self",
    processState: "in-turn",
    respond: {
      messages: (route, body) =>
        json(route, 200, {
          queued: true,
          deferred: true,
          deferredMessages: [
            {
              tempId: body.tempId,
              content: body.message,
              timestamp: new Date().toISOString(),
              kind: "deferred",
            },
          ],
          serverTimestamp: Date.now(),
        }),
    },
  });
  await session.composer.fill("/fast tidy the imports");
  await session.composer.press("Enter");

  await expect.poll(session.endpoints).toEqual(["messages"]);
  const body = session.requests[0]?.body ?? {};
  expect(body.deferred).toBe(true);
  expect(body.message).toBe("tidy the imports");
  expect(body.messageMetadata).toMatchObject({
    deliveryIntent: "deferred",
    turnEffort: "fast",
  });
  await expect(session.composer).toHaveValue("");
});

test("Project Queue queues an existing-session message and confirms it", async ({
  page,
  baseURL,
}) => {
  const text = "Run this once the project is idle.";
  const session = await openSession(page, baseURL, {
    owner: "self",
    processState: "in-turn",
    queueBacklog: true,
    respond: {
      "project-queue": (route) =>
        json(route, 200, { item: {}, queue: { projectId, items: [] } }),
    },
  });
  await session.composer.fill(text);
  await page.getByRole("button", { name: /Queue for Project Queue/ }).click();

  await expect.poll(session.endpoints).toEqual(["project-queue"]);
  const body = session.requests[0]?.body as {
    target?: Record<string, unknown>;
    message?: Record<string, unknown>;
  };
  expect(body.target).toMatchObject({
    type: "existing-session",
    sessionId,
  });
  expect(body.message).toMatchObject({ text });
  expect(body.message?.metadata).toMatchObject({ deliveryIntent: "deferred" });
  await expect(page.getByText("Queued for Project Queue.")).toBeVisible();
  await expect(session.composer).toHaveValue("");
});

test("Project Queue refuses a composer-only command and keeps the draft", async ({
  page,
  baseURL,
}) => {
  const session = await openSession(page, baseURL, {
    owner: "self",
    processState: "in-turn",
    queueBacklog: true,
    respond: {},
  });
  await session.composer.fill("/model");
  await page.getByRole("button", { name: /Queue for Project Queue/ }).click();

  await expect(
    page.getByText(
      "/model acts on the composer, so it cannot be queued. Send it directly.",
    ),
  ).toBeVisible();
  expect(session.endpoints()).toEqual([]);
  await expect(session.composer).toHaveValue("/model");
});

test("a correction is framed on send, and an unchanged one is refused", async ({
  page,
  baseURL,
}) => {
  const session = await openSession(page, baseURL, {
    owner: "self",
    processState: "idle",
    respond: {
      messages: (route) =>
        json(route, 200, { queued: true, serverTimestamp: Date.now() }),
    },
  });
  await page
    .getByRole("button", { name: "Edit latest message" })
    .click({ force: true });
  await expect(session.composer).toHaveValue("Previous message");

  await session.composer.press("Enter");
  await expect(page.getByText("No correction changes to send.")).toBeVisible();
  await expect(session.composer).toHaveValue("Previous message");
  expect(session.endpoints()).toEqual([]);

  await session.composer.fill("Previous message, corrected");
  await session.composer.press("Enter");
  await expect.poll(session.endpoints).toEqual(["messages"]);
  const sent = String(session.requests[0]?.body.message);
  expect(sent).toContain("Previous message, corrected");
  expect(sent).not.toBe("Previous message, corrected");
  await expect(session.composer).toHaveValue("");
});

test("a turn-effort command while correcting goes unframed", async ({
  page,
  baseURL,
}) => {
  const session = await openSession(page, baseURL, {
    owner: "self",
    processState: "idle",
    respond: {
      messages: (route) =>
        json(route, 200, { queued: true, serverTimestamp: Date.now() }),
    },
  });
  await page
    .getByRole("button", { name: "Edit latest message" })
    .click({ force: true });
  await expect(page.getByText("Correcting latest message")).toBeVisible();

  await session.composer.fill("/fast tidy the imports");
  await session.composer.press("Enter");
  await expect.poll(session.endpoints).toEqual(["messages"]);
  expect(session.requests[0]?.body.message).toBe("tidy the imports");
  await expect(page.getByText("Correcting latest message")).toHaveCount(0);
});

// Commands the page runs itself never reach the send path's own clear, so
// they end correction mode themselves.
test("a command the page runs itself ends correction mode", async ({
  page,
  baseURL,
}) => {
  const session = await openSession(page, baseURL, {
    owner: "self",
    processState: "idle",
    respond: {},
  });
  await page
    .getByRole("button", { name: "Edit latest message" })
    .click({ force: true });
  await expect(page.getByText("Correcting latest message")).toBeVisible();

  await session.composer.fill("/model");
  await session.composer.press("Enter");
  await expect(
    page.getByRole("dialog", { name: /Switch Model/ }),
  ).toBeVisible();
  await expect(page.getByText("Correcting latest message")).toHaveCount(0);
  expect(session.endpoints()).toEqual([]);
});

test("start-now on a server without creation admission uses the legacy route", async ({
  page,
  baseURL,
}) => {
  // Creation admission is an optional bit (capability 147: word 4, bit 19)
  // that no version implies; clear the bit and the name.
  await page.route("**/api/version*", async (route) => {
    const response = await route.fetch();
    const version = await response.json();
    version.capabilities = version.capabilities?.filter(
      (capability: string) => capability !== "session-creation-admission-v1",
    );
    version.capabilityBits = version.capabilityBits?.map(
      ([word, bits]: [number, number]) => [
        word,
        word === 4 && Math.floor(bits / 2 ** 19) % 2 === 1
          ? bits - 2 ** 19
          : bits,
      ],
    );
    await route.fulfill({ response, json: version });
  });
  const started: Record<string, unknown>[] = [];
  await page.route(`**/api/projects/${projectId}/sessions`, (route) => {
    if (route.request().method() !== "POST") return route.continue();
    started.push(route.request().postDataJSON() as Record<string, unknown>);
    return json(route, 200, {
      sessionId: "send-paths-legacy",
      projectId,
      processId: "legacy-process",
      permissionMode: "default",
      modeVersion: 0,
    });
  });
  const session = await openSession(page, baseURL, {
    owner: "self",
    processState: "idle",
    respond: {},
  });
  await session.composer.fill("Start this as a new session");
  await page.locator(".send-button-with-help").click({ button: "right" });
  await expect(
    page.getByRole("form", { name: "Queue as new session" }),
  ).toBeVisible();
  await session.composer.press("Enter");

  await expect.poll(() => started.length).toBe(1);
  const request = started[0] ?? {};
  expect(request.message).toBe("Start this as a new session");
  expect(request).toMatchObject({ mode: "default", provider: "claude" });
  expect(request.model).toEqual(expect.any(String));
  expect(request.messageMetadata).toMatchObject({ deliveryIntent: "direct" });
  await expect(page).toHaveURL(/\/sessions\/send-paths-legacy/);
  expect(await page.evaluate(() => history.state?.usr)).toMatchObject({
    initialTitle: "Start this as a new session",
    initialProvider: "claude",
    initialModel: request.model,
    initialStatus: {
      owner: "self",
      processId: "legacy-process",
      modeVersion: 0,
    },
  });
  expect(session.endpoints()).toEqual([]);
});

test("a send whose process ended (410) resumes, as a queued message does", async ({
  page,
  baseURL,
}) => {
  const text = "Resume after the process ended.";
  const session = await openSession(page, baseURL, {
    owner: "self",
    processState: "idle",
    respond: {
      messages: (route) => json(route, 410, { error: "Process terminated" }),
      resume: resumed,
    },
  });
  await session.composer.fill(text);
  await session.composer.press("Enter");

  await expect.poll(session.endpoints).toEqual(["messages", "resume"]);
  expect(session.requests[1]?.body.message).toBe(text);
  await expect(session.composer).toHaveValue("");
  await expect(page.getByText(/Failed to send message/)).toHaveCount(0);
});

test("a send the server defers shows in the queue, as a queued message does", async ({
  page,
  baseURL,
}) => {
  const text = "Send behind a queued compaction.";
  const session = await openSession(page, baseURL, {
    owner: "self",
    processState: "idle",
    respond: {
      messages: (route, body) =>
        json(route, 200, {
          queued: true,
          deferred: true,
          deferredMessages: [
            {
              tempId: body.tempId,
              content: body.message,
              timestamp: new Date().toISOString(),
              kind: "deferred",
            },
          ],
          serverTimestamp: Date.now(),
        }),
    },
  });
  await session.composer.fill(text);
  await session.composer.press("Enter");

  await expect.poll(session.endpoints).toEqual(["messages"]);
  await expect(page.getByText("Queued (next regular)")).toBeVisible();
  await expect(session.composer).toHaveValue("");
});
