import { expect, test } from "@playwright/test";
import { createCodexCreationFixture } from "./support/codex-creation-fixture.js";
import { presentUiCaptures, recordUiCapture } from "./support/ui-capture.js";

test.setTimeout(90_000);
test.skip(
  process.platform === "win32",
  "Controlled native peer uses a POSIX executable",
);
test.afterAll(() => presentUiCaptures());

test("launch steering preserves live owners across settings changes and server replacement", async ({
  browser,
}) => {
  const f = await createCodexCreationFixture(
    true,
    true,
    {},
    { serveBuiltClient: true },
  );
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
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
    const create = async (requestId: string) => {
      const response = await f.request(
        `/projects/${f.projectId}/session-creations`,
        {
          requestId,
          provider: "codex",
          model: "gpt-6.1-sol",
          message: "HELD_WORK",
        },
      );
      expect(response.status).toBe(202);
      return (await response.json()).sessionId as string;
    };
    const owners = async () =>
      (await (await f.request("/processes")).json()).processes;
    const first = await create("steering_gentle");
    await expect
      .poll(
        async () =>
          (await owners()).find(
            (p: { sessionId: string }) => p.sessionId === first,
          )?.steering,
      )
      .toEqual({ mode: "gentle", source: "ya-default" });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${f.server.baseUrl}/settings/message-delivery`);
    const select = page.getByRole("combobox", { name: "Codex steering mode" });
    await expect(select).toHaveValue("gentle");
    const update = page.waitForResponse(
      (r) =>
        r.request().method() === "PUT" && r.url().endsWith("/api/settings"),
    );
    await select.selectOption("immediate");
    expect((await update).ok()).toBe(true);
    await expect(select).toHaveValue("immediate");
    const second = await create("steering_immediate");
    await expect
      .poll(
        async () =>
          (await owners()).find(
            (p: { sessionId: string }) => p.sessionId === second,
          )?.steering,
      )
      .toEqual({ mode: "immediate", source: "ya-setting" });
    const before = await owners();
    expect(
      before.find((p: { sessionId: string }) => p.sessionId === first)?.steering
        .mode,
    ).toBe("gentle");
    expect(
      (await f.launches())
        .filter((args) => args.includes("app-server"))
        .map((args) =>
          args.find((arg) => arg.startsWith("features.instant_interrupt=")),
        )
        .filter(Boolean),
    ).toEqual([
      "features.instant_interrupt=false",
      "features.instant_interrupt=true",
    ]);
    const nativeBefore = (
      await (await f.request("/provider-host/runtimes")).json()
    ).runtimes
      .map((r: { pid: number }) => r.pid)
      .sort();
    await f.crashServer();
    await f.restart();
    expect(
      (await (await f.request("/provider-host/runtimes")).json()).runtimes
        .map((r: { pid: number }) => r.pid)
        .sort(),
    ).toEqual(nativeBefore);
    await expect
      .poll(async () =>
        (await owners())
          .map((p: { sessionId: string; steering: unknown }) => ({
            sessionId: p.sessionId,
            steering: p.steering,
          }))
          .sort((a: { sessionId: string }, b: { sessionId: string }) =>
            a.sessionId.localeCompare(b.sessionId),
          ),
      )
      .toEqual(
        before
          .map((p: { sessionId: string; steering: unknown }) => ({
            sessionId: p.sessionId,
            steering: p.steering,
          }))
          .sort((a: { sessionId: string }, b: { sessionId: string }) =>
            a.sessionId.localeCompare(b.sessionId),
          ),
      );
    await page.goto(`${f.server.baseUrl}/settings/message-delivery`);
    await expect(select).toHaveValue("immediate");
    for (const [name, viewport] of [
      ["desktop", { width: 1280, height: 900 }],
      ["phone", { width: 375, height: 812 }],
    ] as const) {
      await page.setViewportSize(viewport);
      await select.scrollIntoViewIfNeeded();
      await expect(page.getByText(/Active session modes:/)).toBeVisible();
      await recordUiCapture(page, `provider-steering-${name}`);
    }
    const savedMode = page.waitForResponse(
      (r) =>
        r.request().method() === "PUT" && r.url().endsWith("/api/settings"),
    );
    await select.selectOption("gentle");
    expect((await savedMode).ok()).toBe(true);
    const undoneMode = page.waitForResponse(
      (r) =>
        r.request().method() === "PUT" && r.url().endsWith("/api/settings"),
    );
    await page.getByRole("button", { name: /^Undo changes on/ }).click();
    const undoneResponse = await undoneMode;
    expect(
      undoneResponse.ok(),
      `${await undoneResponse.text()} ${undoneResponse.request().postData()}`,
    ).toBe(true);
    await expect(select).toHaveValue("immediate");
    // Capability masking must remove both the control and its Undo payload.
    await page.route("**/api/version**", async (route) => {
      const response = await route.fetch();
      const version = await response.json();
      version.current = "0.11.0";
      version.capabilityBits = version.capabilityBits?.map(
        ([word, bits]: [number, number]) => [
          word,
          word === 4 ? bits & ~(1 << 21) : bits,
        ],
      );
      version.capabilities = version.capabilities?.filter(
        (name: string) => name !== "provider-steering-modes",
      );
      await route.fulfill({ response, json: version });
    });
    await page.reload();
    await expect(select).toHaveCount(0);
    const writes: Record<string, unknown>[] = [];
    page.on("request", (r) => {
      if (r.method() === "PUT" && r.url().endsWith("/api/settings"))
        writes.push(r.postDataJSON());
    });
    const checkbox = page.getByRole("checkbox", {
      name: 'Start with "now" steering on',
    });
    await checkbox.click();
    await page.getByRole("button", { name: /^Undo changes on/ }).click();
    expect(writes.length).toBeGreaterThanOrEqual(2);
    expect(writes.every((body) => !("steeringModes" in body))).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
    await f.close();
  }
});
