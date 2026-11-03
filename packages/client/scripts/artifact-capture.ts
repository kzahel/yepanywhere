import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "@playwright/test";
import type {
  ArtifactViewerGrant,
  ArtifactViewerStatus,
} from "../../shared/src/artifact-viewer";
import {
  serverHasCapability,
  SERVER_CAPABILITIES,
  type ServerCapabilitySource,
} from "../../shared/src/server-capabilities";
import { ensureColorEmojiFont } from "./emoji-font";

const serverRequire = createRequire(
  new URL("../../server/package.json", import.meta.url),
);
const { getMimeType } = serverRequire("hono/utils/mime") as {
  getMimeType(path: string): string | undefined;
};
const checkout = fileURLToPath(new URL("../../../", import.meta.url));
const localOrigin = "http://artifact-capture.invalid";
export const captureViewports = [
  { name: "desktop", width: 1000, height: 600 },
  { name: "phone", width: 375, height: 812 },
] as const;

export interface CaptureOptions {
  input: string;
  out?: string;
  yaUrl?: string;
  audience?: "local" | "public";
  /**
   * Local artifact origin the session already knows, from
   * `AGENT_ARTIFACT_VIEWER_ORIGIN`. Present means the user's YA has interactive
   * delivery configured, so the capability round trip is unnecessary. Absent
   * means ask the server as before.
   */
  artifactOrigin?: string;
  /** Let the grant delete the captured directory at expiry; default true. */
  ownArtifact?: boolean;
  yaHeaders?: Record<string, string>;
  readySelector?: string;
  timeoutMs?: number;
  allowNetwork?: boolean;
  commentary?: boolean;
  /** Trusted caller-owned workflow, run after navigation for each viewport. */
  interact?: (context: {
    page: Page;
    viewport: (typeof captureViewports)[number];
  }) => Promise<void>;
}

export type ArtifactDelivery =
  | { status: "skipped"; reason: string }
  | { status: "existing"; url: string; expiresAt: null }
  | ({ status: "created" } & ArtifactViewerGrant);

export interface CapturePreviewOptions {
  input: string;
  out: string;
  file?: string | null;
  delivery?: ArtifactDelivery;
  screenshots: readonly {
    name: string;
    width: number;
    height: number;
    path: string;
  }[];
  warnings?: readonly string[];
  commentary?: boolean;
}

/**
 * A browser notice about the headers YA serves artifacts with, rather than
 * anything the captured document did.
 *
 * The artifact origin sends `sandbox allow-scripts allow-same-origin
 * allow-downloads`, and Chromium warns about the first pair on every load.
 * Reporting it as a warning of the artifact would tell the author to fix a
 * page that is already correct, once per capture. Keeping the match to the
 * host's own policy leaves every warning the document earns — deprecations,
 * failed preloads, its own console output — where the author can see it.
 */
function isHostPolicyNotice(text: string): boolean {
  return text.includes("can escape its sandboxing");
}

function httpUrl(value: string): URL {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error("Expected an HTTP(S) URL without embedded credentials");
  return url;
}

