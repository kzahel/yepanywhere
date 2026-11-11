import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import type { Message } from "@yep-anywhere/shared/transcript/message";
import {
  decodeJsonFrame,
  type RemoteClientMessage,
} from "@yep-anywhere/shared";
import {
  startYaServerProcess,
  disposeYaServerProcess,
} from "./support/ya-server-process";
import { recordUiCapture } from "./support/ui-capture";
import {
  routeWithDrain,
  drainManagedRoutes,
  readCollectionsOverRest,
} from "./support/managed-routes";

test.use({ serviceWorkers: "block" });

test("async questions preserve context, drafts, scroll and ordinary delivery", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const sessionId = "async-question-test";
  const projectPath = dirname(dirname(fileURLToPath(import.meta.url)));
  const backend = await startYaServerProcess({
    label: "async question test",
    serveBuiltClient: true,
    mockClaudeSession: {
      projectPath,
      sessionId,
      content: "Review this interface.",
    },
  });
  const projectId = Buffer.from(projectPath).toString("base64url");
  const apiPath = `/api/projects/${projectId}/sessions/${sessionId}`;
  let busy = true;
  let fail = false;
  let structured = true;
  let holdReply = false;
  const replyGate: { release?: () => void } = {};
  const sends: Array<{
    message: string;
    messageMetadata: { deliveryIntent: string };
  }> = [];
  let emit: ((eventType: string, data: object) => void) | undefined;
  let emitActivity: ((data: object) => void) | undefined;
  const questions = [
    {
      title: "Q: Should I wait for the other session or coordinate a handoff?",
      options: [
        "Wait for it to finish",
        "Coordinate the handoff and keep the draft available while work continues.",
      ],
    },
    { title: "Q: What else should the handoff include?", options: null },
    {
      title: "Q: Which review should come next?",
      options: ["Check the keyboard behavior", "Inspect the phone layout"],
    },
  ];
  const messages: Message[] = [
    { uuid: "user-start", type: "user", content: "Review this interface." },
    ...Array.from({ length: 18 }, (_, index) => ({
      uuid: `before-${index}`,
      type: "assistant",
      content: `Earlier context ${index}. The running work continues independently of any question.`,
    })),
    {
      uuid: "async-source",
      type: "assistant",
      content: questions
        .map((q) =>
          [q.title, ...(q.options ?? []).map((s) => `- ${s}`)].join("\n"),
        )
        .join("\n\n"),
      codexAgentMessageDelivery: "async",
      codexAsyncQuestions: questions,
    },
    ...Array.from({ length: 18 }, (_, index) => ({
      uuid: `after-${index}`,
      type: "assistant",
      content: `Later progress ${index}. Independent work continues while the user considers the question.`,
    })),
  ];
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => {
    if (
      message.type() === "warning" &&
      /React|act\(|rendering|Maximum update/.test(message.text())
    )
      browserErrors.push(message.text());
  });
  await page.route(
    (url) => url.pathname === apiPath,
    (route) =>
      route.fulfill({
        json: {
          session: {
            id: sessionId,
            projectId,
            provider: "codex",
            model: "gpt-6-astra",
            title: "Async questions",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
          messages: structured
            ? messages
            : messages.map((message) => ({
                ...message,
                codexAgentMessageDelivery: undefined,
                codexAsyncQuestions: undefined,
              })),
          ownership: { owner: "self", processId: "question-process" },
          processState: busy ? "in-turn" : "idle",
        },
      }),
  );
  await page.route(`**/api/sessions/${sessionId}/process`, (route) =>
    route.fulfill({ json: { process: null } }),
  );
  await routeWithDrain(
    page,
    `**/api/sessions/${sessionId}/messages`,
    async (route) => {
      sends.push(route.request().postDataJSON());
      if (holdReply)
        await new Promise<void>((resolve) => {
          replyGate.release = resolve;
        });
      await route.fulfill(
        fail
          ? { status: 503, json: { error: "Test send unavailable" } }
          : { json: { queued: true, serverTimestamp: Date.now() } },
      );
    },
  );
  await page.routeWebSocket("**/api/ws", (socket) => {
    const upstream = socket.connectToServer();
    socket.onMessage((message) => {
      const data =
        typeof message === "string"
          ? (JSON.parse(message) as RemoteClientMessage)
          : decodeJsonFrame<RemoteClientMessage>(message);
      if (
        data.type === "subscribe" &&
        data.channel === "session" &&
        data.sessionId === sessionId
      ) {
        let event = 0;
        emit = (eventType, payload) =>
          socket.send(
            JSON.stringify({
              type: "event",
              subscriptionId: data.subscriptionId,
              eventType,
              eventId: `question-${++event}`,
              data: payload,
            }),
          );
        emit("connected", {
          sessionId,
          state: busy ? "in-turn" : "idle",
          permissionMode: "default",
          modeVersion: 1,
        });
      } else {
        if (data.type === "subscribe" && data.channel === "activity") {
          emitActivity = (payload) =>
            socket.send(
              JSON.stringify({
                type: "event",
                subscriptionId: data.subscriptionId,
                eventType: "session-updated",
                eventId: `question-activity-${Date.now()}`,
                data: payload,
              }),
            );
        }
        upstream.send(message);
      }
    });
  });
  try {
    const origin = backend.baseUrl;
    const captures = process.env.YEP_E2E_UI_CAPTURE_DIR;
    if (captures) mkdirSync(captures, { recursive: true });
    const cdp = await page.context().newCDPSession(page);
    for (const viewport of [
      { name: "phone", width: 375, height: 812 },
      { name: "desktop", width: 1000, height: 600 },
    ]) {
      await cdp.send("Emulation.setTouchEmulationEnabled", {
        enabled: viewport.name === "phone",
      });
      await page.setViewportSize(viewport);
      await page.goto(`${origin}/projects/${projectId}/sessions/${sessionId}`);
      await page.evaluate(() => {
        for (const key of Object.keys(localStorage))
          if (key.startsWith("yep-async-questions:"))
            localStorage.removeItem(key);
      });
      await page.reload();
      const composer = page.locator("[data-composer-input]");
      await expect(composer).toBeVisible({ timeout: 30_000 });
      await composer.fill("Keep my main draft");
      const toolbar = page.locator("[data-message-input-actions]");
      const badge = toolbar.getByRole("button", { name: /^3 questions/ });
      await expect(badge).toBeVisible();
      expect(sends).toHaveLength(viewport.name === "phone" ? 0 : 1);
      const scroller = page.locator("main[data-session-messages]");
      // An unrevealed viewport also has bottom distance zero. Establish the
      // actual transcript volume before capturing the question's return position.
      await expect(
        page.getByText(
          "Later progress 17. Independent work continues while the user considers the question.",
          { exact: true },
        ),
      ).toBeVisible();
      await expect
        .poll(() =>
          scroller.evaluate((el) => el.scrollHeight > el.clientHeight),
        )
        .toBe(true);
      await expect
        .poll(() =>
          scroller.evaluate(
            (el) => el.scrollHeight - el.scrollTop - el.clientHeight,
          ),
        )
        .toBeLessThan(3);
      await badge.click();
      const menu = page.getByRole("dialog", { name: "Questions", exact: true });
      await expect(menu).toBeVisible();
      await expect(
        menu.getByRole("button", { name: /^Dismiss question: / }),
      ).toHaveCount(3);
      await expect(
        menu.getByRole("button", { name: "Dismiss all", exact: true }),
      ).toBeVisible();
      await recordUiCapture(page, `${viewport.name}-menu`, viewport);
      await menu
        .getByRole("button", { name: questions[0]!.title, exact: true })
        .click();
      const field = page.getByRole("textbox", {
        name: `Reply to: ${questions[0]!.title}`,
      });
      await expect(field).toBeFocused();
      await expect(field).toBeInViewport();
      await field.fill("Inline draft survives progress");
      emit?.("message", {
        uuid: "streamed-progress",
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "New live progress while replying." },
          ],
        },
      });
      await expect(
        page.getByText("New live progress while replying."),
      ).toBeVisible();
      await expect(field).toHaveValue("Inline draft survives progress");
      await expect(field).toBeFocused();
      await recordUiCapture(page, `${viewport.name}-reply`, viewport);
      await page
        .getByRole("button", { name: questions[0]!.options![1], exact: true })
        .click();
      await expect(composer).toBeFocused();
      await expect(composer).toHaveValue("Keep my main draft");
      await test.step(`${viewport.name}: reply keeps the transcript pinned`, async () => {
        await expect
          .poll(() =>
            scroller.evaluate(
              (el) => el.scrollHeight - el.scrollTop - el.clientHeight,
            ),
          )
          .toBeLessThan(3);
      });
      expect(sends.at(-1)).toMatchObject({
        message: `> ${questions[0]!.title}\n\n${questions[0]!.options![1]}`,
        messageMetadata: { deliveryIntent: "steer" },
      });
      // Phone-specific focus, viewport, and touch reply behavior is covered.
      // The free-form failure/retry and persisted dismissal run once on desktop.
      if (viewport.name === "phone") continue;

      // A historical reading position must survive a free-form reply, including failure.
      await scroller.hover();
      await page.mouse.wheel(0, -450);
      await page.waitForTimeout(250);
      const previousAnchor = await scroller.evaluate((el) => {
        const top = el.getBoundingClientRect().top;
        const row = [
          ...el.querySelectorAll<HTMLElement>("[data-render-id]"),
        ].find((candidate) => candidate.getBoundingClientRect().bottom > top);
        if (!row) throw new Error("No visible transcript anchor");
        return {
          id: row.dataset.renderId!,
          offset: row.getBoundingClientRect().top - top,
        };
      });
      await toolbar.getByRole("button", { name: /^2 questions/ }).click();
      await menu
        .getByRole("button", { name: questions[1]!.title, exact: true })
        .click();
      const freeform = page.getByRole("textbox", {
        name: `Reply to: ${questions[1]!.title}`,
      });
      await expect(freeform).toBeFocused();
      const sendsBeforeReply = sends.length;
      await freeform.press("Enter");
      await expect(freeform).toHaveValue("");
      await freeform.fill("Include exact test results.");
      await freeform.press("Shift+Enter");
      await expect(freeform).toHaveValue("Include exact test results.\n");
      await freeform.dispatchEvent("keydown", {
        key: "Enter",
        isComposing: true,
      });
      expect(sends).toHaveLength(sendsBeforeReply);
      fail = true;
      await freeform.press("Enter");
      await expect(
        page.getByRole("alert").filter({ hasText: "Reply could not be sent" }),
      ).toBeVisible();
      await expect(freeform).toHaveValue("Include exact test results.\n");
      await expect(composer).toHaveValue("Keep my main draft");
      fail = false;
      busy = false;
      emit?.("status", { sessionId, state: "idle" });
      await freeform.press("Enter");
      await expect(composer).toBeFocused();
      await expect
        .poll(() =>
          scroller.evaluate((el, anchor) => {
            const row = el.querySelector<HTMLElement>(
              `[data-render-id="${CSS.escape(anchor.id)}"]`,
            );
            return row
              ? Math.abs(
                  row.getBoundingClientRect().top -
                    el.getBoundingClientRect().top -
                    anchor.offset,
                )
              : Number.POSITIVE_INFINITY;
          }, previousAnchor),
        )
        .toBeLessThan(3);
      await expect(composer).toHaveValue("Keep my main draft");
      expect(sends.at(-1)).toMatchObject({
        message: `> ${questions[1]!.title}\n\nInclude exact test results.\n`,
        messageMetadata: { deliveryIntent: "direct" },
      });
      await toolbar.getByRole("button", { name: /^1 question/ }).click();
      await menu
        .getByRole("button", {
          name: `Dismiss question: ${questions[2]!.title}`,
          exact: true,
        })
        .click();
      await expect(
        menu.getByText("No pending questions in loaded history."),
      ).toBeVisible();
      const dismissedCard = page
        .locator("[data-async-question-reply]")
        .filter({ hasText: questions[2]!.title });
      await expect(
        dismissedCard.getByRole("button", { name: "Restore", exact: true }),
      ).toBeVisible();
      await expect(dismissedCard.getByRole("button")).toHaveCount(1);
      await menu
        .getByRole("button", { name: "Show dismissed", exact: true })
        .click();
      await menu
        .getByRole("button", {
          name: `Restore question: ${questions[2]!.title}`,
          exact: true,
        })
        .click();
      await menu
        .getByRole("button", { name: "Close questions", exact: true })
        .click();
      await page.reload();
      await expect(
        toolbar.getByRole("button", { name: /^1 question/ }),
      ).toBeVisible({ timeout: 15_000 });
      busy = true;
    }
    await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true });
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(`${origin}/settings`);
    await page
      .getByRole("searchbox", { name: "Search settings" })
      .fill("question reminders");
    await expect(
      page.getByRole("slider", { name: "Question reminders", exact: true }),
    ).toHaveCount(1);
    const slider = page.getByRole("slider", {
      name: "Question reminders",
      exact: true,
    });
    if (captures) {
      for (const viewport of [
        { name: "desktop", width: 1000, height: 600 },
        { name: "phone", width: 375, height: 812 },
      ]) {
        await page.setViewportSize(viewport);
        await expect(async () => {
          await slider.scrollIntoViewIfNeeded();
          await expect(slider).toBeVisible();
        }).toPass({ timeout: 5_000 });
        await page.screenshot({
          path: join(captures, `${viewport.name}-settings.png`),
        });
      }
    }
    await slider.focus();
    await slider.press("Home");
    await expect(slider).toHaveValue("0");
    await page.goto(`${origin}/projects/${projectId}/sessions/${sessionId}`);
    await expect(page.locator("[data-composer-input]")).toBeVisible({
      timeout: 15_000,
    });
    await expect(
      page
        .locator("[data-message-input-actions]")
        .getByRole("button", { name: /question/i }),
    ).toHaveCount(0);
    await expect(page.locator("[data-async-question-reply]")).not.toHaveCount(
      0,
    );
    await page.goto(`${origin}/settings`);
    await page
      .getByRole("searchbox", { name: "Search settings" })
      .fill("question reminders");
    await slider.focus();
    await slider.press("ArrowRight");
    await expect(slider).toHaveValue("1");
    await expect(
      page.getByText(/Fade the count after 1 later turns or 53 composer edits/),
    ).toBeVisible();
    await page.goto(`${origin}/projects/${projectId}/sessions/${sessionId}`);
    const toolbar = page.locator("[data-message-input-actions]");
    const composer = page.locator("[data-composer-input]");
    await expect(composer).toBeVisible({ timeout: 30_000 });
    await expect(
      toolbar.getByRole("button", { name: /^1 question/ }),
    ).toBeVisible();
    emit?.("message", {
      uuid: "age-one",
      type: "user",
      content: "Continue one.",
    });
    await expect(
      toolbar.getByRole("button", { name: "Questions", exact: true }),
    ).toBeVisible();
    emit?.("message", {
      uuid: "age-two",
      type: "user",
      content: "Continue two.",
    });
    emit?.("message", {
      uuid: "age-three",
      type: "user",
      content: "Continue three.",
    });
    await expect(
      toolbar.getByRole("button", { name: "Questions", exact: true }),
    ).toHaveCount(0);
    await page
      .getByRole("button", { name: "More toolbar controls", exact: true })
      .click();
    await page
      .getByRole("menuitem", { name: "Questions", exact: true })
      .click();
    const menu = page.getByRole("dialog", { name: "Questions", exact: true });
    await expect(menu).toBeVisible();
    if (captures)
      await page.screenshot({
        path: join(captures, "phone-overflow-menu.png"),
      });
    await menu
      .getByRole("button", { name: questions[2]!.title, exact: true })
      .click();
    const delayedField = page.getByRole("textbox", {
      name: `Reply to: ${questions[2]!.title}`,
    });
    await expect(delayedField).toBeFocused();
    await delayedField.fill("Check both.");
    holdReply = true;
    await page.getByRole("button", { name: "Send reply", exact: true }).click();
    await expect.poll(() => Boolean(replyGate.release)).toBe(true);
    await composer.fill("My newer focus belongs here");
    replyGate.release?.();
    holdReply = false;
    await expect(
      page.getByText("Reply sent: Check both.", { exact: true }),
    ).toBeVisible();
    await expect(composer).toBeFocused();
    emit?.("message", {
      uuid: "new-question",
      type: "assistant",
      content: "A new question?",
      codexAgentMessageDelivery: "async",
      codexAsyncQuestions: [
        { title: "A new question?", options: ["Yes", "No"] },
      ],
    });
    await expect(
      toolbar.getByRole("button", { name: /^1 question/ }),
    ).toBeVisible();
    await composer.pressSequentially("x".repeat(53));
    await expect(
      toolbar.getByRole("button", { name: "Questions", exact: true }),
    ).toBeVisible();
    await composer.pressSequentially("x".repeat(147));
    await expect(
      toolbar.getByRole("button", { name: "Questions", exact: true }),
    ).toHaveCount(0);

    await page
      .getByRole("button", { name: "More toolbar controls", exact: true })
      .click();
    await page
      .getByRole("menuitem", { name: "Questions", exact: true })
      .click();
    await menu
      .getByRole("button", { name: "A new question?", exact: true })
      .click();
    const question = page
      .locator("[data-async-question-reply]")
      .filter({ hasText: "A new question?" });
    await question
      .getByRole("button", {
        name: "Reply in composer",
        exact: true,
      })
      .click();
    await expect(composer).toBeFocused();
    await expect(composer).toHaveValue(/My newer focus belongs here/);
    await expect(composer).toHaveValue(/> A new question\?/);
    await expect(question).toBeInViewport();
    await expect(question).toContainText("Reply moved to main composer");
    await expect(
      question.getByRole("button", { name: "Write a reply" }),
    ).toHaveCount(0);

    const now = new Date().toISOString();
    const peerId = "unopened-question-session";
    const peerQuestion = "Q: Which color should the secondary badge use?";
    const projection = {
      omitted: false,
      questions: questions.map((question, index) => ({
        messageId: "async-source",
        index,
        title: question.title,
        age: 0,
      })),
    };
    const rows = [
      { id: sessionId, title: "Alpha questions", asyncQuestions: projection },
      {
        id: peerId,
        title: "Beta questions",
        asyncQuestions: {
          omitted: false,
          questions: [
            {
              messageId: "async-source",
              index: 0,
              title: peerQuestion,
              age: 0,
            },
          ],
        },
      },
    ].map((row) => ({
      ...row,
      projectId,
      projectName: "client",
      fullTitle: row.title,
      provider: "codex",
      createdAt: now,
      updatedAt: now,
      messageCount: 3,
      ownership: { owner: "none" },
      hasUnread: true,
    }));
    await readCollectionsOverRest(page);
    await page.route(
      (url) => url.pathname === "/api/sessions",
      (route) =>
        route.fulfill({
          json: {
            sessions: rows,
            hasMore: false,
            total: 2,
            stats: {
              totalCount: 2,
              unreadCount: 2,
              starredCount: 0,
              archivedCount: 0,
            },
          },
        }),
    );
    await page.route(
      (url) => url.pathname === "/api/inbox",
      (route) =>
        route.fulfill({
          json: {
            needsAttention: [],
            active: [],
            unread8h: [],
            unread24h: [],
            recentActivity: rows.map((row) => ({
              sessionId: row.id,
              projectId,
              projectName: "client",
              sessionTitle: row.title,
              updatedAt: now,
              hasUnread: true,
              asyncQuestions: row.asyncQuestions,
            })),
          },
        }),
    );
    for (const viewport of [
      { name: "desktop", width: 1000, height: 600 },
      { name: "phone", width: 375, height: 812 },
    ]) {
      await cdp.send("Emulation.setTouchEmulationEnabled", {
        enabled: viewport.name === "phone",
      });
      await page.setViewportSize(viewport);
      await page.evaluate(() => {
        for (const key of Object.keys(localStorage))
          if (key.startsWith("yep-async-questions:"))
            localStorage.removeItem(key);
        localStorage.setItem("yep-anywhere-question-reminder-turns", "3");
      });
      await page.goto(`${origin}/inbox`);
      const inbox = page.locator("main[data-page-scroll-container]");
      const alpha = inbox
        .locator("li[data-session-list-item]")
        .filter({ hasText: "Alpha questions" });
      await expect(
        alpha.getByRole("button", { name: /^3 questions/ }),
      ).toBeVisible();
      const beta = inbox
        .locator("li[data-session-list-item]")
        .filter({ hasText: "Beta questions" });
      await expect(
        beta.getByRole("button", { name: /^1 question/ }),
      ).toBeVisible();
      if (captures)
        await page.screenshot({
          path: join(captures, `${viewport.name}-inbox.png`),
        });
      await alpha
        .getByRole("button", { name: /^3 questions/ })
        .click({ button: "right" });
      await test.step(`${viewport.name}: Inbox question menu opens`, async () => {
        await expect(menu).toBeVisible();
      });
      await menu
        .getByRole("button", { name: questions[1]!.title, exact: true })
        .click();
      const inline = page.getByRole("textbox", {
        name: `Reply to: ${questions[1]!.title}`,
      });
      await expect(inline).toBeFocused();
      await inline.fill("Cross-session answer");
      await page
        .getByRole("button", { name: "Send reply", exact: true })
        .click();
      await expect(page.locator("[data-composer-input]")).toBeFocused();
      await expect
        .poll(() =>
          page
            .locator("main[data-session-messages]")
            .evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight),
        )
        .toBeLessThan(3);
      await page.goto(`${origin}/inbox`);
      await expect(
        alpha.getByRole("button", { name: /^2 questions/ }),
      ).toBeVisible();
      await expect(
        beta.getByRole("button", { name: /^1 question/ }),
      ).toBeVisible();
      const sidebarToggle = page.getByRole("button", {
        name: "Open sidebar",
        exact: true,
      });
      if (
        !(await page.locator("[data-sidebar-nav-section]").first().isVisible())
      )
        await sidebarToggle.click();
      const sidebarBeta = page
        .locator("[data-sidebar] [data-session-list-item]")
        .filter({ hasText: "Beta questions" })
        .first();
      await sidebarBeta.hover();
      const questionBounds = await sidebarBeta
        .getByRole("button", { name: /^1 question/ })
        .boundingBox();
      const menuBounds = await sidebarBeta
        .locator("[data-session-menu]")
        .boundingBox();
      expect(questionBounds).not.toBeNull();
      expect(menuBounds).not.toBeNull();
      expect(menuBounds!.x + menuBounds!.width).toBeLessThanOrEqual(
        questionBounds!.x,
      );
      if (captures)
        await page.screenshot({
          path: join(captures, `${viewport.name}-sidebar-count.png`),
        });
      await sidebarBeta.getByRole("button", { name: /^1 question/ }).click();
      await expect(menu).toBeVisible();
      await page.keyboard.press("Escape");
      const aggregate = page
        .locator("[data-sidebar-nav-section]")
        .getByRole("button", { name: /^3 questions/ });
      await aggregate.click({ button: "right" });
      await expect(
        menu.getByText("Alpha questions", { exact: true }),
      ).toBeVisible();
      await expect(
        menu.getByText("Beta questions", { exact: true }),
      ).toBeVisible();
      if (captures)
        await page.screenshot({
          path: join(captures, `${viewport.name}-grouped-menu.png`),
        });
      await menu
        .getByRole("button", {
          name: `Dismiss question: ${peerQuestion}`,
          exact: true,
        })
        .click();
      await page.keyboard.press("Escape");
      await expect(aggregate).toHaveCount(0);
      await expect(
        page
          .locator("[data-sidebar-nav-section]")
          .getByRole("button", { name: /^2 questions/ }),
      ).toBeVisible();
      // A question arrives in an unopened session through the real activity
      // transport. Its count appears without loading that transcript.
      await expect.poll(() => Boolean(emitActivity)).toBe(true);
      emitActivity!({
        type: "session-updated",
        sessionId: peerId,
        projectId,
        updatedAt: new Date().toISOString(),
        timestamp: new Date().toISOString(),
        asyncQuestions: {
          omitted: false,
          questions: [
            {
              messageId: "new-live-question",
              index: 0,
              title: "Continue the other review?",
              age: 0,
            },
          ],
        },
      });
      await expect(
        page
          .locator("[data-sidebar-nav-section]")
          .getByRole("button", { name: /^3 questions/ }),
      ).toBeVisible();
    }

    // A populated additive field alone cannot enable a new capability.
    await routeWithDrain(page, "**/api/version*", async (route) => {
      const response = await route.fetch();
      await route.fulfill({
        json: {
          ...(await response.json()),
          current: "0.8.1",
          capabilities: [],
          capabilityBits: [],
        },
      });
    });
    await page.goto(`${origin}/inbox`);
    await expect(
      page.getByText("Alpha questions", { exact: true }).first(),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /^\d+ questions?/ }),
    ).toHaveCount(0);
    await page.goto(`${origin}/projects/${projectId}/sessions/${sessionId}`);
    await expect(composer).toBeVisible({ timeout: 30_000 });
    await test.step("Older server keeps structured replies without the capability", async () => {
      await expect(page.locator("[data-async-question-reply]")).not.toHaveCount(
        0,
      );
    });

    await test.step("Sent quote replies recover answered cards after storage loss", async () => {
      messages.push({
        uuid: "durable-quote-answer",
        type: "user",
        content: [
          {
            type: "text",
            text: `> ${questions[0]!.title}\n\nUse the new defaults.`,
          },
        ],
      });
      await page.evaluate(() => {
        for (const key of Object.keys(localStorage))
          if (key.startsWith("yep-async-questions:"))
            localStorage.removeItem(key);
      });
      await page.reload();
      const answered = page
        .locator("[data-async-question-reply]")
        .filter({ hasText: questions[0]!.title });
      for (const viewport of [
        { width: 1200, height: 600 },
        { width: 1000, height: 600 },
        { width: 375, height: 812 },
      ]) {
        await page.setViewportSize(viewport);
        await expect(answered).toContainText(
          "Reply sent: Use the new defaults.",
        );
        await answered.scrollIntoViewIfNeeded();
        await expect(
          answered.getByRole("button", {
            name: "Wait for it to finish",
            exact: true,
          }),
        ).toBeDisabled();
        await recordUiCapture(page, `recovered-answer-${viewport.width}`);
      }
    });

    // Plain Markdown from an older server never acquires guessed controls.
    structured = false;
    await page.goto(`${origin}/projects/${projectId}/sessions/${sessionId}`);
    await expect(composer).toBeVisible();
    await test.step("Older server leaves plain Markdown without reply controls", async () => {
      await expect(page.locator("[data-async-question-reply]")).toHaveCount(0);
      await expect(
        toolbar.getByRole("button", { name: /question/i }),
      ).toHaveCount(0);
    });
    expect(browserErrors).toEqual([]);
  } finally {
    replyGate.release?.();
    try {
      await drainManagedRoutes(page);
      await page.unrouteAll({ behavior: "wait" });
    } finally {
      await disposeYaServerProcess(backend);
    }
  }
});
