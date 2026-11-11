import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "@playwright/test";
import {
  startYaServerProcess,
  disposeYaServerProcess,
} from "./support/ya-server-process";
import { recordUiCapture } from "./support/ui-capture";

test.use({ serviceWorkers: "block" });
test("native collection writes update live views without full-list reads or delayed typing", async ({
  page,
}, info) => {
  test.setTimeout(60_000);
  const projectPath = mkdtempSync(join(tmpdir(), "collection-browser-"));
  const sessionId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
  const initialTime = new Date(Date.now() - 60_000).toISOString();
  const idleTime = initialTime;
  let transcript = "";
  const backend = await startYaServerProcess({
    label: "collection update integration",
    serveBuiltClient: true,
    ...(process.env.YEP_COLLECTION_TEST_BUN
      ? { serverExecutable: process.env.YEP_COLLECTION_TEST_BUN }
      : {}),
    mockClaudeSession: {
      projectPath,
      sessionId,
      content: "Collection integration session",
      assistantContent: "Ready for concurrent updates.",
      timestamp: initialTime,
    },
    setupProfile: ({ claudeSessionsDir }) => {
      const host = readdirSync(claudeSessionsDir)[0]!;
      const directory = join(
        claudeSessionsDir,
        host,
        projectPath.replace(/\//g, "-"),
      );
      transcript = join(directory, sessionId + ".jsonl");
      for (let n = 0; n < 400; n++)
        writeFileSync(
          join(directory, randomUUID() + ".jsonl"),
          JSON.stringify({
            type: "user",
            uuid: randomUUID(),
            cwd: projectPath,
            timestamp: idleTime,
            message: { role: "user", content: "Idle collection fixture " + n },
          }) + "\n",
        );
    },
  });
  const projectId = Buffer.from(projectPath).toString("base64url");
  const fullReads: string[] = [];
  const diagnostic: unknown[] = [];
  const otherReads: string[] = [];
  const streamQueries: string[][] = [];
  const errors: string[] = [];
  let recording = false;
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.text().startsWith("COLLECTION_DIAG"))
      diagnostic.push(message.text());
  });
  const recordRequests = (request: import("@playwright/test").Request) => {
    const url = new URL(request.url());
    if (url.pathname === "/api/activity/collections")
      streamQueries.push(
        JSON.parse(url.searchParams.get("queries")!) as string[],
      );
    if (!recording || request.method() !== "GET") return;
    if (["/api/sessions", "/api/inbox"].includes(url.pathname))
      fullReads.push(url.pathname + url.search);
    if (["/api/projects", "/api/project-queue"].includes(url.pathname))
      otherReads.push(url.pathname);
  };
  page.on("request", recordRequests);
  const inboxPage = await page.context().newPage();
  inboxPage.on("request", recordRequests);
  inboxPage.on("console", (message) => {
    if (message.text().startsWith("COLLECTION_DIAG"))
      diagnostic.push("inbox:" + message.text());
  });

  let timer: ReturnType<typeof setInterval> | undefined;
  let writes = 0;
  let parent = "fixture-assistant-message";
  const append = () => {
    const uuid = "collection-write-" + ++writes;
    appendFileSync(
      transcript,
      JSON.stringify({
        type: "assistant",
        uuid,
        parentUuid: parent,
        timestamp: new Date(Date.now()).toISOString(),
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Collection live update " + writes }],
        },
      }) + "\n",
    );
    parent = uuid;
  };
  try {
    await page.setViewportSize({ width: 1000, height: 600 });
    await page.goto(
      backend.baseUrl + `/projects/${projectId}/sessions/${sessionId}`,
    );
    const input = page.locator("textarea[data-composer-input]");
    await expect(input).toBeVisible();
    await inboxPage.goto(backend.baseUrl + "/inbox");
    await expect(
      inboxPage.locator("[data-session-list-item--card]").first(),
    ).toBeVisible();
    await expect
      .poll(() =>
        streamQueries.flat().some((query) => query.startsWith("/inbox")),
      )
      .toBe(true);
    await expect
      .poll(() =>
        streamQueries.flat().some((query) => query.startsWith("/sessions")),
      )
      .toBe(true);
    await page.bringToFront();
    const renamed = "Live authoritative collection";
    expect(
      (
        await page.request.put(
          backend.baseUrl + `/api/sessions/${sessionId}/metadata`,
          {
            headers: { "X-Yep-Anywhere": "true" },
            data: { title: renamed, starred: true },
          },
        )
      ).ok(),
    ).toBe(true);
    await expect(page.locator("[data-session-header]")).toContainText(renamed);
    // Cross the old 500 ms refetch boundary after the initial stream handshake.
    await page.waitForTimeout(650);
    const inboxRow = inboxPage
      .locator("[data-session-list-item--card]")
      .filter({
        has: inboxPage.locator('a[href*="/sessions/' + sessionId + '"]'),
      });
    await page.request.post(
      backend.baseUrl + `/api/sessions/${sessionId}/mark-seen`,
      { headers: { "X-Yep-Anywhere": "true" }, data: {} },
    );
    await expect(inboxRow).toHaveCount(0);
    recording = true;
    await input.focus();
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.press("Backspace");
    await input.evaluate((node) => {
      const samples: Array<{
        expected: string;
        actual: string;
        latency: number;
      }> = [];
      Object.assign(window, { collectionTypingSamples: samples });
      let expected = "";
      node.addEventListener("keydown", (event) => {
        if ((event as KeyboardEvent).key.length !== 1) return;
        expected += (event as KeyboardEvent).key;
        const prefix = expected,
          start = event.timeStamp;
        requestAnimationFrame(() =>
          requestAnimationFrame(() =>
            samples.push({
              expected: prefix,
              actual: (node as HTMLTextAreaElement).value,
              latency: performance.now() - start,
            }),
          ),
        );
      });
    });
    timer = setInterval(append, 250);
    const text = "Keep all typed characters";
    await page.keyboard.type(text, { delay: 110 });
    clearInterval(timer);
    timer = undefined;
    await expect(input).toHaveValue(text);
    await expect(
      page
        .getByText("Collection live update " + writes, { exact: true })
        .first(),
    ).toBeVisible();
    await page.waitForTimeout(650);
    const samples = await page.evaluate(
      () =>
        (
          window as unknown as {
            collectionTypingSamples: Array<{
              expected: string;
              actual: string;
              latency: number;
            }>;
          }
        ).collectionTypingSamples,
    );
    expect(samples).toHaveLength(text.length);
    for (const sample of samples) {
      expect(sample.actual).toBe(sample.expected);
      expect(sample.latency).toBeLessThan(100);
    }
    expect(writes).toBeGreaterThan(3);
    await expect(inboxRow).toHaveCount(1);
    writeFileSync(
      info.outputPath("collection-update-evidence.json"),
      JSON.stringify(
        { writes, fullReads, otherReads, streamQueries, samples, diagnostic },
        null,
        2,
      ),
    );
    await info.attach("collection-update-evidence", {
      body: JSON.stringify(
        { writes, fullReads, otherReads, streamQueries, samples, diagnostic },
        null,
        2,
      ),
      contentType: "application/json",
    });
    expect(fullReads).toEqual([]);
    await recordUiCapture(page, "collection-updates-desktop", {
      width: 1000,
      height: 600,
    });
    await page.setViewportSize({ width: 375, height: 812 });
    await expect(input).toBeVisible();
    await expect(input).toHaveValue(text);
    await recordUiCapture(page, "collection-updates-phone", {
      width: 375,
      height: 812,
    });
    expect(errors).toEqual([]);
  } finally {
    if (timer) clearInterval(timer);
    await inboxPage.close();
    await disposeYaServerProcess(backend);
    rmSync(projectPath, { recursive: true, force: true });
  }
});
