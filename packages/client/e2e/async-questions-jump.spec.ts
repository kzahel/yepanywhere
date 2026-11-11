import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import {
  startYaServerProcess,
  disposeYaServerProcess,
} from "./support/ya-server-process";

test.use({ serviceWorkers: "block" });

test("one menu click reaches a question far outside the render window", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const sessionId = "async-question-jump-test";
  const projectPath = dirname(dirname(fileURLToPath(import.meta.url)));
  const backend = await startYaServerProcess({
    label: "async question jump test",
    serveBuiltClient: true,
    mockClaudeSession: {
      projectPath,
      sessionId,
      content: "Review this interface.",
    },
  });
  const projectId = Buffer.from(projectPath).toString("base64url");
  const title = "Q: Does https://example.com/spec cover it?";
  const messages = [
    { uuid: "user-start", type: "user", content: "Review this interface." },
    {
      uuid: "async-source",
      type: "assistant",
      content: `${title}\n- Yes\n- No`,
      codexAgentMessageDelivery: "async",
      codexAsyncQuestions: [{ title, options: ["Yes", "No"] }],
    },
    ...Array.from({ length: 240 }, (_, index) => ({
      uuid: `after-${index}`,
      type: "assistant",
      content: `Later progress ${index}. ${"Independent work continues while the user considers the question. ".repeat(4)}`,
    })),
  ];
  await page.route(
    (url) =>
      url.pathname === `/api/projects/${projectId}/sessions/${sessionId}`,
    (route) =>
      route.fulfill({
        json: {
          session: {
            id: sessionId,
            projectId,
            provider: "codex",
            model: "gpt-6-astra",
            title: "Async question jump",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
          messages,
          ownership: { owner: "self", processId: "question-process" },
          processState: "in-turn",
        },
      }),
  );
  await page.route(`**/api/sessions/${sessionId}/process`, (route) =>
    route.fulfill({ json: { process: null } }),
  );
  try {
    await page.setViewportSize({ width: 1000, height: 600 });
    await page.goto(
      `${backend.baseUrl}/projects/${projectId}/sessions/${sessionId}`,
    );
    await expect(page.locator("[data-composer-input]")).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByText(/^Later progress 239\./)).toBeVisible();
    await page
      .locator("[data-message-input-actions]")
      .getByRole("button", { name: /^1 question/ })
      .click();
    await page
      .getByRole("dialog", { name: "Questions", exact: true })
      .getByRole("button", { name: title, exact: true })
      .click();
    const field = page.getByRole("textbox", { name: `Reply to: ${title}` });
    await expect(field).toBeFocused();
    await expect(field).toBeInViewport();
    const question = page.locator("[data-async-question-reply]");
    await expect(
      question.getByRole("link", { name: "https://example.com/spec" }),
    ).toHaveAttribute("href", "https://example.com/spec");
  } finally {
    await disposeYaServerProcess(backend);
  }
});
