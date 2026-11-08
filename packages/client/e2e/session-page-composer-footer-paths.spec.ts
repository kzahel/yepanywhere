import { expect, test } from "./fixtures.js";
import {
  json,
  liveUpdate,
  openSessionPage,
  sessionId,
  typeEachKeyWithin100ms,
} from "./support/session-page-harness.js";

/**
 * Pins what the session page's composer footer shows and sends today, before
 * docs/tactical/182-session-page-header-and-footer.md moves it out of
 * SessionPage.tsx: the tool approval panel and its toolbar in place of the
 * composer, the question panel above a collapsed composer, and the
 * composer's placeholder. Responses are answered here; each case checks the
 * request body and what the footer shows.
 */

test.use({ serviceWorkers: "block", viewport: { width: 1600, height: 900 } });

const inputPath = `/sessions/${sessionId}/input`;
const accepted = (route: Parameters<typeof json>[0]) =>
  json(route, 200, { accepted: true, pendingInputRequest: null });

const approvalRequest = {
  id: "pin-approval",
  sessionId,
  type: "tool-approval",
  prompt: "Run the tests",
  toolName: "Bash",
  toolInput: { command: "pnpm test", description: "Run the tests" },
  timestamp: "2026-01-02T10:05:00.000Z",
};

const questionRequest = {
  id: "pin-question",
  sessionId,
  type: "question",
  prompt: "Which parser?",
  toolName: "AskUserQuestion",
  toolInput: {
    questions: [
      {
        question: "Which parser should I use?",
        header: "Parser",
        multiSelect: false,
        options: [
          { label: "Recursive descent", description: "Hand written" },
          { label: "Generated", description: "From a grammar" },
        ],
      },
    ],
  },
  timestamp: "2026-01-02T10:05:00.000Z",
};

async function openWithRequest(
  page: Parameters<typeof openSessionPage>[0],
  baseURL: string,
  request: Record<string, unknown>,
  composerHidden: boolean,
) {
  // A waiting session also asks for its pending request directly.
  await page.route(`**/api/sessions/${sessionId}/pending-input`, (route) =>
    json(route, 200, { request }),
  );
  return openSessionPage(page, baseURL, {
    owner: "self",
    processState: "waiting-input",
    pendingInputRequest: request,
    composerHidden,
  });
}

test("a pending approval replaces the composer; Yes approves it", async ({
  page,
  baseURL,
}) => {
  const session = await openWithRequest(page, baseURL, approvalRequest, true);
  await session.answer("POST", inputPath, accepted);
  const panel = page.locator(".session-input-inner");
  await expect(
    panel.getByRole("button", { name: "1 Yes", exact: true }),
  ).toBeVisible();
  // The toolbar stays; the composer and its send button do not.
  await expect(
    panel.getByRole("button", { name: "Show commands and skills" }),
  ).toBeVisible();
  await expect(session.composer).toHaveCount(0);
  await expect(
    panel.getByRole("button", { name: /^Steer current turn/ }),
  ).toHaveCount(0);

  await panel.getByRole("button", { name: "1 Yes", exact: true }).click();
  await expect.poll(session.requests).toEqual([`POST ${inputPath}`]);
  expect(session.calls[0]?.body).toMatchObject({
    requestId: "pin-approval",
    response: "approve",
  });
});

test("No denies a pending approval", async ({ page, baseURL }) => {
  const session = await openWithRequest(page, baseURL, approvalRequest, true);
  await session.answer("POST", inputPath, accepted);
  await page
    .locator(".session-input-inner")
    .getByRole("button", { name: "2 No", exact: true })
    .click();
  await expect.poll(session.requests).toEqual([`POST ${inputPath}`]);
  expect(session.calls[0]?.body).toMatchObject({
    requestId: "pin-approval",
    response: "deny",
  });
});

test("collapsing the approval panel leaves the toolbar's expand control, which brings it back", async ({
  page,
  baseURL,
}) => {
  await openWithRequest(page, baseURL, approvalRequest, true);
  const footer = page.locator(".session-input-inner");
  const yes = footer.getByRole("button", { name: "1 Yes", exact: true });
  await expect(yes).toBeVisible();

  await footer.getByRole("button", { name: "Collapse approval panel" }).click();
  await expect(yes).toBeHidden();
  // The toolbar's indicator, not the panel's own "Expand approval panel".
  const expand = footer.getByRole("button", { name: "Approval", exact: true });
  await expect(expand).toBeVisible();
  await expand.click();
  await expect(yes).toBeVisible();
});

