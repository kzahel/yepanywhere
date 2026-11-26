// YEP_E2E_RUN_DIR=<run with client-dist> node --import tsx --conditions=source
// scripts/perf-repro/codex-project-detail.mjs [--control]
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  startYaServerProcess,
  disposeYaServerProcess,
} from "../../packages/client/e2e/support/ya-server-process.ts";
import { InstallService } from "../../packages/server/src/services/InstallService.ts";
import { codexRollout, codexSession } from "./scenario-transcripts.mjs";

const { chromium, expect } = createRequire(
  new URL("../../packages/client/package.json", import.meta.url),
)("@playwright/test");
let file, projectId, session;
const start = Date.now() - 60000;
const { id, relativePath } = codexRollout(1, start);
const other = codexRollout(2, start);
const backend = await startYaServerProcess({
  label: "Codex streaming project",
  standalone: {},
  serveBuiltClient: true,
  setupProfile: async ({ tempDir, dataDir, codexSessionsDir }) => {
    const install = new InstallService({ dataDir });
    await install.initialize();
    await install.recordSuccessfulProviders(["codex"]);
    const projectPath = join(tempDir, "streaming");
    mkdirSync(projectPath, { recursive: true });
    projectId = Buffer.from(projectPath).toString("base64url");
    file = join(codexSessionsDir, relativePath);
    mkdirSync(dirname(file), { recursive: true });
    session = codexSession({
      sessionId: id,
      projectPath,
      resultLines: 2,
      answerBytes: 40,
    });
    const rows = [session.head(start)];
    for (let i = 0; i < 4; i++) rows.push(...session.next(start + i).rows);
    writeFileSync(file, rows.join("\n") + "\n");
    const otherPath = join(tempDir, "first-project");
    mkdirSync(otherPath);
    const first = codexSession({ sessionId: other.id, projectPath: otherPath });
    writeFileSync(
      join(codexSessionsDir, other.relativePath),
      [first.head(start), ...first.next(start).rows, ""].join("\n"),
    );
  },
});
let browser;
try {
  browser = await chromium.launch({ chromiumSandbox: true });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
    serviceWorkers: "block",
  });
  const detail = "/api/projects/" + projectId;
  const requests = [];
  const activity = [];
  page.on("request", (req) => {
    if (req.method() === "GET") requests.push(new URL(req.url()).pathname);
  });
  page.on("response", async (response) => {
    if (
      new URL(response.url()).pathname !== "/api/projects" ||
      response.status() !== 200
    )
      return;
    const data = await response.json().catch(() => ({}));
    const at = data.projects?.find((p) => p.id === projectId)?.lastActivity;
    if (at) activity.push(at);
  });
  const crumb = page.locator("[data-project-breadcrumb]");
  const openCard = (sessionId) =>
    page
      .locator(
        `[data-session-list-item--card] a[href$="/sessions/${sessionId}"]`,
      )
      .first()
      .click();
  await page.goto(backend.baseUrl + "/inbox");
  await openCard(other.id);
  await expect(crumb).toHaveAccessibleName("first-project");
  await page.locator('a[href="/inbox"]:visible').first().click();
  const beforeNavigation = requests.length;
  await openCard(id);
  await expect(crumb).toHaveAccessibleName("streaming", { timeout: 30000 });
  const input = page.locator("textarea[data-composer-input]");
  await expect(input).toBeVisible();
  await expect.poll(() => activity.length).toBeGreaterThan(0);
  await delay(1200);
  const navigationDetailGets = requests
    .slice(beforeNavigation)
    .filter((path) => path === detail).length;
  const initial = activity.at(-1);
  requests.length = 0;
  const text = "Keep every typed character";
  await input.focus();
  await input.evaluate((node) => {
    let expected = "";
    window.typingSamples = [];
    node.addEventListener("keydown", (event) => {
      if (event.key.length !== 1) return;
      expected += event.key;
      const prefix = expected;
      requestAnimationFrame(() =>
        requestAnimationFrame(() =>
          window.typingSamples.push({
            prefix,
            actual: node.value,
            latency: performance.now() - event.timeStamp,
            focused: document.activeElement === node,
          }),
        ),
      );
    });
  });
  let latest;
  const writes = 12;
  await Promise.all([
    page.keyboard.type(text, { delay: 140 }),
    (async () => {
      for (let i = 0; i < writes; i++) {
        const { marker, rows } = session.next(Date.now());
        appendFileSync(file, rows.join("\n") + "\n");
        if (marker) latest = marker;
        await delay(1050);
      }
    })(),
  ]);
  await expect(input).toHaveValue(text);
  await expect(
    page.locator("main").getByText(new RegExp(latest)).first(),
  ).toBeInViewport({ timeout: 15000 });
  await expect.poll(() => activity.at(-1)).not.toEqual(initial);
  const detailGets = requests.filter((p) => p === detail).length;
  const listGets = requests.filter((p) => p === "/api/projects").length;
  const renamed = await page.request.patch(backend.baseUrl + detail + "/name", {
    headers: { "X-Yep-Anywhere": "true" },
    data: { name: "Renamed during session" },
  });
  assert.equal(renamed.status(), 200);
  await expect(crumb).toHaveAccessibleName("Renamed during session");
  const samples = await page.evaluate(() => window.typingSamples);
  const peak = Math.max(...samples.map((s) => s.latency));
  console.log(
    JSON.stringify({
      writes,
      detailGets,
      navigationDetailGets,
      listGets,
      activityValues: new Set(activity).size,
      initial,
      latestActivity: activity.at(-1),
      lastMarker: latest,
      typed: samples.length,
      peakMs: peak,
      renamed: true,
    }),
  );
  assert.equal(samples.length, text.length);
  assert.ok(samples.every((s) => s.prefix === s.actual && s.focused));
  assert.ok(peak < 100);
  assert.ok(listGets > 0);
  if (process.argv.includes("--control")) {
    assert.ok(navigationDetailGets > 0);
    assert.ok(detailGets > 0);
  } else {
    assert.equal(navigationDetailGets, 0);
    assert.equal(detailGets, 0);
  }
} finally {
  await browser?.close();
  await disposeYaServerProcess(backend);
}
