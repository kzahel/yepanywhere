import { expect, test } from "@playwright/test";
import { createCodexCreationFixture } from "./support/codex-creation-fixture.js";

test.setTimeout(90_000);
test.skip(
  process.platform === "win32",
  "Controlled app-server uses a POSIX executable fixture",
);
const body = {
  requestId: "owned-recovery-operation",
  provider: "codex",
  model: "gpt-6.1-sol",
  message: "OWNED_RECOVERY_PROMPT",
  mode: "bypassPermissions",
  recapMode: "off",
  promptSuggestionMode: "off",
};

async function admit(
  owned: Awaited<ReturnType<typeof createCodexCreationFixture>>,
) {
  const response = await owned.request(
    `/projects/${owned.projectId}/session-creations`,
    body,
  );
  expect(response.status).toBe(202);
  const receipt = await response.json();
  const detailPath = `/projects/${owned.projectId}/sessions/${receipt.sessionId}`;
  const detail = async () => (await owned.request(detailPath)).json();
  await expect
    .poll(
      async () =>
        (await owned.requests()).filter(
          (request) => request.method === "turn/start",
        ).length,
    )
    .toBe(1);
  await expect
    .poll(async () => (await detail()).session.creation.state)
    .toBe("bound");
  expect((await detail()).session.creation.delivery).not.toBe("consumed");
  return { receipt, detail, detailPath };
}

test("lost HTTP acceptance reply recovers read-only and submits the initial prompt once", async ({
  browser,
}) => {
  // The immutable invocation build avoids a cold Vite route graph per case.
  const owned = await createCodexCreationFixture(
    false,
    false,
    {},
    { serveBuiltClient: true },
  );
  const context = await browser.newContext({ serviceWorkers: "block" });
  try {
    const origin = owned.server.baseUrl;
    const page = await context.newPage();
    let posts = 0,
      recoveryReads = 0,
      acceptedId = "";
    page.on("request", (request) => {
      if (
        request.method() === "GET" &&
        new URL(request.url()).pathname.startsWith("/api/session-creations/")
      )
        recoveryReads++;
    });
    await page.route("**/session-creations", async (route) => {
      posts++;
      const accepted = await route.fetch();
      expect(accepted.status()).toBe(202);
      acceptedId = (await accepted.json()).sessionId;
      await route.abort("failed");
    });
    await page.goto(
      `${origin}/new-session?projectId=${owned.projectId}&provider=codex&model=gpt-6.1-sol`,
    );
    await page
      .locator("textarea[data-new-session-form-textarea]")
      .pressSequentially("OWNED_RECOVERY_PROMPT");
    await page
      .getByRole("button", { name: "Start session", exact: true })
      .click();
    await expect.poll(() => acceptedId).not.toBe("");
    await expect(page).toHaveURL(
      `${origin}/projects/${owned.projectId}/sessions/${acceptedId}`,
    );
    expect(recoveryReads).toBe(1);
    await owned.releaseAck();
    await owned.releaseReply();
    await expect(
      page.getByText("OWNED_CODEX_CREATION_REPLY", { exact: true }).first(),
    ).toBeVisible();
    await page.reload();
    await expect(
      page.getByText("OWNED_CODEX_CREATION_REPLY", { exact: true }).first(),
    ).toBeVisible();
    expect(posts).toBe(1);
    expect(
      (await owned.requests()).filter(
        (request) => request.method === "turn/start",
      ),
    ).toHaveLength(1);
  } finally {
    await context.close();
    await owned.close();
  }
});

test("abrupt Hono replacement preserves the hosted worker and its native acknowledgement", async () => {
  test.skip(
    !!process.env.YA_STANDALONE_TEST_RUNTIME?.includes("bun"),
    "macOS provider host requires Node",
  );
  const owned = await createCodexCreationFixture(true, true);
  try {
    const { receipt, detail } = await admit(owned);
    const before = await (
      await owned.request("/provider-host/runtimes")
    ).json();
    const pid = before.runtimes[0].pid;
    await owned.crashServer();
    await owned.restart();
    const after = await (await owned.request("/provider-host/runtimes")).json();
    expect(after.runtimes[0].pid).toBe(pid);
    await owned.releaseAck();
    await owned.releaseReply();
    await expect
      .poll(async () => (await detail()).session.creation.delivery)
      .toBe("consumed");
    await expect
      .poll(async () =>
        JSON.stringify((await detail()).messages).includes(
          "OWNED_CODEX_CREATION_REPLY",
        ),
      )
      .toBe(true);
    expect((await detail()).session.id).toBe(receipt.sessionId);
    expect(
      (await owned.requests()).filter(
        (request) => request.method === "thread/start",
      ),
    ).toHaveLength(1);
    expect(
      (await owned.requests()).filter(
        (request) => request.method === "turn/start",
      ),
    ).toHaveLength(1);
  } finally {
    await owned.close();
  }
});

for (const hosted of [false, true])
  test(`${hosted ? "hosted" : "local"} owner loss before input acknowledgement retains uncertainty and refuses automatic replay`, async () => {
    test.skip(
      hosted && !!process.env.YA_STANDALONE_TEST_RUNTIME?.includes("bun"),
      "macOS provider host requires Node",
    );
    const owned = await createCodexCreationFixture(hosted);
    try {
      const { receipt, detail, detailPath } = await admit(owned);
      await owned.crashServer();
      if (hosted) await owned.loseHost();
      await owned.restart();
      if (!hosted)
        expect(
          (await owned.requests()).some((record) => record.fixtureExit),
        ).toBe(true);
      await expect
        .poll(async () => (await detail()).session.creation.state)
        .toBe("uncertain");
      expect((await detail()).session.initialPrompt).toBe(body.message);
      expect((await detail()).session.creation.delivery).toBe("uncertain");
      const refused = await owned.request(`${detailPath}/resume`, {
        provider: "codex",
        message: "MUST_NOT_REPLAY",
        mode: "bypassPermissions",
      });
      expect(refused.status).toBe(409);
      const recovered = await owned.request(
        `/session-creations/${body.requestId}`,
      );
      expect(recovered.status).toBe(200);
      expect((await recovered.json()).sessionId).toBe(receipt.sessionId);
      const replay = await owned.request(
        `/projects/${owned.projectId}/session-creations`,
        body,
      );
      expect(replay.status).toBe(202);
      expect((await replay.json()).sessionId).toBe(receipt.sessionId);
      expect(
        (await owned.requests()).filter(
          (request) => request.method === "thread/start",
        ),
      ).toHaveLength(1);
      expect(
        (await owned.requests()).filter(
          (request) => request.method === "turn/start",
        ),
      ).toHaveLength(1);
    } finally {
      await owned.close();
    }
  });
