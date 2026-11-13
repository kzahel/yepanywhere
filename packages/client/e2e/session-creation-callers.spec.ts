import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { createCodexCreationFixture } from "./support/codex-creation-fixture.js";
import { recordUiCapture, presentUiCaptures } from "./support/ui-capture.js";

// Owned startup/restart qualification observed 22.8 s; allow approximately 4x.
test.setTimeout(90000);
test.skip(
  process.platform === "win32",
  "Owned native peer uses a POSIX executable",
);
test.afterAll(() => presentUiCaptures());
const headers = {
  "Content-Type": "application/json",
  "X-Yep-Anywhere": "true",
};

for (const hosted of [false, true])
  test(`explicit Codex preparation ${hosted ? "hosted" : "local"} preserves one public resource and permits its first turn`, async ({
    browser,
  }) => {
    const owned = await createCodexCreationFixture(
      hosted,
      false,
      {},
      { serveBuiltClient: true },
    );
    const context = await browser.newContext({
      serviceWorkers: "block",
      viewport: { width: 1000, height: 600 },
    });
    try {
      const response = await owned.request(
        `/projects/${owned.projectId}/session-creations`,
        {
          requestId: crypto.randomUUID(),
          message: "",
          intent: "prepare",
          provider: "codex",
          model: "gpt-6.1-sol",
        },
      );
      expect(response.status).toBe(202);
      const prepared = await response.json();
      expect(prepared.creation.initialInputExpected).toBe(false);
      await expect
        .poll(
          async () =>
            (
              await (
                await owned.request(`/session-creations/${prepared.requestId}`)
              ).json()
            ).creation.state,
        )
        .toBe("bound");
      await expect
        .poll(
          async () =>
            (
              await (
                await owned.request(`/sessions/${prepared.sessionId}/process`)
              ).json()
            ).process?.state,
        )
        .toBe("idle");
      expect(prepared.sessionId).not.toBe(
        "019a0000-cccc-7ccc-8ccc-cccccccccccc",
      );
      expect(
        (await owned.requests()).filter((r) => r.method === "turn/start"),
      ).toHaveLength(0);
      const path = `/projects/${owned.projectId}/sessions/${prepared.sessionId}`;
      const detail = async () => await (await owned.request(path)).json();
      expect((await detail()).session.creation).toMatchObject({
        state: "bound",
        initialInputExpected: false,
        delivery: "not-admitted",
      });
      const origin = owned.server.baseUrl;
      const page = await context.newPage();
      await page.goto(origin + path);
      const composer = page.locator("textarea[data-composer-input]").first();
      await expect(composer).toBeEditable();
      if (!hosted) {
        await recordUiCapture(page, "prepared-session-first-input-desktop");
        await page.setViewportSize({ width: 375, height: 812 });
        await recordUiCapture(page, "prepared-session-first-input-phone");
      }
      let input = "";
      for (const c of "OWNED_PREPARED_FIRST_TURN") {
        await composer.pressSequentially(c);
        input += c;
        await expect(composer).toHaveValue(input, { timeout: 100 });
      }
      await composer.press("Enter");
      await expect
        .poll(
          async () =>
            (await owned.requests()).filter((r) => r.method === "turn/start")
              .length,
        )
        .toBe(1);
      await owned.releaseAck();
      await owned.releaseReply();
      await expect
        .poll(async () => JSON.stringify((await detail()).messages))
        .toContain("OWNED_CODEX_CREATION_REPLY");
      await context.close();
      await owned.restart();
      expect(JSON.stringify((await detail()).messages)).toContain(
        "OWNED_CODEX_CREATION_REPLY",
      );
      expect((await detail()).session.id).toBe(prepared.sessionId);
      expect(
        (await owned.requests()).filter((r) => r.method === "thread/start"),
      ).toHaveLength(1);
    } finally {
      await context.close();
      await owned.close();
    }
  });

