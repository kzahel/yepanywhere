import { e2ePaths, expect, test } from "./fixtures.js";
import { recordUiCapture } from "./support/ui-capture.js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { providerHostRuntimeDir } from "./support/provider-host-runtime.js";

test.use({ serviceWorkers: "block" });

const templates = [
  {
    id: "app-canvas",
    title: "App canvas",
    description: "An interactive canvas to make your own.",
  },
  {
    id: "web-page",
    title: "Web page",
    description: "A page for an idea, a person, or a place.",
  },
  {
    id: "storybook",
    title: "Storybook",
    description: "Stories and pictures, one page at a time.",
  },
].map((item) => ({
  ...item,
  sourceId: "ya-default",
}));

// The browser boundary here is palette placement and real sequential input while
// choices refresh. Filesystem and retry semantics have server integration tests.
test("template palette preserves sequential input and inline state at desktop and phone widths", async ({
  page,
  baseURL,
}) => {
  // Optional capture input is the actual source library, never invented artwork.
  const artworkDirectory = process.env.YEP_E2E_TEMPLATE_ARTWORK_DIR;
  const choices = await Promise.all(
    templates.map(async (item) => ({
      ...item,
      icon: artworkDirectory
        ? `data:image/svg+xml;base64,${(await readFile(join(artworkDirectory, item.id, "icon.svg"))).toString("base64")}`
        : undefined,
    })),
  );
  await page.route("**/api/project-templates/choices", (route) =>
    route.fulfill({ json: { enabled: true, templates: choices } }),
  );
  for (const viewport of [
    { width: 1200, height: 600 },
    { width: 1000, height: 600 },
    { width: 375, height: 812 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto(`${baseURL}/projects`);
    await page
      .getByRole("button", { name: "Add Project", exact: true })
      .click();
    const form = page.getByRole("region", { name: "New project", exact: true });
    await expect(form.getByRole("radio")).toHaveCount(3);
    // The superuser's path entry comes first; typing there drops the chooser.
    const pathEntry = page.getByRole("textbox", { name: "Project path" });
    await recordUiCapture(page, `template-project-open-${viewport.width}`);
    await pathEntry.pressSequentially("~/src");
    await expect(pathEntry).toHaveValue("~/src", { timeout: 100 });
    await expect(form).toBeHidden();
    await recordUiCapture(page, `template-project-path-${viewport.width}`);
    await pathEntry.fill("");
    await expect(form).toBeVisible();
    const name = form.getByRole("textbox", { name: "Name", exact: true });
    let typed = "";
    for (const character of "Sketch garden") {
      typed += character;
      await name.pressSequentially(character);
      await expect(name).toHaveValue(typed, { timeout: 100 });
    }
    await form
      .getByRole("textbox", { name: "What would you like to make?" })
      .fill("A place to sketch ideas together");
    await form.getByRole("radio", { name: /Storybook/ }).check();
    await expect(name).toHaveValue("Sketch garden");
    await form.scrollIntoViewIfNeeded();
    await recordUiCapture(page, `template-project-${viewport.width}`);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);

    await page.goto(`${baseURL}/new-session`);
    await page
      .getByRole("button", { name: "New project", exact: true })
      .click();
    const inline = page.getByRole("region", {
      name: "New project",
      exact: true,
    });
    // Empty folder leads the same palette as the templates.
    await expect(inline.getByRole("radio")).toHaveCount(4);
    await expect(
      inline.getByRole("radio", { name: /Empty folder/ }),
    ).toBeChecked();
    await inline
      .getByRole("textbox", { name: "Name or path", exact: true })
      .fill("My story");
    await inline.getByRole("radio", { name: /Web page/ }).check();
    const prepare = page.getByRole("button", {
      name: "Create & prepare",
      exact: true,
    });
    const slotBounds = await prepare.locator("xpath=../..").boundingBox();
    const layoutBounds = await page
      .locator("[data-new-session-top-layout]")
      .boundingBox();
    expect(slotBounds!.width).toBeGreaterThan(layoutBounds!.width * 0.9);
    await page
      .getByRole("button", { name: "New project", exact: true })
      .click();
    await expect(inline).toBeHidden();
    await expect(prepare).toBeHidden();
    await page
      .getByRole("button", { name: "New project", exact: true })
      .click();
    await expect(
      inline.getByRole("textbox", { name: "Name or path", exact: true }),
    ).toHaveValue("My story");
    await expect(inline.getByRole("radio", { name: /Web page/ })).toBeChecked();
    await page
      .locator("[data-new-session-project-chooser]")
      .evaluate((node) => node.scrollIntoView({ block: "start" }));
    await recordUiCapture(page, `template-session-${viewport.width}`);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  }
});

for (const limited of [false, true]) {
  test(`creates a fresh template project as ${limited ? "a limited user" : "the superuser"} through the real UI and retains the operation after reload`, async ({
    page,
    request,
    baseURL,
  }) => {
    test.skip(
      process.env.USE_MOCK_SDK !== "true",
      "This launch test requires the isolated mock provider, never the developer's provider credentials.",
    );
    const source = join(e2ePaths.tempDir, "template-source");
    const realSource = process.env.YEP_E2E_TEMPLATE_SOURCE;
    if (realSource) test.setTimeout(120_000);
    const selectedTemplate = realSource ? "app-canvas" : "starter";
    const selectedTitle = realSource ? /App canvas/ : /Starter/;
    const template = join(source, "templates", "starter");
    await mkdir(template, { recursive: true });
    await writeFile(
      join(source, "library.json"),
      JSON.stringify({ formatVersion: 1, bases: [], templates: ["starter"] }),
    );
    await writeFile(
      join(template, "template.json"),
      JSON.stringify({
        formatVersion: 1,
        kind: "template",
        status: "ready",
        id: "starter",
        title: "Starter",
        description: "A working static starter",
        extends: [],
        files: [
          { from: "setup.mjs", to: "setup.mjs" },
          { from: "app.json", to: ".project-template/app.json" },
          { from: "prepare.md", to: ".project-template/PREPARE.md" },
        ],
        overrides: [],
      }),
    );
    await writeFile(
      join(template, "setup.mjs"),
      'import {mkdirSync,writeFileSync} from "node:fs"; mkdirSync("dist"); writeFileSync("dist/index.html", "<h1>Starter ready</h1>");',
    );
    await writeFile(
      join(template, "app.json"),
      JSON.stringify({
        kind: "static",
        dir: "dist",
        setup: [process.execPath, "setup.mjs"],
        build: [process.execPath, "setup.mjs"],
        test: [process.execPath, "--version"],
        preview: [process.execPath, "--version"],
        prepare: ".project-template/PREPARE.md",
      }),
    );
    await writeFile(
      join(template, "prepare.md"),
      "Read the user intent and prepare the project.",
    );
    const headers = {
      "Content-Type": "application/json",
      "X-Yep-Anywhere": "true",
    };
    const previous = await (
      await request.get(`${baseURL}/api/project-template-source`, { headers })
    ).json();
    const previousSettings = await (
      await request.get(`${baseURL}/api/settings`, { headers })
    ).json();
    const projectName = limited ? "Limited garden" : "Browser garden";
    try {
      const configured = await request.put(
        `${baseURL}/api/project-template-source`,
        {
          headers,
          data: {
            enabled: true,
            sources: [
              {
                id: "browser",
                repository: realSource ?? source,
                contentPath: "",
                revision: "HEAD",
              },
            ],
          },
        },
      );
      expect(configured.status()).toBe(202);
      await expect
        .poll(
          async () =>
            (
              await (
                await request.get(`${baseURL}/api/project-template-source`, {
                  headers,
                })
              ).json()
            ).phase,
        )
        .toBe("ready");
      if (limited) {
        // The mock provider never starts the runtime host; sandbox preflight
        // still requires its configured private directory to exist.
        await mkdir(providerHostRuntimeDir(e2ePaths.tempDir), {
          recursive: true,
        });
        const created = await request.post(`${baseURL}/api/users`, {
          headers,
          data: {
            username: "template-user",
            password: "test-password",
            projectRoot: join(e2ePaths.tempDir, "archer", "projects"),
          },
        });
        expect(created.status()).toBe(201);
        await page.goto(`${baseURL}/settings/users`);
        const userChip = page.getByRole("button", {
          name: "template-user",
          exact: true,
        });
        await userChip.click();
        const grant = page.getByRole("group", {
          name: "New projects from templates",
          exact: true,
        });
        await expect(
          grant.getByRole("radio", {
            name: "Any configured template",
            exact: true,
          }),
        ).toBeChecked();
        await grant
          .getByRole("radio", { name: "Selected templates", exact: true })
          .check();
        await grant.getByRole("checkbox", { name: selectedTitle }).check();
        // Each choice saves as it is made; the editor stays open.
        await expect(page.getByText(/· Saved$/)).toBeVisible();
        for (const viewport of [
          { width: 1200, height: 600 },
          { width: 375, height: 812 },
        ]) {
          await page.setViewportSize(viewport);
          await page.goto(`${baseURL}/settings/users`);
          await userChip.click();
          await expect(
            grant.getByRole("checkbox", { name: selectedTitle }),
          ).toBeChecked();
          await grant.scrollIntoViewIfNeeded();
          await recordUiCapture(page, `template-user-grant-${viewport.width}`);
        }
        // Pressing the open user's name again closes the editor.
        await userChip.click();
        await expect(grant).toHaveCount(0);
        const saved = await (
          await request.get(`${baseURL}/api/users`, { headers })
        ).json();
        expect(
          saved.users.find(
            (user: { username: string }) => user.username === "template-user",
          ).templateCreation,
        ).toEqual({
          mode: "selected",
          templates: [{ sourceId: "browser", templateId: selectedTemplate }],
        });
        const switched = await page.request.post(
          `${baseURL}/api/users/switch`,
          { headers, data: { username: "template-user" } },
        );
        expect(switched.ok()).toBe(true);
      }
      await page.goto(`${baseURL}/projects`);
      await page
        .getByRole("button", { name: "Add Project", exact: true })
        .click();
      const form = page.getByRole("region", {
        name: "New project",
        exact: true,
      });
      await expect(form.getByRole("radio")).toHaveCount(1);
      await form
        .getByRole("textbox", { name: "Name", exact: true })
        .fill(projectName);
      await form
        .getByRole("textbox", { name: "What would you like to make?" })
        .fill("A garden sketchbook");
      if (!limited)
        await form
          .getByRole("textbox", { name: "Create in", exact: true })
          .fill(e2ePaths.tempDir);
      if (limited) {
        await expect(
          form.getByRole("textbox", { name: "Create in", exact: true }),
        ).toHaveCount(0);
        await expect(
          page.getByRole("button", { name: "Existing directory", exact: true }),
        ).toHaveCount(0);
        for (const viewport of [
          { width: 1200, height: 600 },
          { width: 375, height: 812 },
        ]) {
          await page.setViewportSize(viewport);
          await page.goto(`${baseURL}/projects`);
          await page
            .getByRole("button", { name: "Add Project", exact: true })
            .click();
          await form
            .getByRole("textbox", { name: "Name", exact: true })
            .fill(projectName);
          await form
            .getByRole("textbox", { name: "What would you like to make?" })
            .fill("A garden sketchbook");
          await form.scrollIntoViewIfNeeded();
          await recordUiCapture(
            page,
            `template-limited-project-${viewport.width}`,
          );
        }
      }
      if (limited) {
        await form
          .getByRole("textbox", { name: "What would you like to make?" })
          .evaluate((node) => {
            const transfer = new DataTransfer();
            const bytes = Uint8Array.from(
              atob(
                "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jGZkAAAAASUVORK5CYII=",
              ),
              (character) => character.charCodeAt(0),
            );
            transfer.items.add(
              new File([bytes], "pasted.png", { type: "image/png" }),
            );
            node.dispatchEvent(
              new ClipboardEvent("paste", {
                clipboardData: transfer,
                bubbles: true,
              }),
            );
          });
        await expect(
          form.getByRole("button", { name: "Remove pasted.png", exact: true }),
        ).toBeVisible();
        await expect(
          form.getByRole("button", { name: "Create & prepare" }),
        ).toBeEnabled();
      }
      const response = page.waitForResponse(
        (response) =>
          response.url().endsWith("/api/project-templates/operations") &&
          response.request().method() === "POST",
      );
      await form.getByRole("button", { name: "Create & prepare" }).click();
      const operation = await (await response).json();
      expect(operation.request, JSON.stringify(operation)).toBeDefined();
      if (limited)
        expect(operation.request.stagedAttachments.refs).toHaveLength(1);
      await page.reload();
      await page
        .getByRole("button", { name: "Add Project", exact: true })
        .click();
      await expect
        .poll(
          async () => {
            const result = await (
              await request.get(
                `${baseURL}/api/project-templates/operations/${operation.request.operationId}`,
                { headers },
              )
            ).json();
            if (result.phase === "failed")
              throw new Error(`${result.error}\n${result.log}`);
            return result.phase;
          },
          { timeout: 90_000 },
        )
        .toBe("started");
      await expect(page).toHaveURL(/\/projects\/[^/]+\/sessions\/[^/]+$/, {
        timeout: 15_000,
      });
      const outcome = await (
        await request.get(
          `${baseURL}/api/project-templates/operations/${operation.request.operationId}`,
          { headers },
        )
      ).json();
      expect(outcome.phase).toBe("started");
      if (limited) expect(outcome.ownerUsername).toBe("template-user");
      expect(
        await readFile(
          join(
            e2ePaths.tempDir,
            ...(limited ? ["archer", "projects"] : []),
            limited ? "limited-garden" : "browser-garden",
            "dist/index.html",
          ),
          "utf8",
        ),
      ).toContain(realSource ? "<html" : "Starter ready");
      if (limited) {
        await page.goto(
          `${baseURL}/new-session?projectId=${encodeURIComponent(outcome.projectId)}`,
        );
        const composer = page.locator("textarea[data-composer-input]");
        await composer.fill("Continue the garden with this image");
        await page
          .getByRole("button", { name: "Attach files", exact: true })
          .click({ button: "right" });
        const gallery = page.getByRole("region", {
          name: "Recent uploads",
          exact: true,
        });
        await expect(
          gallery.getByRole("button", { name: "pasted.png", exact: true }),
        ).toBeVisible();
        await recordUiCapture(page, "limited-recent-uploads");
        await gallery
          .getByRole("button", { name: "pasted.png", exact: true })
          .click();
        await expect(
          page.getByRole("region", { name: "Recent uploads", exact: true }),
        ).toHaveCount(0);
        const queued = page.waitForResponse(
          (response) =>
            response.url().includes("/messages") &&
            response.request().method() === "POST",
        );
        await page.locator("[data-new-session-submit-button]").click();
        expect((await queued).ok()).toBe(true);
        await expect(page).toHaveURL(/\/projects\/[^/]+\/sessions\/[^/]+$/);
      }
    } catch (error) {
      await test.info().attach("creation-state", {
        body: await page.locator("body").innerText(),
        contentType: "text/plain",
      });
      throw error;
    } finally {
      if (limited) {
        await page.request.post(`${baseURL}/api/users/logout`, { headers });
        await request.delete(`${baseURL}/api/users/template-user`, { headers });
        await request.patch(`${baseURL}/api/settings`, {
          headers,
          data: {
            limitedUsersEnabled: previousSettings.limitedUsersEnabled ?? false,
          },
        });
      }
      const restored = await request.put(
        `${baseURL}/api/project-template-source`,
        { headers, data: previous.config },
      );
      expect(restored.ok()).toBe(true);
    }
  });
}
