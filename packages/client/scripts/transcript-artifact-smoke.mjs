#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "../../..");
const DEFAULT_ARTIFACT_ROOT = join(
  REPO_ROOT,
  ".artifacts",
  "portable-transcript-compiler",
);
const DEFAULT_MANIFEST = join(DEFAULT_ARTIFACT_ROOT, "local-sessions.json");
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_SETTLE_MS = 750;
const BUILTIN_VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  mobile: { width: 375, height: 812 },
};

function timestampForPath(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

function resolveFromCwd(path) {
  return isAbsolute(path) ? path : resolve(process.cwd(), path);
}

function valueAfter(argv, index, option) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

export function parseArgs(argv) {
  const options = {
    manifestPath: DEFAULT_MANIFEST,
    outDir: join(DEFAULT_ARTIFACT_ROOT, "runs", timestampForPath()),
    comparePath: null,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    settleMs: DEFAULT_SETTLE_MS,
    headed: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--":
        break;
      case "--manifest":
        options.manifestPath = resolveFromCwd(valueAfter(argv, index, arg));
        index += 1;
        break;
      case "--out-dir":
        options.outDir = resolveFromCwd(valueAfter(argv, index, arg));
        index += 1;
        break;
      case "--compare":
        options.comparePath = resolveFromCwd(valueAfter(argv, index, arg));
        index += 1;
        break;
      case "--timeout-ms":
        options.timeoutMs = Number(valueAfter(argv, index, arg));
        index += 1;
        break;
      case "--settle-ms":
        options.settleMs = Number(valueAfter(argv, index, arg));
        index += 1;
        break;
      case "--headed":
        options.headed = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  for (const [name, value] of [
    ["--timeout-ms", options.timeoutMs],
    ["--settle-ms", options.settleMs],
  ]) {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`${name} must be a non-negative number`);
    }
  }
  return options;
}