test("native v0 creation retains the trusted receipt/input identity and public id through restart", async () => {
  const owned = await createCodexCreationFixture(false);
  try {
    const settings = await fetch(`${owned.server.baseUrl}/api/settings`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ agentApiManagementEnabled: true }),
    });
    expect(settings.status).toBe(200);
    const registered = await owned.request("/projects", {
      path: Buffer.from(owned.projectId, "base64url").toString(),
      gitInit: false,
    });
    expect(registered.status).toBe(200);
    const identity = await (
      await fetch(`${owned.server.baseUrl}/v0/me`, { headers })
    ).json();
    const path = `/v0/servers/${identity.server.id}`;
    const body = {
      projectId: owned.projectId,
      provider: "codex",
      model: "gpt-6.1-sol",
      prompt: "OWNED_NATIVE_CREATION",
    };
    // v0 takes the request identity from this header; the replay after
    // restart reuses it.
    const creation = { ...headers, "Idempotency-Key": randomUUID() };
    const create = () =>
      fetch(`${owned.server.baseUrl}${path}/sessions`, {
        method: "POST",
        headers: creation,
        body: JSON.stringify(body),
      });
    const initial = await create();
    expect(initial.status).toBe(202);
    const receipt = await initial.json();
    const read = async () =>
      await (
        await fetch(`${owned.server.baseUrl}${path}/receipts/${receipt.id}`, {
          headers,
        })
      ).json();
    await expect.poll(async () => (await read()).sessionId).toBeTruthy();
    const publicId = (await read()).sessionId;
    expect(publicId).not.toBe("019a0000-cccc-7ccc-8ccc-cccccccccccc");
    await expect
      .poll(
        async () =>
          (await owned.requests()).filter((r) => r.method === "turn/start")
            .length,
      )
      .toBe(1);
    expect(
      (await owned.requests()).find((r) => r.method === "turn/start").params
        .clientUserMessageId,
    ).toBe(receipt.id);
    const detailPath = `/projects/${owned.projectId}/sessions/${publicId}`;
    expect(
      (await (await owned.request(detailPath)).json()).session.creation
        .delivery,
    ).not.toBe("consumed");
    await owned.releaseAck();
    await owned.releaseReply();
    await expect
      .poll(
        async () =>
          (await (await owned.request(detailPath)).json()).session.creation
            .delivery,
      )
      .toBe("consumed");
    expect((await read()).creator.principal.kind).toBe("superuser");
    await owned.restart();
    const replay = await create();
    expect(replay.status).toBe(202);
    expect(await replay.json()).toMatchObject({
      id: receipt.id,
      sessionId: publicId,
      creator: receipt.creator,
    });
    expect(
      (await owned.requests()).filter((r) => r.method === "thread/start"),
    ).toHaveLength(1);
    expect(
      (await owned.requests()).filter((r) => r.method === "turn/start"),
    ).toHaveLength(1);
  } finally {
    await owned.close();
  }
});

