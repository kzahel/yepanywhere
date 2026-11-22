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
 * A stand-in `agy acp` for resuming (plan 195 step 5): it records each ACP
 * method, answers `session/resume` without replaying anything, streams a
 * reply over a few seconds, and appends the turn's records to the brain log
 * as each step ends, as `agy` does.
 */
const resumablePeer = (id: string, methods: string) => `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const flag = process.argv.indexOf('--gemini-dir');
const gemini = flag > 0 ? process.argv[flag + 1] : process.env.GEMINI_HOME;
const brainLog = path.join(gemini, 'antigravity-cli', 'brain', '${id}', '.system_generated', 'logs', 'transcript_full.jsonl');
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const update = (value) => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: '${id}', update: value } });
const logStep = (type, source, fields) => {
  const text = fs.readFileSync(brainLog, 'utf8').trimEnd();
  const step = JSON.parse(text.slice(text.lastIndexOf('\\n') + 1)).step_index + 1;
  fs.appendFileSync(brainLog, JSON.stringify({ step_index: step, source, type, status: 'DONE', created_at: new Date().toISOString().replace(/\\.\\d+Z$/, 'Z'), ...fields }) + '\\n');
};
// The generated history's model, so a resume keeps it.
const model = 'gemini-3.1-pro-low';
const setup = {
  models: { currentModelId: model, availableModels: [{ modelId: model, name: 'Gemini 3.1 Pro (Low)' }] },
  configOptions: [{ id: 'model', category: 'model', type: 'select', currentValue: model, options: [{ value: model, name: 'Gemini 3.1 Pro (Low)' }] }],
};
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.method) fs.appendFileSync('${methods}', m.method + '\\n');
  if (m.method === 'initialize') return reply(m.id, { protocolVersion: 1, agentInfo: { version: '1.5.13' } });
  if (m.method === 'session/new' || m.method === 'session/resume')
    return reply(m.id, { ...(m.method === 'session/new' ? { sessionId: '${id}' } : {}), ...setup });
  if (m.method === 'session/load') return send({ jsonrpc: '2.0', id: m.id, error: { code: -32000, message: 'This stand-in never replays' } });
  if (m.method === 'session/prompt') {
    const text = m.params.prompt[0].text;
    logStep('USER_INPUT', 'USER_EXPLICIT', { content: '<USER_REQUEST>\\n' + text + '\\n</USER_REQUEST>' });
    let sent = 0;
    const chunk = () => {
      if (sent++ < 60) {
        update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: sent === 1 ? 'RESUMED_REPLY' : ' streamed' } });
        return setTimeout(chunk, 100);
      }
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ' RESUMED_REPLY_DONE' } });
      logStep('PLANNER_RESPONSE', 'MODEL', { content: 'RESUMED_REPLY' + ' streamed'.repeat(59) + ' RESUMED_REPLY_DONE' });
      reply(m.id, { stopReason: 'end_turn' });
    };
    return chunk();
  }
  if (m.id !== undefined && m.method) reply(m.id, {});
});
`;

/**
 * An owned server whose store holds one long conversation, and a stand-in
 * `agy` that only records being started. Each case gets its own, so its
 * log append is the first change its server observes.
 */
async function serve(nativeId: string, options: { resumable?: boolean } = {}) {
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
      await writeFile(
        agy,
        options.resumable
          ? resumablePeer(nativeId, started)
          : `#!/bin/sh\necho "$@" >> '${started}'\nexit 1\n`,
        { mode: 0o755 },
      );
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

test("resumes a long Antigravity conversation from the browser without replaying it", async ({
  browser,
}) => {
  const viewport = { name: "desktop" as const, width: 1000, height: 600 };
  const resumedId = "a9a90000-0000-4000-8000-000000000196";
  const { server, projectId, started } = await serve(resumedId, {
    resumable: true,
  });
  const context = await browser.newContext({
    serviceWorkers: "block",
    viewport,
  });
  const page = await context.newPage();
  const olderPages: Array<{
    messages: Array<{ uuid: string }>;
    pagination?: { hasOlderMessages: boolean };
  }> = [];
  page.on("response", async (response) => {
    const url = new URL(response.url());
    if (
      url.pathname.endsWith(`/sessions/${resumedId}`) &&
      url.searchParams.has("beforeMessageId")
    )
      olderPages.push(await response.json());
  });
  await page.goto(
    `${server.baseUrl}/projects/${projectId}/sessions/${resumedId}`,
  );
  const main = page.getByRole("main");
  await expect(main.getByText(/TURN_\d+_REPLY/).first()).toBeAttached({
    timeout: 20_000,
  });
  const methods = async () =>
    (await readFile(started, "utf8").catch(() => "")).split("\n");

  // Resume by sending a prompt from the stopped conversation's composer.
  const composer = page.locator("[data-composer-input]");
  await composer.fill("RESUMED_PROMPT");
  await composer.press("Enter");
  await expect
    .poll(async () => (await methods()).includes("session/prompt"), {
      timeout: 20_000,
    })
    .toBe(true);
  expect(await methods()).toContain("session/resume");

  // Sequential typing while the resumed turn streams.
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
  const prefixes: string[] = [];
  let draft = "";
  for (const character of "Typing while the reply streams") {
    draft += character;
    await page.keyboard.type(character);
    await expect(composer).toHaveValue(draft);
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
  // Every key was typed while the turn was still streaming.
  expect(await main.getByText(/RESUMED_REPLY_DONE/).count()).toBe(0);
  expect(acks.map((ack) => ack.value)).toEqual(prefixes);
  const slowest = Math.max(...acks.map((ack) => ack.latency));
  console.log(
    `Antigravity resumed-turn typing (${viewport.name}): ${acks.length} keys while streaming, browser maximum ${slowest.toFixed(1)} ms`,
  );
  expect(slowest).toBeLessThan(100);

  // The turn ends; its prompt and reply show once, after the history.
  await expect(main.getByText(/RESUMED_REPLY_DONE/)).toHaveCount(1, {
    timeout: 20_000,
  });
  await expect(main.getByText("RESUMED_PROMPT", { exact: true })).toHaveCount(
    1,
  );
  await expect(composer).toHaveValue(draft);

  // Older pages load across the resume point, back to the first step.
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
  expect(olderPages.length).toBeGreaterThanOrEqual(2);
  expect(olderPages.at(-1)?.messages[0]?.uuid).toBe(`${resumedId}:step-0`);
  const loaded = olderPages.flatMap((older) =>
    older.messages.map((message) => message.uuid),
  );
  expect(new Set(loaded).size).toBe(loaded.length);
  await recordUiCapture(page, "antigravity-resume-desktop", viewport);
  // The owner's view after the turn: the resumed prompt and reply once.
  const latest = await page.request.get(
    `${server.baseUrl}/api/projects/${projectId}/sessions/${resumedId}`,
    { headers: { "X-Yep-Anywhere": "true" } },
  );
  const { messages } = (await latest.json()) as {
    messages: Array<{ message?: { content?: unknown } }>;
  };
  const holding = (marker: string) =>
    messages.filter((message) =>
      JSON.stringify(message.message?.content ?? "").includes(marker),
    ).length;
  expect(holding("RESUMED_PROMPT")).toBe(1);
  expect(holding("RESUMED_REPLY_DONE")).toBe(1);
  // Resume and every read served history without a replay.
  expect(await methods()).not.toContain("session/load");
  await context.close();
});
