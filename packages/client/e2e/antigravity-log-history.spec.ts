import {
  appendFile,
  mkdir,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { InstallService } from "../../server/src/services/InstallService.js";
import { writeAntigravityScaleConversation } from "../../server/test/utils/antigravity-scale-log.js";
import { toUrlProjectId } from "../../shared/src/index.js";
import { expect, test } from "./fixtures.js";
import {
  startTypingDiagnostics,
  typingAckTargetMs,
} from "./support/typing-diagnostics.js";
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

async function loadNextHistoryPage(page: Page, sessionId: string) {
  const boundary = page.locator("[data-load-older-messages]");
  const button = boundary.getByRole("button");
  await expect(button).toBeEnabled();
  // Scrolling to the button kicks off the intersection observer's own load.
  await button.evaluate((element: HTMLButtonElement) =>
    element.focus({ preventScroll: true }),
  );
  await expect(button).toBeFocused();
  const [response] = await Promise.all([
    page.waitForResponse(
      (response) => {
        const url = new URL(response.url());
        return (
          url.pathname.endsWith(`/sessions/${sessionId}`) &&
          url.searchParams.has("beforeMessageId")
        );
      },
      { timeout: 20_000 },
    ),
    page.keyboard.press("Enter"),
  ]);
  expect(response.ok()).toBe(true);
  await expect(boundary.locator('[aria-busy="true"]')).toHaveCount(0, {
    timeout: 20_000,
  });
}

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
    // A BIG_ prompt gets a reply of about 1.2 MB named after it; a SLOW_
    // prompt streams a short reply for about 50 s.
    const big = text.startsWith('BIG_');
    const slow = text.startsWith('SLOW_');
    const first = big || slow ? text + '_REPLY' : 'RESUMED_REPLY';
    const last = big || slow ? ' ' + text + '_DONE' : ' RESUMED_REPLY_DONE';
    const body = big ? ' ' + 'x'.repeat(40000) : ' streamed';
    const chunks = big ? 30 : slow ? 50 : 60;
    const pause = slow ? 1000 : 100;
    let sent = 0;
    const chunk = () => {
      if (sent++ < chunks) {
        update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: sent === 1 ? first : body } });
        return setTimeout(chunk, pause);
      }
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: last } });
      logStep('PLANNER_RESPONSE', 'MODEL', { content: first + body.repeat(chunks - 1) + last });
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
async function serve(
  nativeId: string,
  options: { resumable?: boolean; hosted?: boolean } = {},
) {
  const env: NodeJS.ProcessEnv = { ENABLED_PROVIDERS: "antigravity" };
  let projectId = "";
  let started = "";
  let store = "";
  let nextStep = 0;
  const server = await startYaServerProcess({
    label: "antigravity log history",
    standalone: { providerHostEnabled: options.hosted === true },
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
  }, testInfo) => {
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
    // Settle the initial render before measuring the separate append.
    await expect(main.locator("[data-message-list]")).not.toHaveAttribute(
      "aria-busy",
      "true",
      { timeout: 20_000 },
    );

    // Sequential typing while the log grows and the client catches up.
    const composer = page.locator("[data-composer-input]");
    await composer.focus();
    await expect(composer).toBeFocused();
    const recordTyping = await startTypingDiagnostics(composer, {
      limitMs: typingAckTargetMs,
    });
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
    await recordTyping(
      testInfo,
      `antigravity-log-${viewport.name}`,
      acks,
      slowest,
    );
    expect(slowest).toBeLessThan(typingAckTargetMs);
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
      await loadNextHistoryPage(page, nativeId);
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

// Plan 195 step 7: another program appends a turn to a stopped
// conversation open in the browser. Only the log changes, which the open
// page's focused watch observes: the page shows the new rows and the
// external-session banner.
test("shows another program's append to an open stopped conversation, with the external-session banner", async ({
  browser,
}) => {
  const appendedId = "a9a90000-0000-4000-8000-000000000197";
  const { server, projectId, store, nextStep } = await serve(appendedId);
  for (const viewport of [
    { name: "desktop" as const, width: 1000, height: 600 },
    { name: "phone" as const, width: 375, height: 812 },
  ]) {
    const context = await browser.newContext({
      serviceWorkers: "block",
      viewport,
    });
    const page = await context.newPage();
    await page.goto(
      `${server.baseUrl}/projects/${projectId}/sessions/${appendedId}`,
    );
    const main = page.getByRole("main");
    await expect(main.getByText(/TURN_\d+_REPLY/).first()).toBeAttached({
      timeout: 20_000,
    });
    if (viewport.name === "desktop") {
      await expect(page.getByText(/External session active/)).toHaveCount(0);
      const step = nextStep;
      await appendFile(
        join(
          store,
          "brain",
          appendedId,
          ".system_generated",
          "logs",
          "transcript_full.jsonl",
        ),
        [
          {
            type: "USER_INPUT",
            source: "USER_EXPLICIT",
            content: "<USER_REQUEST>\nOUTSIDE_PROMPT\n</USER_REQUEST>",
          },
          {
            type: "PLANNER_RESPONSE",
            source: "MODEL",
            content: "OUTSIDE_REPLY",
          },
        ]
          .map(
            (record, index) =>
              `${JSON.stringify({ step_index: step + index, source: record.source, type: record.type, status: "DONE", created_at: new Date().toISOString().replace(/\.\d+Z$/, "Z"), content: record.content })}\n`,
          )
          .join(""),
      );
    }
    await expect(main.getByText("OUTSIDE_REPLY")).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByText(/External session active/)).toBeVisible({
      timeout: 20_000,
    });
    await recordUiCapture(
      page,
      `antigravity-external-append-${viewport.name}`,
      viewport,
    );
    await context.close();
  }
});

// Plan 195 step 8: no ACP replay fallback. A stopped conversation whose
// log YA cannot read shows one row saying so, and starts no agy to read it.
test("shows a stopped conversation whose log it cannot read as one row saying so", async ({
  browser,
}) => {
  const unreadableId = "a9a90000-0000-4000-8000-000000000198";
  const { server, projectId, started, store, nextStep } =
    await serve(unreadableId);
  // A record with a field no observed agy writes: an unknown log.
  await appendFile(
    join(
      store,
      "brain",
      unreadableId,
      ".system_generated",
      "logs",
      "transcript_full.jsonl",
    ),
    `${JSON.stringify({ step_index: nextStep, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-11-23T08:00:00Z", content: "UNSHOWN_REPLY", novel: 1 })}\n`,
  );
  for (const viewport of [
    { name: "desktop" as const, width: 1000, height: 600 },
    { name: "phone" as const, width: 375, height: 812 },
  ]) {
    const context = await browser.newContext({
      serviceWorkers: "block",
      viewport,
    });
    const page = await context.newPage();
    await page.goto(
      `${server.baseUrl}/projects/${projectId}/sessions/${unreadableId}`,
    );
    const main = page.getByRole("main");
    await expect(
      main.getByText(/Earlier history cannot be shown: YA cannot read/),
    ).toBeVisible({ timeout: 20_000 });
    await expect(main.getByText(/TURN_\d+_REPLY/)).toHaveCount(0);
    await expect(main.getByText("UNSHOWN_REPLY")).toHaveCount(0);
    await recordUiCapture(
      page,
      `antigravity-unreadable-log-${viewport.name}`,
      viewport,
    );
    await context.close();
  }
  expect(await readFile(started, "utf8").catch(() => "")).not.toContain(
    "--gemini-dir",
  );
});

/** Provider Host workers for the session (none without the host). */
async function hostedRuntimes(
  page: import("@playwright/test").Page,
  baseUrl: string,
  sessionId: string,
) {
  const response = await page.request.get(
    `${baseUrl}/api/provider-host/runtimes`,
    { headers: { "X-Yep-Anywhere": "true" } },
  );
  if (!response.ok()) return 0;
  const { runtimes } = (await response.json()) as {
    runtimes: Array<{ providerName: string; sessionId?: string }>;
  };
  return runtimes.filter(
    (runtime) =>
      runtime.providerName === "antigravity" && runtime.sessionId === sessionId,
  ).length;
}

// The owner in this process, and in a Provider Host worker (plan 195 step
// 9), whose view the backend reads across the process boundary while the
// turn streams and the client types.
for (const hosted of [false, true]) {
  const where = hosted ? " (owner in the Provider Host)" : "";
  test(`resumes a long Antigravity conversation from the browser without replaying it${where}`, async ({
    browser,
  }, testInfo) => {
    const viewport = { name: "desktop" as const, width: 1000, height: 600 };
    const resumedId = "a9a90000-0000-4000-8000-000000000196";
    const { server, projectId, started } = await serve(resumedId, {
      resumable: true,
      hosted,
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
    expect(await hostedRuntimes(page, server.baseUrl, resumedId)).toBe(
      hosted ? 1 : 0,
    );

    // Sequential typing while the resumed turn streams.
    await composer.focus();
    const recordTyping = await startTypingDiagnostics(composer, {
      limitMs: typingAckTargetMs,
    });
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
    await recordTyping(testInfo, "antigravity-resume", acks, slowest);
    expect(slowest).toBeLessThan(typingAckTargetMs);

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
      await loadNextHistoryPage(page, resumedId);
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

  test(`keeps a long live Antigravity session whole across a move of its live rows to the log${where}`, async ({
    browser,
  }, testInfo) => {
    // Plan 195 step 6: past its 2 MiB soft budget, once a split point is
    // older than Process's replay window, the owner moves the rows before it
    // to the log. A move is one replacement window for a connected client.
    test.setTimeout(180_000);
    const viewport = { name: "desktop" as const, width: 1000, height: 600 };
    const liveId = "a9a90000-0000-4000-8000-000000000197";
    const { server, projectId } = await serve(liveId, {
      resumable: true,
      hosted,
    });
    const context = await browser.newContext({
      serviceWorkers: "block",
      viewport,
    });
    const page = await context.newPage();
    // Every catch-up the client makes: its cursor, whether the move had
    // been seen yet, and whether it was answered as a replacement window
    // (with pagination) instead of incrementally.
    let movedSeen = false;
    const catchUps: Array<{
      cursor: string;
      afterMove: boolean;
      replaced: boolean;
    }> = [];
    page.on("response", async (response) => {
      const url = new URL(response.url());
      if (!url.pathname.endsWith(`/sessions/${liveId}`)) return;
      const cursor = url.searchParams.get("afterMessageId");
      if (cursor) {
        const afterMove = movedSeen;
        const data = await response.json();
        catchUps.push({
          cursor,
          afterMove,
          replaced: Boolean(data.pagination),
        });
      }
    });
    await page.goto(
      `${server.baseUrl}/projects/${projectId}/sessions/${liveId}`,
    );
    const main = page.getByRole("main");
    await expect(main.getByText(/TURN_\d+_REPLY/).first()).toBeAttached({
      timeout: 20_000,
    });
    const detail = async (query = "") => {
      const response = await page.request.get(
        `${server.baseUrl}/api/projects/${projectId}/sessions/${liveId}${query}`,
        { headers: { "X-Yep-Anywhere": "true" } },
      );
      return (await response.json()) as {
        messages: Array<{ uuid: string; message?: { content?: unknown } }>;
        pagination?: unknown;
      };
    };
    const rowsOf = async (marker: string) =>
      (await detail()).messages.filter((message) =>
        JSON.stringify(message.message?.content ?? "").includes(marker),
      );
    const finished = (marker: string) =>
      expect
        .poll(async () => (await rowsOf(marker)).length, { timeout: 30_000 })
        .toBe(1);
    const send = async (message: string) =>
      expect(
        (
          await page.request.post(
            `${server.baseUrl}/api/sessions/${liveId}/messages`,
            { headers: { "X-Yep-Anywhere": "true" }, data: { message } },
          )
        ).status(),
      ).toBe(200);

    // Two large turns pass the soft budget; the first resumes from the
    // composer. Nothing has moved yet: every catch-up appends.
    const composer = page.locator("[data-composer-input]");
    await composer.fill("BIG_TURN_1");
    await composer.press("Enter");
    await finished("BIG_TURN_1_DONE");
    expect(await hostedRuntimes(page, server.baseUrl, liveId)).toBe(
      hosted ? 1 : 0,
    );
    const firstReply = (await rowsOf("BIG_TURN_1_DONE"))[0]!.uuid;
    const firstPrompt = (await detail()).messages.find(
      (message) => message.message?.content === "BIG_TURN_1",
    )!.uuid;
    expect(firstReply).not.toContain(":step-");
    // An older page loaded before the move.
    const loadOlder = page.locator("[data-load-older-messages]");
    await loadNextHistoryPage(page, liveId);
    await send("BIG_TURN_2");
    await finished("BIG_TURN_2_DONE");
    expect(catchUps.filter((entry) => entry.replaced)).toEqual([]);

    // A slow turn streams across the moment the split at BIG_TURN_2 is old
    // enough; the owner moves BIG_TURN_1 into the log during it. Type all
    // the while, until that move is visible on the server.
    await send("SLOW_TURN_3");
    await expect
      .poll(async () => (await rowsOf("SLOW_TURN_3_REPLY")).length, {
        timeout: 20_000,
      })
      .toBe(1);
    await expect(main.getByText(/SLOW_TURN_3_REPLY/)).toHaveCount(1, {
      timeout: 20_000,
    });
    await composer.focus();
    const maxTypingKeys = 400;
    const recordTyping = await startTypingDiagnostics(composer, {
      limitMs: typingAckTargetMs,
      maxKeys: maxTypingKeys,
    });
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
    const moved = async () =>
      (movedSeen ||= !(await detail()).messages.some(
        (message) => message.uuid === firstReply,
      ));
    const prefixes: string[] = [];
    let draft = "";
    const sentence = "Typing while live rows move to the log. ";
    for (let index = 0; index < maxTypingKeys; index++) {
      const character = sentence[index % sentence.length]!;
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
      if (index >= 30 && index % 10 === 0 && (await moved())) break;
    }
    await expect.poll(moved, { timeout: 60_000 }).toBe(true);
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
      `Antigravity live-memory typing (${viewport.name}): ${acks.length} keys while a turn streamed across a move, browser maximum ${slowest.toFixed(1)} ms`,
    );
    await recordTyping(testInfo, "antigravity-live-move", acks, slowest);
    expect(slowest).toBeLessThan(typingAckTargetMs);
    await finished("SLOW_TURN_3_DONE");
    await expect(composer).toHaveValue(draft);

    // The move evicted only BIG_TURN_1's rows (before the split at
    // BIG_TURN_2), and this client's cursor was always its last row: a live
    // row the owner still held, so every catch-up appended, including those
    // after the move; none appended rows it already held (each turn shows
    // once, below).
    const cursorClass = (cursor: string) =>
      cursor.includes(":step-")
        ? "log"
        : cursor === firstReply || cursor === firstPrompt
          ? "evicted"
          : "held";
    // Before the move a cursor may be a log row (the history the owner
    // resumed after) or BIG_TURN_1's rows; after it, only a held live row.
    expect(
      catchUps
        .filter(
          (entry) => entry.afterMove && cursorClass(entry.cursor) !== "held",
        )
        .map((entry) => entry.cursor),
    ).toEqual([]);
    expect(catchUps.filter((entry) => entry.replaced)).toEqual([]);
    expect(catchUps.some((entry) => entry.afterMove)).toBe(true);
    // Each cursor class's answer after the move, through the real route: a
    // held live row appends; a live row that left memory, or a log row before
    // the moved range, is a replacement window.
    const lastHeld = catchUps.at(-1)!.cursor;
    expect(cursorClass(lastHeld)).toBe("held");
    expect(
      (await detail(`?afterMessageId=${lastHeld}`)).pagination,
    ).toBeFalsy();
    for (const cursor of [firstReply, `${liveId}:step-0`])
      expect(
        (await detail(`?afterMessageId=${encodeURIComponent(cursor)}`))
          .pagination,
      ).toBeTruthy();
    // "Load older" from a cursor that left memory answers an empty page, the
    // miss the browser recovers from by taking its tail again.
    const evicted = await detail(
      `?tailCompactions=2&beforeMessageId=${encodeURIComponent(firstReply)}`,
    );
    expect(evicted.messages).toEqual([]);
    // Every turn once, at the bottom.
    const follow = page.getByRole("button", {
      name: "Follow latest session output",
    });
    if (await follow.isVisible()) await follow.click();
    await expect(main.getByText(/SLOW_TURN_3_DONE/)).toBeVisible({
      timeout: 20_000,
    });
    // The newest turn once; older turns at most once (the 1.2 MB replies put
    // them outside the mounted, trimmed window), never twice.
    await expect(main.getByText("SLOW_TURN_3", { exact: true })).toHaveCount(1);
    await expect(main.getByText(/SLOW_TURN_3_DONE/)).toHaveCount(1);
    for (const turn of ["BIG_TURN_1", "BIG_TURN_2"]) {
      expect(
        await main.getByText(turn, { exact: true }).count(),
      ).toBeLessThanOrEqual(1);
      expect(
        await main.getByText(new RegExp(`${turn}_DONE`)).count(),
      ).toBeLessThanOrEqual(1);
    }
    await recordUiCapture(page, "antigravity-live-memory-desktop", viewport);
    // Older pages load after the move, from the replaced window, to step 0.
    const olderAfter: Array<{ messages: Array<{ uuid: string }> }> = [];
    page.on("response", async (response) => {
      const url = new URL(response.url());
      if (
        url.pathname.endsWith(`/sessions/${liveId}`) &&
        url.searchParams.has("beforeMessageId")
      )
        olderAfter.push(await response.json());
    });
    for (let attempt = 0; attempt < 12; attempt++) {
      if ((await loadOlder.count()) === 0) break;
      await loadNextHistoryPage(page, liveId);
    }
    await expect(loadOlder).toHaveCount(0);
    expect(olderAfter.at(-1)?.messages[0]?.uuid).toBe(`${liveId}:step-0`);
    const loaded = olderAfter.flatMap((older) =>
      older.messages.map((message) => message.uuid),
    );
    expect(new Set(loaded).size).toBe(loaded.length);
    // A reload shows each turn once too.
    await page.reload();
    await expect(main.getByText(/SLOW_TURN_3_DONE/)).toHaveCount(1, {
      timeout: 20_000,
    });
    await expect(main.getByText("SLOW_TURN_3", { exact: true })).toHaveCount(1);
    for (const turn of ["BIG_TURN_1", "BIG_TURN_2"])
      expect(
        await main.getByText(turn, { exact: true }).count(),
      ).toBeLessThanOrEqual(1);
    // The server's view holds each turn once.
    for (const marker of [
      "BIG_TURN_1_DONE",
      "BIG_TURN_2_DONE",
      "SLOW_TURN_3_DONE",
    ])
      expect(await rowsOf(marker)).toHaveLength(1);
    await context.close();
  });
}
