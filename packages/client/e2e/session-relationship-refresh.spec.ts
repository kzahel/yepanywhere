import { join } from "node:path";
import { e2ePaths, expect, test } from "./fixtures.js";
import { recordUiCapture } from "./support/ui-capture.js";

const projectId = Buffer.from(join(e2ePaths.tempDir, "mockproject")).toString(
  "base64url",
);
const sessionId = "mock-session-001";
test.use({ serviceWorkers: "block" });

for (const viewport of [
  { name: "desktop", width: 1000, height: 600 },
  { name: "phone", width: 375, height: 812 },
]) {
  test(`late relationship publication preserves typing and transcript on ${viewport.name}`, async ({
    page,
    baseURL,
  }) => {
    await page.setViewportSize(viewport);
    const timestamp = "2026-11-04T00:00:00.000Z";
    const messages = Array.from({ length: 160 }, (_, index) => ({
      uuid: `relationship-message-${index}`,
      type: index % 2 ? "assistant" : "user",
      timestamp,
      message: {
        role: index % 2 ? "assistant" : "user",
        content: `Relationship test turn ${index}. ${"Persist the original transcript. ".repeat(8)}`,
      },
    }));
    let published = false,
      transcriptReads = 0,
      metadataReads = 0;
    const children = [
      {
        id: "late-child",
        parentSessionId: sessionId,
        title: "Durable reviewer",
        updatedAt: timestamp,
      },
    ];
    await page.route(
      new RegExp(
        `/api/projects/[^/]+/sessions/${sessionId}(?:/metadata)?(?:\\?|$)`,
      ),
      (route) => {
        const metadata = new URL(route.request().url()).pathname.endsWith(
          "/metadata",
        );
        if (metadata) metadataReads++;
        else transcriptReads++;
        return route.fulfill({
          json: {
            session: {
              id: sessionId,
              projectId,
              provider: "codex",
              title: "Durable relationships",
              createdAt: timestamp,
              updatedAt: timestamp,
              messageCount: messages.length,
              ownership: { owner: "none" },
              ...(published ? { providerChildren: children } : {}),
            },
            ...(metadata
              ? {}
              : {
                  messages,
                  ownership: { owner: "none" },
                  pendingInputRequest: null,
                  pagination: {
                    hasOlderMessages: false,
                    totalMessageCount: messages.length,
                    returnedMessageCount: messages.length,
                    totalCompactions: 0,
                  },
                }),
          },
        });
      },
    );
    const listeners: Array<() => void> = [];
    await page.routeWebSocket("**/api/ws", (socket) => {
      const upstream = socket.connectToServer();
      socket.onMessage((wire) => {
        const message = JSON.parse(
          typeof wire === "string" ? wire : wire.subarray(1).toString("utf8"),
        );
        if (message.type === "subscribe" && message.channel === "activity") {
          let eventId = 0;
          listeners.push(() =>
            socket.send(
              JSON.stringify({
                type: "event",
                subscriptionId: message.subscriptionId,
                eventId: `relationship-${eventId++}`,
                eventType: "session-metadata-changed",
                data: {
                  type: "session-metadata-changed",
                  sessionId,
                  timestamp,
                },
              }),
            ),
          );
        }
        upstream.send(wire);
      });
    });
    await page.goto(`${baseURL}/projects/${projectId}/sessions/${sessionId}`);
    const composer = page.locator("[data-composer-input]");
    await expect(composer).toBeVisible();
    await expect.poll(() => listeners.length).toBeGreaterThan(0);
    const main = page.getByRole("main");
    const transcript = main.getByText(/Relationship test turn 159\./);
    await expect(transcript).toBeVisible();
    const node = await transcript.elementHandle();
    const delays: number[] = [];
    let draft = "";
    let readsBeforePublication = 0;
    for (const character of "Keep this draft while child metadata arrives") {
      if (draft.length >= 5) {
        if (!published) readsBeforePublication = transcriptReads;
        published = true;
        for (const emit of listeners) emit();
      }
      draft += character;
      const start = performance.now();
      await composer.pressSequentially(character);
      await expect(composer).toHaveValue(draft, { timeout: 100 });
      delays.push(performance.now() - start);
    }
    await expect(
      page
        .getByRole("banner")
        .getByRole("button", { name: "1 provider subagent", exact: true }),
    ).toBeVisible();
    expect(metadataReads).toBeGreaterThan(0);
    expect(transcriptReads).toBe(readsBeforePublication);
    expect(await node!.evaluate((element) => element.isConnected)).toBe(true);
    expect(Math.max(...delays)).toBeLessThan(100);
    await expect(composer).toHaveValue(draft);
    await recordUiCapture(
      page,
      `durable-relationships-${viewport.name}`,
      viewport,
    );
  });
}
