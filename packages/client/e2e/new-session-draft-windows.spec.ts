import type { Page, Request } from "@playwright/test";
import { expect, test } from "./fixtures.js";

// These cases own the shared server's new-session draft slot, which the
// fixture clears before each one.
test.use({ draftSessionIds: [] });
test.use({ serviceWorkers: "block" });
// Each case waits out a real save debounce in two windows.
test.setTimeout(90_000);

const composer = "textarea[data-new-session-form-textarea]";
const slot = { kind: "new-session" };

/** Type one key at a time after the first character; record any divergence. */
async function typeMidline(page: Page, words: string) {
  const input = page.locator(composer);
  await input.click();
  await input.press("Home");
  await input.press("ArrowRight");
  const misses: string[] = [];
  let expected = await input.inputValue();
  let caret = 1;
  for (const ch of words) {
    await page.keyboard.type(ch);
    expected = expected.slice(0, caret) + ch + expected.slice(caret);
    caret++;
    await page.waitForTimeout(150);
    const got = await input.evaluate((node: HTMLTextAreaElement) => ({
      value: node.value,
      caret: node.selectionStart,
    }));
    if (got.value !== expected || got.caret !== caret) {
      misses.push(`after ${JSON.stringify(ch)}: ${JSON.stringify(got)}`);
      expected = got.value;
      caret = got.caret;
    }
  }
  return misses;
}

const isDraftWrite = (request: Request) =>
  new URL(request.url()).pathname.endsWith("/api/drafts/write");

test("a draft begun in another window continues here without losing keys", async ({
  page,
  browser,
  baseURL,
}) => {
  const elsewhere = await browser.newContext();
  try {
    const other = await elsewhere.newPage();
    await other.goto(`${baseURL}/new-session`);
    await other.locator(composer).click();
    await other.keyboard.type("Begun elsewhere.", { delay: 20 });
    await expect
      .poll(
        async () => {
          const read = await fetch(`${baseURL}/api/drafts/read`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Yep-Anywhere": "true",
            },
            body: JSON.stringify({ slot }),
          });
          return (await read.json()).snapshot.payload.fields.text;
        },
        { timeout: 20_000 },
      )
      .toBe("Begun elsewhere.");

    // This window opens with its composer focused and still empty.
    await page.goto(`${baseURL}/new-session`);
    await expect(page.locator(composer)).toHaveValue("Begun elsewhere.", {
      timeout: 20_000,
    });
    expect(await typeMidline(page, "then continued here ")).toEqual([]);
    await expect(page.locator(composer)).toHaveValue(
      "Bthen continued here egun elsewhere.",
    );
  } finally {
    await elsewhere.close();
  }
});

test("a background sibling tab never saves over the tab being typed in", async ({
  page,
  context,
  baseURL,
}) => {
  await page.goto(`${baseURL}/new-session`);
  await page.locator(composer).click();
  await page.keyboard.type("Typed here.", { delay: 20 });
  const sibling = await context.newPage();
  const siblingWrites: string[] = [];
  sibling.on("request", (request) => {
    if (isDraftWrite(request)) siblingWrites.push(request.url());
  });
  await sibling.goto(`${baseURL}/new-session`);
  await expect(sibling.locator(composer)).toHaveValue("Typed here.");
  await sibling.locator("body").click({ position: { x: 5, y: 5 } });
  await page.bringToFront();
  // Opening may save the shared text once; typing elsewhere must not.
  siblingWrites.length = 0;

  // Long enough to cross the save debounce and its ten-second ceiling.
  expect(
    await typeMidline(page, "the quick brown fox jumps over the lazy dog "),
  ).toEqual([]);
  await expect(sibling.locator(composer)).toHaveValue(
    await page.locator(composer).inputValue(),
  );
  expect(siblingWrites).toEqual([]);
});
