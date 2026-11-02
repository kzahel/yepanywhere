import { resolve, join } from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { terminateChildProcess } from "./support/process-lifecycle.js";
import {
  registerProcess,
  readRegisteredProcess,
  unregisterProcess,
} from "./support/process-registry.js";
import { expect, test, type Browser } from "@playwright/test";
import { SERVER_CAPABILITIES } from "../../shared/src/index.js";
import { createCodexCreationFixture } from "./support/codex-creation-fixture.js";
import { createTestViteServer } from "./support/vite-server.js";

// Two owned server startups plus browser/native protocol teardown.
test.setTimeout(90_000);
test.skip(
  process.platform === "win32",
  "Controlled provider uses a POSIX executable fixture",
);
async function fixture(browser: Browser, inputs: NodeJS.ProcessEnv = {}) {
  const owned = await createCodexCreationFixture(false, false, inputs);
  let vite: Awaited<ReturnType<typeof createTestViteServer>> | undefined;
  const context = await browser.newContext({ serviceWorkers: "block" });
  try {
    vite = await createTestViteServer({
      configFile: resolve("vite.config.ts"),
      root: process.cwd(),
      server: {
        host: "127.0.0.1",
        hmr: false,
        proxy: { "/api": { target: owned.server.baseUrl, ws: true } },
      },
    });
    await vite.listen();
    const address = vite.httpServer!.address();
    if (!address || typeof address === "string")
      throw new Error("Missing owned Vite listener");
    const origin = `http://127.0.0.1:${address.port}`;
    const formUrl = `${origin}/new-session?projectId=${owned.projectId}&provider=codex&model=gpt-6.1-sol`;
    return {
      ...owned,
      context,
      origin,
      formUrl,
      async close() {
        await context.close();
        await vite?.close();
        await owned.close();
      },
    };
  } catch (error) {
    await context.close();
    await vite?.close();
    await owned.close();
    throw error;
  }
}

