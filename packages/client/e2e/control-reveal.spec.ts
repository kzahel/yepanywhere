import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { createTestViteServer } from "./support/vite-server";
import { presentUiCaptures, recordUiCapture } from "./support/ui-capture";

// The first page on a cold fixture server took 10.5 s to boot on CI (6.9 s
// to transform the fixture). A failure restarts the worker and its server,
// so every retry and later test paid that again against the 15 s default.
test.setTimeout(60_000);

let server: Awaited<ReturnType<typeof createTestViteServer>>;
let base: string;
test.beforeAll(async () => {
  server = await createTestViteServer({
    root: resolve(dirname(fileURLToPath(import.meta.url)), ".."),
    server: { host: "127.0.0.1" },
  });
  await server.listen();
  base = server.resolvedUrls!.local[0]!;
});
test.afterAll(async () => {
  await server?.close();
  await presentUiCaptures();
});

async function revealed(button: Locator) {
  await expect(button).toHaveCSS("opacity", "1");
  await expect(button).not.toHaveCSS("pointer-events", "none");
  await button.click({ trial: true });
}
async function tabTo(page: Page, before: Locator, target: Locator) {
  await before.focus();
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press("Tab");
    if (await target.evaluate((element) => element === document.activeElement))
      return;
  }
  throw new Error(`Tab never reached ${await target.getAttribute("class")}`);
}

