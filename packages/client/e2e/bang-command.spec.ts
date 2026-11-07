import {
  routeWithDrain,
  drainManagedRoutes,
} from "./support/managed-routes.js";
import { join } from "node:path";
import { e2ePaths, expect, test } from "./fixtures.js";
import { recordUiCapture } from "./support/ui-capture.js";

const testCommands = new Set([
  "echo ya-bang-ok",
  "printf 'bang stderr explanation\\n' >&2; exit 1",
]);

test.afterEach(async ({ baseURL, request }) => {
  // Playwright retries reuse the server. A failed assertion must not leave a
  // run behind for this test's next attempt or the route tests later on.
  const project = join(e2ePaths.tempDir, "mockproject");
  const id = Buffer.from(project).toString("base64url");
  const sessionPath = `/api/projects/${id}/sessions/mock-session-001`;
  const response = await request.get(`${baseURL}${sessionPath}`);
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as {
    session: {
      transcriptDisplayObjects?: Array<{
        kind: string;
        id: string;
        command?: string;
      }>;
    };
  };
  for (const object of body.session.transcriptDisplayObjects ?? []) {
    if (
      object.kind !== "bang-command" ||
      !testCommands.has(object.command ?? "")
    )
      continue;
    const deletion = await request.delete(
      `${baseURL}${sessionPath}/bang-commands/${object.id}`,
    );
    expect(deletion.ok(), `${deletion.status()} ${await deletion.text()}`).toBe(
      true,
    );
  }
});

/**
 * One end-to-end pass over a `!!` local command: the composer says where the
 * draft is going before it is sent, and the command runs in the project
 * without the provider seeing it.
 * Contract: topics/bang-commands.md.
 */
