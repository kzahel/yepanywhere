import { appendFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { AuthService } from "../../server/src/auth/AuthService.js";
import { InstallService } from "../../server/src/services/InstallService.js";
import { e2ePaths, expect, test } from "./fixtures.js";
import {
  startYaServerProcess,
  stopYaServerProcess,
} from "./support/ya-server-process.js";
import { recordUiCapture } from "./support/ui-capture.js";

for (const authenticated of [false, true]) {
  test(`self-hosted preview uses local HTTP/SSE with cookie auth=${authenticated}`, async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const projectPath = join(e2ePaths.tempDir, "local-preview-project");
    const sessionId = "local-preview-session";
    const server = await startYaServerProcess({
      label: "local preview",
      mockClaudeSession: {
        content: "Review the local preview",
        projectPath,
        sessionId,
      },
      env: {
        SERVE_FRONTEND: "true",
        CLIENT_DIST_PATH: e2ePaths.clientDist,
        AUTH_DISABLED: "false",
      },
      setupProfile: async ({ dataDir }) => {
        const install = new InstallService({ dataDir });
        await install.initialize();
        await install.recordSuccessfulProviders(["claude"]);
        if (authenticated) {
          const auth = new AuthService({
            dataDir,
            cookieSecret: "preview-fixture",
          });
          await auth.initialize();
          await auth.enableAuth("preview-test-password");
          await auth.setLocalhostOpen(false);
          await auth.flushPendingWrites();
        }
      },
    });
    try {
      const sockets: string[] = [];
      const requests: string[] = [];
      page.on("websocket", (socket) => sockets.push(socket.url()));
      page.on("request", (request) => requests.push(request.url()));
      const url = `${server.baseUrl}/-/preview${authenticated ? `?session=${sessionId}` : ""}`;
      await page.goto(url);
      const source = page.getByTestId("preview-source");
      if (authenticated) {
        await expect(source).toHaveAttribute(
          "data-source-status",
          "sign-in-required",
        );
        expect(
          requests.some((url) => url.includes("/conversation/subscribe?")),
        ).toBe(false);
        await page
          .getByRole("link", { name: "Sign in again", exact: true })
          .click();
        await page
          .getByLabel("Password", { exact: true })
          .fill("preview-test-password");
        await page.getByRole("button", { name: "Login", exact: true }).click();
        await expect(page).toHaveURL(url);
      }
      await expect(source).toHaveAttribute("data-source-status", "ready");
      await expect(page.getByRole("checkbox")).toHaveCount(0);
      await expect(
        page.getByRole("link", { name: "Add / sign in" }),
      ).toHaveCount(0);
      await expect(page.getByLabel("Group by")).toHaveValue("none");
      await expect(
        page.getByRole("option", { name: "Machine", exact: true }),
      ).toHaveCount(0);
      const sessions = page.getByRole("navigation", {
        name: "Sessions",
        exact: true,
      });
      await sessions
        .getByRole("button", { name: /Review the local preview/ })
        .click();
      const conversation = page.getByTestId("preview-conversation");
      await expect(conversation).toContainText("Review the local preview");
      const transcript = join(
        server.claudeSessionsDir,
        hostname(),
        projectPath.replace(/\//g, "-"),
        `${sessionId}.jsonl`,
      );
      appendFileSync(
        transcript,
        `${JSON.stringify({ type: "assistant", uuid: "local-preview-response", parentUuid: "fixture-user-message", timestamp: new Date().toISOString(), message: { role: "assistant", content: [{ type: "text", text: "The local connection is working. Completed messages arrive without relay." }] } })}\n`,
      );
      await expect(conversation).toContainText(
        "The local connection is working",
        { timeout: 15_000 },
      );
      await source.getByRole("button", { name: "Refresh" }).click();
      await expect(conversation).toContainText(
        "The local connection is working",
      );
      await expect(source).toHaveAttribute("data-source-status", "ready");
      await page.reload();
      await expect(conversation).toContainText(
        "The local connection is working",
      );
      if (!authenticated) {
        expect(sockets).toEqual([]);
        expect(
          requests.some((url) => url.includes("/conversation/subscribe?")),
        ).toBe(true);
        expect(
          requests
            .filter((url) => url.includes("/api/"))
            .every((url) => url.startsWith(`${server.baseUrl}/api/`)),
        ).toBe(true);
        await page.setViewportSize({ width: 1000, height: 600 });
        await recordUiCapture(page, "local-preview-desktop");
        await page.setViewportSize({ width: 375, height: 812 });
        await expect(page.locator("body")).toHaveJSProperty("scrollWidth", 375);
        await recordUiCapture(page, "local-preview-phone");
        await page
          .getByRole("button", { name: "Sessions", exact: true })
          .click();
        await recordUiCapture(page, "local-preview-phone-sidebar");
        await sessions
          .getByRole("button", { name: /Review the local preview/ })
          .click();
      }
      const full = page.getByRole("link", { name: "Open full session" });
      await expect(full).toHaveAttribute(
        "href",
        `/projects/${Buffer.from(projectPath).toString("base64url")}/sessions/${sessionId}`,
      );
      await full.click();
      await expect(page).toHaveURL(new RegExp(`/sessions/${sessionId}$`));
    } catch (error) {
      throw new Error(`${String(error)}\n${server.output.stderr.join("")}`);
    } finally {
      await page.goto("about:blank");
      stopYaServerProcess(server);
    }
  });
}
