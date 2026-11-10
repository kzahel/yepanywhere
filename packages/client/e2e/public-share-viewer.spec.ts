import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  toUrlProjectId,
  type PublicSessionShareResponse,
} from "@yep-anywhere/shared";
import { expect, test } from "./fixtures.js";
import { recordUiCapture } from "./support/ui-capture";

const projectId = toUrlProjectId("/project");
const attachmentPath =
  "/app-data/projects/0123456789abcdef0123456789abcdef/attachments/source-session/12345678-1234-1234-1234-123456789abc_image.svg";
const timestamp = "2026-09-07T00:00:00.000Z";
const command = Array.from(
  { length: 32 },
  (_, i) => `echo 'Command line ${i + 1}'`,
).join("\n");

function shareResponse(): PublicSessionShareResponse {
  const messages = [
    {
      id: "user-1",
      type: "user",
      timestamp,
      content: `${"Please review the diagram and its accompanying command output.\n\n".repeat(24)}Review this attached diagram.\n\nUser uploaded files:\n- [image.svg](${attachmentPath}) (1 KB, image/svg+xml, 640x360)`,
    },
    ...Array.from({ length: 8 }, (_, i) => [
      {
        id: `assistant-${i}`,
        type: "assistant",
        timestamp,
        content: [
          {
            type: "tool_use",
            id: `tool-${i}`,
            name: "Bash",
            input: { command },
          },
        ],
      },
      {
        id: `result-${i}`,
        type: "user",
        timestamp,
        content: [
          {
            type: "tool_result",
            tool_use_id: `tool-${i}`,
            content: "Command completed successfully.",
          },
        ],
      },
    ]).flat(),
    {
      id: "answer",
      type: "assistant",
      timestamp,
      content: "The diagram is ready for review.",
    },
    {
      id: "next-user",
      type: "user",
      timestamp,
      content: "Please keep the command details available for review.",
    },
  ];
  return {
    share: {
      mode: "live",
      title: "Shared attachment review",
      createdAt: timestamp,
      updatedAt: timestamp,
      source: {
        projectId,
        sessionId: "shared-session",
        projectName: "Example project",
        provider: "claude",
      },
    },
    session: {
      id: "shared-session",
      projectId,
      provider: "claude",
      title: "Shared attachment review",
      fullTitle: "Shared attachment review",
      createdAt: timestamp,
      updatedAt: timestamp,
      messageCount: messages.length,
      ownership: { owner: "none" },
      messages: messages.map((message) => ({
        ...message,
        uuid: message.id,
        message: { role: message.type, content: message.content },
      })) as PublicSessionShareResponse["session"]["messages"],
    },
  };
}

test.beforeEach(async ({ page, remotePreviewURL }) => {
  await page.routeWebSocket("wss://share-relay.test/ws", (socket) => {
    socket.onMessage((wire) => {
      const message = JSON.parse(String(wire));
      if (message.type === "client_connect") {
        socket.send(JSON.stringify({ type: "client_connected" }));
        return;
      }
      expect(message.method).toBe("GET");
      const url = new URL(message.path, "http://share.test");
      const isFile = url.pathname.endsWith("/files/raw");
      if (isFile) expect(url.searchParams.get("path")).toBe(attachmentPath);
      socket.send(
        JSON.stringify({
          type: "response",
          id: message.id,
          status: 200,
          headers: {
            "content-type": isFile ? "image/svg+xml" : "application/json",
          },
          body: isFile
            ? '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="#144c44"/><text x="320" y="190" text-anchor="middle" font-family="sans-serif" font-size="36" fill="white">Shared attachment</text></svg>'
            : shareResponse(),
        }),
      );
    });
  });
  await page.setViewportSize({ width: 1000, height: 600 });
  // Use the deployed remote bundle; this contract does not import source
  // modules. Enter the actual public share route before React initializes.
  await page.addInitScript(() => {
    history.replaceState(
      null,
      "",
      "/share/public-secret?h=owner&r=wss%3A%2F%2Fshare-relay.test%2Fws",
    );
  });
  await page.goto(`${remotePreviewURL}/remote.html`);
  await expect(page.locator("[data-brand-wordmark]")).toHaveCSS(
    "font-size",
    "14px",
  );
  await expect(
    page.locator("[data-conversation-activity-summary]"),
  ).toHaveCount(1);
});

