import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.js";
import {
  json,
  openSessionPage,
  projectId,
  sessionId,
} from "./support/session-page-harness.js";

/**
 * Pins what the session page's queued-message actions do today, before
 * docs/tactical/181-session-page-feature-hooks.md moves them out of
 * SessionPage.tsx into hooks: queued chips, recovered queue entries, Project
 * Queue items shown in the session, an unconfirmed steer, and the composer
 * recall those handlers keep current. Each case answers the endpoints the
 * action calls and checks the request, the toast, the chips and the composer.
 */

test.use({ serviceWorkers: "block", viewport: { width: 1200, height: 800 } });

const now = () => new Date().toISOString();
const queued = (
  tempId: string,
  content: string,
  extra: Record<string, unknown> = {},
) => ({ tempId, content, timestamp: now(), kind: "deferred", ...extra });
const deferredPath = (tempId: string) =>
  `/sessions/${sessionId}/deferred/${tempId}`;
const chip = (page: Page, text: string) =>
  page.locator(".deferred-message").filter({ hasText: text });

test("Edit returns a queued message with its effort command to the composer, only when the composer is free", async ({
  page,
  baseURL,
}) => {
  const session = await openSessionPage(page, baseURL, {
    owner: "self",
    processState: "in-turn",
    deferredMessages: [
      queued("pin-edit", "Tidy the imports", {
        metadata: { deliveryIntent: "deferred", turnEffort: "fast" },
      }),
    ],
  });
  await session.answer("DELETE", deferredPath("pin-edit"), (route) =>
    json(route, 200, { cancelled: true }),
  );
  const edit = chip(page, "Tidy the imports").getByRole("button", {
    name: "Edit queued message",
  });
  await expect(edit).toBeVisible();

  // A draft or a staged attachment holds the composer, so Edit is withheld.
  await session.composer.fill("Draft in progress");
  await expect(edit).toHaveCount(0);
  await session.composer.fill("");
  await page
    .locator(".message-input-wrapper input[type=file]")
    .first()
    .setInputFiles({
      name: "pin-queue.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("queued attachment"),
    });
  await expect(page.getByText("pin-queue.txt").first()).toBeVisible();
  await expect(edit).toHaveCount(0);
  await page.getByRole("button", { name: /Remove pin-queue\.txt/ }).click();
  await expect(edit).toBeVisible();
  expect(session.requests()).toEqual([]);

  await edit.click();
  await expect
    .poll(session.requests)
    .toEqual([`DELETE ${deferredPath("pin-edit")}`]);
  await expect(session.composer).toHaveValue("/fast Tidy the imports");
});

test("cancelling a queued message toasts a real failure but not a missing entry; Ctrl+K cancels the latest", async ({
  page,
  baseURL,
}) => {
  const session = await openSessionPage(page, baseURL, {
    owner: "self",
    processState: "in-turn",
    deferredMessages: [
      queued("pin-locked", "Locked queued message"),
      queued("pin-gone", "Already delivered message"),
    ],
  });
  await session.answer("DELETE", deferredPath("pin-gone"), (route) =>
    json(route, 404, { error: "Deferred message not found" }),
  );
  await session.answer("DELETE", deferredPath("pin-locked"), (route) =>
    json(route, 500, { error: "Queue is locked" }),
  );

  // Ctrl+K in the composer cancels the latest queued message.
  await session.composer.press("Control+k");
  await expect
    .poll(session.requests)
    .toEqual([`DELETE ${deferredPath("pin-gone")}`]);

  await chip(page, "Locked queued message")
    .getByRole("button", { name: "Cancel queued message" })
    .click();
  await expect(
    session.toast("Failed to cancel queued message: Queue is locked"),
  ).toBeVisible();
  expect(session.requests()).toEqual([
    `DELETE ${deferredPath("pin-gone")}`,
    `DELETE ${deferredPath("pin-locked")}`,
  ]);
  // The missing entry produced no toast of its own.
  await expect(session.toast("Failed to cancel queued message")).toHaveCount(1);
});

