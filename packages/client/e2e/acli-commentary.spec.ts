import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { toUrlProjectId } from "@yep-anywhere/shared";
import { createTestViteServer as createViteServer } from "./support/vite-server";
import { createToolCommentaryRoutes } from "../../server/src/routes/tool-commentary";
import type { ProjectScanner } from "../../server/src/projects/scanner";

// Each test file boots its own cold server; on CI the first page can take
// over 10 s to load, leaving little of the 15 s default for the test itself.
test.setTimeout(60_000);

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const serverRequire = createRequire(join(root, "../server/package.json"));
const { getRequestListener } = serverRequire("@hono/node-server");
let vite: Awaited<ReturnType<typeof createViteServer>>;
let listener: ReturnType<typeof createServer>;
let directory: string;
let base: string;
let requests = 0;
let artifactOutput: { stdout: string; stderr: string; toolName: string };
let lineOutput: { stdout: string; stderr: string; command: string };
const workflowOutput = {
  stdout:
    '# acli: 1 +commentary\n{"checks":"passed"}\n' +
    JSON.stringify({
      _acli: {
        commentary: [
          { text: "[build] [Report](./report.md) checks passed." },
          { text: "[report] The score is \\(x^2 = 25\\)." },
        ],
      },
    }) +
    "\n[build] Final data.\n",
  stderr:
    "# acli-capabilities: commentary-lines/1\n# _acli.commentary: [report] Independent stderr note.\n",
  workflowActivation:
    '@@visualization-schema/1 ["parent","build","report"]\n[parent] Check the report.',
};
const captureImages = new Map<string, Buffer>();
const basicAcliOutput = {
  toolName: "Exec",
  workflowActivation: '@@visualization-schema/1 ["build"]',
  stderr: "",
  stdout: JSON.stringify(
    [
      "0\t0\n",
      'master\n# acli: 1 complete\n{"kind":"file_claim","dropped":["client/output.tsx","client/workflow.tsx"],"ok":true}\n',
    ].map((output, index) => ({
      type: "input_text",
      text: JSON.stringify({
        chunk_id: String(index),
        output,
        exit_code: 0,
        wall_time_seconds: 0.1,
      }),
    })),
  ),
};
const note = (text: string) => ({ _acli: { commentary: [{ text }] } });

