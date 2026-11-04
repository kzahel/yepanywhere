import { expect, test } from "@playwright/test";
import {
  nativeAppFixture,
  appBarrier,
} from "../../server/test/native-provider/app-fixture.js";
import { presentUiCaptures, recordUiCapture } from "./support/ui-capture.js";

test.afterAll(() => presentUiCaptures());
test("native grouped input reconciles both echoes and original-input navigation", async ({
  page,
}) => {
  const f = await nativeAppFixture("claude");
  const messages: Record<string, unknown>[] = [];
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("websocket", (socket) =>
    socket.on("framereceived", (event) => {
      const raw = String(event.payload);
      try {
        const envelope = JSON.parse(
          raw.startsWith("\x01") ? raw.slice(1) : raw,
        );
        if (envelope.eventType === "message") messages.push(envelope.data);
      } catch {
        /* Vite HMR and transport control frames are not session data. */
      }
    }),
  );
  try {
    await f.ready();
    // Use the real setting: gentle delivery holds both steers for one native boundary.
    await f.api(
      "/settings",
      { clientDefaults: { steerNowDefault: false } },
      "PUT",
    );
    expect((await f.api("/version")).clientDefaults.steerNowDefault).toBe(
      false,
    );
    const created = await f.create("IDENTITY_BROWSER_INITIAL");
    const initial = await f.model.next();
    initial.finish(
      Array.from({ length: 200 }, (_, i) => `History line ${i}`).join("\n"),
    );
    const url = `${f.baseUrl}/projects/${created.projectId}/sessions/${created.sessionId}`;
    await page.goto(url);
    const input = page.locator("textarea[data-composer-input]").first();
    await expect(input).toBeEditable();
    await input.pressSequentially("IDENTITY_BROWSER_ACTIVE");
    await input.press("Enter");
    const active = await f.model.next();
    active.partial("IDENTITY_STREAMING");
    await expect(
      page.getByText("IDENTITY_STREAMING", { exact: true }),
    ).toBeVisible();
    const ids: string[] = [];
    for (const text of ["IDENTITY_ALPHA", "IDENTITY_BRAVO"]) {
      await input.pressSequentially(text);
      await input.press("Enter");
      const echo = await appBarrier(
        async () =>
          messages.find(
            (m) =>
              m.type === "user" && JSON.stringify(m.message).includes(text),
          ) || false,
        `accepted ${text}`,
      );
      expect(echo.messageMetadata).not.toMatchObject({ steerNow: true });
      const id = String(echo.uuid);
      ids.push(id);
      await appBarrier(
        async () =>
          messages.some(
            (m) =>
              m.type === "command_lifecycle" &&
              m.command_uuid === id &&
              m.state === "queued",
          ) || false,
        `native queued ${text}`,
      );
    }
    await input.evaluate((element) => {
      const field = element as HTMLTextAreaElement & {
        acks: { value: string; latency: number }[];
      };
      field.acks = [];
      field.addEventListener("keydown", (event) =>
        requestAnimationFrame(() =>
          requestAnimationFrame(() =>
            field.acks.push({
              value: field.value,
              latency: performance.now() - event.timeStamp,
            }),
          ),
        ),
      );
    });
    let draft = "";
    for (const char of "IDENTITY_UNSENT_DRAFT") {
      active.partial(" live");
      await input.pressSequentially(char);
      draft += char;
      await expect(input).toHaveValue(draft);
      await expect
        .poll(() =>
          input.evaluate(
            (element) =>
              (
                element as HTMLTextAreaElement & { acks: { value: string }[] }
              ).acks.at(-1)?.value,
          ),
        )
        .toBe(draft);
    }
    const acks = await input.evaluate(
      (element) =>
        (element as HTMLTextAreaElement & { acks: { latency: number }[] }).acks,
    );
    expect(acks).toHaveLength(draft.length);
    expect(Math.max(...acks.map((a) => a.latency))).toBeLessThan(100);
    active.finish(" ACTIVE_DONE");
    const grouped = await f.model.next();
    expect(JSON.stringify(grouped.body)).toContain("IDENTITY_ALPHA");
    expect(JSON.stringify(grouped.body)).toContain("IDENTITY_BRAVO");
    expect(JSON.stringify(grouped.body)).not.toContain(
      JSON.stringify("IDENTITY_ALPHA\n\n--------\n\nIDENTITY_BRAVO"),
    );
    grouped.finish(
      "GROUP_REPLY\n" +
        Array.from({ length: 200 }, (_, i) => `Reply line ${i}`).join("\n"),
    );
    await appBarrier(
      async () =>
        messages.some(
          (m) =>
            m.type === "result" &&
            typeof m.result === "string" &&
            m.result.startsWith("GROUP_REPLY"),
        ) || false,
      "native grouped completion",
    );
    const row = await appBarrier(async () => {
      const detail = await f.api(
        `/projects/${created.projectId}/sessions/${created.sessionId}`,
      );
      if (
        !detail.messages.some(
          (m: Record<string, unknown>) =>
            m.type === "assistant" &&
            JSON.stringify(m.message).includes("GROUP_REPLY"),
        )
      )
        return false;
      return (
        detail.messages.find((m: Record<string, unknown>) => {
          const inputIds = m.inputMessageIds;
          return (
            Array.isArray(inputIds) && ids.every((id) => inputIds.includes(id))
          );
        }) || false
      );
    }, "persisted grouped identity");
    const canonical = String(row.uuid ?? row.id);
    await expect(page.locator(`[data-render-id="${ids[0]}"]`)).toHaveCount(0);
    const bubble = page.locator(`[data-render-id="${canonical}"]`);
    await expect(bubble).toContainText("IDENTITY_ALPHA");
    await expect(bubble).toContainText("IDENTITY_BRAVO");
    await expect(
      page
        .locator('[data-render-type="user_prompt"]')
        .filter({ hasText: "IDENTITY_ALPHA" }),
    ).toHaveCount(1);
    await expect(input).toHaveValue(draft);
    // A cold page must resolve the original A link to B's native grouped row.
    await page.goto(`${url}?searchMatch=${encodeURIComponent(ids[0]!)}`);
    await expect(bubble).toBeInViewport({ ratio: 1 });
    await expect(
      page.getByText(
        "The matching turn is no longer available in this session.",
        { exact: true },
      ),
    ).toHaveCount(0);
    await expect(input).toHaveValue(draft);
    expect(f.model.requests).toHaveLength(3);
    expect(errors).toEqual([]);
    for (const [name, viewport] of [
      ["desktop", { width: 1000, height: 600 }],
      ["phone", { width: 375, height: 812 }],
    ] as const) {
      await page.setViewportSize(viewport);
      await page.goto(`${url}?searchMatch=${encodeURIComponent(ids[0]!)}`);
      await expect(bubble).toBeInViewport({ ratio: 1 });
      await expect(input).toHaveValue(draft);
      await expect(
        page.getByText("Server changed", { exact: true }),
      ).toHaveCount(0);
      await recordUiCapture(page, `native-input-identity-${name}`);
    }
  } catch (error) {
    console.info(await f.diagnostics());
    console.info(
      "Native identity frames",
      messages
        .filter((m) => m.type === "user" || m.type === "command_lifecycle")
        .slice(-12),
    );
    throw error;
  } finally {
    try {
      await page.close();
    } finally {
      await f.close();
    }
  }
  expect(f.model.failures).toEqual([]);
});
