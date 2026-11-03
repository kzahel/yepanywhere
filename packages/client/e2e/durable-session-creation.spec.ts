import { createHash } from "node:crypto";
import { createServer } from "node:http";
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  unlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { resolveClaudeSdkNativeExecutable } from "../../server/src/sdk/providers/claude.js";
import { DiscoverySqliteService } from "../../server/src/storage/discovery-sqlite.js";
import { SessionMetadataService } from "../../server/src/metadata/SessionMetadataService.js";
import { InstallService } from "../../server/src/services/InstallService.js";
import { toUrlProjectId } from "../../shared/src/index.js";
import { createTestViteServer } from "./support/vite-server.js";
import {
  startYaServerProcess,
  restartYaServerProcess,
  disposeYaServerProcess,
} from "./support/ya-server-process.js";
import { presentUiCaptures, recordUiCapture } from "./support/ui-capture.js";

const prompt = "OWNED_BROWSER_CREATION";
const reply = "OWNED_CREATION_REPLY";
const poolId = "11111111-1111-4111-8111-111111111111";
const nativeCli = resolveClaudeSdkNativeExecutable();
// Own server/Vite/native CLI startup, two reloads and teardown. Each existing
// server startup has a 30s bound; this whole-flow budget includes those owners.
test.setTimeout(90_000);
test.skip(
  !nativeCli || process.platform === "win32",
  "Requires the pinned native Claude CLI and a private Unix router socket",
);
test.afterAll(() => presentUiCaptures());