// CSS opacity and hit testing are the unique browser boundary here. jsdom's
// visibility assertions cannot catch a missing hover/focus selector body.
test("copy and row actions reveal and accept clicks on hover and real Tab focus", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.setViewportSize({ width: 1000, height: 600 });
  await page.goto(`${base}e2e/fixtures/control-reveal.html`);
  const cases = [
    ["tool", "[data-tool-row-header]", "[data-tool-header-copy]"],
    ["bash", "[data-bash-inline-section-header]", "[data-bash-section-copy]"],
    ["text", "[data-text-block]", "[data-text-block-copy]"],
    ["text", "[data-text-block]", "[data-text-block-toggle]"],
    ["quote", "[data-text-block]", "[data-text-block-quote-paragraph]"],
    ["text", "[data-text-block]", "[data-text-block-quote-fallback]"],
    ["edit", "[data-diff-view-container]", "[data-diff-copy-button]"],
    ["app", "[class*=title]", "[class*=copyPath]"],
    ["host", '[data-reveal-row="host"]', '[aria-label="Delete host"]'],
    ["menu", "[class*=rowSurface]", "[class*=trigger]"],
    ["last", "[data-site=last]", "[class*=reopen]"],
  ];
  for (const [siteName, surfaceSelector, buttonSelector] of cases) {
    const site = page.locator(`[data-site=${siteName}]`);
    const button = site.locator(buttonSelector!).first();
    await button.waitFor({ state: "attached" });
    await site.scrollIntoViewIfNeeded();
    if (siteName === "tool") {
      await page.mouse.move(0, 0);
      await expect(button).toHaveCSS("opacity", "0");
    }
    const surface =
      siteName === "last" ? site : site.locator(surfaceSelector!).first();
    await surface.hover({ position: { x: 10, y: 10 } });
    // LastSessionFile reveals when the action itself is hovered.
    if (siteName === "last") await button.hover();
    await revealed(button);
    await page.mouse.move(0, 0);
    await tabTo(page, site.locator("[data-before]"), button);
    // Test focus before copying can set the persistent .copied reveal state.
    await expect(button).toHaveCSS("opacity", "1");
    await expect(button).not.toHaveCSS("pointer-events", "none");
    await page.keyboard.press("Enter");
    await revealed(button);
    if (
      ["tool", "bash", "text", "edit"].includes(siteName!) &&
      buttonSelector!.includes("copy")
    ) {
      await expect(button).toHaveAttribute("data-copied");
      if (siteName === "tool" || siteName === "bash") {
        await site.locator("[data-before]").focus();
        await page.mouse.move(0, 0);
        await expect(button).toHaveCSS("opacity", "1");
      }
    }
    await button.click();
    await revealed(button);
  }
  const bash = page.locator("[data-site=bash] [data-bash-section-copy]");
  // Earlier copies can expire while slower hosts finish the other controls.
  await page
    .locator("[data-site=bash] [data-bash-inline-section-header]")
    .hover();
  await bash.click();
  await page.locator("[data-before=tool]").focus();
  await page.mouse.move(0, 0);
  await expect(bash).toHaveCSS("opacity", "1");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    "bash clipboard witness",
  );
  const exact = page.locator("[data-site=source-exact]");
  await exact.locator("[data-text-block]").hover();
  await exact.locator("[data-text-block-toggle]").click();
  await expect(exact.locator("[data-text-block-source]")).toBeVisible();
  const copiedSource = await exact.evaluate(async (element) => {
    const raw = element.querySelector("[data-text-block-source]")!;
    const text = document
      .createTreeWalker(raw, NodeFilter.SHOW_TEXT)
      .nextNode()!;
    const range = document.createRange();
    range.setStart(text, 3);
    range.setEnd(text, 8);
    getSelection()!.removeAllRanges();
    getSelection()!.addRange(range);
    const modulePath = "/src/lib/markdownSelectionCopy.ts";
    const { extractMarkdownSnippetsFromSelection } = await import(modulePath);
    const markdown = extractMarkdownSnippetsFromSelection(element)[0]?.markdown;
    getSelection()!.removeAllRanges();
    return markdown;
  });
  expect(copiedSource).toBe("Debug");
  const diff = page.locator(
    "[data-site=edit-rendered] [data-fixed-font-rendered-panel]",
  );
  await expect(diff).toHaveCSS("overflow-x", "auto");
  await expect(diff).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(diff.locator(":scope > div")).not.toHaveCSS(
    "padding-left",
    "0px",
  );
  const longDiff = page.locator("[data-site=edit-rendered]");
  for (const mode of ["rendered", "source"]) {
    const preview = longDiff.locator("[data-diff-view-container]");
    await expect(preview).toHaveAttribute("data-truncated", "true");
    await expect(preview).toHaveCSS("overflow", "hidden");
    expect(
      await preview.evaluate(
        (element) => element.scrollHeight > element.clientHeight,
      ),
    ).toBe(true);
    if (mode === "rendered")
      await longDiff
        .getByRole("button", { name: "Show source", exact: true })
        .click();
  }
  const grep = page.locator("[data-site=grep-files]");
  await expect(grep.locator("[data-file-dir]")).toContainText("src/a.ts");
  await expect(grep.locator("[data-file-dir]")).toHaveCSS(
    "font-family",
    /Mono|monospace/,
  );
  for (const copy of await page
    .locator("[data-site=bash-modal] [data-bash-section-copy]")
    .all()) {
    await copy.locator("..").hover();
    await copy.click();
    await page.locator("[data-before=tool]").focus();
    await page.mouse.move(0, 0);
    await expect(copy).toHaveAttribute("data-copied");
    await expect(copy).toHaveCSS("opacity", "1");
  }
  for (const viewport of [
    { width: 1000, height: 600 },
    { width: 375, height: 812 },
  ]) {
    await page.setViewportSize(viewport);
    await expect(
      page.locator("[data-site=bash-modal] [data-bash-modal-code]").first(),
    ).toHaveCSS(
      "border-top-left-radius",
      viewport.width <= 600 ? "0px" : "4px",
    );
    await page.locator("[data-site=tool]").hover();
    await recordUiCapture(page, `reveal-${viewport.width}`);
  }
});

