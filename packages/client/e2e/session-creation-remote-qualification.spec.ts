import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { createCodexCreationFixture } from "./support/codex-creation-fixture.js";
import { createTestViteServer } from "./support/vite-server.js";
import { createE2ERunDirectory } from "./support/run-directory.js";
import {
  startWorkerRelay,
  type WorkerRelay,
} from "./support/worker-services.js";
import { terminateChildProcess } from "./support/process-lifecycle.js";
import {
  readRegisteredProcess,
  unregisterProcess,
} from "./support/process-registry.js";
import { recordUiCapture, presentUiCaptures } from "./support/ui-capture.js";

test.setTimeout(90_000);
test.skip(
  process.platform === "win32",
  "Controlled provider uses a POSIX executable fixture",
);
let relay: WorkerRelay,
  root = "";
const previousRun = process.env.YEP_E2E_RUN_DIR;
test.beforeAll(async () => {
  root = createE2ERunDirectory();
  relay = await startWorkerRelay();
});
test.afterAll(async () => {
  await presentUiCaptures();
  if (relay) {
    await terminateChildProcess(
      relay.process,
      "owned creation qualification relay",
      readRegisteredProcess(relay.registryFile)?.leaderStartTime,
    );
    unregisterProcess(relay.registryFile);
  }
  if (root) await rm(root, { recursive: true, force: true });
  if (previousRun === undefined) delete process.env.YEP_E2E_RUN_DIR;
  else process.env.YEP_E2E_RUN_DIR = previousRun;
});
async function configure(
  owned: Awaited<ReturnType<typeof createCodexCreationFixture>>,
  username: string,
) {
  const password = "owned-qualification-password";
  for (const [path, method, body] of [
    [
      "/remote-access/relay",
      "PUT",
      { url: `ws://127.0.0.1:${relay.port}/ws`, username },
    ],
    ["/remote-access/configure", "POST", { password }],
  ] as const) {
    const response = await fetch(`${owned.server.baseUrl}/api${path}`, {
      method,
      headers: { "Content-Type": "application/json", "X-Yep-Anywhere": "true" },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(200);
  }
  await expect
    .poll(
      async () =>
        (await (await owned.request("/remote-access/relay/status")).json())
          .status,
    )
    .toBe("waiting");
  return { username, password, relayUrl: `ws://127.0.0.1:${relay.port}/ws` };
}
async function remoteVite() {
  const vite = await createTestViteServer({
    configFile: resolve("vite.config.remote.ts"),
    root: process.cwd(),
    server: { host: "127.0.0.1", hmr: false },
  });
  await vite.listen();
  const address = vite.httpServer!.address();
  if (!address || typeof address === "string")
    throw Error("Missing owned remote listener");
  return { vite, origin: `http://127.0.0.1:${address.port}` };
}

test("phone-width relay interruption recovers the accepted session without a second native input", async ({
  browser,
}) => {
  const owned = await createCodexCreationFixture(false);
  let frontend: Awaited<ReturnType<typeof remoteVite>> | undefined;
  const context = await browser.newContext({
    serviceWorkers: "block",
    viewport: { width: 375, height: 812 },
    isMobile: true,
    hasTouch: true,
  });
  let dropReplies = false,
    dropped = 0;
  const disconnects: (() => void)[] = [];
  try {
    const credentials = await configure(
      owned,
      `creation-${randomUUID().slice(0, 8)}`,
    );
    frontend = await remoteVite();
    const page = await context.newPage();
    await page.routeWebSocket(
      (url) => url.port === String(relay.port),
      (client) => {
        const server = client.connectToServer();
        disconnects.push(() => {
          client.close({
            code: 1011,
            reason: "owned acceptance response interruption",
          });
          server.close();
        });
        client.onMessage((message) => server.send(message));
        server.onMessage((message) => {
          if (dropReplies) dropped++;
          else client.send(message);
        });
      },
    );
    await page.goto(frontend.origin);
    await page.getByTestId("relay-mode-button").click();
    await page.getByTestId("relay-username-input").fill(credentials.username);
    await page.getByTestId("srp-password-input").fill(credentials.password);
    await page.locator(".login-advanced-toggle").click();
    await page.getByTestId("custom-relay-url-input").fill(credentials.relayUrl);
    await page.getByTestId("login-button").click();
    await expect(page).toHaveURL(
      new RegExp(`/-/relay/${credentials.username}/projects`),
      { timeout: 15_000 },
    );
    const prefix = `${frontend.origin}/-/relay/${credentials.username}`;
    await page.goto(
      `${prefix}/new-session?projectId=${owned.projectId}&provider=codex&model=gpt-6.1-sol`,
    );
    await page
      .locator("textarea.new-session-form-textarea")
      .pressSequentially("OWNED_RELAY_ACCEPTANCE");
    await page.exposeFunction("armCreationDrop", () => {
      dropReplies = true;
    });
    await page.evaluate(async () => {
      const path = "/src/lib/sourceRuntime.ts";
      const { getSourceRuntimeRegistry } = await import(
        /* @vite-ignore */ path
      );
      const transport =
        getSourceRuntimeRegistry().getCurrentSourceRuntime().transport;
      const original = transport.fetch.bind(transport);
      const state = window as typeof window & {
        armCreationDrop: () => Promise<void>;
        creationRecoveryReads: number;
      };
      state.creationRecoveryReads = 0;
      transport.fetch = async (path: string, init: RequestInit) => {
        if (init?.method === "POST" && path.endsWith("/session-creations"))
          await state.armCreationDrop();
        if (path.startsWith("/session-creations/"))
          state.creationRecoveryReads++;
        return original(path, init);
      };
    });
    await page
      .getByRole("button", { name: "Start session", exact: true })
      .click();
    await expect
      .poll(
        async () =>
          (await owned.requests()).filter((r) => r.method === "turn/start")
            .length,
      )
      .toBe(1);
    await expect.poll(() => dropped).toBeGreaterThan(0);
    const sessions = await (await owned.request("/sessions")).json();
    const id = sessions.sessions.find(
      (s: { initialPrompt?: string; fullTitle?: string }) =>
        (s.initialPrompt ?? s.fullTitle)?.includes("OWNED_RELAY_ACCEPTANCE"),
    ).id;
    for (const disconnect of disconnects) disconnect();
    dropReplies = false;
    const recovery = page.getByRole("button", {
      name: "Check saved session",
      exact: true,
    });
    await expect
      .poll(
        async () =>
          page.url().endsWith(`/sessions/${id}`) ||
          (await recovery.isVisible()),
        { timeout: 15_000 },
      )
      .toBe(true);
    if (await recovery.isVisible()) await recovery.click();
    await expect(page).toHaveURL(
      `${prefix}/projects/${owned.projectId}/sessions/${id}`,
    );
    expect(
      await page.evaluate(
        () =>
          (window as typeof window & { creationRecoveryReads: number })
            .creationRecoveryReads,
      ),
    ).toBeGreaterThan(0);
    await owned.releaseAck();
    await owned.releaseReply();
    await expect(
      page.getByText("OWNED_CODEX_CREATION_REPLY", { exact: true }).first(),
    ).toBeVisible();
    await recordUiCapture(page, "creation-relay-phone");
    await page.setViewportSize({ width: 1000, height: 600 });
    await recordUiCapture(page, "creation-relay-desktop");
    await page.reload();
    await expect(
      page.getByText("OWNED_CODEX_CREATION_REPLY", { exact: true }).first(),
    ).toBeVisible();
    expect(
      (await owned.requests()).filter((r) => r.method === "turn/start"),
    ).toHaveLength(1);
  } finally {
    dropReplies = false;
    await context.close();
    await frontend?.vite.close();
    await owned.close();
  }
});

test("a delayed accepted reply cannot navigate or clear another relay host's draft", async ({
  browser,
}) => {
  const first = await createCodexCreationFixture(false),
    second = await createCodexCreationFixture(false);
  let frontend: Awaited<ReturnType<typeof remoteVite>> | undefined;
  const context = await browser.newContext({ serviceWorkers: "block" });
  const page = await context.newPage();
  try {
    const a = await configure(first, `creation-a-${randomUUID().slice(0, 8)}`),
      b = await configure(second, `creation-b-${randomUUID().slice(0, 8)}`);
    frontend = await remoteVite();
    await page.goto(frontend.origin);
    await page.evaluate(
      async (inputs) => {
        const modulePath = "/src/lib/e2e/multiHostSessionProvisioning.ts";
        const { provisionRelayHostSession } = await import(
          /* @vite-ignore */ modulePath
        );
        for (const input of inputs)
          await provisionRelayHostSession({
            ...input,
            displayName: input.username,
          });
      },
      [a, b],
    );
    const formA = `${frontend.origin}/-/relay/${a.username}/new-session?projectId=${first.projectId}&provider=codex&model=gpt-6.1-sol`;
    const formB = `${frontend.origin}/-/relay/${b.username}/new-session?projectId=${second.projectId}&provider=codex&model=gpt-6.1-sol`;
    await page.goto(formA);
    const composer = page.locator("textarea.new-session-form-textarea");
    await composer.pressSequentially("OWNED_SOURCE_A_PROMPT");
    await page.evaluate(async () => {
      const path = "/src/lib/sourceRuntime.ts";
      const { getSourceRuntimeRegistry } = await import(
        /* @vite-ignore */ path
      );
      const transport =
        getSourceRuntimeRegistry().getCurrentSourceRuntime().transport;
      const original = transport.fetch.bind(transport);
      const state = window as typeof window & {
        acceptedCreation?: { sessionId: string };
        releaseCreation?: () => void;
      };
      transport.fetch = async (path: string, init: RequestInit) => {
        const result = await original(path, init);
        if (init?.method === "POST" && path.endsWith("/session-creations")) {
          state.acceptedCreation = result;
          await new Promise<void>((resolve) => {
            state.releaseCreation = resolve;
          });
        }
        return result;
      };
    });
    await page
      .getByRole("button", { name: "Start session", exact: true })
      .click();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as typeof window & { acceptedCreation?: unknown })
              .acceptedCreation !== undefined,
        ),
      )
      .toBe(true);
    const id = await page.evaluate(
      () =>
        (window as typeof window & { acceptedCreation: { sessionId: string } })
          .acceptedCreation.sessionId,
    );
    await page.evaluate((url) => {
      history.pushState(null, "", url);
      dispatchEvent(new PopStateEvent("popstate"));
    }, formB);
    await expect(composer).toHaveValue("");
    await composer.pressSequentially("OWNED_SOURCE_B_UNSENT");
    await page.evaluate(() =>
      (
        window as typeof window & { releaseCreation?: () => void }
      ).releaseCreation?.(),
    );
    await expect
      .poll(() =>
        page.evaluate(
          (id) =>
            Object.keys(localStorage)
              .filter((key) => key.startsWith("ya-text-creation:"))
              .some(
                (key) =>
                  JSON.parse(localStorage.getItem(key) ?? "{}").receipt
                    ?.sessionId === id,
              ),
          id,
        ),
      )
      .toBe(true);
    await expect(page).toHaveURL(formB);
    await expect(composer).toHaveValue("OWNED_SOURCE_B_UNSENT");
    expect(
      (await second.requests()).filter((r) => r.method === "thread/start"),
    ).toHaveLength(0);
    await page.evaluate((url) => {
      history.pushState(null, "", url);
      dispatchEvent(new PopStateEvent("popstate"));
    }, formA);
    await expect(
      page.getByRole("button", { name: "Check saved session", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Check saved session", exact: true })
      .click();
    await expect(page).toHaveURL(
      `${frontend.origin}/-/relay/${a.username}/projects/${first.projectId}/sessions/${id}`,
    );
    await first.releaseAck();
    await first.releaseReply();
    await expect(
      page.getByText("OWNED_CODEX_CREATION_REPLY", { exact: true }).first(),
    ).toBeVisible();
  } finally {
    await page
      .evaluate(() =>
        (
          window as typeof window & { releaseCreation?: () => void }
        ).releaseCreation?.(),
      )
      .catch(() => {});
    await context.close();
    await frontend?.vite.close();
    await Promise.all([first.close(), second.close()]);
  }
});