test("keyed source review saves its web origin and association before startup and recovers one target", async () => {
  const owned = await createCodexCreationFixture(false);
  try {
    expect(
      (
        await fetch(`${owned.server.baseUrl}/api/settings`, {
          method: "PUT",
          headers,
          body: JSON.stringify({ sourceReviewSubmissionsEnabled: true }),
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await owned.request("/projects", {
          path: Buffer.from(owned.projectId, "base64url").toString(),
          gitInit: false,
        })
      ).status,
    ).toBe(200);
    const created = await owned.request(
      `/projects/${owned.projectId}/review/comments`,
      {
        anchor: {
          path: "missing.ts",
          revision: { kind: "uncommitted", savedAt: "2026-11-02T00:00:00Z" },
          side: "new",
          oldLine: null,
          newLine: 1,
          snippet: "owned",
        },
        text: "OWNED_REVIEW_CREATION",
      },
    );
    expect(created.status).toBe(201);
    const comment = (await created.json()).comment;
    const body = {
      include: [comment.id],
      target: "new",
      submissionId: randomUUID(),
      newSession: { provider: "codex", model: "gpt-6.1-sol" },
    };
    const submit = () =>
      fetch(
        `${owned.server.baseUrl}/api/projects/${owned.projectId}/review/submit`,
        {
          method: "POST",
          headers: { ...headers, "X-Yep-Client-Surface": "web" },
          body: JSON.stringify(body),
        },
      );
    const first = await submit();
    expect([200, 202], await first.clone().text()).toContain(first.status);
    const result = await first.json();
    expect(result.sessionId).toBeTruthy();
    const detailPath = `/projects/${owned.projectId}/sessions/${result.sessionId}`;
    const detail = async () => await (await owned.request(detailPath)).json();
    expect((await detail()).session.creationProvenance).toEqual({
      surface: "web",
    });
    expect((await detail()).session.creation).toBeTruthy();
    await owned.releaseAck();
    await owned.releaseReply();
    await expect
      .poll(async () => (await detail()).session.creation.delivery)
      .toBe("consumed");
    await owned.restart();
    const replay = await submit();
    expect([200, 202]).toContain(replay.status);
    expect((await replay.json()).sessionId).toBe(result.sessionId);
    expect(
      (await owned.requests()).filter((r) => r.method === "thread/start"),
    ).toHaveLength(1);
    expect(
      (await owned.requests()).filter((r) => r.method === "turn/start"),
    ).toHaveLength(1);
  } finally {
    await owned.close();
  }
});

for (const hosted of [false, true])
  test(`admitted Codex fork ${hosted ? "hosted" : "local"} is visible before copying and cold-continues under its public id`, async ({
    browser,
  }) => {
    const owned = await createCodexCreationFixture(
      hosted,
      false,
      {},
      { serveBuiltClient: true },
    );
    let context = await browser.newContext({
      serviceWorkers: "block",
      viewport: { width: 1000, height: 600 },
    });
    let copying: Promise<Response> | undefined;
    try {
      await owned.releaseAck();
      await owned.releaseReply();
      const parent = await (
        await owned.request(`/projects/${owned.projectId}/session-creations`, {
          requestId: crypto.randomUUID(),
          provider: "codex",
          model: "gpt-6.1-sol",
          message: "OWNED_COPY_PARENT",
        })
      ).json();
      expect(parent.sessionId).toBeTruthy();
      const detail = async (id: string) =>
        await (
          await owned.request(`/projects/${owned.projectId}/sessions/${id}`)
        ).json();
      await expect
        .poll(async () =>
          JSON.stringify((await detail(parent.sessionId)).messages),
        )
        .toContain("OWNED_CODEX_CREATION_REPLY");
      copying = owned.request(
        `/projects/${owned.projectId}/sessions/${parent.sessionId}/fork`,
        { creationProvenance: { surface: "web" } },
      );
      await expect
        .poll(
          async () =>
            (await owned.requests()).filter((r) => r.method === "thread/fork")
              .length,
        )
        .toBe(1);
      const rows = await (
        await owned.request(`/projects/${owned.projectId}/sessions`)
      ).json();
      const child = rows.sessions.find(
        (row: { creation?: { kind?: string } }) =>
          row.creation?.kind === "copy",
      );
      expect(child?.id).toBeTruthy();
      expect(child.id).not.toBe(parent.sessionId);
      expect((await detail(child.id)).session).toMatchObject({
        id: child.id,
        creation: {
          kind: "copy",
          state: "dispatching",
          initialInputExpected: false,
        },
        creationProvenance: { surface: "web" },
        forkedFromSessionId: parent.sessionId,
      });
      let page = await context.newPage();
      const path = `/projects/${owned.projectId}/sessions/${child.id}`;
      await page.goto(`${owned.server.baseUrl}${path}`);
      await expect(
        page.getByRole("region", { name: "Session startup" }),
      ).toHaveCount(0);
      let composer = page.locator("textarea[data-composer-input]").first();
      await expect(composer).not.toBeEditable();
      if (!hosted) {
        await recordUiCapture(page, "admitted-copy-before-native-desktop");
        await page.setViewportSize({ width: 375, height: 812 });
        await recordUiCapture(page, "admitted-copy-before-native-phone");
      }
      await owned.releaseFork();
      const response = await copying;
      expect(response.status, await response.clone().text()).toBe(200);
      expect((await response.json()).sessionId).toBe(child.id);
      await expect
        .poll(async () => (await detail(child.id)).session.creation.state)
        .toBe("bound");
      const viewport = page.viewportSize();
      await context.close();
      await owned.restart();
      context = await browser.newContext({ serviceWorkers: "block", viewport });
      page = await context.newPage();
      await page.goto(`${owned.server.baseUrl}${path}`);
      composer = page.locator("textarea[data-composer-input]").first();
      await expect(composer).toBeEditable();
      let input = "";
      for (const c of "OWNED_COPY_CONTINUATION") {
        await composer.pressSequentially(c);
        input += c;
        await expect(composer).toHaveValue(input, { timeout: 100 });
      }
      await composer.press("Enter");
      await expect
        .poll(
          async () =>
            (await owned.requests()).filter((r) => r.method === "turn/start")
              .length,
        )
        .toBe(2);
      const calls = await owned.requests(),
        fork = calls.find((r) => r.method === "thread/fork"),
        resume = calls.find((r) => r.method === "thread/resume");
      expect(fork.params.threadId).not.toBe(parent.sessionId);
      expect(resume.params.threadId).not.toBe(child.id);
      expect(resume.params.threadId).not.toBe(fork.params.threadId);
      expect(resume.params.path).toContain(resume.params.threadId);
      expect(calls.filter((r) => r.method === "thread/start")).toHaveLength(1);
      expect(calls.filter((r) => r.method === "thread/fork")).toHaveLength(1);
      expect((await detail(child.id)).session).toMatchObject({
        id: child.id,
        creationProvenance: { surface: "web" },
      });
    } finally {
      await context.close();
      await owned.releaseFork();
      await copying?.catch(() => {});
      await owned.close();
    }
  });
