import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { InstallService } from "../../server/src/services/InstallService.js";
import { toUrlProjectId } from "../../shared/src/index.js";
import {
  startYaServerProcess,
  restartYaServerProcess,
  disposeYaServerProcess,
} from "./support/ya-server-process.js";

// Own process startup, gated native input, browser reload and cold continuation.
test.setTimeout(90_000);
test.skip(
  process.platform === "win32",
  "Executable fixture uses a POSIX shebang",
);

for (const hosted of [false, true])
  test(`Codex ${hosted ? "hosted" : "local"} binds one public session, confirms native acknowledgement and continues after restart`, async ({
    browser,
  }) => {
    let server: Awaited<ReturnType<typeof startYaServerProcess>> | undefined;
    let detailPath = "";
    let projectId = "",
      requestsFile = "",
      gate = "",
      nativeFile = "";
    const nativeId = "019a0000-cccc-7ccc-8ccc-cccccccccccc";
    const env: NodeJS.ProcessEnv = {
      USE_MOCK_SDK: "false",
      OPENAI_API_KEY: "owned-fixture-only",
      ENABLED_PROVIDERS: "codex",
    };
    const context = await browser.newContext({ serviceWorkers: "block" });
    const page = await context.newPage();
    const streamFrames: string[] = [];
    page.on("websocket", (socket) =>
      socket.on("framereceived", (frame) => {
        streamFrames.push(String(frame.payload).slice(0, 6000));
        if (streamFrames.length > 80) streamFrames.shift();
      }),
    );
    const errors: string[] = [],
      nativeUrls: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => {
      if (request.url().includes(nativeId)) nativeUrls.push(request.url());
    });
    try {
      server = await startYaServerProcess({
        label: "owned Codex creation",
        standalone: { providerHostEnabled: hosted },
        serveBuiltClient: true,
        env,
        async setupProfile(paths) {
          const cwd = join(paths.profileDir, "project");
          await mkdir(cwd);
          projectId = toUrlProjectId(await realpath(cwd));
          nativeFile = join(
            await realpath(paths.codexSessionsDir),
            `rollout-${nativeId}.jsonl`,
          );
          requestsFile = join(paths.profileDir, "requests.jsonl");
          gate = join(paths.profileDir, "release");
          const cli = join(paths.profileDir, "owned-codex.mjs");
          env.YEP_DESKTOP_CODEX_CLI_PATH = cli;
          env.YEP_E2E_CREATION_CWD = await realpath(cwd);
          env.YEP_E2E_CREATION_NATIVE_FILE = nativeFile;
          env.YEP_E2E_CREATION_REQUESTS = requestsFile;
          env.YEP_E2E_CREATION_GATE = gate;
          await writeFile(
            cli,
            `#!${process.execPath}\n${await readFile(new URL("./support/fixtures/creation-codex.mjs", import.meta.url), "utf8")}`,
            { mode: 0o755 },
          );
          const install = new InstallService({ dataDir: paths.dataDir });
          await install.initialize();
          await install.recordSuccessfulProviders(["codex"]);
          await writeFile(
            join(paths.dataDir, "onboarding.json"),
            JSON.stringify({ complete: true }),
          );
        },
      });
      const api = async (path: string, body?: unknown) => {
        const response = await fetch(`${server!.baseUrl}/api${path}`, {
          method: body === undefined ? "GET" : "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Yep-Anywhere": "true",
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        expect(response.status, path).toBe(200);
        return response.json();
      };
      // The immutable invocation build avoids a cold Vite route graph.
      const origin = server.baseUrl;
      await page.goto(
        `${origin}/new-session?projectId=${projectId}&provider=codex&model=gpt-6.1-sol`,
      );
      const composer = page.locator("textarea.new-session-form-textarea");
      await composer.waitFor();
      await composer.pressSequentially("OWNED_CODEX_CREATION");
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
      expect(receipt.sessionId).not.toBe(nativeId);
      detailPath = `/projects/${projectId}/sessions/${receipt.sessionId}`;
      await expect(page).toHaveURL(`${origin}${detailPath}`);
      await expect
        .poll(async () =>
          (await readFile(requestsFile, "utf8")).includes(
            '"method":"turn/start"',
          ),
        )
        .toBe(true);
      // The adapter already emitted its fabricated user echo; RPC is held.
      await expect
        .poll(async () => (await api(detailPath)).session.creation.state)
        .toBe("bound");
      expect((await api(detailPath)).session.creation.delivery).not.toBe(
        "consumed",
      );
      await page.reload();
      await expect(
        page.getByRole("region", { name: "Session startup" }),
      ).toHaveCount(0);
      await writeFile(`${gate}.ack`, "release");
      await expect
        .poll(async () => (await api(detailPath)).session.creation.delivery)
        .toBe("consumed");
      await writeFile(`${gate}.reply`, "release");
      await expect(
        page.getByText("OWNED_CODEX_CREATION_REPLY", { exact: true }).first(),
      ).toBeVisible();
      await page.reload();
      await expect(
        page.getByText("OWNED_CODEX_CREATION_REPLY", { exact: true }).first(),
      ).toBeVisible();
      server = await restartYaServerProcess(server);
      await page.reload();
      await expect(
        page.getByText("OWNED_CODEX_CREATION_REPLY", { exact: true }).first(),
      ).toBeVisible();
      const input = page.locator("textarea[data-composer-input]").first();
      await input.pressSequentially("OWNED_CODEX_CONTINUATION");
      await input.press("Enter");
      await expect
        .poll(
          async () =>
            (await readFile(requestsFile, "utf8"))
              .split("\n")
              .filter((line) => line.includes('"method":"turn/start"')).length,
        )
        .toBe(2);
      const requests = (await readFile(requestsFile, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(
        requests.filter((request) => request.method === "thread/start"),
      ).toHaveLength(1);
      expect(
        requests.some(
          (request) =>
            request.method === "thread/resume" &&
            request.params.threadId === nativeId &&
            request.params.path === nativeFile,
        ),
      ).toBe(true);
      expect(
        (await api("/sessions")).sessions.filter(
          (session: { id: string }) => session.id === receipt.sessionId,
        ),
      ).toHaveLength(1);
      await expect(page).toHaveURL(
        `${origin}/projects/${projectId}/sessions/codex/${nativeId}`,
      );
      expect(nativeUrls.length).toBeGreaterThan(0);
      for (const value of nativeUrls) {
        // Only the viewer address and its one lookup name the native id;
        // every session resource request uses the YA id.
        const url = new URL(value);
        expect([
          `/projects/${projectId}/sessions/codex/${nativeId}`,
          `/api/projects/${projectId}/native-sessions/codex/${nativeId}`,
        ]).toContain(url.pathname);
        expect(url.search).toBe("");
      }
      expect(errors).toEqual([]);
    } catch (error) {
      if (server) {
        console.error("Owned frames", JSON.stringify(streamFrames));
        console.error(
          "Owned detail",
          await fetch(`${server.baseUrl}/api${detailPath}`)
            .then((r) => r.json())
            .catch(String),
        );
        console.error(
          "Owned native",
          await readFile(nativeFile, "utf8").catch(String),
        );
        console.error(
          "Owned Codex failure",
          server.output.stderr.join("").slice(-12000),
          server.output.stdout.join("").slice(-12000),
        );
        console.error(
          "Owned RPC methods",
          (await readFile(requestsFile, "utf8").catch(() => ""))
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line).method),
        );
      }
      throw error;
    } finally {
      if (gate) {
        await writeFile(`${gate}.ack`, "release").catch(() => {});
        await writeFile(`${gate}.reply`, "release").catch(() => {});
      }
      await context.close();
      if (server) await disposeYaServerProcess(server);
    }
  });