// These targets used to draw their own ButtonBase. Test the actual transcript
// owners: opacity belongs to the containing row, while the shared control owns
// focus, state colors and the touch target. Whole-field fixtures cannot catch it.
for (const theme of ["dark", "light"]) {
  test(`shared prompt, math, copy and card states (${theme}, phone and mouse)`, async ({
    browser,
  }) => {
    for (const touch of [false, true]) {
      const context = await browser.newContext({
        viewport: touch
          ? { width: 375, height: 812 }
          : { width: 1000, height: 600 },
        isMobile: touch,
        hasTouch: touch,
        permissions: ["clipboard-read", "clipboard-write"],
      });
      try {
        const page = await context.newPage();
        await page.goto(`${base}e2e/fixtures/control-reveal.html`);
        await page
          .locator("html")
          .evaluate((el, value) => el.setAttribute("data-theme", value), theme);
        const prompt = page.locator("[data-site=prompt]");
        const actions = prompt.locator("[data-user-prompt-actions]");
        await prompt.scrollIntoViewIfNeeded();
        if (!touch)
          await prompt.locator("[data-user-prompt-container]").hover();
        await expect(actions).toHaveCSS("opacity", "1");
        const buttons = actions.getByRole("button");
        for (const button of await buttons.all()) {
          await button.click({ trial: true });
          const box = await button.boundingBox();
          expect(box?.width).toBeGreaterThanOrEqual(touch ? 36 : 26);
          expect(box?.height).toBeGreaterThanOrEqual(touch ? 36 : 26);
        }
        const copy = actions.getByRole("button", {
          name: "Copy message text",
          exact: true,
        });
        await tabTo(page, prompt.locator("[data-before]"), copy);
        await expect(actions).toHaveCSS("opacity", "1");
        await page.keyboard.press("Enter");
        await expect(
          actions.getByRole("button", {
            name: "Copied message text",
            exact: true,
          }),
        ).toHaveCSS(
          "border-top-color",
          await actions.evaluate((el) => {
            const probe = document.createElement("span");
            probe.style.color = "var(--success-color)";
            el.append(probe);
            const color = getComputedStyle(probe).color;
            probe.remove();
            return color;
          }),
        );
        const math = page.locator("[data-site=math]");
        const toggle = math.locator("[data-fixed-font-toggle]");
        await math.scrollIntoViewIfNeeded();
        await math.locator("[data-fixed-font-render-toggle]").hover();
        await revealed(toggle);
        await tabTo(page, math.locator("[data-before]"), toggle);
        await revealed(toggle);
        const pressed = await toggle.getAttribute("aria-pressed");
        await page.keyboard.press("Space");
        await expect(toggle).toHaveAttribute(
          "aria-pressed",
          pressed === "true" ? "false" : "true",
        );
        if (touch) {
          const hit = await toggle.evaluate((el) => ({
            height: el.getBoundingClientRect().height,
            before: getComputedStyle(el, "::before").top,
          }));
          expect(
            hit.height - 2 * Number.parseFloat(hit.before),
          ).toBeGreaterThanOrEqual(38);
        }
        const queued = page.getByRole("button", {
          name: "Copy queued text",
          exact: true,
        });
        await queued.click();
        await expect(
          page.getByRole("button", { name: "Queued text copied", exact: true }),
        ).toBeVisible();
        expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
          "queued clipboard witness",
        );
        const cards = page.locator("[data-site=cards]");
        const card = cards.getByRole("button", {
          name: "Session action with a long description that wraps across the phone viewport.",
        });
        const initial = await card.getAttribute("aria-pressed");
        await card.click();
        await expect(card).toHaveAttribute(
          "aria-pressed",
          initial === "true" ? "false" : "true",
        );
        await expect(cards.getByRole("button").last()).toBeDisabled();
        await prompt.scrollIntoViewIfNeeded();
        if (!touch)
          await prompt.locator("[data-user-prompt-container]").hover();
        await recordUiCapture(
          page,
          `shared-prompt-${theme}-${touch ? "phone" : "desktop"}`,
        );
        await math.scrollIntoViewIfNeeded();
        await recordUiCapture(
          page,
          `shared-math-${theme}-${touch ? "phone" : "desktop"}`,
        );
      } finally {
        await context.close();
      }
    }
  });
}

