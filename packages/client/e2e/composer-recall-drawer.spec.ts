import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { e2ePaths, expect, test } from "./fixtures.js";

type AckedField = HTMLTextAreaElement & {
  acks: { value: string; latency: number }[];
};

const sessionId = "composer-recall-drawer-001";
test.use({ draftSessionIds: [sessionId] });

/**
 * The Ctrl+↑ recall drawer over a long session that keeps updating: typing
 * while it is open dismisses it and types normally, and typing after
 * accepting a row continues the drafted text. Every keystroke shows within
 * 100 ms, measured in the browser. Contract: topics/composer-recall-drawer.md.
 */
test("typing around the recall drawer acknowledges every key", async ({
  page,
  baseURL,
}) => {
  const projectPath = join(e2ePaths.tempDir, "mockproject");
  const directory = join(
    e2ePaths.claudeSessionsDir,
    hostname(),
    projectPath.replace(/[/\\]/g, "-"),
  );
  mkdirSync(directory, { recursive: true });
  const turnCount = 300;
  const start = Date.parse("2026-11-01T00:00:00.000Z");
  const rows: object[] = [];
  let parentUuid: string | null = null;
  for (let index = 0; index < turnCount; index += 1) {
    const userUuid = `recall-user-${index}`;
    const assistantUuid = `recall-assistant-${index}`;
    rows.push(
      {
        type: "user",
        uuid: userUuid,
        parentUuid,
        cwd: projectPath,
        sessionId,
        timestamp: new Date(start + index * 2000).toISOString(),
        message: { role: "user", content: `Recall fixture turn ${index}` },
      },
      {
        type: "assistant",
        uuid: assistantUuid,
        parentUuid: userUuid,
        cwd: projectPath,
        sessionId,
        timestamp: new Date(start + index * 2000 + 1000).toISOString(),
        message: {
          role: "assistant",
          content: [{ type: "text", text: `Reply ${index}` }],
        },
      },
    );
    parentUuid = assistantUuid;
  }
  const sessionFile = join(directory, `${sessionId}.jsonl`);
  writeFileSync(sessionFile, rows.map((row) => JSON.stringify(row)).join("\n"));
  const projectId = Buffer.from(projectPath).toString("base64url");
  // Appends an assistant row to the transcript and waits until the page
  // shows it, so the update lands between two measured keystrokes.
  let updates = 0;
  const updateTranscript = async () => {
    updates += 1;
    const uuid = `recall-concurrent-${updates}`;
    const text = `Concurrent reply ${updates}`;
    appendFileSync(
      sessionFile,
      `\n${JSON.stringify({
        type: "assistant",
        uuid,
        parentUuid,
        cwd: projectPath,
        sessionId,
        timestamp: new Date(start + (turnCount + updates) * 2000).toISOString(),
        message: { role: "assistant", content: [{ type: "text", text }] },
      })}`,
    );
    parentUuid = uuid;
    await expect(page.getByText(text, { exact: true })).toBeVisible();
  };

  await page.goto(`${baseURL}/projects/${projectId}/sessions/${sessionId}`);
  const composer = page.locator("textarea[data-composer-input]").first();
  await expect(composer).toBeVisible();
  // The drawer's rows come from the loaded transcript, which can show after
  // the composer does.
  await expect(
    page.getByText(`Reply ${turnCount - 1}`, { exact: true }),
  ).toBeVisible();
  await composer.focus();
  await composer.evaluate((element) => {
    const field = element as AckedField;
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
    composer.evaluate((element) => (element as AckedField).acks.at(-1)?.value);
  // Waits out the two frames a pending acknowledgement takes, then hands
  // over and clears what was recorded.
  const takeAcks = () =>
    composer.evaluate(async (element) => {
      await new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      );
      const field = element as AckedField;
      const acks = field.acks;
      field.acks = [];
      return acks;
    });
  // Types one key at a time, the transcript updating halfway through.
  const typeMeasured = async (start: string, keys: string) => {
    await takeAcks();
    let typed = start;
    for (const [index, character] of [...keys].entries()) {
      if (index === Math.floor(keys.length / 2)) await updateTranscript();
      await page.keyboard.type(character);
      typed += character;
      await expect.poll(lastAck).toBe(typed);
    }
    const acks = await takeAcks();
    expect(acks.map((ack) => ack.value)).toEqual(
      [...keys].map((_, index) => start + keys.slice(0, index + 1)),
    );
    expect(Math.max(...acks.map((ack) => ack.latency))).toBeLessThan(100);
  };

  const menu = page.locator(".composer-recall-menu");
  const menuRows = menu.locator("[data-slash-command-item]");

  // Open over every turn, move the selection while the transcript updates,
  // then type: the first key closes the still-open drawer and lands in the
  // draft.
  await page.keyboard.press("Control+ArrowUp");
  await expect(menu).toBeVisible();
  await expect(menuRows.nth(0)).toHaveAttribute("data-composer-recall-active");
  await page.keyboard.press("ArrowDown");
  await updateTranscript();
  await page.keyboard.press("ArrowDown");
  await expect(menuRows.nth(2)).toHaveAttribute("data-composer-recall-active");
  await expect(composer).toHaveValue("");
  const prefix = "Recall fixture turn 29";
  await typeMeasured("", prefix);
  await expect(menu).toHaveCount(0);

  // Escape restores the draft the drawer opened over.
  await page.keyboard.press("Control+ArrowUp");
  await expect(menu).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(composer).toHaveValue(prefix);

  // Reopen over the prefix matches and accept the active row, then keep
  // typing after the drafted text.
  await page.keyboard.press("Control+ArrowUp");
  await expect(menu).toBeVisible();
  const active = menu.locator("[data-composer-recall-active]");
  const accepted = (await active.textContent()) ?? "";
  expect(accepted.startsWith(prefix)).toBe(true);
  await page.keyboard.press("Enter");
  await expect(menu).toHaveCount(0);
  await expect(composer).toHaveValue(accepted);
  await expect(composer).toBeFocused();
  await typeMeasured(accepted, " and more");
});