test("steering a patient message posts steer-through, and send without compacting takes the server's queue", async ({
  page,
  baseURL,
}) => {
  const session = await openSessionPage(page, baseURL, {
    owner: "self",
    processState: "in-turn",
    deferredMessages: [
      queued("pin-patient", "Patient follow-up", {
        kind: "patient",
        metadata: { deliveryIntent: "patient" },
      }),
      queued("pin-gated", "Behind a failed compaction", {
        compactionGate: { state: "failed", reason: "Compaction failed" },
      }),
    ],
  });
  const steerPath = `${deferredPath("pin-patient")}/steer`;
  const releasePath = `${deferredPath("pin-gated")}/deliver-without-compaction`;
  await session.answer("POST", steerPath, (route) =>
    json(route, 500, { error: "Process busy" }),
  );
  await session.answer("POST", releasePath, (route) =>
    json(route, 200, {
      released: true,
      deferredMessages: [queued("pin-server", "Queue as the server has it")],
    }),
  );

  await chip(page, "Patient follow-up")
    .getByRole("button", { name: "Steer queued message now" })
    .click();
  await expect(
    session.toast("Failed to steer queued message: Process busy"),
  ).toBeVisible();

  await chip(page, "Behind a failed compaction")
    .getByRole("button", { name: "Send without compacting" })
    .click();
  await expect
    .poll(session.requests)
    .toEqual([`POST ${steerPath}`, `POST ${releasePath}`]);
  await expect(chip(page, "Queue as the server has it")).toBeVisible();
  await expect(chip(page, "Behind a failed compaction")).toHaveCount(0);
  await expect(chip(page, "Patient follow-up")).toHaveCount(0);
});

test("recovered queue entries resume, steer and delete, and resuming makes the page live", async ({
  page,
  baseURL,
}) => {
  const recovered = (id: string, content: string) =>
    queued(`temp-${id}`, content, {
      id,
      kind: "patient",
      status: "paused-after-restart",
      metadata: { deliveryIntent: "patient" },
    });
  const resumeEntry = recovered("pin-rec-resume", "Recovered to resume");
  const steerEntry = recovered("pin-rec-steer", "Recovered to steer");
  const deleteEntry = recovered("pin-rec-delete", "Recovered to delete");
  const session = await openSessionPage(page, baseURL, {
    owner: "none",
    deferredMessages: [resumeEntry, steerEntry, deleteEntry],
  });
  const base = `/sessions/${sessionId}/recovered-queue`;
  const live = (deferredMessages: unknown[], processState: string) => ({
    processId: "pin-resumed",
    processState,
    permissionMode: "default",
    modeVersion: 2,
    deferredMessages,
    serverTimestamp: Date.now(),
  });
  await session.answer("POST", `${base}/pin-rec-resume/resume`, (route) => {
    session.setDeferredMessages([steerEntry, deleteEntry]);
    session.setOwner("pin-resumed", "in-turn");
    return json(route, 200, {
      resumed: true,
      ...live([steerEntry, deleteEntry], "in-turn"),
    });
  });
  await session.answer("POST", `${base}/pin-rec-steer/steer`, (route) => {
    session.setDeferredMessages([deleteEntry]);
    return json(route, 200, {
      steered: true,
      ...live([deleteEntry], "in-turn"),
    });
  });
  await session.answer("DELETE", `${base}/pin-rec-delete`, (route) => {
    session.setDeferredMessages([]);
    return json(route, 200, { deleted: true, deferredMessages: [] });
  });
  await expect(session.composer).toHaveAttribute(
    "placeholder",
    "Send a message to resume...",
  );

  await chip(page, "Recovered to resume")
    .getByRole("button", { name: "Resume recovered queued message" })
    .click();
  await expect(chip(page, "Recovered to resume")).toHaveCount(0);
  // The response's in-turn process now owns the session.
  await expect(session.composer).toHaveAttribute(
    "placeholder",
    "Queue a message...",
  );

  await chip(page, "Recovered to steer")
    .getByRole("button", { name: /^Steer/ })
    .click();
  await expect(chip(page, "Recovered to steer")).toHaveCount(0);

  await chip(page, "Recovered to delete")
    .getByRole("button", { name: "Delete recovered queued message" })
    .click();
  await expect(chip(page, "Recovered to delete")).toHaveCount(0);
  expect(session.requests()).toEqual([
    `POST ${base}/pin-rec-resume/resume`,
    `POST ${base}/pin-rec-steer/steer`,
    `DELETE ${base}/pin-rec-delete`,
  ]);
});