test.beforeAll(async () => {
  // The file-level limit does not reach hooks. This one runs a browser capture
  // and boots a cold Vite server, and exceeded the 15 s default in CI runs
  // 42990576039 and 43275032371.
  test.setTimeout(60_000);
  const scratch = resolve(
    root,
    "../../.artifacts/ui-testing/2026-09-07-acli-commentary",
  );
  await mkdir(scratch, { recursive: true });
  directory = await mkdtemp(join(scratch, "project-"));
  await writeFile(join(directory, "report.md"), "# Result");
  const projectId = toUrlProjectId(directory);
  const input = join(directory, "index.html");
  await writeFile(
    input,
    '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Capture result</title><style>body{margin:32px;background:#17232d;color:#f4f7fa;font:20px system-ui}main{max-width:640px}h1{font-size:36px}strong{color:#83d6b4}</style><main><h1>Artifact capture</h1><p>This generated image reaches the transcript through the <strong>capture call itself</strong>.</p></main>',
  );
  const cli = await promisify(execFile)(
    process.execPath,
    [
      "--import",
      createRequire(join(root, "package.json")).resolve("tsx/esm"),
      join(root, "scripts/capture-artifact.ts"),
      input,
      "--out",
      join(directory, "captures"),
      "--json",
    ],
    { env: { ...process.env, ACLI_QUIET: "" } },
  );
  const captured = JSON.parse(cli.stdout) as {
    screenshots: { path: string }[];
  };
  for (const capture of captured.screenshots)
    captureImages.set(capture.path, await readFile(capture.path));
  artifactOutput = {
    toolName: "Exec",
    stderr: "",
    stdout: JSON.stringify([
      { type: "text", text: "Script completed\nWall time: 2s\nOutput:\n" },
      {
        type: "text",
        text: JSON.stringify({
          chunk_id: "capture",
          wall_time_seconds: 2,
          exit_code: 0,
          output: cli.stderr + cli.stdout,
        }),
      },
    ]),
  };
  // ACLI_FIXTURE_JSON can supply actual producer output for a local smoke.
  const output = process.env.ACLI_FIXTURE_JSON
    ? (JSON.parse(await readFile(process.env.ACLI_FIXTURE_JSON, "utf8")) as {
        stdout: string;
        stderr: string;
      })
    : {
        stdout: [
          note("The report is ready. **Three checks passed.**"),
          {
            checks: [
              {
                name: "Links",
                status: "passed",
                ...note("[Report](./report.md) links resolve in this project."),
              },
              {
                name: "Math",
                status: "passed",
                ...note("The score is \\(x^2 + y^2 = 25\\)."),
              },
            ],
          },
          note("All checks completed."),
        ]
          .map((value) => JSON.stringify(value))
          .join("\n"),
        stderr: "# acli: 1 +commentary\n",
      };
  const routes = createToolCommentaryRoutes({
    scanner: {
      getProject: async (id: string) =>
        id === projectId ? { path: directory } : null,
    } as ProjectScanner,
  });
  const handle = getRequestListener(routes.fetch);
  process.env.VITE_DISABLE_ONBOARDING = "true";
  process.env.VITE_DISABLE_CLI_UPDATE_NOTIFICATIONS = "true";
  vite = await createViteServer({
    root,
    server: { middlewareMode: true, hmr: false },
    appType: "mpa",
  });
  listener = createServer((req, res) => {
    if (req.url?.startsWith("/api/projects/")) {
      requests++;
      req.url = req.url.slice("/api/projects".length);
      void handle(req, res);
    } else if (req.url?.startsWith("/api/local-image?")) {
      const path = new URL(req.url, "http://fixture").searchParams.get("path");
      const bytes = path ? captureImages.get(path) : undefined;
      res.statusCode = bytes ? 200 : 404;
      res.setHeader("Content-Type", "image/png");
      res.end(bytes);
    } else if (
      req.url?.startsWith("/api/version") ||
      req.url?.startsWith("/api/fixture")
    ) {
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify(
          req.url?.startsWith("/api/fixture")
            ? {
                projectId,
                ...(req.url.includes("acli-basics=1")
                  ? basicAcliOutput
                  : req.url.includes("workflow-json=1")
                    ? {
                        stdout:
                          '[build] Checks passed.\n# acli: 1 complete\n{"kind":"checks","ok":true,"count":2}\n',
                        stderr: "",
                        workflowActivation:
                          '@@visualization-schema/1 ["build"]',
                      }
                    : req.url.includes("plain-workflow=1")
                      ? {
                          stdout: "[build] Compilation passed.",
                          stderr: "",
                          workflowActivation:
                            '@@visualization-schema/1 ["build"]',
                        }
                      : req.url.includes("artifact=1")
                        ? artifactOutput
                        : req.url.includes("lines=1")
                          ? lineOutput
                          : req.url.includes("composition=1")
                            ? workflowOutput
                            : output),
              }
            : { current: "0.8.2" },
        ),
      );
    } else vite.middlewares(req, res);
  });
  await new Promise<void>((ready) => listener.listen(0, "127.0.0.1", ready));
  const address = listener.address();
  if (!address || typeof address === "string")
    throw new Error("Missing browser fixture port");
  base = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
  if (listener) {
    listener.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      listener.close((error) => (error ? reject(error) : resolve())),
    );
  }
  if (vite) await vite.close();
  if (directory) await rm(directory, { recursive: true });
});

test("renders through the endpoint and keeps context outside transcript geometry", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (["warning", "error"].includes(message.type()))
      errors.push(message.text());
  });
  const archive = resolve(
    root,
    "../../.artifacts/ui-testing/2026-09-07-acli-commentary",
  );
  for (const [name, width, height] of [
    ["desktop", 1000, 600],
    ["phone", 375, 812],
  ] as const) {
    await page.setViewportSize({ width, height });
    await page.goto(`${base}/e2e/fixtures/acli-commentary.html`);
    await expect(
      page.getByRole("button", { name: "Open tool output" }),
    ).toHaveCount(1);
    await expect(page.locator(".katex")).toHaveCount(1);
    await expect(page.getByRole("link", { name: "Report" })).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: join(archive, `${name}.png`) });
    const before = await page.locator("main").boundingBox();
    await page
      .getByRole("button", { name: "Show commentary context" })
      .first()
      .click();
    await expect(
      page.getByRole("dialog", { name: "Show commentary context" }),
    ).toContainText("Links");
    expect(await page.locator("main").boundingBox()).toEqual(before);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
    await page.screenshot({ path: join(archive, `${name}-context.png`) });
    await page
      .getByRole("button", { name: "Close commentary context" })
      .click();
    await page.getByRole("button", { name: "Open tool output" }).click();
    await expect(page.getByRole("button", { name: /minimize/i })).toBeVisible();
    await page.getByRole("button", { name: /minimize/i }).click();
    await expect(
      page.getByRole("button", { name: "Open tool output" }),
    ).toBeVisible();
  }
  expect(requests).toBe(2);
  expect(errors).toEqual([]);
  const before = requests;
  await page.evaluate(() =>
    localStorage.setItem("yep-anywhere-acli-commentary-enabled", "false"),
  );
  await page.reload();
  await expect(page.getByText("report --jsonl", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Open tool output" }),
  ).toHaveCount(0);
  expect(requests).toBe(before);
});