async function fixture(
  missingExecutable: boolean,
  savedSessions = 0,
  routerUnavailable = false,
) {
  let server: Awaited<ReturnType<typeof startYaServerProcess>> | undefined;
  let vite: Awaited<ReturnType<typeof createTestViteServer>> | undefined;
  let router: ReturnType<typeof createServer> | undefined;
  let routerRoot = "",
    projectId = "",
    ownedCli = "";
  let release: (() => void) | undefined;
  const modelRequests: { path: string; credential?: string }[] = [];
  const routerRequests: { path: string; body: Record<string, unknown> }[] = [];
  const model = createServer(async (req, res) => {
    for await (const _chunk of req) {
      /* Consume the real SDK request. */
    }
    if (req.url?.includes("/messages/count_tokens")) {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ input_tokens: 100 }));
      return;
    }
    if (req.url?.includes("/messages")) {
      modelRequests.push({
        path: req.url,
        credential: String(
          req.headers["x-api-key"] ??
            req.headers.authorization?.replace(/^Bearer /, "") ??
            "",
        ),
      });
      await new Promise<void>((resolveReply) => {
        release = resolveReply;
      });
      if (res.destroyed) return;
      res.setHeader("Content-Type", "text/event-stream");
      const event = (type: string, fields: Record<string, unknown>) =>
        res.write(
          `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`,
        );
      event("message_start", {
        message: {
          id: "msg_owned_creation",
          type: "message",
          role: "assistant",
          content: [],
          model: "claude-sonnet-4-6",
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 100, output_tokens: 0 },
        },
      });
      event("content_block_start", {
        index: 0,
        content_block: { type: "text", text: "" },
      });
      event("content_block_delta", {
        index: 0,
        delta: { type: "text_delta", text: reply },
      });
      event("content_block_stop", { index: 0 });
      event("message_delta", {
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 3 },
      });
      event("message_stop", {});
      res.end();
      return;
    }
    res.setHeader("Content-Type", "application/json");
    res.end("{}");
  });
  const close = async () => {
    release?.();
    await vite?.close();
    if (server) await disposeYaServerProcess(server);
    for (const listener of [router, model]) {
      if (!listener) continue;
      listener.closeAllConnections();
      await new Promise<void>((done) => listener.close(() => done()));
    }
    if (routerRoot) await rm(routerRoot, { recursive: true, force: true });
  };
  await new Promise<void>((done) => model.listen(0, "127.0.0.1", done));
  const address = model.address();
  if (!address || typeof address === "string")
    throw new Error("Missing owned model listener");
  const env: NodeJS.ProcessEnv = {
    USE_MOCK_SDK: "false",
    ENABLED_PROVIDERS: "claude",
    ANTHROPIC_API_KEY: "owned-fixture-only",
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    DISABLE_TELEMETRY: "1",
    DISABLE_ERROR_REPORTING: "1",
  };
  // Router authorization is independent of a direct-provider login/API key.
  if (!missingExecutable && !routerUnavailable) delete env.ANTHROPIC_API_KEY;
  try {
    server = await startYaServerProcess({
      label: "durable Claude creation",
      standalone: {},
      env,
      async setupProfile(paths) {
        const project = join(paths.profileDir, "project");
        await mkdir(project);
        projectId = toUrlProjectId(await realpath(project));
        if (savedSessions) {
          const storage = new DiscoverySqliteService({
            dataDir: paths.dataDir,
            probeNetworkFilesystem: () => undefined,
          });
          const metadata = new SessionMetadataService({
            dataDir: paths.dataDir,
            database: storage.getDatabase(),
          });
          try {
            await metadata.initialize();
            for (let index = 0; index < savedSessions; index++) {
              const saved = metadata.creations.admit({
                requestId: `owned-seed-${index}`,
                context: {
                  owner: { kind: "superuser" },
                  source: { kind: "request", provenance: { surface: "web" } },
                },
                request: {
                  projectId: toUrlProjectId(await realpath(project)),
                  projectPath: await realpath(project),
                  provider: "claude",
                  message: `Owned saved session ${index}`,
                  settings: {
                    permissionMode: "default",
                    requestedModel: "sonnet",
                    thinking: null,
                    effort: null,
                    serviceTier: null,
                  },
                  launch: { schemaVersion: 1 },
                },
              });
              metadata.creations.failBeforeEffects(
                saved.attempt,
                "startup-unavailable",
              );
            }
          } finally {
            storage.close();
          }
        }
        if (missingExecutable) {
          ownedCli = join(paths.profileDir, "owned-claude-cli");
          await symlink(nativeCli!, ownedCli);
          env.CLAUDE_CODE_EXECUTABLE = ownedCli;
        }
        const install = new InstallService({ dataDir: paths.dataDir });
        await install.initialize();
        await install.recordSuccessfulProviders(["claude"]);
      },
    });
    const request = async (path: string, body?: unknown, method = "POST") => {
      const response = await fetch(`${server!.baseUrl}/api${path}`, {
        method: body === undefined ? "GET" : method,
        headers: {
          "Content-Type": "application/json",
          "X-Yep-Anywhere": "true",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      expect(response.status, await response.clone().text()).toBe(
        body !== undefined && path.endsWith("/session-creations") ? 202 : 200,
      );
      return response.json();
    };
    if (!missingExecutable) {
      routerRoot = await mkdtemp(join(tmpdir(), "ya-owned-router-"));
      const socket = join(routerRoot, "control.sock");
      const models = [{ id: "sonnet", name: "Sonnet", supportsEffort: true }];
      const account = {
        id: "owned-account",
        displayName: "Owned account",
        provider: "claude",
        enabled: true,
        renewal: "manual",
        freshness: "fresh",
        models,
        catalogAt: new Date().toISOString(),
        attemptedAt: null,
        error: null,
        quota: null,
        windows: [],
      };
      router = createServer(async (req, res) => {
        let raw = "";
        for await (const chunk of req) raw += chunk;
        const body = JSON.parse(raw || "{}");
        routerRequests.push({ path: req.url!, body });
        if (routerUnavailable && req.url === "/v1/pools/prepare") {
          res.writeHead(503, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Owned router unavailable" }));
          return;
        }
        res.setHeader("Content-Type", "application/json");
        let response: unknown = {};
        if (req.url === "/v1/info")
          response = {
            protocol: 1,
            routerId: "owned-router",
            inferenceOrigin: `http://127.0.0.1:${address.port}`,
            capabilities: ["manual-bindings", "pools-v1"],
          };
        else if (
          ["/v1/selection", "/v1/overview", "/v1/overview/refresh"].includes(
            req.url!,
          )
        )
          response = {
            observedAt: new Date().toISOString(),
            quotaFreshSeconds: 120,
            pools: [
              {
                id: poolId,
                name: "Owned pool",
                provider: "claude",
                accountIds: [account.id],
                policy: "manual",
                revision: 1,
                bindings: [],
              },
            ],
            accounts: [account],
          };
        else if (req.url === "/v1/accounts") response = { accounts: [account] };
        else if (req.url === "/v1/catalog") response = { models };
        else if (req.url === "/v1/pools/prepare")
          response = { accountId: account.id };
        res.end(JSON.stringify(response));
      });
      await new Promise<void>((done) => router!.listen(socket, done));
      await chmod(socket, 0o600);
      await request("/agent-auth-router/connect", { socketPath: socket });
      await request(
        "/settings",
        {
          newSessionDefaults: {
            provider: "claude",
            providers: {
              claude: {
                model: "sonnet",
                routerAccountId: account.id,
                routerPoolId: poolId,
                thinkingMode: "off",
              },
            },
            recapMode: "off",
            promptSuggestionMode: "off",
          },
        },
        "PUT",
      );
    }
    vite = await createTestViteServer({
      configFile: resolve("vite.config.ts"),
      root: process.cwd(),
      server: {
        host: "127.0.0.1",
        hmr: false,
        proxy: {
          "/api": { target: server.baseUrl, ws: true },
          "/ws": { target: server.baseUrl, ws: true },
        },
      },
    });
    await vite.listen();
    const viteAddress = vite.httpServer!.address();
    if (!viteAddress || typeof viteAddress === "string")
      throw new Error("Missing owned Vite listener");
    return {
      origin: `http://127.0.0.1:${viteAddress.port}`,
      projectId,
      ownedCli,
      request,
      modelRequests,
      routerRequests,
      close,
      releaseReply: () => release?.(),
      async restart() {
        server = await restartYaServerProcess(server!);
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}

test("routed Claude accepts before startup and retains one session and native turn through browser reload", async ({
  browser,
}) => {
  const owned = await fixture(false);
  const context = await browser.newContext({
    serviceWorkers: "block",
    viewport: { width: 1000, height: 600 },
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.goto(
      `${owned.origin}/new-session?projectId=${owned.projectId}&provider=claude&model=sonnet`,
    );
    const composer = page.locator("textarea.new-session-form-textarea");
    await composer.waitFor();
    await composer.pressSequentially(prompt);
    const responsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname.endsWith("/session-creations"),
    );
    await page
      .getByRole("button", { name: "Start session", exact: true })
      .click();
    const response = await responsePromise;
    expect(response.status()).toBe(202);
    expect(response.request().postDataJSON().routerAccountId).toBe(
      "owned-account",
    );
    const receipt = await response.json();
    await expect(page).toHaveURL(new RegExp(`/sessions/${receipt.sessionId}$`));
    await expect(
      page.getByRole("region", { name: "Session startup" }),
    ).toBeVisible();
    await page.reload();
    await expect(
      page.getByRole("region", { name: "Session startup" }),
    ).toBeVisible();
    await expect.poll(() => owned.modelRequests.length).toBe(1);
    const [prepare] = owned.routerRequests.filter(
      (request) => request.path === "/v1/pools/prepare",
    );
    expect(prepare?.body.accountId).toBe("owned-account");
    expect(owned.modelRequests[0]?.path).toMatch(/^\/claude\//);
    expect(
      createHash("sha256")
        .update(owned.modelRequests[0]!.credential!)
        .digest("hex"),
    ).toBe(prepare!.body.tokenHash);
    owned.releaseReply();
    await expect(page.getByText(reply, { exact: true }).first()).toBeVisible();
    await page.reload();
    await expect(page.getByText(reply, { exact: true }).first()).toBeVisible();
    expect(owned.modelRequests).toHaveLength(1);
    const detail = await owned.request(
      `/projects/${receipt.projectId}/sessions/${receipt.sessionId}`,
    );
    expect(detail.session.id).toBe(receipt.sessionId);
    expect(detail.session.creation.delivery).toBe("consumed");
    expect(detail.session.routerBinding.accountId).toBe("owned-account");
    expect(errors).toEqual([]);
  } finally {
    await context.close();
    await owned.close();
  }
});

test("a disappeared executable leaves a saved failed session and prompt after page and server restart", async ({
  browser,
}) => {
  const owned = await fixture(true);
  const context = await browser.newContext({
    serviceWorkers: "block",
    viewport: { width: 1000, height: 600 },
  });
  const page = await context.newPage();
  try {
    await page.goto(
      `${owned.origin}/new-session?projectId=${owned.projectId}&provider=claude&model=sonnet`,
    );
    const composer = page.locator("textarea.new-session-form-textarea");
    await composer.waitFor();
    await composer.pressSequentially(prompt);
    await unlink(owned.ownedCli);
    await page
      .getByRole("button", { name: "Start session", exact: true })
      .click();
    const failure = page.getByText(
      "The session could not start. Your prompt is saved.",
      { exact: true },
    );
    await expect(failure).toBeVisible();
    const sessionUrl = page.url();
    await page.getByText("Saved prompt", { exact: true }).click();
    await expect(page.getByText(prompt, { exact: true }).first()).toBeVisible();
    await recordUiCapture(page, "claude-creation-failed-desktop");
    await page.setViewportSize({ width: 375, height: 812 });
    await recordUiCapture(page, "claude-creation-failed-phone");
    await page.reload();
    await expect(failure).toBeVisible();
    await owned.restart();
    await page.reload();
    await expect(failure).toBeVisible();
    expect(page.url()).toBe(sessionUrl);
    expect(owned.modelRequests).toHaveLength(0);
  } finally {
    await context.close();
    await owned.close();
  }
});

test("retiring the form before acceptance preserves recovery and never creates the submitted prompt twice", async ({
  browser,
}) => {
  const owned = await fixture(false);
  const context = await browser.newContext({
    serviceWorkers: "block",
    viewport: { width: 1000, height: 600 },
  });
  const page = await context.newPage();
  let releaseAcceptance!: () => void;
  const barrier = new Promise<void>((done) => {
    releaseAcceptance = done;
  });
  let saved!: () => void;
  const savedAtServer = new Promise<void>((done) => {
    saved = done;
  });
  let receipt: { sessionId: string; projectId: string } | undefined;
  try {
    await page.goto(
      `${owned.origin}/new-session?projectId=${owned.projectId}&provider=claude&model=sonnet`,
    );
    const composer = page.locator("textarea.new-session-form-textarea");
    await composer.waitFor();
    await composer.pressSequentially(prompt);
    await page.route("**/api/projects/*/session-creations", async (route) => {
      const response = await route.fetch();
      receipt = await response.json();
      saved();
      await barrier;
      await route.fulfill({ response });
    });
    await page
      .getByRole("button", { name: "Start session", exact: true })
      .click();
    await savedAtServer;
    // A real SPA route retirement keeps the pending fetch/JS realm alive.
    await page.evaluate(() => {
      history.pushState(null, "", "/projects");
      dispatchEvent(new PopStateEvent("popstate"));
    });
    await expect(composer).toHaveCount(0);
    releaseAcceptance();
    await expect
      .poll(() =>
        page.evaluate(() =>
          Object.keys(localStorage)
            .filter((key) => key.startsWith("ya-text-creation:"))
            .some(
              (key) => !!JSON.parse(localStorage.getItem(key) ?? "{}").receipt,
            ),
        ),
      )
      .toBe(true);
    await expect.poll(() => owned.modelRequests.length).toBe(1);
    owned.releaseReply();
    await expect
      .poll(
        async () =>
          (
            await owned.request(
              `/projects/${receipt!.projectId}/sessions/${receipt!.sessionId}`,
            )
          ).session.creation.delivery,
      )
      .toBe("consumed");
    await page.goto(
      `${owned.origin}/new-session?projectId=${owned.projectId}&provider=claude&model=sonnet`,
    );
    await expect(composer).toHaveValue(prompt);
    await expect(
      page.getByText(
        "A session was saved while you were away. Check it before submitting again.",
        { exact: true },
      ),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Check saved session", exact: true })
      .click();
    await expect(page).toHaveURL(
      new RegExp(`/sessions/${receipt!.sessionId}$`),
    );
    await expect(page.getByText(reply, { exact: true }).first()).toBeVisible();
    await page.goto(
      `${owned.origin}/new-session?projectId=${owned.projectId}&provider=claude&model=sonnet`,
    );
    await expect(composer).toHaveValue("");
    expect(owned.modelRequests).toHaveLength(1);
  } finally {
    releaseAcceptance?.();
    await context.close();
    await owned.close();
  }
});

test("background typing during delayed acceptance stays responsive with 200 saved sessions and preserves the newer draft", async ({
  browser,
}) => {
  const owned = await fixture(false, 200);
  const context = await browser.newContext({ serviceWorkers: "block" });
  const page = await context.newPage();
  let release!: () => void, saved!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const admitted = new Promise<void>((resolve) => {
    saved = resolve;
  });
  let receipt!: { sessionId: string; projectId: string };
  try {
    const formUrl = `${owned.origin}/new-session?projectId=${owned.projectId}&provider=claude&model=sonnet`;
    await page.addInitScript(() =>
      localStorage.setItem("yep-anywhere-background-session-creation", "true"),
    );
    await page.goto(formUrl);
    const composer = page.locator("textarea.new-session-form-textarea");
    await composer.pressSequentially(prompt);
    await page.route("**/api/projects/*/session-creations", async (route) => {
      const response = await route.fetch();
      receipt = await response.json();
      saved();
      await barrier;
      await route.fulfill({ response });
    });
    await composer.press("Meta+Enter");
    await admitted;
    await expect.poll(() => owned.modelRequests.length).toBe(1);
    await expect(composer).toBeEnabled();
    // Include input dispatch delay using the browser event timestamp. The
    // second animation frame follows the first frame's rendering/paint.
    await composer.evaluate((element) => {
      const input = element as HTMLTextAreaElement & {
        acks: { latency: number; value: string; eventAt: number }[];
      };
      input.acks = [];
      input.addEventListener("keydown", (event) => {
        requestAnimationFrame(() =>
          requestAnimationFrame(() =>
            input.acks.push({
              eventAt: event.timeStamp,
              latency: performance.now() - event.timeStamp,
              value: input.value,
            }),
          ),
        );
      });
    });
    let typed = prompt;
    let acceptedAt = 0;
    for (const [index, character] of [..." newer draft"].entries()) {
      // First establish newer work, then deliver acceptance while keys continue.
      if (index === 3) release();
      await Promise.all([
        composer.pressSequentially(character),
        owned.request(
          `/sessions/${receipt.sessionId}/metadata`,
          { title: `Owned concurrent title ${typed.length}` },
          "PUT",
        ),
      ]);
      typed += character;
      await expect(composer).toHaveValue(typed);
      if (index === 4) {
        await expect(
          page.getByRole("button", { name: "Open saved session", exact: true }),
        ).toBeVisible();
        acceptedAt = await composer.evaluate(() => performance.now());
      }
      await expect
        .poll(() =>
          composer.evaluate(
            (element) =>
              (
                element as HTMLTextAreaElement & { acks: { value: string }[] }
              ).acks.at(-1)?.value,
          ),
        )
        .toBe(typed);
    }
    const acks = await composer.evaluate(
      (element) =>
        (
          element as HTMLTextAreaElement & {
            acks: { latency: number; value: string; eventAt: number }[];
          }
        ).acks,
    );
    expect(acks).toHaveLength(" newer draft".length);
    expect(Math.max(...acks.map((ack) => ack.latency))).toBeLessThanOrEqual(
      100,
    );
    expect(acks[0]!.eventAt).toBeLessThan(acceptedAt);
    expect(acceptedAt).toBeLessThan(acks.at(-1)!.eventAt);
    release();
    await expect(
      page.getByRole("button", { name: "Open saved session", exact: true }),
    ).toBeVisible();
    await expect(composer).toHaveValue(typed);
    expect(page.url()).toBe(formUrl);
    await page
      .getByRole("button", { name: "Open saved session", exact: true })
      .click();
    await expect(page).toHaveURL(new RegExp(`/sessions/${receipt.sessionId}$`));
    owned.releaseReply();
    await expect(page.getByText(reply, { exact: true }).first()).toBeVisible();
    await page.goto(formUrl);
    await expect(composer).toHaveValue(typed);
    expect(owned.modelRequests).toHaveLength(1);
  } finally {
    release?.();
    await context.close();
    await owned.close();
  }
});

test("router refusal preserves saved intent and never falls back to available direct credentials", async ({
  browser,
}) => {
  const owned = await fixture(false, 0, true);
  const context = await browser.newContext({ serviceWorkers: "block" });
  const page = await context.newPage();
  try {
    await page.goto(
      `${owned.origin}/new-session?projectId=${owned.projectId}&provider=claude&model=sonnet`,
    );
    await page
      .locator("textarea.new-session-form-textarea")
      .pressSequentially(prompt);
    const accepted = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname.endsWith("/session-creations"),
    );
    await page
      .getByRole("button", { name: "Start session", exact: true })
      .click();
    const response = await accepted;
    expect(response.status()).toBe(202);
    expect(response.request().postDataJSON().routerAccountId).toBe(
      "owned-account",
    );
    const receipt = await response.json();
    const path = `/projects/${receipt.projectId}/sessions/${receipt.sessionId}`;
    await expect(page).toHaveURL(new RegExp(`/sessions/${receipt.sessionId}$`));
    await expect
      .poll(async () =>
        ["failed", "uncertain"].includes(
          (await owned.request(path)).session.creation.state,
        ),
      )
      .toBe(true);
    const detail = await owned.request(path);
    expect(detail.session.initialPrompt).toBe(prompt);
    expect(detail.session.creation.delivery).not.toBe("consumed");
    await page.reload();
    await expect(
      page.getByRole("region", { name: "Session startup" }),
    ).toBeVisible();
    expect(owned.modelRequests).toHaveLength(0);
    expect(
      owned.routerRequests.filter(
        (request) => request.path === "/v1/pools/prepare",
      ),
    ).toHaveLength(1);
  } finally {
    await context.close();
    await owned.close();
  }
});

test("explicit Claude preparation sends no phantom prompt and accepts the first turn under its saved YA id", async ({
  browser,
}) => {
  const owned = await fixture(false);
  const context = await browser.newContext({ serviceWorkers: "block" });
  try {
    const prepared = await owned.request(
      `/projects/${owned.projectId}/session-creations`,
      {
        requestId: crypto.randomUUID(),
        message: "",
        intent: "prepare",
        provider: "claude",
        model: "sonnet",
        mode: "bypassPermissions",
        thinking: "off",
        routerAccountId: "owned-account",
        routerPoolId: poolId,
        recapMode: "off",
        promptSuggestionMode: "off",
      },
    );
    expect(prepared.creation.initialInputExpected).toBe(false);
    await expect
      .poll(async () => ({
        state: (await owned.request(`/sessions/${prepared.sessionId}/process`))
          .process?.state,
        creation: (
          await owned.request(`/session-creations/${prepared.requestId}`)
        ).creation,
      }))
      .toMatchObject({ state: "idle" });
    const path = `/projects/${owned.projectId}/sessions/${prepared.sessionId}`;
    expect(
      (await owned.request(path)).session.creation.initialInputExpected,
    ).toBe(false);
    expect(owned.modelRequests).toHaveLength(0);
    const page = await context.newPage();
    await page.goto(owned.origin + path);
    const composer = page.locator("textarea[data-composer-input]").first();
    await expect(composer).toBeEditable();
    let input = "";
    for (const c of "OWNED_CLAUDE_PREPARED_TURN") {
      await composer.pressSequentially(c);
      input += c;
      await expect(composer).toHaveValue(input, { timeout: 100 });
    }
    await composer.press("Enter");
    await expect.poll(() => owned.modelRequests.length).toBe(1);
    owned.releaseReply();
    await expect
      .poll(async () => JSON.stringify((await owned.request(path)).messages))
      .toContain(reply);
    await context.close();
    await owned.restart();
    const restored = await owned.request(path);
    expect(restored.session.id).toBe(prepared.sessionId);
    expect(restored.session.routerBinding.accountId).toBe("owned-account");
    expect(JSON.stringify(restored.messages)).toContain(reply);
    expect(owned.modelRequests).toHaveLength(1);
  } finally {
    await context.close();
    await owned.close();
  }
});
