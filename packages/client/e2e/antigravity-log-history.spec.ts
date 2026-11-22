import {
  appendFile,
  mkdir,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { InstallService } from "../../server/src/services/InstallService.js";
import { writeAntigravityScaleConversation } from "../../server/test/utils/antigravity-scale-log.js";
import { toUrlProjectId } from "../../shared/src/index.js";
import { expect, test } from "./fixtures.js";
import { presentUiCaptures, recordUiCapture } from "./support/ui-capture.js";
import {
  disposeYaServerProcess,
  startYaServerProcess,
} from "./support/ya-server-process.js";

// A stopped Antigravity conversation whose brain log spans several 4 MiB
// pages (plan 195 step 4). The server reads it a page at a time; the `agy`
// it could start is a stand-in that only records being started.
const nativeId = "a9a90000-0000-4000-8000-000000000195";
test.skip(
  process.platform === "win32",
  "Antigravity execution is unavailable on Windows",
);
test.setTimeout(120_000);
test.afterAll(() => presentUiCaptures());
let active: Awaited<ReturnType<typeof startYaServerProcess>> | undefined;
test.afterEach(async () => {
  if (active) await disposeYaServerProcess(active);
  active = undefined;
});

/**
 * An owned server whose store holds one long conversation, and a stand-in
 * `agy` that only records being started. Each case gets its own, so its
 * log append is the first change its server observes.
 */
async function serve(nativeId: string) {
  const env: NodeJS.ProcessEnv = { ENABLED_PROVIDERS: "antigravity" };
  let projectId = "";
  let started = "";
  let store = "";
  let nextStep = 0;
  const server = await startYaServerProcess({
    label: "antigravity log history",
    standalone: {},
    serveBuiltClient: true,
    env,
    async setupProfile(paths) {
      const project = join(paths.profileDir, "project");
      await mkdir(project);
      const cwd = await realpath(project);
      projectId = toUrlProjectId(cwd);
      started = join(paths.profileDir, "agy-started");
      const agy = join(paths.profileDir, "agy");
      await writeFile(agy, `#!/bin/sh\necho "$@" >> '${started}'\nexit 1\n`, {
        mode: 0o755,
      });
      env.ANTIGRAVITY_ACP_PATH = agy;
      store = join(paths.profileDir, ".gemini", "antigravity-cli");
      const scale = await writeAntigravityScaleConversation({
        store,
        id: nativeId,
        cwd,
        steps: 3000,
        targetBytes: 10 * 1024 * 1024,
        checkpointEvery: 0,
        skipEvery: 0,
        shortLog: false,
      });
      nextStep = scale.lastStep + 1;
      const install = new InstallService({ dataDir: paths.dataDir });
      await install.initialize();
      await install.recordSuccessfulProviders(["antigravity"]);
      await writeFile(
        join(paths.dataDir, "onboarding.json"),
        JSON.stringify({ complete: true }),
      );
    },
  });
  active = server;
  return { server, projectId, started, store, nextStep };
}

for (const viewport of [
  { name: "desktop" as const, width: 1000, height: 600 },
  { name: "phone" as const, width: 375, height: 812 },
]) {
  test(`pages a long Antigravity log and keeps typing responsive on ${viewport.name}`, async ({
    browser,
  }) => {
    const { server, projectId, started, store, nextStep } =
      await serve(nativeId);
    const context = await browser.newContext({
      serviceWorkers: "block",
      viewport,
    });
    const page = await context.newPage();
    const pageRequests: string[] = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.pathname.endsWith(`/sessions/${nativeId}`))
        pageRequests.push(url.searchParams.get("beforeMessageId") ?? "latest");
    });
    const olderPages: Array<{
      messages: Array<{ uuid: string }>;
      pagination?: { hasOlderMessages: boolean };
    }> = [];
    const caughtUp: string[] = [];
    page.on("response", async (response) => {
      const url = new URL(response.url());
      if (!url.pathname.endsWith(`/sessions/${nativeId}`)) return;
      if (url.searchParams.has("beforeMessageId"))
        olderPages.push(await response.json());
      else caughtUp.push(await response.text());
    });
    await page.goto(
      `${server.baseUrl}/projects/${projectId}/sessions/${nativeId}`,
    );
    const main = page.getByRole("main");
    await expect(main.getByText(/TURN_\d+_REPLY/).first()).toBeAttached({
      timeout: 20_000,
    });

    // Sequential typing while the log grows and the client catches up.
    const composer = page.locator("[data-composer-input]");
    await composer.focus();
    await expect(composer).toBeFocused();
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
    const delays: number[] = [];
    const prefixes: string[] = [];
    let draft = "";
    const appended = `CONCURRENT_REPLY_${nextStep}`;
    for (const character of "Typing stays quick over every loaded page") {
      if (draft.length === 12) {
        await appendFile(
          join(
            store,
            "brain",
            nativeId,
            ".system_generated",
            "logs",
            "transcript_full.jsonl",
          ),
          `${JSON.stringify({ step_index: nextStep, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: new Date().toISOString().replace(/\.\d+Z$/, "Z"), content: appended })}\n`,
        );
        // agy writes its database with each step; the watcher observes it.
        await appendFile(
          join(store, "conversations", `${nativeId}.db`),
          "step",
        );
      }
      draft += character;
      const start = performance.now();
      await page.keyboard.type(character);
      await expect(composer).toHaveValue(draft);
      delays.push(performance.now() - start);
      prefixes.push(draft);
      await expect
        .poll(() =>
          composer.evaluate(
            (element) =>
              (
                element as HTMLTextAreaElement & { acks: { value: string }[] }
              ).acks.at(-1)?.value,
          ),
        )
        .toBe(draft);
    }
    const acks = await composer.evaluate(
      (element) =>
        (
          element as HTMLTextAreaElement & {
            acks: { value: string; latency: number }[];
          }
        ).acks,
    );
    expect(acks.map((ack) => ack.value)).toEqual(prefixes);
    const slowest = Math.max(...acks.map((ack) => ack.latency));
    console.log(
      `Antigravity log typing (${viewport.name}): ${acks.length} keys during a log append and catch-up, browser maximum ${slowest.toFixed(1)} ms; controller wall maximum ${Math.max(...delays).toFixed(1)} ms`,
    );
    expect(slowest).toBeLessThan(100);
    await expect(composer).toHaveValue(draft);
    // The append reached the client through a refresh of the transcript.
    await expect
      .poll(() => caughtUp.some((body) => body.includes(appended)), {
        timeout: 20_000,
      })
      .toBe(true);
    await expect(composer).toHaveValue(draft);
    await expect(composer).toBeFocused();

    // Load older pages until there are none.
    const loadOlder = page.locator("[data-load-older-messages]");
    for (let attempt = 0; attempt < 12; attempt++) {
      if ((await loadOlder.count()) === 0) break;
      const older = loadOlder.getByRole("button");
      await older.scrollIntoViewIfNeeded();
      await older.click();
      await expect(loadOlder.locator('[aria-busy="true"]')).toHaveCount(0, {
        timeout: 20_000,
      });
    }
    await expect(loadOlder).toHaveCount(0);
    const earliest = olderPages.at(-1);
    expect(earliest?.pagination?.hasOlderMessages).toBe(false);
    expect(earliest?.messages[0]?.uuid).toBe(`${nativeId}:step-0`);
    const cursors = pageRequests.filter((cursor) => cursor !== "latest");
    expect(cursors.length).toBeGreaterThanOrEqual(2);
    expect(new Set(cursors).size).toBe(cursors.length);
    for (const cursor of cursors)
      expect(cursor).toMatch(new RegExp(`^${nativeId}:step-\\d+`));

    await recordUiCapture(
      page,
      `antigravity-log-history-${viewport.name}`,
      viewport,
    );
    // Viewing started no history reader: those launches pin the store with
    // --gemini-dir. Provider status probes (plain `acp`, `--version`) are
    // not history reads.
    expect(await readFile(started, "utf8").catch(() => "")).not.toContain(
      "--gemini-dir",
    );
    await context.close();
  });
}