test("public attachment opens without private API requests", async ({
  page,
}) => {
  const privateRequests: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/"))
      privateRequests.push(request.url());
  });
  await page.getByRole("button", { name: "Open image.svg" }).click();
  const image = page.getByRole("img", { name: "image.svg" });
  await expect
    .poll(() => image.evaluate((node: HTMLImageElement) => node.naturalWidth))
    .toBe(640);
  expect(privateRequests).toEqual([]);
  const captures = process.env.YEP_PUBLIC_SHARE_CAPTURE_DIR;
  if (captures) {
    mkdirSync(captures, { recursive: true });
    await page.screenshot({ path: join(captures, "attachment-desktop.png") });
    await page.setViewportSize({ width: 375, height: 812 });
    await page.screenshot({ path: join(captures, "attachment-phone.png") });
  }
});

for (const viewport of [
  { width: 1000, height: 600 },
  { width: 375, height: 812 },
]) {
  test(`expanding activities holds the clicked summary near the live edge (${viewport.width}px)`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await page.evaluate(async () => {
      await document.fonts.ready;
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
    });
    await page.locator("[data-public-share-scroll]").evaluate((node) => {
      node.scrollTop = node.scrollHeight - node.clientHeight - 12;
    });
    const summary = page.locator("[data-conversation-activity-summary]");
    await summary.scrollIntoViewIfNeeded();
    await expect(summary).toBeInViewport();
    await summary.evaluate((node: HTMLElement) => {
      node.addEventListener(
        "click",
        () => {
          // Measure at the actual click boundary, after Playwright's own
          // visibility scrolling and any pending live-edge reconciliation.
          document.documentElement.dataset.beforeExpandedTop = String(
            node.getBoundingClientRect().top,
          );
          // Animation frames run before ResizeObserver's pre-paint layout
          // corrections. Sample after the transcript's resize observer so
          // this records the first painted geometry, including lazy styles.
          const observer = new ResizeObserver(() => {
            const expanded = document.querySelector(
              "[data-conversation-activity-summary]",
            );
            if (expanded?.getAttribute("aria-expanded") !== "true") return;
            document.documentElement.dataset.firstExpandedTop = String(
              expanded.getBoundingClientRect().top,
            );
            observer.disconnect();
          });
          observer.observe(document.querySelector("[data-message-list]")!);
        },
        { once: true, capture: true },
      );
    });
    await summary.click();
    await expect(
      page.getByRole("button", { name: "Show full command", exact: true }),
    ).toHaveCount(8);
    const before = Number(
      await page.locator("html").getAttribute("data-before-expanded-top"),
    );
    await expect
      .poll(async () => Math.abs((await summary.boundingBox())!.y - before))
      .toBeLessThan(3);
    await expect
      .poll(async () =>
        Math.abs(
          Number(
            await page.locator("html").getAttribute("data-first-expanded-top"),
          ) - before,
        ),
      )
      .toBeLessThan(3);
    await recordUiCapture(
      page,
      `public-share-expanded-${viewport.width}`,
      viewport,
    );
  });
}

test("expanded commands grow with their content", async ({ page }) => {
  await page.locator("[data-conversation-activity-summary]").click();
  const fullCommand = page
    .getByRole("button", { name: "Show full command", exact: true })
    .first();
  await fullCommand.click();
  const expanded = page.getByRole("button", {
    name: "Collapse command",
    exact: true,
  });
  await expect
    .poll(() =>
      expanded.evaluate((node) => node.scrollHeight - node.clientHeight),
    )
    .toBeLessThan(2);
  await expect(expanded).toContainText("Command line 32");
  const captures = process.env.YEP_PUBLIC_SHARE_CAPTURE_DIR;
  if (captures) {
    await page.screenshot({ path: join(captures, "expanded-desktop.png") });
    await page.setViewportSize({ width: 375, height: 812 });
    await page.screenshot({ path: join(captures, "expanded-phone.png") });
  }
});
