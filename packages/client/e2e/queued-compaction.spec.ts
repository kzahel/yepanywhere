import { expect, test } from "@playwright/test";
import { createCodexCreationFixture } from "./support/codex-creation-fixture.js";
import { presentUiCaptures, recordUiCapture } from "./support/ui-capture.js";

test.setTimeout(90_000); // Owned server/worker startup, two viewports and joined teardown.
test.skip(
  process.platform === "win32",
  "Controlled native peer uses a POSIX executable",
);
test.afterAll(() => presentUiCaptures());

test("Queue preserves compact order through reload and acknowledges typing during completion", async ({
  browser,
}) => {
  const f = await createCodexCreationFixture(
    true,
    false,
    { YEP_E2E_CREATION_HISTORY_ROWS: "1000" },
    { serveBuiltClient: true },
  );
  const context = await browser.newContext({
    viewport: { width: 1000, height: 600 },
    serviceWorkers: "block",
  });
  try {
    expect(
      (
        await f.request("/projects", {
          path: Buffer.from(f.projectId, "base64url").toString(),
        })
      ).ok,
    ).toBe(true);
    await f.releaseAck();
    const created = await f.request(
      `/projects/${f.projectId}/session-creations`,
      {
        requestId: "queued_compact_browser",
        provider: "codex",
        model: "gpt-6.1-sol",
        message: "HELD_WORK",
      },
    );
    expect(created.status).toBe(202);
    const receipt = await created.json();
    await expect
      .poll(
        async () =>
          (await f.requests()).filter((r) => r.method === "turn/start").length,
      )
      .toBe(1);
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(
      `${f.server.baseUrl}/projects/${f.projectId}/sessions/${receipt.sessionId}`,
    );
    const input = page.locator("textarea[data-composer-input]").first();
    await expect(input).toBeEditable();
    const queue = () =>
      page.getByRole("button", { name: /^Queue message/ }).first();
    // An older server must never receive a delayed command it would run now.
    await page.route("**/api/version**", async (route) => {
      const response = await route.fetch();
      const version = await response.json();
      version.current = "0.11.0";
      version.capabilityBits = version.capabilityBits?.map(
        ([word, bits]: [number, number]) => [
          word,
          word === 4 ? bits & ~(1 << 20) : bits,
        ],
      );
      version.capabilities = version.capabilities?.filter(
        (name: string) => name !== "queued-session-compaction",
      );
      await route.fulfill({ response, json: version });
    });
    await page.reload();
    await expect(input).toBeEditable();
    const writes: string[] = [];
    page.on("request", (request) => {
      if (
        request.method() === "POST" &&
        request.url().endsWith(`/sessions/${receipt.sessionId}/messages`)
      )
        writes.push(request.postData() ?? "");
    });
    await input.pressSequentially("/compact");
    await queue().click();
    await expect(
      page.getByText(
        "Update this server to queue compaction. Manual Compact is still available when idle.",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(input).toHaveValue("/compact");
    expect(writes).toHaveLength(0);
    await page.unroute("**/api/version**");
    await page.reload();
    await expect(input).toHaveValue("/compact");
    const queuedCompactResponse = page.waitForResponse(
      (r) =>
        r.request().method() === "POST" &&
        r.url().endsWith(`/sessions/${receipt.sessionId}/messages`),
    );
    await queue().click();
    expect((await queuedCompactResponse).status()).toBe(200);
    await expect(input).toHaveValue("");
    await expect(
      page.locator("[data-deferred-message]").filter({ hasText: "/compact" }),
    ).toBeVisible();
    await input.pressSequentially("FOLLOWING_COMPACT");
    const queuedFollowupResponse = page.waitForResponse(
      (r) =>
        r.request().method() === "POST" &&
        r.url().endsWith(`/sessions/${receipt.sessionId}/messages`),
    );
    await queue().click();
    expect((await queuedFollowupResponse).status()).toBe(200);
    await expect(input).toHaveValue("");
    await expect
      .poll(
        async () =>
          (
            await (
              await f.request("/drafts/read", {
                slot: { kind: "session", sessionId: receipt.sessionId },
              })
            ).json()
          ).snapshot.payload.fields.text ?? "",
      )
      .toBe("");
    await page.reload();
    await expect(input).toHaveValue("");
    await expect(input).toBeEditable();
    await expect(page.locator("[data-deferred-message]")).toHaveCount(2);
    expect(
      (await f.requests()).filter((r) => r.method === "thread/compact/start"),
    ).toHaveLength(0);
    await f.releaseReply();
    await expect
      .poll(
        async () =>
          (await f.requests()).filter(
            (r) => r.method === "thread/compact/start",
          ).length,
      )
      .toBe(1);
    await expect(
      page.getByText("Compacting", { exact: true }).first(),
    ).toBeVisible();
    for (const [name, viewport] of [
      ["desktop", { width: 1000, height: 600 }],
      ["phone", { width: 375, height: 812 }],
    ] as const) {
      await page.setViewportSize(viewport);
      await page
        .locator("[data-message-list]")
        .hover({ position: { x: 100, y: 100 } });
      await page.mouse.wheel(0, 1_000_000);
      await expect(
        page.locator("[data-deferred-message]").filter({ hasText: "/compact" }),
      ).toBeInViewport();
      await expect(
        page
          .locator("[data-deferred-message]")
          .filter({ hasText: "FOLLOWING_COMPACT" }),
      ).toBeInViewport();
      await page.mouse.move(2, 2);
      await recordUiCapture(page, `queued-compact-${name}`);
    }
    await input.evaluate((element) => {
      const input = element as HTMLTextAreaElement & {
        acks: { value: string; latency: number }[];
      };
      input.acks = [];
      input.addEventListener("keydown", (event) =>
        requestAnimationFrame(() =>
          requestAnimationFrame(() =>
            input.acks.push({
              value: input.value,
              latency: performance.now() - event.timeStamp,
            }),
          ),
        ),
      );
    });
    let text = "";
    for (const [index, char] of [
      ..."Draft remains responsive through compaction",
    ].entries()) {
      if (index === 3) await f.releaseCompactBoundary();
      if (index === 12) await f.releaseCompactCompletion();
      await Promise.all([
        input.pressSequentially(char),
        page.request
          .put(
            `${f.server.baseUrl}/api/sessions/${receipt.sessionId}/metadata`,
            {
              data: { title: `Concurrent update ${index}` },
              headers: { "X-Yep-Anywhere": "true" },
            },
          )
          .then((response) => expect(response.ok()).toBe(true)),
      ]);
      text += char;
      await expect(input).toHaveValue(text);
      await expect
        .poll(() =>
          input.evaluate(
            (element) =>
              (
                element as HTMLTextAreaElement & { acks: { value: string }[] }
              ).acks.at(-1)?.value,
          ),
        )
        .toBe(text);
    }
    const acks = await input.evaluate(
      (element) =>
        (element as HTMLTextAreaElement & { acks: { latency: number }[] }).acks,
    );
    expect(acks).toHaveLength(text.length);
    expect(Math.max(...acks.map((ack) => ack.latency))).toBeLessThanOrEqual(
      100,
    );
    await expect
      .poll(
        async () =>
          (await f.requests()).filter((r) => r.method === "turn/start").length,
      )
      .toBe(2);
    const turns = (await f.requests()).filter((r) => r.method === "turn/start");
    expect(turns.map((r) => r.params.input[0].text)).toEqual([
      "HELD_WORK",
      "FOLLOWING_COMPACT",
    ]);
    expect(errors).toEqual([]);
    console.log(
      `Queued compact typing: ${acks.length} keys, maximum ${Math.max(...acks.map((ack) => ack.latency)).toFixed(1)} ms`,
    );
  } finally {
    await context.close();
    await f.close();
  }
});
