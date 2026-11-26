// Build an isolated browser bundle with VITE_DISABLE_ONBOARDING=true:
// pnpm --dir packages/client exec vite build --outDir <run>/client-dist --emptyOutDir
// YEP_E2E_RUN_DIR=<run> node --import tsx --conditions=source scripts/perf-repro/issue-navigation.mjs [50 8370]
import assert from "node:assert/strict";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  utimesSync,
} from "node:fs";
import { createRequire } from "node:module";
import { hostname } from "node:os";
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
const image = readFileSync(
  new URL("../../site/public/screenshots/session-view.png", import.meta.url),
).toString("base64");
async function run(browser, population, images, enabled) {
  const ids = [];
  let projectId;
  const backend = await startYaServerProcess({
    label: "issue navigation",
    standalone: {},
    serveBuiltClient: true,
    serverPreload: new URL("./issue-navigation-probe.mjs", import.meta.url)
      .href,
    startupDeadline: Date.now() + 180000,
    setupProfile: async ({
      tempDir,
      dataDir,
      claudeSessionsDir,
      codexSessionsDir,
    }) => {
      const install = new InstallService({ dataDir });
      await install.initialize();
      await install.recordSuccessfulProviders(["claude", "codex"]);
      const project = join(tempDir, "opened");
      projectId = Buffer.from(project).toString("base64url");
      const idle = join(tempDir, "unrelated");
      for (const dir of [project, idle]) mkdirSync(dir, { recursive: true });
      const old = Date.now() - 86400000;
      for (let i = 0; i < population; i++) {
        const { id, relativePath } = codexRollout(i + 1, old);
        const session = codexSession({ sessionId: id, projectPath: idle });
        const file = join(codexSessionsDir, relativePath);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(
          file,
          [session.head(old), ...session.next(old).rows, ""].join("\n"),
        );
        utimesSync(file, old / 1000, old / 1000);
      }
      const dir = join(
        claudeSessionsDir,
        hostname(),
        project.replace(/\//g, "-"),
      );
      mkdirSync(dir, { recursive: true });
      for (let i = 0; i < 10; i++) {
        const id = codexRollout(100000 + i, old).id;
        ids.push(id);
        const common = {
          sessionId: id,
          cwd: project,
          timestamp: new Date().toISOString(),
        };
        const text = "Open navigation session " + i;
        const content = images
          ? [
              { type: "text", text },
              ...Array.from({ length: 4 }, () => ({
                type: "image",
                source: {
                  type: "base64",
                  media_type: "image/png",
                  data: image,
                },
              })),
            ]
          : text;
        const records = [
          {
            ...common,
            type: "user",
            uuid: id + "-head",
            message: { role: "user", content: text },
          },
          {
            ...common,
            type: "user",
            uuid: id + "-u",
            parentUuid: id + "-head",
            message: { role: "user", content },
          },
          {
            ...common,
            type: "assistant",
            uuid: id + "-a",
            parentUuid: id + "-u",
            message: {
              role: "assistant",
              content: [
                {
                  type: "text",
                  text:
                    "Latest navigation answer " +
                    i +
                    " https://jira.example.test/browse/NAV-" +
                    (i + 1),
                },
              ],
            },
          },
        ];
        writeFileSync(
          join(dir, id + ".jsonl"),
          records.map((row) => JSON.stringify(row)).join("\n") + "\n",
        );
      }
    },
  });
  let context;
  try {
    context = await browser.newContext({
      serviceWorkers: "block",
      viewport: { width: 1280, height: 800 },
    });
    const headers = { "X-Yep-Anywhere": "true" };
    const put = await context.request.put(
      backend.baseUrl + "/api/issues/settings",
      { headers, data: { enabled, scope: "viewed", recentDays: 7 } },
    );
    assert.equal(put.status(), 200);
    await expect
      .poll(
        async () => {
          const res = await context.request.get(
            backend.baseUrl + "/api/projects?summaryMode=retained",
          );
          const data = await res.json();
          return (
            data.catalog?.complete &&
            data.projects.some((p) => p.sessionCount === population) &&
            data.projects.some(
              (p) => p.id === projectId && p.sessionCount === 10,
            )
          );
        },
        { timeout: 150000 },
      )
      .toBe(true);
    const page = await context.newPage();
    const requests = [];
    page.on("request", (req) => {
      const u = new URL(req.url());
      if (u.pathname.startsWith("/api/")) requests.push(u);
    });
    await page.goto(backend.baseUrl + "/inbox");
    const times = [];
    for (const [i, id] of ids.entries()) {
      const card = page
        .locator(
          '[data-session-list-item--card] a[href$="/sessions/' + id + '"]',
        )
        .first();
      await expect(card).toBeVisible({ timeout: 30000 });
      const start = performance.now();
      await card.click();
      const latest = page
        .locator("main")
        .getByText("Latest navigation answer " + i, { exact: false })
        .first();
      await expect(latest).toBeInViewport({ timeout: 30000 });
      times.push(Math.round(performance.now() - start));
      if (enabled)
        await expect(
          page.locator("[data-session-header]").getByRole("button", {
            name: "1 issue or pull request associated with this session",
          }),
        ).toBeVisible({ timeout: 20000 });
      if (i < 9) await page.locator('a[href="/inbox"]:visible').first().click();
    }
    await delay(18000);
    const readsFile = join(backend.dataDir, "badge-reads.jsonl");
    const reads = existsSync(readsFile)
      ? readFileSync(readsFile, "utf8")
          .trim()
          .split("\n")
          .map((s) => JSON.parse(s))
      : [];
    const sorted = reads.filter((r) => r.sort === "mentioned");
    const badges = requests.filter((u) => u.pathname === "/api/issues");
    assert.equal(reads.length, badges.length);
    assert.equal(new Set(reads.map((r) => r.sessionId)).size, enabled ? 10 : 0);
    if (enabled) assert.ok(sorted.length >= 3);
    const fullReads = reads.reduce((n, r) => n + r.fullReads, 0),
      rows = reads.reduce((n, r) => n + r.rows, 0);
    console.log(
      JSON.stringify({
        population,
        images,
        imageBytesPerSession: images
          ? Buffer.byteLength(image, "base64") * 4
          : 0,
        enabled,
        apiRequests: requests.length,
        badgeRequests: reads.length,
        sorted: sorted.length,
        fullReads,
        rows,
        visibleMs: times,
      }),
    );
    assert.equal(fullReads, 0);
    // Each fixture session has one native row and no legacy alias.
    assert.equal(rows, sorted.length);
  } finally {
    await context?.close();
    await disposeYaServerProcess(backend);
  }
}
const browser = await chromium.launch({ chromiumSandbox: true });
try {
  for (const population of (process.argv.slice(2).length
    ? process.argv.slice(2)
    : [50, 8370]
  ).map(Number))
    for (const enabled of [true, false])
      for (const images of [false, true])
        await run(browser, population, images, enabled);
} finally {
  await browser.close();
}
