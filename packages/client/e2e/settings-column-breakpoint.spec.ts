import { expect, test } from "./fixtures.js";

test.use({ serviceWorkers: "block", viewport: { width: 1280, height: 800 } });

// Crossing the two-column threshold re-lays out the open pane; it must not
// remount it, which would detach the field being typed into and drop keys.
test("typing continues in the same field across the settings column breakpoint", async ({
  page,
  baseURL,
}) => {
  const rail = page.locator("[data-settings-category-nav]");
  await page.goto(`${baseURL}/settings/agent-context`);
  await expect(rail).toHaveCount(1);

  const field = page.getByRole("textbox", { name: "Global Instructions" });
  await field.click();
  await field.evaluate((element) => {
    (element as HTMLElement & { breakpointProbe?: true }).breakpointProbe =
      true;
  });

  const narrowTyping = field.pressSequentially("abcdef", { delay: 40 });
  await page.setViewportSize({ width: 600, height: 800 });
  await narrowTyping;
  await expect(rail).toHaveCount(0);

  const wideTyping = field.pressSequentially("ghijkl", { delay: 40 });
  await page.setViewportSize({ width: 1280, height: 800 });
  await wideTyping;
  await expect(rail).toHaveCount(1);

  await expect(field).toHaveValue("abcdefghijkl");
  await expect(field).toBeFocused();
  expect(
    await field.evaluate(
      (element) =>
        (element as HTMLElement & { breakpointProbe?: true })
          .breakpointProbe === true,
    ),
  ).toBe(true);
});
