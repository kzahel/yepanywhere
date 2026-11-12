import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { createTestViteServer } from "./support/vite-server";
import { presentUiCaptures, recordUiCapture } from "./support/ui-capture";
import { augmentPersistedSessionMessages } from "../../server/src/sessions/persisted-augments";
import type { Message } from "../../server/src/supervisor/types";

const url =
  "https://docs.cloud.google.com/appengine/docs/standard/testing-and-deploying-your-app?tab=go";
const marker = "\uE200cite\uE202turn553176search1\uE201";
let server: Awaited<ReturnType<typeof createTestViteServer>>;
let base: string;
let updates = 0;
test.beforeAll(async () => {
  server = await createTestViteServer({
    root: resolve(dirname(fileURLToPath(import.meta.url)), ".."),
    server: { host: "127.0.0.1" },
    plugins: [
      {
        name: "citation-fixture",
        configureServer(vite) {
          vite.middlewares.use("/citation-response", (_req, res) => {
            const text = `We can reuse the **exact JAR**. App Engine may rebuild its runtime container during deployment. ${marker}\n\nUpdate ${++updates}.`;
            const messages: Message[] = [
              {
                uuid: "source",
                type: "user",
                content: [
                  {
                    type: "tool_result",
                    tool_use_id: "web",
                    content: `Test and deploy your application (${url})\n【turn553176search1】 [wordlim: 200] Snippet.`,
                  },
                ],
              },
              {
                uuid: "answer",
                type: "assistant",
                content: [{ type: "text", text }],
              },
            ];
            void augmentPersistedSessionMessages(messages)
              .then(() => {
                res.setHeader("Content-Type", "application/json");
                res.end(
                  JSON.stringify({
                    text,
                    html: (messages[1]!.content as Array<{ _html: string }>)[0]!
                      ._html,
                  }),
                );
              })
              .catch((error) => {
                res.statusCode = 500;
                res.end(String(error));
              });
          });
        },
      },
    ],
  });
  await server.listen();
  base = server.resolvedUrls!.local[0]!;
});
test.afterAll(async () => {
  await server?.close();
  await presentUiCaptures();
});

test("citation links survive real rendering and concurrent updates without delaying sequential input", async ({
  page,
}) => {
  // Two cold fixture boots and two paced typing runs took 9-14 s on CI
  // against the 15 s default; the per-key latency check below is unchanged.
  test.setTimeout(60_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  for (const viewport of [
    { width: 1000, height: 600 },
    { width: 375, height: 812 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto(`${base}e2e/fixtures/web-citations.html`);
    const answer = page.getByRole("region", { name: "Latest answer" });
    const link = answer.getByRole("link", { name: "[docs.cloud.google.com]" });
    await expect(link).toHaveAttribute("href", url);
    await expect(link).toHaveAttribute(
      "title",
      "Test and deploy your application",
    );
    await expect(
      page.getByText("Earlier response 199", { exact: true }),
    ).toBeAttached();
    const composer = page.getByRole("textbox", { name: "Message" });
    await composer.focus();
    await composer.evaluate((field) => {
      const samples: { value: string; ms: number }[] = [];
      Object.assign(window, { citationTyping: samples });
      field.addEventListener("keydown", (event) => {
        requestAnimationFrame(() =>
          requestAnimationFrame(() =>
            samples.push({
              value: (field as HTMLTextAreaElement).value,
              ms: performance.now() - event.timeStamp,
            }),
          ),
        );
      });
    });
    const before = updates;
    const typed = "Keep citations responsive";
    await page.keyboard.type(typed, { delay: 70 });
    await expect(composer).toHaveValue(typed);
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { citationTyping: unknown[] }).citationTyping
              .length,
        ),
      )
      .toBe(typed.length);
    const samples = await page.evaluate(
      () =>
        (
          window as unknown as {
            citationTyping: { value: string; ms: number }[];
          }
        ).citationTyping,
    );
    expect(samples.map((sample) => sample.value)).toEqual(
      [...typed].map((_, i) => typed.slice(0, i + 1)),
    );
    expect(Math.max(...samples.map((sample) => sample.ms))).toBeLessThan(100);
    expect(updates).toBeGreaterThan(before);
    console.log(
      `Citation typing ${viewport.width}: ${samples.length} keys, max ${Math.max(...samples.map((sample) => sample.ms)).toFixed(1)} ms`,
    );
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect(link).toBeVisible();
    await recordUiCapture(page, `web-citations-${viewport.width}`);
  }
  await page.context().route(url, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<h1>Citation destination</h1>",
    }),
  );
  const followed = page
    .context()
    .waitForEvent("request", { predicate: (request) => request.url() === url });
  await page
    .getByRole("region", { name: "Latest answer" })
    .getByRole("link", { name: "[docs.cloud.google.com]" })
    .click();
  expect((await followed).url()).toBe(url);
  expect(errors).toEqual([]);
});