for (const theme of ["dark", "light"]) {
  test(`review corrections preserve geometry, flow and states (${theme})`, async ({
    browser,
  }) => {
    for (const touch of [false, true]) {
      const context = await browser.newContext({
        viewport: touch
          ? { width: 375, height: 812 }
          : { width: 1000, height: 600 },
        isMobile: touch,
        hasTouch: touch,
        permissions: ["clipboard-read", "clipboard-write"],
      });
      try {
        await context.route("**/en_50k.txt", (route) =>
          route.fulfill({
            body: "known 1000\nother 1000",
            contentType: "text/plain",
          }),
        );
        const page = await context.newPage();
        await page.goto(`${base}e2e/fixtures/control-reveal.html`);
        await page
          .locator("html")
          .evaluate((el, value) => el.setAttribute("data-theme", value), theme);
        const root = page.locator("[data-site=corrections]");
        await expect(root).toBeVisible();
        for (const name of ["approval", "questions"]) {
          const owner = root.locator(`[data-case=${name}]`);
          const toggle = owner.locator("button[aria-expanded]").first();
          await toggle.scrollIntoViewIfNeeded();
          const centered = await toggle.evaluate((el) => {
            const b = el.getBoundingClientRect(),
              p = el.parentElement!.getBoundingClientRect();
            return Math.abs(b.x + b.width / 2 - (p.x + p.width / 2));
          });
          expect(centered).toBeLessThan(1);
          if (name === "approval")
            await expect(toggle).not.toHaveCSS(
              "background-color",
              "rgba(0, 0, 0, 0)",
            );
          await toggle.click();
          await recordUiCapture(
            page,
            `review-${name}-${theme}-${touch ? "phone" : "desktop"}`,
          );
        }
        const code = root.locator("[data-case=code-name] button");
        await expect(code).toHaveCSS("text-overflow", "ellipsis");
        expect(
          await code.evaluate((el) => el.scrollWidth > el.clientWidth),
        ).toBe(true);
        const location = root.locator("[class*=location]");
        await expect(location).toHaveCSS("white-space", "normal");
        expect(
          await location.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
        ).toBe(true);
        const files = root.locator("[data-case=files]");
        for (const header of await files
          .locator("[data-tool-row-header]:not([data-non-expandable])")
          .all())
          await header.click();
        for (const link of await files
          .locator("[data-file-link-inline], [data-file-link-button]")
          .all()) {
          await expect(link).toHaveCSS("white-space", "normal");
          expect(
            await link.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
          ).toBe(true);
          expect(
            await link.evaluate((el) => getComputedStyle(el).fontFamily),
          ).toContain("mono");
        }
        const inline = root.locator("[data-case=inline]");
        const heights = await inline
          .locator("p")
          .evaluateAll((els) =>
            els.map((el) => el.getBoundingClientRect().height),
          );
        expect(heights[0]).toBe(heights[1]);
        const pathCopy = inline.getByRole("button", {
          name: "Copy path",
          exact: true,
        });
        await expect(pathCopy).toHaveCSS("opacity", "0.4");
        expect((await pathCopy.boundingBox())!.width).toBe(11);
        await pathCopy.focus();
        await page.keyboard.press("Tab");
        await page.keyboard.press("Shift+Tab");
        await expect(pathCopy).toHaveCSS("opacity", "1");
        const gallery = root.locator("[data-case=gallery-prose]");
        const galleryAction = gallery.locator(
          "[data-turn-image-gallery-inline-action]",
        );
        await expect(galleryAction).toBeVisible();
        const prose = gallery.locator("[data-text-block] p");
        const withAction = await prose.evaluate(
          (el) => el.getBoundingClientRect().height,
        );
        await galleryAction.evaluate((el) => {
          el.style.display = "none";
        });
        const withoutAction = await prose.evaluate(
          (el) => el.getBoundingClientRect().height,
        );
        expect(withAction).toBe(withoutAction);
        await galleryAction.evaluate((el) => {
          el.style.display = "";
        });
        await recordUiCapture(
          page,
          `review-gallery-${theme}-${touch ? "phone" : "desktop"}`,
        );
        const help = root.locator("[data-case=help] button");
        if (touch) await expect(help).toBeHidden();
        else {
          await help.click();
          await expect(help).toHaveAttribute("data-selected", "true");
          await expect(help).not.toHaveCSS(
            "background-color",
            "rgba(0, 0, 0, 0)",
          );
          await page.keyboard.press("Escape");
        }
        const provider = root.locator("[data-case=provider-trigger] > button");
        await provider.click();
        await expect(provider).toHaveAttribute("data-selected", "true");
        const viewer = page.getByRole("dialog");
        await expect(viewer).toBeVisible();
        const navigation = viewer.locator("nav button");
        await expect(navigation).toHaveCount(2);
        await navigation.nth(1).click();
        await expect(navigation.nth(1)).toHaveAttribute("aria-current", "true");
        await recordUiCapture(
          page,
          `review-provider-${theme}-${touch ? "phone" : "desktop"}`,
        );
        await viewer
          .getByRole("button", { name: "Close", exact: true })
          .click();
        const touchTargets = root.locator("[data-case=touch-targets]");
        const unknown = touchTargets.getByRole("button", {
          name: /unknownword/,
        });
        await expect(unknown).toBeVisible();
        for (const target of [touchTargets.locator("button").first(), unknown])
          expect((await target.boundingBox())!.height).toBeGreaterThanOrEqual(
            touch ? 44 : 26,
          );
        const rows = root.locator("[data-case=current-rows] > button");
        const first = rows.nth(0),
          second = rows.nth(1);
        const currentFill = await first.evaluate(
          (el) => getComputedStyle(el).backgroundColor,
        );
        if (!touch) {
          await second.hover();
          expect(
            await second.evaluate((el) => getComputedStyle(el).backgroundColor),
          ).not.toBe(currentFill);
        }
        await second.click();
        await expect(second).toHaveAttribute("aria-current", "true");
        await expect(first).not.toHaveAttribute("aria-current", "true");
        const connecting = root.locator("[data-case=connecting]");
        await expect(connecting).toBeDisabled();
        await expect(connecting).toHaveCSS("opacity", "1");
        const dense = root.locator("[data-case=dense-taps]");
        for (const name of ["A", "B", "C"]) {
          const target = dense.getByRole("button", {
            name: `Dense ${name}`,
            exact: true,
          });
          if (touch) await target.tap();
          else await target.click();
          await expect(dense.locator("output")).toHaveText(name);
        }
        const math = page.locator("[data-site=math]");
        await page.mouse.move(0, 0);
        await page.locator("[data-before=math]").focus();
        await math.scrollIntoViewIfNeeded();
        const toggle = math.locator("[data-fixed-font-toggle]");
        await expect(toggle).toHaveCSS("opacity", "0");
        if (touch) await tabTo(page, math.locator("[data-before]"), toggle);
        else await math.locator("[data-fixed-font-render-toggle]").hover();
        await revealed(toggle);
        await expect(toggle).not.toHaveCSS(
          "background-color",
          "rgba(0, 0, 0, 0)",
        );
        const prompt = page.locator("[data-site=prompt]");
        for (const width of touch ? [260, 280, 300] : [280, 360, 520, 700]) {
          await prompt.evaluate((el, w) => {
            el.style.width = `${w}px`;
            el.style.boxSizing = "border-box";
          }, width);
          await expect
            .poll(() =>
              prompt.locator("[data-user-prompt-container]").evaluate((el) => {
                const grid = el.querySelector<HTMLElement>(
                    "[data-user-prompt-actions]",
                  )!,
                  button = grid.querySelector<HTMLElement>(
                    "[data-user-prompt-action]",
                  )!;
                return Math.abs(
                  parseFloat(
                    getComputedStyle(el).getPropertyValue(
                      "--user-prompt-action-size",
                    ),
                  ) - button.getBoundingClientRect().width,
                );
              }),
            )
            .toBeLessThan(0.1);
          const metrics = await prompt
            .locator("[data-user-prompt-actions]")
            .evaluate((el) => {
              const s = getComputedStyle(el),
                buttons = [
                  ...el.querySelectorAll<HTMLElement>(
                    "[data-user-prompt-action]",
                  ),
                ];
              return {
                columns: s.gridTemplateColumns
                  .split(" ")
                  .map(Number.parseFloat),
                widths: buttons.map((b) => b.getBoundingClientRect().width),
                overflow: el.scrollWidth - el.clientWidth,
              };
            });
          expect(
            metrics.widths.every(
              (w) => Math.abs(w - metrics.columns[0]!) < 0.1,
            ),
          ).toBe(true);
          expect(metrics.overflow).toBeLessThanOrEqual(1);
        }
        for (const name of [
          "code-name",
          "files",
          "inline",
          "touch-targets",
          "current-rows",
          "connecting",
        ]) {
          await root.locator(`[data-case=${name}]`).scrollIntoViewIfNeeded();
          await recordUiCapture(
            page,
            `review-${name}-${theme}-${touch ? "phone" : "desktop"}`,
          );
        }
      } finally {
        await context.close();
      }
    }
  });
}