test("a !! draft is routed locally and its run is recorded", async ({
  page,
  baseURL,
}) => {
  const project = join(e2ePaths.tempDir, "mockproject");
  const id = Buffer.from(project).toString("base64url");
  const sessionPath = `/api/projects/${id}/sessions/mock-session-001`;
  await routeWithDrain(page, `**${sessionPath}`, async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.messages.push({ id: "msg-transient-result", type: "result" });
    await route.fulfill({ response, json: body });
  });
  const providerRequests: string[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      request.url().endsWith(`${sessionPath}/messages`)
    )
      providerRequests.push(request.url());
  });
  // Force completion-before-receipt without spending its response deadline
  // on the command execution that this fixture intentionally withholds.
  let releaseResponse!: () => void;
  const responseGate = new Promise<void>((resolve) => {
    releaseResponse = resolve;
  });
  await routeWithDrain(
    page,
    `**${sessionPath}/bang-commands`,
    async (route) => {
      expect(route.request().postDataJSON().placementAfterMessageId).not.toBe(
        "msg-transient-result",
      );
      const response = await route.fetch();
      await responseGate;
      await route.fulfill({ response });
    },
  );
  // The bang completion check below holds the "ech" answer until the next
  // key has been typed.
  let releaseEch!: () => void;
  const echHeld = new Promise<void>((resolve) => {
    releaseEch = resolve;
  });
  try {
    await page.goto(`${baseURL}/projects/${id}/sessions/mock-session-001`);

    const composer = page.locator("textarea[data-composer-input]").first();
    await expect(composer).toBeVisible();
    // Each keystroke shows within 100 ms, measured in the browser, while the
    // completion menu is open and its fetches come back between keys.
    const completionTokens: string[] = [];
    await routeWithDrain(page, "**/bang-completions?*", async (route) => {
      const token = new URL(route.request().url()).searchParams.get("token");
      completionTokens.push(token ?? "");
      if (token === "ech") await echHeld;
      else await new Promise((resolve) => setTimeout(resolve, 80));
      await route.fulfill({
        json: {
          completions: token?.startsWith("ec") ? ["echo", "echoes"] : [],
          history: [],
        },
      });
    });
    await composer.focus();
    await composer.evaluate((element) => {
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
    const lastAck = () =>
      composer.evaluate(
        (element) =>
          (
            element as HTMLTextAreaElement & { acks: { value: string }[] }
          ).acks.at(-1)?.value,
      );
    const menu = page.locator(".bang-completion-menu");
    const draft = "!!echo ya-bang-ok";
    let typed = "";
    for (const character of draft) {
      await page.keyboard.type(character);
      typed += character;
      await expect.poll(lastAck).toBe(typed);
      if (typed === "!!ec") {
        await expect(menu).toBeVisible();
      } else if (typed === "!!ech") {
        // The next key lands while this token's completions are in flight.
        await expect.poll(() => completionTokens.at(-1)).toBe("ech");
      } else if (typed === "!!echo") {
        // Then the stale answer comes back before the following key.
        const answered = page.waitForResponse((response) =>
          response.url().includes("token=ech&"),
        );
        releaseEch();
        await answered;
      }
    }
    const acks = await composer.evaluate(
      (element) =>
        (
          element as HTMLTextAreaElement & {
            acks: { value: string; latency: number }[];
          }
        ).acks,
    );
    expect(acks.map((ack) => ack.value)).toEqual(
      [...draft].map((_, index) => draft.slice(0, index + 1)),
    );
    expect(Math.max(...acks.map((ack) => ack.latency))).toBeLessThan(100);
    await expect(menu).toHaveCount(0);

    // Routing is shown before submission, never inferred.
    await expect(
      page.getByText("!! local command", { exact: false }),
    ).toBeVisible();

    await composer.press("Enter");
    const block = page
      .getByRole("group", { name: "Local command run" })
      .first();
    await expect(block.getByText("echo ya-bang-ok")).toBeVisible();
    await expect(composer).toHaveValue("");

    const finished = page
      .getByRole("group", { name: "Local command run" })
      .first();
    await expect(finished.getByText("exit 0")).toBeVisible({ timeout: 15000 });
    await expect(
      finished.getByRole("button", { name: "Hide output" }),
    ).toBeVisible();
    // Observe completion, then start the receipt clock and release fulfillment.
    const receipt = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith(`${sessionPath}/bang-commands`),
    );
    releaseResponse();
    await receipt;
    await expect
      .poll(() =>
        page.evaluate(() =>
          localStorage.getItem("draft-message-mock-session-001"),
        ),
      )
      .toBeNull();
    await page.unroute(`**${sessionPath}/bang-commands`);
    await page.reload();
    await expect(finished.getByText("exit 0")).toBeVisible();
    await expect(composer).toHaveValue("");

    // Exercise deletion through the block's own action as well as the
    // afterEach cleanup used when an earlier assertion fails.
    await finished.getByRole("button", { name: "Delete" }).click();
    await expect(finished).toHaveCount(0);

    await composer.pressSequentially(
      "!!printf 'bang stderr explanation\\n' >&2; exit 1",
      { delay: 15 },
    );
    await composer.press("Enter");
    await expect(finished.getByText("exit 1", { exact: true })).toBeVisible();
    await expect(
      finished.locator("pre").filter({ hasText: "bang stderr explanation" }),
    ).toBeVisible();
    await expect(
      finished.getByRole("button", { name: "Hide output" }),
    ).toBeVisible();
    for (const viewport of [
      { width: 1200, height: 600 },
      { width: 375, height: 812 },
    ]) {
      await page.setViewportSize(viewport);
      await finished.scrollIntoViewIfNeeded();
      await recordUiCapture(page, `bang-error-${viewport.width}`, viewport);
    }
    expect(providerRequests).toEqual([]);
    await finished.getByRole("button", { name: "Delete" }).click();
    await expect(finished).toHaveCount(0);
  } finally {
    releaseResponse();
    releaseEch();
    await drainManagedRoutes(page);
  }
});