test("a pending question shows above a collapsed composer and Submit sends the answer", async ({
  page,
  baseURL,
}) => {
  const session = await openWithRequest(page, baseURL, questionRequest, false);
  await session.answer("POST", inputPath, accepted);
  const footer = page.locator(".session-input-inner");
  await expect(footer.getByText("Which parser should I use?")).toBeVisible();
  // The composer stays beneath the question, collapsed.
  await expect(page.locator(".message-input")).toHaveClass(
    /message-input-collapsed/,
  );

  await footer.getByRole("button", { name: /Generated/ }).click();
  await footer.getByRole("button", { name: /^Submit/ }).click();
  await expect.poll(session.requests).toEqual([`POST ${inputPath}`]);
  expect(session.calls[0]?.body).toMatchObject({
    requestId: "pin-question",
    response: "approve",
    answers: { "Which parser should I use?": "Generated" },
  });
});

test("the composer asks to resume an idle session and to queue for a busy one", async ({
  page,
  baseURL,
}) => {
  const idle = await openSessionPage(page, baseURL, { owner: "none" });
  await expect(idle.composer).toHaveAttribute(
    "placeholder",
    "Send a message to resume...",
  );
  await expect(page.locator(".message-input")).not.toHaveClass(
    /message-input-collapsed/,
  );

  const busy = await openSessionPage(page, baseURL, {
    owner: "self",
    processState: "in-turn",
  });
  await expect(busy.composer).toHaveAttribute(
    "placeholder",
    "Queue a message...",
  );
});

test("an edit approval offers don't-ask-again, which approves and accepts edits", async ({
  page,
  baseURL,
}) => {
  const session = await openWithRequest(
    page,
    baseURL,
    {
      ...approvalRequest,
      toolName: "Edit",
      toolInput: {
        file_path: "/tmp/parser.ts",
        old_string: "a",
        new_string: "b",
      },
    },
    true,
  );
  await session.answer("POST", inputPath, accepted);
  await page
    .locator(".session-input-inner")
    .getByRole("button", { name: /Yes, and don't ask again/ })
    .click();
  await expect.poll(session.requests).toEqual([`POST ${inputPath}`]);
  expect(session.calls[0]?.body).toMatchObject({
    requestId: "pin-approval",
    response: "approve_accept_edits",
  });
});

test("a typed reason denies an approval with feedback, each key shown within 100 ms", async ({
  page,
  baseURL,
}) => {
  const session = await openWithRequest(page, baseURL, approvalRequest, true);
  await session.answer("POST", inputPath, accepted);
  const footer = page.locator(".session-input-inner");
  await footer
    .getByRole("button", { name: "Tell the agent what to do instead" })
    .click();
  const reason = footer.getByPlaceholder(
    "Tell the agent what to do instead...",
  );
  await typeEachKeyWithin100ms(reason, "use vitest", (typed) =>
    session.emit("message", liveUpdate(typed.length)),
  );
  await expect(
    page.locator(".message-list").getByText("Live update 9.", { exact: true }),
  ).toBeVisible();
  await footer.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(session.requests).toEqual([`POST ${inputPath}`]);
  expect(session.calls[0]?.body).toMatchObject({
    requestId: "pin-approval",
    response: "deny",
    feedback: "use vitest",
  });
});

test("a typed Other answer is sent, each key shown within 100 ms", async ({
  page,
  baseURL,
}) => {
  const session = await openWithRequest(page, baseURL, questionRequest, true);
  await session.answer("POST", inputPath, accepted);
  const footer = page.locator(".session-input-inner");
  await footer.getByRole("button", { name: /Other/ }).click();
  const other = footer.getByPlaceholder("Type your answer...");
  await typeEachKeyWithin100ms(other, "pratt parser", (typed) =>
    session.emit("message", liveUpdate(typed.length)),
  );
  await expect(
    page.locator(".message-list").getByText("Live update 11.", { exact: true }),
  ).toBeVisible();
  await footer.getByRole("button", { name: /^Submit/ }).click();
  await expect.poll(session.requests).toEqual([`POST ${inputPath}`]);
  expect(session.calls[0]?.body).toMatchObject({
    requestId: "pin-question",
    response: "approve",
    answers: { "Which parser should I use?": "pratt parser" },
  });
});
