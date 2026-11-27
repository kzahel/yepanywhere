import assert from "node:assert/strict";

// Keep one editor active while another real session releases its directory.
export async function typeThroughRelease({
  page,
  session,
  other,
  append,
  expect,
  workerState,
}) {
  const otherPage = await page.context().newPage();
  await otherPage.goto(page.url().replace(session.id, other.id));
  await expect(
    otherPage.locator("main").getByText(new RegExp(other.marker)).last(),
  ).toBeInViewport({ timeout: 30000 });
  if (process.platform === "darwin")
    await expect
      .poll(async () => (await workerState()).attached.sort(), {
        timeout: 30000,
      })
      .toEqual(["claude", "codex"]);
  await page.bringToFront();
  const input = page.locator("textarea[data-composer-input]");
  await input.focus();
  await expect(input).toHaveValue("");
  // Keep the original element across the on-disk write and re-render.
  const editor = await input.elementHandle();
  const text = "keep typing across updates";
  const samples = [];
  let visible, updateMs;
  for (let i = 0; i < text.length; i++) {
    if (i === 3) {
      await otherPage.close();
      const start = performance.now();
      append(session);
      visible = expect(
        page.locator("main").getByText(new RegExp(session.marker)).last(),
      )
        .toBeInViewport({ timeout: 30000 })
        .then(() => Math.round(performance.now() - start));
    }
    await editor.evaluate((el) => {
      el.addEventListener(
        "keydown",
        (event) => {
          el.ack = new Promise((resolve) =>
            requestAnimationFrame(() =>
              requestAnimationFrame(() =>
                resolve({
                  ms: performance.now() - event.timeStamp,
                  value: el.value,
                  focused: el.isConnected && document.activeElement === el,
                }),
              ),
            ),
          );
        },
        { once: true },
      );
    });
    await page.keyboard.type(text[i]);
    const sample = await editor.evaluate((el) => el.ack);
    assert(sample.focused);
    assert.equal(sample.value, text.slice(0, i + 1));
    samples.push(sample.ms);
    if (i === 12) updateMs = await visible;
  }
  assert(Math.max(...samples) < 100, "Typed key exceeded 100 ms");
  await editor.dispose();
  return { keys: samples.length, maxMs: Math.max(...samples), updateMs };
}
