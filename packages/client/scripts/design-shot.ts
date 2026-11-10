// acli: 1 +commentary
/**
 * Capture design playground states through the repository's capture
 * presentation (artifact-capture's writeCapturePreview), so the images are
 * presented beside the call rather than only written to disk.
 *
 * By default it starts a private Vite dev server for this checkout on a free
 * loopback port and closes it afterwards; --url reuses a running one.
 */
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { chromium } from "@playwright/test";
import type { ViteDevServer } from "vite";
import { DESIGN_THEMES, type DesignTheme, toId } from "../design/specimen";
import {
  captureViewports,
  emitCapturePreview,
  writeCapturePreview,
} from "./artifact-capture";
import { clientRoot, loadDesignIndex } from "./design-index";
import { ensureColorEmojiFont } from "./emoji-font";

const help = `Usage: pnpm -s design:shot <specimen-or-state-id> [options]

Capture design playground states (design.html) in the system Chrome.

  <id>                   A specimen id (every state), a state id, or a title
                         such as "Census/Composer". List them: pnpm -s design:index
  --theme <name|all>     verydark, dark (default), light, or all
  --phone                Also capture each state at 375×812
  --grid                 Capture the grid page (the specimen's or state's
                         themes side by side) instead of isolated states
  --url <origin>         Use a running dev server (for example http://localhost:3400)
                         instead of starting a private one
  --out <directory>      New output directory; default .artifacts/design-shots/<id>-<unique>
  --timeout-ms <number>  Per-operation deadline, default 60000
  -h, --help             Show this help

State captures are full-page PNGs of the isolated state at 1000 px wide
(and 375 px with --phone). Page errors, console errors and failed requests
fail the capture. Stdout: one JSON result with image commentary.
Exit: 0 complete; 2 invalid arguments; 3 capture failure.
acli: 1 +commentary
`;

class UsageError extends Error {}

async function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const server = createNetServer();
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() =>
        typeof address === "object" && address
          ? done(address.port)
          : fail(new Error("No port")),
      );
    });
  });
}

async function startDevServer(): Promise<{
  origin: string;
  server: ViteDevServer;
}> {
  const { createServer } = await import("vite");
  const port = await freePort();
  const server = await createServer({
    configFile: join(clientRoot, "vite.config.ts"),
    root: clientRoot,
    // A private optimizer cache, so a running dev server's graph is untouched.
    cacheDir: join(clientRoot, "node_modules/.vite-design-shot"),
    logLevel: "error",
    server: { host: "127.0.0.1", port, strictPort: true, hmr: false },
  });
  await server.listen();
  return { origin: `http://127.0.0.1:${port}`, server };
}

interface Shot {
  name: string;
  hash: string;
  width: number;
  height: number;
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      theme: { type: "string", default: "dark" },
      phone: { type: "boolean", default: false },
      grid: { type: "boolean", default: false },
      url: { type: "string" },
      out: { type: "string" },
      "timeout-ms": { type: "string", default: "60000" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    process.stdout.write(help);
    return;
  }
  const [rawTarget] = positionals;
  if (!rawTarget || positionals.length > 1)
    throw new UsageError("Expected exactly one specimen or state id");
  const themes: readonly DesignTheme[] =
    values.theme === "all"
      ? DESIGN_THEMES
      : DESIGN_THEMES.filter((theme) => theme === values.theme);
  if (!themes.length)
    throw new UsageError(
      `Unknown theme ${values.theme}; use ${DESIGN_THEMES.join(", ")} or all`,
    );
  const timeout = Number(values["timeout-ms"]);
  if (!Number.isSafeInteger(timeout) || timeout <= 0)
    throw new UsageError("--timeout-ms must be a positive integer");

  const index = await loadDesignIndex();
  const target = rawTarget.includes("/") ? toId(rawTarget) : rawTarget;
  const specimen = index.specimens.find(
    (candidate) =>
      candidate.id === target ||
      candidate.states.some((state) => state.id === target),
  );
  if (!specimen)
    throw new UsageError(
      `No specimen or state "${rawTarget}"; run pnpm -s design:index`,
    );
  const states =
    specimen.id === target
      ? specimen.states
      : specimen.states.filter((state) => state.id === target);