async function apiJson<T>(
  options: CaptureOptions,
  path: string,
  body?: unknown,
): Promise<T> {
  const base = httpUrl(options.yaUrl!);
  if (base.pathname !== "/" || base.search || base.hash)
    throw new Error(
      "--ya-url must be a server origin, without a path, query, or fragment",
    );
  const response = await fetch(new URL(path, base), {
    method: body === undefined ? "GET" : "POST",
    headers: {
      ...options.yaHeaders,
      "X-Yep-Anywhere": "true",
      "Content-Type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    redirect: "error",
    signal: AbortSignal.timeout(options.timeoutMs ?? 30000),
  }).catch(() => {
    // Fetch errors can contain invalid authentication header values.
    throw new Error(
      `YA ${path}: request failed; check origin, headers, and timeout`,
    );
  });
  if (!response.ok) throw new Error(`YA ${path}: HTTP ${response.status}`);
  return response.json() as Promise<T>;
}

async function createDelivery(
  options: CaptureOptions,
  path: string,
): Promise<ArtifactDelivery> {
  if (!options.yaUrl)
    return {
      status: "skipped",
      reason: "Local capture; no YA server selected",
    };
  const audience = options.audience ?? "local";
  // The session marker already answers "is interactive delivery configured",
  // so trust it for the local audience and skip the round trip.
  let value = audience === "local" ? options.artifactOrigin?.trim() : undefined;
  if (!value) {
    const version = await apiJson<
      ServerCapabilitySource & { artifactViewer?: ArtifactViewerStatus }
    >(options, "/api/version");
    const config = version.artifactViewer;
    if (!serverHasCapability(version, SERVER_CAPABILITIES.artifactViewer.name))
      return {
        status: "skipped",
        reason: "Server does not advertise interactive artifact delivery",
      };
    value = audience === "local" ? config?.localOrigin : config?.publicOrigin;
    if (!config?.available || !value)
      return {
        status: "skipped",
        reason: `${audience} artifact origin is disabled or unconfigured`,
      };
  }
  const origin = httpUrl(value);
  // A misconfigured artifact origin costs the interactive link, never the
  // captures: report the reason and let the caller keep its images.
  if (
    origin.origin !== value ||
    origin.hostname === httpUrl(options.yaUrl).hostname
  )
    return {
      status: "skipped",
      reason: "Artifact configuration does not name an isolated origin",
    };
  // Whether the origin resolves is not this tool's question. A browser maps
  // `*.localhost` to loopback itself (RFC 6761) with no hosts file and no
  // flag, which is why the configured default is spelled that way. Enabled or
  // not is the whole decision, and the grant request below is the authority on
  // it: a viewer that is off or has since been disabled refuses the grant.
  const grant = await apiJson<ArtifactViewerGrant>(options, "/api/artifacts", {
    path,
    audience,
    // This command wrote the directory it is publishing, so it can be the one
    // to clean it up; the server still refuses ownership it considers unsafe.
    owned: options.ownArtifact !== false,
  }).catch((error: unknown) => (error as Error).message);
  if (typeof grant === "string")
    return { status: "skipped", reason: `Artifact grant refused: ${grant}` };
  if (
    httpUrl(grant.url).origin !== origin.origin ||
    !/^\/a\/[A-Za-z0-9_-]+\/.+/.test(new URL(grant.url).pathname) ||
    typeof grant.id !== "string" ||
    !Number.isFinite(grant.expiresAt) ||
    grant.expiresAt <= Date.now()
  )
    throw new Error("Server returned an invalid artifact grant");
  return {
    status: "created",
    id: grant.id,
    url: httpUrl(grant.url).href,
    expiresAt: grant.expiresAt,
    ...(grant.reused ? { reused: true } : {}),
  };
}

export function markdownLink(label: string, target: string): string {
  const destination = target
    .replaceAll("\\", "/")
    .replaceAll("%", "%25")
    .replaceAll("#", "%23")
    .replaceAll("?", "%3F")
    .replaceAll("|", "%7C")
    .replaceAll("<", "%3C")
    .replaceAll(">", "%3E")
    .replaceAll("\n", "%0A")
    .replaceAll("\r", "%0D");
  return `[${label}](<${destination}>)`;
}

/** Capture an existing document; this never builds it or starts/restarts YA. */
export async function captureArtifact(options: CaptureOptions) {
  const isUrl = /^https?:\/\//i.test(options.input);
  const file = isUrl ? null : await realpath(resolve(options.input));
  if (
    file &&
    (![".html", ".htm"].includes(extname(file).toLowerCase()) ||
      !(await stat(file)).isFile())
  )
    throw new Error("Local input must be an existing HTML entry file");
  const root = file ? dirname(file) : null;
  const output = resolve(
    options.out ?? join(checkout, ".artifacts", "captures", randomUUID()),
  );
  await mkdir(dirname(output), { recursive: true });
  // Each capture owns a new directory; existing output is never overwritten.
  await mkdir(output);
  // Before the browser starts, so emoji in the page render as themselves.
  const emojiFont = await ensureColorEmojiFont();
  // Agent-authored pages are untrusted, so they render in the system's
  // auto-updated Chrome rather than Playwright's pinned build, which lags
  // Chrome security fixes, and inside Chrome's sandbox.
  const browser = await chromium.launch({
    channel: "chrome",
    chromiumSandbox: true,
  });
  const screenshots: {
    name: string;
    width: number;
    height: number;
    path: string;
  }[] = [];
  let delivery: ArtifactDelivery = { status: "skipped", reason: "Not started" };
  const warnings = new Set<string>();
  if (emojiFont.status === "unavailable") warnings.add(emojiFont.detail);
  try {
    delivery = isUrl
      ? {
          status: "existing",
          url: httpUrl(options.input).href,
          expiresAt: null,
        }
      : await createDelivery(options, file!);
    const url =
      delivery.status === "skipped"
        ? `${localOrigin}/${encodeURIComponent(basename(file!))}`
        : delivery.url;
    const origin = new URL(url).origin;
    for (const viewport of captureViewports) {
      const problems = new Set<string>();
      const context = await browser.newContext({
        viewport,
        serviceWorkers: "block",
      });
      try {
        await context.route("**/*", async (route) => {
          const request = route.request();
          const requested = new URL(request.url());
          if (!options.allowNetwork && requested.origin !== origin) {
            problems.add(
              `Blocked external request: ${requested.origin}${requested.pathname}`,
            );
            await route.abort("blockedbyclient");
            return;
          }
          if (
            delivery.status !== "skipped" ||
            requested.origin !== localOrigin
          ) {
            await route.continue();
            return;
          }
          try {
            if (!["GET", "HEAD"].includes(request.method()))
              throw new Error("Only static GET/HEAD requests are supported");
            const target = await realpath(
              resolve(root!, `.${decodeURIComponent(requested.pathname)}`),
            );
            const child = relative(root!, target);
            if (
              child === ".." ||
              child.startsWith(`..${sep}`) ||
              isAbsolute(child)
            )
              throw new Error("File is outside the HTML entry directory");
            const info = await stat(target);
            if (!info.isFile() || info.size > 64 * 1024 * 1024)
              throw new Error("Expected a static file no larger than 64 MiB");
            await route.fulfill({
              status: 200,
              contentType: getMimeType(target) ?? "application/octet-stream",
              body:
                request.method() === "HEAD"
                  ? undefined
                  : await readFile(target),
              headers: {
                "Cache-Control": "no-store",
                "Referrer-Policy": "no-referrer",
              },
            });
          } catch (error) {
            problems.add(
              `Cannot load ${requested.pathname}: ${(error as Error).message}`,
            );
            await route.fulfill({
              status: 404,
              body: "Artifact file unavailable",
            });
          }
        });
        const page = await context.newPage();
        page.setDefaultTimeout(options.timeoutMs ?? 30000);
        page.setDefaultNavigationTimeout(options.timeoutMs ?? 30000);
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
          if (
            message.type() === "warning" &&
            !isHostPolicyNotice(message.text())
          )
            warnings.add(message.text());
          if (message.type() === "error") problems.add(message.text());
        });
        await page.goto(url, {
          waitUntil: options.interact ? "domcontentloaded" : "networkidle",
        });
        await options.interact?.({ page, viewport });
        if (options.readySelector)
          await page
            .locator(options.readySelector)
            .waitFor({ state: "visible" });
        await page.waitForFunction(() => document.fonts.status === "loaded");
        const path = join(output, `${viewport.name}.png`);
        await page.screenshot({ path, animations: "disabled" });
        if (problems.size)
          throw new Error(`${viewport.name}: ${[...problems].join("; ")}`);
        screenshots.push({ ...viewport, path });
      } finally {
        await context.close();
      }
    }
    return await writeCapturePreview({
      out: output,
      input: file ?? url,
      file,
      delivery,
      screenshots,
      warnings: [...warnings],
      commentary: options.commentary,
    });
  } catch (error) {
    // A reused grant belongs to whoever else holds it, not to this capture.
    if (delivery.status === "created" && !delivery.reused) {
      const response = await fetch(
        new URL(
          `/api/artifacts/${encodeURIComponent(delivery.id)}`,
          options.yaUrl,
        ),
        {
          method: "DELETE",
          headers: { ...options.yaHeaders, "X-Yep-Anywhere": "true" },
          redirect: "error",
          signal: AbortSignal.timeout(2500),
        },
      );
      if (!response.ok)
        throw new Error(
          `Capture failed and grant revocation returned HTTP ${response.status}`,
          { cause: error },
        );
    }
    throw error;
  } finally {
    await browser.close();
  }
}