test("full workers expose queued sessions, promote once and resolve lost pre-dispatch ownership after restart", async ({
  browser,
}) => {
  const owned = await fixture(browser, { MAX_WORKERS: "1" });
  const page = await owned.context.newPage();
  const create = async (text: string) => {
    await page.goto(owned.formUrl);
    await page
      .locator("textarea.new-session-form-textarea")
      .pressSequentially(text);
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
    const receipt = await response.json();
    await expect(page).toHaveURL(
      `${owned.origin}/projects/${owned.projectId}/sessions/${receipt.sessionId}`,
    );
    return receipt;
  };
  const detail = async (id: string) =>
    (await owned.request(`/projects/${owned.projectId}/sessions/${id}`)).json();
  try {
    const first = await create("OWNED_OCCUPIED_WORKER");
    await expect
      .poll(
        async () =>
          (await owned.requests()).filter((r) => r.method === "turn/start")
            .length,
      )
      .toBe(1);
    const queued = await create("OWNED_QUEUED_PROMPT");
    await expect
      .poll(async () => (await detail(queued.sessionId)).session.creation.state)
      .toBe("queued");
    await expect(
      page.getByRole("region", { name: "Session startup" }),
    ).toContainText("waiting");
    expect(
      (await owned.requests()).filter((r) => r.method === "thread/start"),
    ).toHaveLength(1);
    // A competing startup may read this profile before failing its port bind.
    // It must not reinterpret a live controller's queue as abandoned.
    const duplicate = spawn(
      owned.server.serverExecutable,
      [
        "--import",
        pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href,
        "--import",
        pathToFileURL(resolve("e2e/support/fixture-runtime.mjs")).href,
        "--conditions",
        "source",
        "src/index.ts",
      ],
      {
        cwd: resolve("../server"),
        env: {
          ...owned.server.restartEnv,
          PORT: String(owned.server.port),
          PORT_FILE: join(owned.server.tempDir, "duplicate-port"),
        },
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let duplicateOutput = "",
      registry: string | undefined;
    duplicate.on("error", (error) => {
      duplicateOutput += String(error);
    });
    duplicate.stdout.on("data", (chunk) => {
      duplicateOutput = (duplicateOutput + chunk).slice(-8000);
    });
    duplicate.stderr.on("data", (chunk) => {
      duplicateOutput = (duplicateOutput + chunk).slice(-8000);
    });
    try {
      registry = duplicate.pid
        ? await registerProcess(
            { pid: duplicate.pid, label: "owned competing YA startup" },
            join(owned.server.tempDir, "duplicate-process.json"),
          )
        : undefined;
      await expect
        .poll(
          () => duplicate.exitCode !== null || duplicate.signalCode !== null,
          { timeout: 30_000 },
        )
        .toBe(true);
      expect(duplicate.exitCode).not.toBe(0);
      expect(duplicateOutput).toMatch(/EADDRINUSE|Port \d+ is already in use/);
      expect((await detail(queued.sessionId)).session.creation.state).toBe(
        "queued",
      );
    } finally {
      await terminateChildProcess(
        duplicate,
        "owned competing YA startup",
        readRegisteredProcess(registry)?.leaderStartTime,
      );
      unregisterProcess(registry);
    }
    const processes = await (await owned.request("/processes")).json();
    const firstProcess = processes.processes.find(
      (p: { sessionId: string }) => p.sessionId === first.sessionId,
    );
    expect(
      (await owned.request(`/processes/${firstProcess.id}/abort`, {})).status,
    ).toBe(200);
    await expect
      .poll(
        async () =>
          (await owned.requests()).filter((r) => r.method === "turn/start")
            .length,
      )
      .toBe(2);
    await owned.releaseAck();
    await expect
      .poll(
        async () => (await detail(queued.sessionId)).session.creation.delivery,
      )
      .toBe("consumed");
    const waiting = await create("OWNED_QUEUED_BEFORE_RESTART");
    await expect
      .poll(
        async () => (await detail(waiting.sessionId)).session.creation.state,
      )
      .toBe("queued");
    await owned.crashServer();
    await owned.restart();
    await page.reload();
    // There is no surviving in-memory worker queue. A saved prompt must not
    // remain indefinitely labelled as waiting for a worker that cannot promote it.
    await expect
      .poll(
        async () => (await detail(waiting.sessionId)).session.creation.state,
      )
      .toBe("failed");
    await expect(
      page.getByRole("region", { name: "Session startup" }),
    ).toContainText("Your prompt is saved");
    expect((await detail(waiting.sessionId)).session.initialPrompt).toBe(
      "OWNED_QUEUED_BEFORE_RESTART",
    );
    expect(
      (await owned.requests()).filter((r) => r.method === "turn/start"),
    ).toHaveLength(2);
  } finally {
    await owned.close();
  }
});

test("a sibling tab's newer draft survives delayed acceptance", async ({
  browser,
}) => {
  const owned = await fixture(browser);
  const page = await owned.context.newPage(),
    sibling = await owned.context.newPage();
  let release!: () => void, saved!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const admitted = new Promise<void>((resolve) => {
    saved = resolve;
  });
  try {
    await page.goto(owned.formUrl);
    const composer = page.locator("textarea.new-session-form-textarea");
    await composer.pressSequentially("OWNED_ORIGINAL_DRAFT");
    await page.route("**/session-creations", async (route) => {
      const response = await route.fetch();
      saved();
      await barrier;
      await route.fulfill({ response });
    });
    await page
      .getByRole("button", { name: "Start session", exact: true })
      .click();
    await admitted;
    await sibling.goto(owned.formUrl);
    const other = sibling.locator("textarea.new-session-form-textarea");
    await expect(other).toHaveValue("OWNED_ORIGINAL_DRAFT");
    await other.press("End");
    await other.pressSequentially(" newer sibling work");
    // Flush the actual sibling editor to account-scoped storage before ACK.
    await other.blur();
    await expect
      .poll(() =>
        sibling.evaluate(() =>
          Object.keys(localStorage)
            .filter((key) => key.includes("draft-new-session"))
            .map((key) => localStorage.getItem(key))
            .join("\n"),
        ),
      )
      .toContain("newer sibling work");
    release();
    await expect(
      page.getByRole("button", { name: "Open saved session", exact: true }),
    ).toBeVisible();
    await expect(other).toHaveValue("OWNED_ORIGINAL_DRAFT newer sibling work");
    await sibling.reload();
    await expect(other).toHaveValue("OWNED_ORIGINAL_DRAFT newer sibling work");
    expect(page.url()).toBe(owned.formUrl);
  } finally {
    release?.();
    await owned.close();
  }
});

test("independent browser draft handoff survives another device's creation acknowledgement", async ({
  browser,
}) => {
  const owned = await fixture(browser);
  const second = await browser.newContext({ serviceWorkers: "block" });
  const page = await owned.context.newPage(),
    otherPage = await second.newPage();
  let acceptedId = "";
  let release!: () => void, saved!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const admitted = new Promise<void>((resolve) => {
    saved = resolve;
  });
  try {
    await page.goto(owned.formUrl);
    const composer = page.locator("textarea.new-session-form-textarea");
    await composer.pressSequentially("OWNED_DEVICE_DRAFT");
    await composer.blur();
    await otherPage.goto(owned.formUrl);
    const other = otherPage.locator("textarea.new-session-form-textarea");
    await expect(other).toHaveValue("OWNED_DEVICE_DRAFT");
    await page.route("**/session-creations", async (route) => {
      const response = await route.fetch();
      acceptedId = (await response.json()).sessionId;
      saved();
      await barrier;
      await route.fulfill({ response });
    });
    await page
      .getByRole("button", { name: "Start session", exact: true })
      .click();
    await admitted;
    await other.press("End");
    await other.pressSequentially(" newer device work");
    await other.blur();
    // A genuine draft write must have reached the shared server, not just DOM.
    await expect
      .poll(async () =>
        JSON.stringify(
          await (
            await owned.request("/drafts/read", {
              slot: { kind: "new-session" },
            })
          ).json(),
        ),
      )
      .toContain("newer device work");
    release();
    await expect
      .poll(
        async () =>
          page.url().endsWith(`/sessions/${acceptedId}`) ||
          (await page
            .getByRole("button", { name: "Open saved session", exact: true })
            .isVisible()),
      )
      .toBe(true);
    expect(
      JSON.stringify(
        await (
          await owned.request("/drafts/read", { slot: { kind: "new-session" } })
        ).json(),
      ),
    ).toContain("newer device work");
    await expect(other).toHaveValue("OWNED_DEVICE_DRAFT newer device work");
    await otherPage.reload();
    await expect(other).toHaveValue("OWNED_DEVICE_DRAFT newer device work");
  } finally {
    release?.();
    await second.close();
    await owned.close();
  }
});

test("missing durable-creation capability uses the established start endpoint", async ({
  browser,
}) => {
  const owned = await fixture(browser);
  const page = await owned.context.newPage();
  let durablePosts = 0,
    starts = 0;
  try {
    const absent = [
      SERVER_CAPABILITIES.claudeTextCreation,
      SERVER_CAPABILITIES.codexTextCreation,
    ];
    const strip = (version: {
      capabilities?: string[];
      capabilityBits?: [number, number][];
    }) => {
      version.capabilities = version.capabilities?.filter(
        (name) => !absent.some((cap) => cap.name === name),
      );
      version.capabilityBits = version.capabilityBits?.map(([word, bits]) => [
        word,
        absent.reduce(
          (value, cap) =>
            Math.floor(cap.id / 32) === word
              ? value & ~(2 ** (cap.id % 32))
              : value,
          bits,
        ) >>> 0,
      ]);
      return version;
    };
    await page.route("**/api/version**", async (route) => {
      const response = await route.fetch();
      await route.fulfill({ response, json: strip(await response.json()) });
    });
    await page.route("**/api/settings?bootstrap=*", async (route) => {
      const response = await route.fetch();
      const body = (await response.text())
        .split("\n")
        .map((line) => {
          if (!line.startsWith("data: ")) return line;
          const frame = JSON.parse(line.slice(6));
          if (frame.part === "version") strip(frame.body);
          return `data: ${JSON.stringify(frame)}`;
        })
        .join("\n");
      await route.fulfill({ response, body });
    });
    page.on("request", (request) => {
      if (request.method() !== "POST") return;
      const path = new URL(request.url()).pathname;
      if (path.endsWith("/session-creations")) durablePosts++;
      if (
        path === `/api/projects/${owned.projectId}/sessions` ||
        path === "/api/sessions"
      )
        starts++;
    });
    await owned.releaseAck();
    await owned.releaseReply();
    await page.goto(owned.formUrl);
    await page
      .locator("textarea.new-session-form-textarea")
      .pressSequentially("OWNED_COMPATIBILITY_START");
    await page
      .getByRole("button", { name: "Start session", exact: true })
      .click();
    await expect(
      page.getByText("OWNED_CODEX_CREATION_REPLY", { exact: true }).first(),
    ).toBeVisible();
    expect(starts).toBe(1);
    expect(durablePosts).toBe(0);
    await page.reload();
    await expect(
      page.getByText("OWNED_CODEX_CREATION_REPLY", { exact: true }).first(),
    ).toBeVisible();
  } finally {
    await owned.close();
  }
});

test("switching acting account during acceptance keeps the new account's draft separate", async ({
  browser,
}) => {
  const owned = await fixture(browser);
  const page = await owned.context.newPage();
  let release!: () => void,
    saved!: () => void,
    acceptedId = "";
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const admitted = new Promise<void>((resolve) => {
    saved = resolve;
  });
  try {
    const configured = await fetch(`${owned.server.baseUrl}/api/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-Yep-Anywhere": "true" },
      body: JSON.stringify({ limitedUsersEnabled: true }),
    });
    expect(configured.status).toBe(200);
    expect(
      (
        await owned.request("/users", {
          username: "alice",
          password: "owned-qualification-password",
          newSessionProjects: [owned.projectId],
        })
      ).status,
    ).toBe(201);
    await page.goto(owned.formUrl);
    await page
      .locator("textarea.new-session-form-textarea")
      .pressSequentially("OWNED_OWNER_ONLY_PROMPT");
    await page.route("**/session-creations", async (route) => {
      const response = await route.fetch();
      acceptedId = (await response.json()).sessionId;
      saved();
      await barrier;
      await route.fulfill({ response }).catch(() => {});
    });
    await page
      .getByRole("button", { name: "Start session", exact: true })
      .click();
    await admitted;
    const switched = await page.request.post(
      `${owned.origin}/api/users/switch`,
      { data: { username: "alice" }, headers: { "X-Yep-Anywhere": "true" } },
    );
    expect(switched.status()).toBe(200);
    // Account switching in the actual Settings UI renews the document.
    await page.reload();
    const identity = await page.request.get(`${owned.origin}/api/users/me`);
    expect((await identity.json()).username).toBe("alice");
    const composer = page.locator("textarea.new-session-form-textarea");
    await expect(composer).toHaveValue("");
    await composer.pressSequentially("OWNED_ALICE_UNSENT");
    release();
    await expect(composer).toHaveValue("OWNED_ALICE_UNSENT");
    expect(page.url()).toBe(owned.formUrl);
    expect(
      await page
        .getByRole("button", { name: "Check saved session", exact: true })
        .count(),
    ).toBe(0);
    expect(
      (
        await page.request.get(
          `${owned.origin}/api/session-creations/owner-private-request`,
        )
      ).status(),
    ).toBe(403);
    await composer.blur();
    await page.reload();
    await expect(composer).toHaveValue("OWNED_ALICE_UNSENT");
    expect(
      (
        await (
          await owned.request(
            `/projects/${owned.projectId}/sessions/${acceptedId}`,
          )
        ).json()
      ).session.initialPrompt,
    ).toBe("OWNED_OWNER_ONLY_PROMPT");
  } finally {
    release?.();
    await owned.close();
  }
});