function printUsage() {
  console.log(`Usage: pnpm --filter client transcript:artifacts -- [options]

Capture privacy-local transcript screenshots and structural assertions.

Options:
  --manifest <path>   Session manifest. Default:
                      .artifacts/portable-transcript-compiler/local-sessions.json
  --out-dir <path>    Artifact run directory. Default: timestamped ignored run.
  --compare <path>    Prior report.json or its directory. Require exact
                      structural and screenshot hash parity.
  --timeout-ms <ms>   Per-page readiness timeout. Default: ${DEFAULT_TIMEOUT_MS}
  --settle-ms <ms>    Stable-row interval after loading. Default: ${DEFAULT_SETTLE_MS}
  --headed            Show Chromium.
  --help              Show this help.

Copy packages/client/scripts/transcript-artifact-sessions.example.json to the
ignored default manifest and replace its URL with an inactive local session.
Reports and screenshots can contain sensitive local metadata; never stage the
.artifacts/portable-transcript-compiler directory.
`);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sanitizeName(name) {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function validateViewport(name) {
  const viewport = BUILTIN_VIEWPORTS[name];
  if (!viewport) {
    throw new Error(
      `Unknown viewport ${JSON.stringify(name)}; expected ${Object.keys(
        BUILTIN_VIEWPORTS,
      ).join(" or ")}`,
    );
  }
  return viewport;
}

export function validateManifest(value) {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new Error("Manifest must be an object with schemaVersion: 1");
  }
  if (!Array.isArray(value.sessions) || value.sessions.length === 0) {
    throw new Error("Manifest sessions must be a non-empty array");
  }

  const names = new Set();
  const sessions = value.sessions.map((session, index) => {
    if (!isRecord(session)) {
      throw new Error(`sessions[${index}] must be an object`);
    }
    if (typeof session.name !== "string" || !session.name.trim()) {
      throw new Error(`sessions[${index}].name must be a non-empty string`);
    }
    const name = sanitizeName(session.name);
    if (!name) {
      throw new Error(`sessions[${index}].name has no path-safe characters`);
    }
    if (names.has(name)) {
      throw new Error(`Duplicate session artifact name: ${name}`);
    }
    names.add(name);

    if (typeof session.url !== "string") {
      throw new Error(`sessions[${index}].url must be a URL string`);
    }
    const url = new URL(session.url);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error(`sessions[${index}].url must use http or https`);
    }

    const minimumRenderRows = session.minimumRenderRows ?? 1;
    if (!Number.isInteger(minimumRenderRows) || minimumRenderRows < 1) {
      throw new Error(
        `sessions[${index}].minimumRenderRows must be a positive integer`,
      );
    }

    const viewportNames = session.viewports ?? ["desktop", "mobile"];
    if (!Array.isArray(viewportNames) || viewportNames.length === 0) {
      throw new Error(`sessions[${index}].viewports must be non-empty`);
    }
    for (const viewportName of viewportNames) {
      validateViewport(viewportName);
    }

    return {
      name,
      url: url.toString(),
      minimumRenderRows,
      theme:
        typeof session.theme === "string" && session.theme
          ? session.theme
          : "verydark",
      viewports: viewportNames,
    };
  });

  return { schemaVersion: 1, sessions };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function reportPathFrom(path) {
  const details = await stat(path);
  return details.isDirectory() ? join(path, "report.json") : path;
}

function currentGitRevision() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function caseKey(entry) {
  return `${entry.name}/${entry.viewport}`;
}

export function compareReports(baseline, current) {
  const failures = [];
  const baselineCases = new Map(
    (baseline.cases ?? []).map((entry) => [caseKey(entry), entry]),
  );
  const currentCases = new Map(
    (current.cases ?? []).map((entry) => [caseKey(entry), entry]),
  );

  for (const [key, expected] of baselineCases) {
    const actual = currentCases.get(key);
    if (!actual) {
      failures.push(`${key}: missing from current report`);
      continue;
    }
    if (actual.status !== "passed") {
      failures.push(`${key}: current capture did not pass`);
      continue;
    }
    for (const field of ["rowCount", "renderSignature"]) {
      if (actual[field] !== expected[field]) {
        failures.push(
          `${key}: ${field} changed (${JSON.stringify(expected[field])} -> ${JSON.stringify(actual[field])})`,
        );
      }
    }
    for (const position of ["top", "tail"]) {
      const expectedHash = expected.screenshots?.[position]?.sha256;
      const actualHash = actual.screenshots?.[position]?.sha256;
      if (actualHash !== expectedHash) {
        failures.push(`${key}: ${position} screenshot hash changed`);
      }
    }
  }

  for (const key of currentCases.keys()) {
    if (!baselineCases.has(key)) {
      failures.push(`${key}: absent from baseline report`);
    }
  }
  return failures;
}

async function dismissOnboarding(page) {
  const skip = page.getByRole("button", { name: "Skip all", exact: true });
  if (
    await skip
      .waitFor({ state: "visible", timeout: 750 })
      .then(() => true)
      .catch(() => false)
  ) {
    await skip.click();
  }
}

async function waitForStableTranscript(
  page,
  { minimumRenderRows, settleMs, timeoutMs },
) {
  await page.waitForSelector(".session-messages [data-message-list]", {
    timeout: timeoutMs,
  });

  const deadline = Date.now() + timeoutMs;
  let stableSince = null;
  let priorSignature = null;
  while (Date.now() <= deadline) {
    const state = await page.evaluate(() => {
      const list = document.querySelector(
        ".session-messages [data-message-list]",
      );
      const rows = Array.from(
        list?.querySelectorAll("[data-render-id][data-render-type]") ?? [],
      ).filter(
        (row) =>
          !row.parentElement?.closest("[data-render-id][data-render-type]"),
      );
      return {
        busy: list?.getAttribute("aria-busy") === "true",
        signature: rows
          .map(
            (row) =>
              `${row.getAttribute("data-render-type")}:${row.getAttribute(
                "data-render-id",
              )}`,
          )
          .join("\n"),
        rowCount: rows.length,
      };
    });

    if (!state.busy && state.rowCount >= minimumRenderRows) {
      if (state.signature === priorSignature) {
        stableSince ??= Date.now();
        if (Date.now() - stableSince >= settleMs) {
          return state;
        }
      } else {
        priorSignature = state.signature;
        stableSince = Date.now();
      }
    } else {
      priorSignature = null;
      stableSince = null;
    }
    await page.waitForTimeout(100);
  }

  throw new Error(
    `Transcript did not reach ${minimumRenderRows} stable rows within ${timeoutMs}ms`,
  );
}

async function installStableCaptureStyle(page) {
  await page.addStyleTag({
    content: `
      *, *::before, *::after {
        animation-duration: 0s !important;
        animation-delay: 0s !important;
        caret-color: transparent !important;
        transition-duration: 0s !important;
        transition-delay: 0s !important;
      }
      [data-message-age],
      .reload-banner,
      [data-turn-rail],
      .selection-quote-button {
        visibility: hidden !important;
      }
    `,
  });
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
}

async function collectTranscriptState(page) {
  return page.evaluate(async () => {
    const encoder = new TextEncoder();
    const digest = async (text) => {
      const bytes = await crypto.subtle.digest("SHA-256", encoder.encode(text));
      return Array.from(new Uint8Array(bytes), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("");
    };
    const list = document.querySelector(
      ".session-messages [data-message-list]",
    );
    const scroll = document.querySelector(".session-messages");
    if (!(list instanceof HTMLElement) || !(scroll instanceof HTMLElement)) {
      throw new Error("Transcript containers are missing");
    }

    const allRows = Array.from(
      list.querySelectorAll("[data-render-id][data-render-type]"),
    );
    const rows = allRows.filter(
      (row) =>
        !row.parentElement?.closest("[data-render-id][data-render-type]"),
    );
    const rawIds = rows.map((row) => row.getAttribute("data-render-id") ?? "");
    const duplicateIds = rawIds.filter(
      (id, index) => id && rawIds.indexOf(id) !== index,
    );
    const typeCounts = {};
    const signatures = [];

    for (const row of rows) {
      const id = row.getAttribute("data-render-id") ?? "";
      const type = row.getAttribute("data-render-type") ?? "";
      typeCounts[type] = (typeCounts[type] ?? 0) + 1;
      const clone = row.cloneNode(true);
      for (const dynamic of clone.querySelectorAll(
        "[data-message-age], [data-turn-rail], button, [role='status']",
      )) {
        dynamic.remove();
      }
      const text = (clone.textContent ?? "").replace(/\s+/g, " ").trim();
      signatures.push({
        idHash: (await digest(id)).slice(0, 16),
        type,
        textHash: await digest(text),
        textLength: text.length,
      });
    }

    return {
      rowCount: rows.length,
      rows: signatures,
      duplicateIdHashes: await Promise.all(
        [...new Set(duplicateIds)].map(async (id) =>
          (await digest(id)).slice(0, 16),
        ),
      ),
      typeCounts,
      documentWidth: {
        client: document.documentElement.clientWidth,
        scroll: document.documentElement.scrollWidth,
      },
      transcriptWidth: {
        client: scroll.clientWidth,
        overflowX: getComputedStyle(scroll).overflowX,
        scroll: scroll.scrollWidth,
      },
    };
  });
}

async function capturePosition(page, outputPath, position) {
  const scroll = page.locator(".session-messages");
  await scroll.evaluate((element, wanted) => {
    element.scrollTop = wanted === "top" ? 0 : element.scrollHeight;
  }, position);
  await page.waitForTimeout(150);
  const bytes = await scroll.screenshot({
    animations: "disabled",
    path: outputPath,
  });
  return { file: outputPath, sha256: sha256(bytes) };
}

async function captureCase(browser, session, viewportName, options) {
  const viewport = validateViewport(viewportName);
  const context = await browser.newContext({
    colorScheme: session.theme === "light" ? "light" : "dark",
    ignoreHTTPSErrors: true,
    viewport,
  });
  const page = await context.newPage();
  const consoleFailures = [];
  const pageErrors = [];
  page.on("console", (message) => {
    if (message.type() === "warning" || message.type() === "error") {
      consoleFailures.push(`${message.type()}: ${message.text()}`);
    }
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.addInitScript((theme) => {
    localStorage.setItem("yep-anywhere-theme", theme);
  }, session.theme);

  const outputDir = join(options.outDir, session.name);
  await mkdir(outputDir, { recursive: true });
  const result = {
    name: session.name,
    viewport: viewportName,
    viewportSize: viewport,
    status: "failed",
    rowCount: null,
    renderSignature: null,
    screenshots: {},
    assertions: [],
    error: null,
  };

  try {
    const response = await page.goto(session.url, {
      timeout: options.timeoutMs,
      waitUntil: "domcontentloaded",
    });
    if (!response?.ok()) {
      throw new Error(`Navigation returned HTTP ${response?.status() ?? "?"}`);
    }
    await dismissOnboarding(page);
    await waitForStableTranscript(page, {
      minimumRenderRows: session.minimumRenderRows,
      settleMs: options.settleMs,
      timeoutMs: options.timeoutMs,
    });
    await installStableCaptureStyle(page);
    const state = await collectTranscriptState(page);
    result.rowCount = state.rowCount;
    result.rows = state.rows;
    result.renderSignature = sha256(JSON.stringify(state.rows));
    result.typeCounts = state.typeCounts;
    result.duplicateIdHashes = state.duplicateIdHashes;
    result.documentWidth = state.documentWidth;
    result.transcriptWidth = state.transcriptWidth;

    const assertions = [
      {
        name: "minimum render rows",
        passed: state.rowCount >= session.minimumRenderRows,
        detail: `${state.rowCount} >= ${session.minimumRenderRows}`,
      },
      {
        name: "unique top-level render ids",
        passed: state.duplicateIdHashes.length === 0,
        detail: state.duplicateIdHashes.join(", ") || "none",
      },
      {
        name: "document horizontal overflow",
        passed: state.documentWidth.scroll <= state.documentWidth.client + 1,
        detail: `${state.documentWidth.scroll}/${state.documentWidth.client}`,
      },
      {
        name: "transcript horizontal overflow is contained",
        passed:
          state.transcriptWidth.scroll <= state.transcriptWidth.client + 1 ||
          ["auto", "clip", "hidden", "scroll"].includes(
            state.transcriptWidth.overflowX,
          ),
        detail: `${state.transcriptWidth.scroll}/${state.transcriptWidth.client} (${state.transcriptWidth.overflowX})`,
      },
      {
        name: "browser console warnings/errors",
        passed: consoleFailures.length === 0,
        detail: consoleFailures.join(" | ") || "none",
      },
      {
        name: "browser page errors",
        passed: pageErrors.length === 0,
        detail: pageErrors.join(" | ") || "none",
      },
    ];
    result.assertions = assertions;

    result.screenshots.top = await capturePosition(
      page,
      join(outputDir, `${viewportName}-top.png`),
      "top",
    );
    result.screenshots.tail = await capturePosition(
      page,
      join(outputDir, `${viewportName}-tail.png`),
      "tail",
    );

    const failures = assertions.filter((assertion) => !assertion.passed);
    if (failures.length > 0) {
      throw new Error(
        failures
          .map((assertion) => `${assertion.name}: ${assertion.detail}`)
          .join("; "),
      );
    }
    result.status = "passed";
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  } finally {
    await context.close();
  }
  return result;
}

async function run(options) {
  const manifest = validateManifest(await readJson(options.manifestPath));
  await mkdir(options.outDir, { recursive: true });
  const browser = await chromium.launch({
    chromiumSandbox: true,
    args: ["--ignore-certificate-errors"],
    headless: !options.headed,
  });
  const report = {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    gitRevision: currentGitRevision(),
    manifestSha256: sha256(JSON.stringify(manifest)),
    browserVersion: browser.version(),
    cases: [],
    comparisonFailures: [],
  };

  try {
    for (const session of manifest.sessions) {
      for (const viewportName of session.viewports) {
        console.log(`Capturing ${session.name}/${viewportName}...`);
        const result = await captureCase(
          browser,
          session,
          viewportName,
          options,
        );
        report.cases.push(result);
        console.log(
          `  ${result.status}: ${result.rowCount ?? 0} rows${
            result.error ? ` (${result.error})` : ""
          }`,
        );
      }
    }
  } finally {
    await browser.close();
  }

  if (options.comparePath) {
    const baselinePath = await reportPathFrom(options.comparePath);
    const baseline = await readJson(baselinePath);
    report.comparison = { baselinePath };
    report.comparisonFailures = compareReports(baseline, report);
  }

  const reportPath = join(options.outDir, "report.json");
  await writeJson(reportPath, report);
  const captureFailures = report.cases.filter(
    (entry) => entry.status !== "passed",
  );
  const failures = [
    ...captureFailures.map(
      (entry) => `${caseKey(entry)}: ${entry.error ?? "capture failed"}`,
    ),
    ...report.comparisonFailures,
  ];
  if (failures.length > 0) {
    console.error(`Transcript artifact gate failed; report: ${reportPath}`);
    for (const failure of failures) {
      console.error(`- ${failure}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log(`Transcript artifact gate passed; report: ${reportPath}`);
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      printUsage();
      return;
    }
    await run(options);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  await main();
}