test("ACLI metadata and JSON retain their types inside workflows", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (["warning", "error"].includes(message.type()))
      errors.push(message.text());
  });
  for (const query of ["acli-basics", "workflow-json"]) {
    for (const [name, width, height] of [
      ["desktop", 1000, 600],
      ["phone", 375, 812],
    ] as const) {
      await page.setViewportSize({ width, height });
      await page.goto(`${base}/e2e/fixtures/acli-commentary.html?${query}=1`);
      if (query === "acli-basics")
        await page.getByRole("button", { name: "Expand", exact: true }).click();
      const json = page.locator('[data-tool-output-kind="json"]');
      await expect(json).toHaveCount(1);
      await expect(json).toContainText('"ok": true');
      expect(await json.textContent()).toContain('\n  "kind":');
      await expect(
        page.locator('[data-tool-output-kind="metadata"]'),
      ).toHaveCount(1);
      if (query === "acli-basics") {
        await expect(page.locator("[data-workflow-output]")).toHaveCount(0);
        await expect(
          page.getByText("Exit code: 0 · 0.1s", { exact: true }),
        ).toHaveCount(2);
      } else
        await expect(
          page.getByText("Checks passed.", { exact: false }),
        ).toBeVisible();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBeLessThanOrEqual(width);
      await page.screenshot({
        path: resolve(
          root,
          `../../.artifacts/ui-testing/2026-09-08-acli-basics/${query}-${name}.png`,
        ),
        fullPage: true,
      });
    }
  }
  expect(errors).toEqual([]);
});

test("schema-rendered tool progress stays visible in collapsed Conversation View", async ({
  page,
}) => {
  for (const [name, width, height] of [
    ["desktop", 1000, 600],
    ["phone", 375, 812],
  ] as const) {
    await page.setViewportSize({ width, height });
    await page.goto(
      `${base}/e2e/fixtures/acli-commentary.html?plain-workflow=1&conversation=1`,
    );
    await expect(
      page.getByText("Compilation passed.", { exact: false }),
    ).toBeVisible();
    await page.screenshot({
      path: resolve(
        root,
        `../../.artifacts/ui-testing/2026-09-07-acli-commentary/workflow-conversation-${name}.png`,
      ),
      fullPage: true,
    });
  }
});

test("the capture CLI presents its links and generated images in collapsed Conversation View", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (["warning", "error"].includes(message.type()))
      errors.push(message.text());
  });
  for (const [name, width, height] of [
    ["desktop", 1000, 600],
    ["phone", 375, 812],
  ] as const) {
    await page.setViewportSize({ width, height });
    await page.goto(
      `${base}/e2e/fixtures/acli-commentary.html?artifact=1&conversation=1`,
    );
    await expect(
      page.getByRole("link", { name: "File viewer", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Open tool output" }),
    ).toHaveCount(2);
    // Ordinary media controls remain collapsed by default. The final two are
    // the producer's explicit image Markdown; the handoff also has PNG links.
    const toggles = page.getByRole("button", {
      name: "Expand image",
      exact: true,
    });
    await expect(toggles).toHaveCount(4);
    await toggles.nth(2).click();
    await toggles.nth(2).click();
    const images = page.locator("main img");
    await expect(images).toHaveCount(2);
    await expect
      .poll(() =>
        images.evaluateAll((elements) =>
          elements.every(
            (image) => (image as HTMLImageElement).naturalWidth > 0,
          ),
        ),
      )
      .toBe(true);
    const desktop = await images.nth(0).boundingBox();
    const phone = await images.nth(1).boundingBox();
    expect(desktop).not.toBeNull();
    expect(phone).not.toBeNull();
    expect(Math.abs(desktop!.y - phone!.y)).toBeLessThan(2);
    expect(desktop!.x + desktop!.width).toBeLessThanOrEqual(phone!.x);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
    await page.screenshot({
      path: resolve(
        root,
        `../../.artifacts/ui-testing/2026-09-07-acli-commentary/artifact-${name}.png`,
      ),
      fullPage: true,
    });
  }
  expect(errors).toEqual([]);
});