test("Project Queue items in the session resume dispatch, cancel, edit into the composer and steer", async ({
  page,
  baseURL,
}) => {
  const item = (id: string, text: string) => ({
    id,
    projectId,
    target: { type: "existing-session", sessionId },
    messagePreview: text,
    message: { text },
    createdAt: now(),
    updatedAt: now(),
    status: "queued",
    attachmentCount: 0,
  });
  const cancelItem = item("pin-pq-cancel", "Project item to cancel");
  const editItem = item("pin-pq-edit", "Project item to edit");
  const steerItem = item("pin-pq-steer", "Project item to steer");
  await page.route("**/api/project-queue", (route) =>
    route.request().method() === "GET"
      ? route.fulfill({
          json: {
            items: [cancelItem, editItem, steerItem],
            dispatchState: {
              status: "paused",
              reason: "manual",
              pausedAt: now(),
            },
          },
        })
      : route.fallback(),
  );
  const session = await openSessionPage(page, baseURL, { owner: "none" });
  const itemPath = (id: string) => `/projects/${projectId}/queue/${id}`;
  const promotePath = `/project-queue/${projectId}/promote-now`;
  await session.answer("POST", "/project-queue/resume", (route) =>
    json(route, 200, {
      items: [cancelItem, editItem, steerItem],
      dispatchState: { status: "running" },
    }),
  );
  await session.answer("DELETE", itemPath("pin-pq-cancel"), (route) =>
    json(route, 200, {
      deleted: true,
      queue: { projectId, items: [editItem, steerItem] },
    }),
  );
  await session.answer("DELETE", itemPath("pin-pq-edit"), (route) =>
    json(route, 200, {
      deleted: true,
      queue: { projectId, items: [steerItem] },
    }),
  );
  await session.answer("POST", promotePath, (route) =>
    json(route, 200, {
      items: [],
      promoteResult: {
        promoted: true,
        itemId: "pin-pq-steer",
        sessionId,
        reason: "promoted",
        status: {
          projectId,
          state: "dispatching",
          idle: false,
          blockers: [],
          dispatchPaused: false,
          inFlight: true,
          quietWindowMs: 0,
          itemCount: 0,
        },
      },
    }),
  );
  const row = (text: string) =>
    page
      .locator("[data-message-list] [data-message-render-row]")
      .filter({ hasText: text });

  await row("Project item to cancel")
    .getByRole("button", { name: "Resume", exact: true })
    .click();
  await expect.poll(session.requests).toEqual(["POST /project-queue/resume"]);

  await row("Project item to cancel")
    .getByRole("button", { name: "Cancel Project Queue item" })
    .click();
  await expect(row("Project item to cancel")).toHaveCount(0);

  await row("Project item to edit")
    .getByRole("button", { name: "Edit Project Queue item" })
    .click();
  await expect(session.composer).toHaveValue("Project item to edit");
  await expect(row("Project item to edit")).toHaveCount(0);

  await row("Project item to steer")
    .getByRole("button", { name: "Steer Project Queue item now" })
    .click();
  await expect(session.toast("Steered Project Queue item now.")).toBeVisible();
  expect(session.requests()).toEqual([
    "POST /project-queue/resume",
    `DELETE ${itemPath("pin-pq-cancel")}`,
    `DELETE ${itemPath("pin-pq-edit")}`,
    `POST ${promotePath}`,
  ]);
  expect(session.calls[3]?.body).toEqual({
    itemId: "pin-pq-steer",
    force: true,
    deliveryIntent: "steer",
  });
});