/** Package existing PNGs without navigating, recapturing, or closing their browser. */
export async function writeCapturePreview(options: CapturePreviewOptions) {
  if (!options.screenshots.length)
    throw new Error("At least one screenshot is required");
  const names = new Set<string>();
  const screenshots = [];
  for (const screenshot of options.screenshots) {
    if (!screenshot.name || names.has(screenshot.name))
      throw new Error("Screenshot names must be nonempty and unique");
    names.add(screenshot.name);
    if (
      ![screenshot.width, screenshot.height].every(
        (size) => Number.isSafeInteger(size) && size > 0,
      )
    )
      throw new Error("Screenshot dimensions must be positive integers");
    const path = await realpath(resolve(screenshot.path));
    const info = await stat(path);
    if (!info.isFile() || info.size === 0)
      throw new Error("Screenshot must be a nonempty file");
    screenshots.push({ ...screenshot, path });
  }
  const delivery: ArtifactDelivery = options.delivery ?? {
    status: "skipped",
    reason: "Existing browser captures; interactive delivery not requested",
  };
  const file = options.file ? await realpath(resolve(options.file)) : null;
  const warnings = [...(options.warnings ?? [])];
  const lines = [
    ...(file ? [`Open in YA: ${markdownLink("File viewer", file)}`] : []),
    ...(delivery.status !== "skipped"
      ? [
          `Interactive: [Artifact](<${delivery.url}>) — ${delivery.expiresAt === null ? "expiry unknown (existing URL)" : `expires ${new Date(delivery.expiresAt).toISOString()}`}`,
        ]
      : [`Interactive: unavailable — ${delivery.reason}`]),
    `Captures: ${screenshots.map((item) => markdownLink(`${item.name} ${item.width}×${item.height}`, item.path)).join(" · ")}`,
    // A blockquote so the reader sees a warning as one, rather than as another
    // line of the capture's ordinary report.
    ...(warnings.length
      ? [
          `> **Browser warnings**\n>\n${warnings.map((warning) => `> - ${warning}`).join("\n")}`,
        ]
      : []),
  ];
  const result = {
    kind: "artifact-capture",
    capturedAt: new Date().toISOString(),
    input: options.input,
    delivery,
    screenshots,
    warnings,
    markdown: lines.join("\n\n"),
    ...(options.commentary === false
      ? {}
      : {
          _acli: {
            commentary: [
              { text: lines.join("\n\n") },
              {
                text: [
                  `| ${screenshots.map((item) => `${item.name} ${item.width}×${item.height}`).join(" | ")} |`,
                  `| ${screenshots.map(() => "---").join(" | ")} |`,
                  `| ${screenshots.map((item) => `!${markdownLink(item.name, item.path)}`).join(" | ")} |`,
                ].join("\n"),
              },
            ],
          },
        }),
  };
  const output = resolve(options.out);
  await mkdir(output, { recursive: true });
  await writeFile(
    join(output, "capture.json"),
    `${JSON.stringify(result, null, 2)}\n`,
    { flag: "wx" },
  );
  await writeFile(join(output, "links.md"), `${result.markdown}\n`, {
    flag: "wx",
  });
  return result;
}

/** Emit the same YA preview presentation from a caller-owned browser workflow. */
export function emitCapturePreview(
  result: Awaited<ReturnType<typeof writeCapturePreview>>,
) {
  if (!process.env.ACLI_QUIET) process.stderr.write("# acli: 1 +commentary\n");
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