  const desktop = captureViewports[0];
  const phone = captureViewports[1];
  const shots: Shot[] = values.grid
    ? [
        {
          name: "grid",
          hash: `#/${target}${themes.length === 1 ? `?theme=${themes[0]}` : ""}`,
          width: 1400,
          height: 900,
        },
      ]
    : states.flatMap((state) =>
        themes.flatMap((theme) => [
          {
            name: `${state.id}-${theme}`,
            hash: `#/${state.id}?iso&theme=${theme}`,
            width: desktop.width,
            height: desktop.height,
          },
          ...(values.phone
            ? [
                {
                  name: `${state.id}-${theme}-phone`,
                  hash: `#/${state.id}?iso&theme=${theme}`,
                  width: phone.width,
                  height: phone.height,
                },
              ]
            : []),
        ]),
      );

  const out = resolve(
    values.out ??
      join(
        clientRoot,
        "../../.artifacts/design-shots",
        `${target}-${randomUUID().slice(0, 8)}`,
      ),
  );
  await mkdir(join(out, ".."), { recursive: true });
  await mkdir(out);

  const emojiFont = await ensureColorEmojiFont();
  const warnings = new Set<string>();
  if (emojiFont.status === "unavailable") warnings.add(emojiFont.detail);
  const dev = values.url
    ? { origin: new URL(values.url).origin, server: undefined }
    : await startDevServer();
  // Pages here are this checkout's own source, but every Chromium launch in
  // the repository uses the system Chrome inside its sandbox.
  const browser = await chromium.launch({
    channel: "chrome",
    chromiumSandbox: true,
  });
  const screenshots = [];
  try {
    for (const shot of shots) {
      const context = await browser.newContext({
        viewport: { width: shot.width, height: shot.height },
        serviceWorkers: "block",
      });
      try {
        const page = await context.newPage();
        page.setDefaultTimeout(timeout);
        page.setDefaultNavigationTimeout(timeout);
        const problems = new Set<string>();
        page.on("pageerror", (error) => problems.add(error.message));
        page.on("requestfailed", (request) =>
          problems.add(`Request failed: ${new URL(request.url()).pathname}`),
        );
        page.on("response", (response) => {
          if (response.status() >= 400)
            problems.add(
              `HTTP ${response.status()}: ${new URL(response.url()).pathname}`,
            );
        });
        page.on("console", (message) => {
          if (message.type() === "error") problems.add(message.text());
          if (message.type() === "warning") warnings.add(message.text());
        });
        await page.goto(`${dev.origin}/design.html${shot.hash}`, {
          waitUntil: "networkidle",
        });
        await page
          .locator("[data-design-ready]")
          .first()
          .waitFor({ state: "visible" });
        await page.waitForFunction(
          () =>
            document.fonts.status === "loaded" &&
            !document.querySelector("[data-design-pending]"),
        );
        const path = join(out, `${shot.name}.png`);
        await page.screenshot({ path, fullPage: true, animations: "disabled" });
        if (problems.size)
          throw new Error(`${shot.name}: ${[...problems].join("; ")}`);
        const height = await page.evaluate(
          () => document.documentElement.scrollHeight,
        );
        screenshots.push({
          name: shot.name,
          width: shot.width,
          height: Math.max(shot.height, height),
          path,
        });
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
    await dev.server?.close();
  }
  const result = await writeCapturePreview({
    input: `${values.url ? dev.origin : "private dev server"}/design.html#/${target}`,
    out,
    delivery: {
      status: "skipped",
      reason:
        "Design playground captures come from a dev server; open design.html on the YA dev port to interact",
    },
    screenshots,
    warnings: [...warnings],
  });
  emitCapturePreview(result);
}

main().catch((error: unknown) => {
  const usage = error instanceof UsageError;
  process.stderr.write(
    `${JSON.stringify({ error: (error as Error).message, ...(usage ? { help: "pnpm -s design:shot --help" } : {}) })}\n`,
  );
  process.exitCode = usage ? 2 : 3;
});