// The fixture provider does not steer from the composer, so the server's
// echo of a steer this browser sent arrives on the stream, as it would.
test("cancelling an unconfirmed steer removes its row", async ({
  page,
  baseURL,
}) => {
  const session = await openSessionPage(page, baseURL, {
    owner: "self",
    processState: "in-turn",
  });
  session.emit("message", {
    type: "user",
    uuid: "pin-steer-echo",
    timestamp: now(),
    tempId: "pin-steer",
    messageMetadata: { deliveryIntent: "steer" },
    message: { role: "user", content: "Steer toward the parser" },
  });
  const steerRow = page
    .locator("[data-message-list] [data-render-id]")
    .filter({ hasText: "Steer toward the parser" });
  const steeringPath = `/sessions/${sessionId}/steering/pin-steer`;
  await session.answer("DELETE", steeringPath, (route) =>
    json(route, 200, { cancelled: true }),
  );
  await steerRow
    .getByRole("button", { name: "Cancel sent steering message" })
    .click();

  await expect.poll(session.requests).toEqual([`DELETE ${steeringPath}`]);
  await expect(steerRow).toHaveCount(0);
});

test("after cancelling and editing queued messages, ↑ recalls the last delivered one", async ({
  page,
  baseURL,
}) => {
  const session = await openSessionPage(page, baseURL, {
    owner: "self",
    processState: "in-turn",
  });
  const queue: ReturnType<typeof queued>[] = [];
  await session.answer(
    "POST",
    `/sessions/${sessionId}/messages`,
    (route, body) => {
      const { tempId, message } = body as { tempId: string; message: string };
      if (message === "Delivered first")
        return json(route, 200, {
          queued: true,
          deferred: false,
          promoted: true,
          deferredMessages: [],
          serverTimestamp: Date.now(),
        });
      queue.push(queued(tempId, message));
      return json(route, 200, {
        queued: true,
        deferred: true,
        deferredMessages: [...queue],
        serverTimestamp: Date.now(),
      });
    },
  );
  for (const text of ["Delivered first", "Queued second", "Queued third"]) {
    await session.composer.fill(text);
    await session.composer.press("Control+Enter");
    await expect(session.composer).toHaveValue("");
  }
  await expect(chip(page, "Queued third")).toBeVisible();
  const [second, third] = queue;
  if (!second || !third) throw new Error("Both messages should be queued");
  await session.answer("DELETE", deferredPath(third.tempId), (route) =>
    json(route, 200, { cancelled: true }),
  );
  await session.answer("DELETE", deferredPath(second.tempId), (route) =>
    json(route, 200, { cancelled: true }),
  );

  await chip(page, "Queued third")
    .getByRole("button", { name: "Cancel queued message" })
    .click();
  await expect
    .poll(() => session.requests().at(-1))
    .toBe(`DELETE ${deferredPath(third.tempId)}`);
  // The server's mirror drops the cancelled message.
  session.emit("deferred-queue", { messages: [second], reason: "cancelled" });
  await expect(chip(page, "Queued third")).toHaveCount(0);

  await chip(page, "Queued second")
    .getByRole("button", { name: "Edit queued message" })
    .click();
  await expect(session.composer).toHaveValue("Queued second");
  session.emit("deferred-queue", { messages: [], reason: "edited" });
  await expect(chip(page, "Queued second")).toHaveCount(0);

  await session.composer.fill("");
  await session.composer.press("ArrowUp");
  await expect(session.composer).toHaveValue("Delivered first");
  await expect(
    page.getByRole("button", { name: "Cancel correction" }),
  ).toBeVisible();
});