test("workflow tags compose with rich commentary and recover original records", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (["warning", "error"].includes(message.type()))
      errors.push(message.text());
  });
  const archive = resolve(
    root,
    "../../.artifacts/ui-testing/2026-09-08-acli-workflow",
  );
  await mkdir(archive, { recursive: true });
  for (const [name, width, height] of [
    ["desktop", 1000, 600],
    ["phone", 375, 812],
  ] as const) {
    await page.setViewportSize({ width, height });
    await page.goto(`${base}/e2e/fixtures/acli-commentary.html?composition=1`);
    await expect(page.getByRole("link", { name: "Report" })).toBeVisible();
    await expect(page.locator(".katex")).toHaveCount(1);
    await expect(
      page.locator('[data-workflow-path="[parent][build]"]'),
    ).toHaveCount(2);
    await expect(
      page.locator('[data-workflow-output="true"]'),
    ).not.toContainText("_acli");
    await expect(
      page.getByRole("button", { name: "Show commentary context" }),
    ).toHaveCount(2);
    await expect(
      page.getByRole("button", { name: "Open tool output" }),
    ).toHaveCount(1);
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: join(archive, `${name}.png`) });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
    await page.getByRole("button", { name: "Expand original output" }).click();
    await expect(page.locator('[data-workflow-original="true"]')).toContainText(
      "_acli",
    );
  }
  // Each switch works independently; disabling both preserves raw output.
  const before = requests;
  await page.evaluate(() =>
    localStorage.setItem("yep-anywhere-acli-commentary-enabled", "false"),
  );
  await page.reload();
  await expect(
    page.locator('[data-workflow-path="[parent][build]"]'),
  ).toHaveCount(2);
  expect(requests).toBe(before);
  await page.goto(
    `${base}/e2e/fixtures/acli-commentary.html?composition=1&workflow=off`,
  );
  await expect(page.locator('[data-workflow-output="true"]')).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Report" })).toHaveCount(0);
  await page.evaluate(() =>
    localStorage.removeItem("yep-anywhere-acli-commentary-enabled"),
  );
  await page.reload();
  await expect(page.getByRole("link", { name: "Report" })).toBeVisible();
  await expect(page.locator("[data-workflow-boundary]")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("shell commentary lines preserve stdout context and unsequenced stderr", async ({
  page,
}) => {
  test.skip(
    process.platform === "win32",
    "Native POSIX shell producer; portable decoding is covered by unit tests.",
  );
  const source = [
    "printf '%s\\n' '# acli-capabilities: commentary-lines/1'",
    "printf '%s\\n' 'Links: passed' 'Math: passed'",
    'if [ "$1" != --no-commentary ]; then',
    "  printf '%s\\n' '# _acli.commentary: [Report](./report.md) checks passed.'",
    "fi",
    "printf '%s\\n' '# acli-capabilities: commentary-lines/1' >&2",
    "printf '%s\\n' 'diagnostic retained' >&2",
    'if [ "$1" != --no-commentary ]; then',
    "  printf '%s\\n' '# _acli.commentary: Run completed; this stderr note is unsequenced.' >&2",
    "fi",
  ].join("\n");
  const run = promisify(execFile);
  const emitted = await run("sh", ["-c", source, "report.sh"]);
  const suppressed = await run("sh", [
    "-c",
    source,
    "report.sh",
    "--no-commentary",
  ]);
  expect(suppressed.stdout).toBe(
    "# acli-capabilities: commentary-lines/1\nLinks: passed\nMath: passed\n",
  );
  expect(suppressed.stderr).toBe(
    "# acli-capabilities: commentary-lines/1\ndiagnostic retained\n",
  );
  lineOutput = { ...emitted, command: "sh report.sh" };
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (["warning", "error"].includes(message.type()))
      errors.push(message.text());
  });
  const archive = resolve(
    root,
    "../../.artifacts/ui-testing/2026-09-08-acli-lines",
  );
  await mkdir(archive, { recursive: true });
  for (const [name, width, height] of [
    ["desktop", 1000, 600],
    ["phone", 375, 812],
  ] as const) {
    await page.setViewportSize({ width, height });
    await page.goto(`${base}/e2e/fixtures/acli-commentary.html?lines=1`);
    await expect(page.getByRole("link", { name: "Report" })).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Show commentary context" }),
    ).toHaveCount(1);
    await expect(
      page.getByRole("button", { name: "Open tool output" }),
    ).toHaveCount(1);
    await expect(
      page.getByText("Run completed; this stderr note is unsequenced."),
    ).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: join(archive, `${name}.png`) });
    await page.getByRole("button", { name: "Show commentary context" }).click();
    await expect(
      page.getByRole("dialog", { name: "Show commentary context" }),
    ).toContainText("Links: passed\nMath: passed");
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
    await page.screenshot({ path: join(archive, `${name}-context.png`) });
  }
  expect(errors).toEqual([]);
  const before = requests;
  await page.evaluate(() =>
    localStorage.setItem("yep-anywhere-acli-commentary-enabled", "false"),
  );
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Show commentary context" }),
  ).toHaveCount(0);
  await expect(page.getByText("sh report.sh", { exact: true })).toBeVisible();
  expect(requests).toBe(before);
});
