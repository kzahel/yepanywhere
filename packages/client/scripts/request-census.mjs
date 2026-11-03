#!/usr/bin/env node
import { chromium } from "@playwright/test";

const DEFAULT_WAIT_MS = 8000;

function printUsage() {
  console.log(`Usage: pnpm --filter client request:census -- --url <url> [options]

Options:
  --url <url>        Page URL to load.
  --wait-ms <ms>     Milliseconds to observe after DOMContentLoaded.
                     Default: ${DEFAULT_WAIT_MS}
  --all              Include non-/api same-origin requests in the grouped table.
  --json             Print JSON instead of the text summary.
  --headed           Run Chromium headed.
  --help             Show this help.
`);
}

function parseArgs(argv) {
  const options = {
    url: "",
    waitMs: DEFAULT_WAIT_MS,
    apiOnly: true,
    json: false,
    headless: true,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--":
        break;
      case "--url":
        options.url = argv[++index] ?? "";
        break;
      case "--wait-ms":
        options.waitMs = Number.parseInt(argv[++index] ?? "", 10);
        break;
      case "--all":
        options.apiOnly = false;
        break;
      case "--json":
        options.json = true;
        break;
      case "--headed":
        options.headless = false;
        break;
      case "--help":
        printUsage();
        process.exit(0);
        break;
      case "-h":
        printUsage();
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!options.url) {
    throw new Error("--url is required");
  }
  if (!Number.isFinite(options.waitMs) || options.waitMs < 0) {
    throw new Error("--wait-ms must be a non-negative integer");
  }
  return options;
}

function classifyUrl(url, origin) {
  try {
    const parsed = new URL(url);
    return {
      sameOrigin: parsed.origin === origin,
      origin: parsed.origin,
      path: `${parsed.pathname}${parsed.search}`,
    };
  } catch {
    return {
      sameOrigin: false,
      origin: "",
      path: url,
    };
  }
}

function initiatorTop(initiator) {
  const frames = [
    ...(initiator?.stack?.callFrames ?? []),
    ...(initiator?.stack?.parent?.callFrames ?? []),
  ];
  const frame =
    frames.find(
      (candidate) =>
        candidate.url &&
        !candidate.url.includes("/node_modules/") &&
        !candidate.url.includes("/@vite/"),
    ) ?? frames[0];

  if (!frame) {
    return initiator?.type ?? "unknown";
  }

  const location = `${frame.url}:${frame.lineNumber + 1}:${
    frame.columnNumber + 1
  }`;
  return `${initiator?.type ?? "unknown"} ${location} ${
    frame.functionName ?? ""
  }`.trim();
}

function increment(map, key) {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function groupRequests(requests, initiatorsByKey, apiOnly) {
  const grouped = new Map();
  for (const request of requests) {
    if (!request.sameOrigin) continue;
    if (apiOnly && !request.path.startsWith("/api/")) continue;

    const key = `${request.method} ${request.path} [${request.resourceType}]`;
    let entry = grouped.get(key);
    if (!entry) {
      entry = {
        key,
        method: request.method,
        path: request.path,
        resourceType: request.resourceType,
        count: 0,
        firstMs: request.t,
        lastMs: request.t,
        statuses: new Map(),
        failures: new Map(),
        initiators: new Set(),
      };
      grouped.set(key, entry);
    }

    entry.count += 1;
    entry.firstMs = Math.min(entry.firstMs, request.t);
    entry.lastMs = Math.max(entry.lastMs, request.t);
    increment(entry.statuses, request.status ?? "pending/none");
    if (request.failure) {
      increment(entry.failures, request.failure);
    }

    const initiatorKey = `${request.method} ${request.path}`;
    for (const initiator of initiatorsByKey.get(initiatorKey) ?? []) {
      entry.initiators.add(initiator);
    }
  }

  return [...grouped.values()].sort(
    (a, b) => b.count - a.count || a.key.localeCompare(b.key),
  );
}

function serializeEntry(entry) {
  return {
    key: entry.key,
    count: entry.count,
    firstMs: entry.firstMs,
    lastMs: entry.lastMs,
    statuses: Object.fromEntries(entry.statuses),
    failures: Object.fromEntries(entry.failures),
    initiators: [...entry.initiators],
  };
}

function printTextSummary(summary) {
  console.log(`Request census for ${summary.url}`);
  console.log(`Title: ${summary.title || "(none)"}`);
  console.log(
    `Observed ${summary.waitMs} ms after DOMContentLoaded: ${summary.groupedRequestCount} grouped ${summary.apiOnly ? "API" : "same-origin"} keys, ${summary.duplicateCount} duplicate keys.`,
  );
  console.log("");

  if (summary.duplicates.length === 0) {
    console.log("No duplicate grouped request keys.");
  } else {
    console.log("Duplicates:");
    for (const entry of summary.duplicates) {
      const statuses = Object.entries(entry.statuses)
        .map(([status, count]) => `${status} x${count}`)
        .join(", ");
      console.log(
        `- ${entry.count}x ${entry.key} (${entry.firstMs}-${entry.lastMs} ms, ${statuses})`,
      );
      for (const initiator of entry.initiators.slice(0, 3)) {
        console.log(`  initiator: ${initiator}`);
      }
      if (entry.initiators.length > 3) {
        console.log(`  initiator: ... ${entry.initiators.length - 3} more`);
      }
    }
  }

  console.log("");
  console.log("All grouped requests:");
  for (const entry of summary.allGrouped) {
    const statuses = Object.entries(entry.statuses)
      .map(([status, count]) => `${status} x${count}`)
      .join(", ");
    console.log(
      `- ${entry.count}x ${entry.key} (${entry.firstMs}-${entry.lastMs} ms, ${statuses})`,
    );
  }

  if (summary.failures.length > 0) {
    console.log("");
    console.log("Request failures:");
    for (const failure of summary.failures) {
      console.log(`- ${failure.method} ${failure.path}: ${failure.failure}`);
    }
  }

  if (summary.consoleErrors.length > 0) {
    console.log("");
    console.log("Console errors:");
    for (const error of summary.consoleErrors) {
      console.log(`- ${error}`);
    }
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const origin = new URL(options.url).origin;
  const browser = await chromium.launch({
    chromiumSandbox: true,
    headless: options.headless,
  });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });

  const startedAt = Date.now();
  const requests = new Map();
  const failures = [];
  const consoleErrors = [];
  const initiatorsByKey = new Map();
  let sequence = 0;

  cdp.on("Network.requestWillBeSent", (event) => {
    const classified = classifyUrl(event.request.url, origin);
    if (!classified.sameOrigin) return;
    const key = `${event.request.method} ${classified.path}`;
    const list = initiatorsByKey.get(key) ?? [];
    list.push(initiatorTop(event.initiator));
    initiatorsByKey.set(key, list);
  });

  page.on("request", (request) => {
    const classified = classifyUrl(request.url(), origin);
    requests.set(request, {
      id: ++sequence,
      t: Date.now() - startedAt,
      method: request.method(),
      path: classified.path,
      sameOrigin: classified.sameOrigin,
      resourceType: request.resourceType(),
      status: null,
      failure: null,
    });
  });

  page.on("response", (response) => {
    const record = requests.get(response.request());
    if (record) {
      record.status = response.status();
    }
  });

  page.on("requestfailed", (request) => {
    const record = requests.get(request);
    const failure = request.failure()?.errorText ?? "unknown";
    if (record) {
      record.failure = failure;
    }
    const classified = classifyUrl(request.url(), origin);
    failures.push({
      t: Date.now() - startedAt,
      method: request.method(),
      path: classified.path,
      resourceType: request.resourceType(),
      failure,
    });
  });

  page.on("console", (message) => {
    if (message.type() === "error") {
      consoleErrors.push(message.text());
    }
  });

  try {
    await page.goto(options.url, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    await page.waitForTimeout(options.waitMs);

    const grouped = groupRequests(
      [...requests.values()],
      initiatorsByKey,
      options.apiOnly,
    );
    const allGrouped = grouped.map(serializeEntry);
    const duplicates = allGrouped.filter((entry) => entry.count > 1);
    const summary = {
      url: options.url,
      waitMs: options.waitMs,
      apiOnly: options.apiOnly,
      title: await page.title().catch(() => ""),
      totalRequests: requests.size,
      groupedRequestCount: allGrouped.length,
      duplicateCount: duplicates.length,
      duplicates,
      allGrouped,
      failures,
      consoleErrors,
    };

    if (options.json) {
      console.log(JSON.stringify(summary, null, 2));
    } else {
      printTextSummary(summary);
    }
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
