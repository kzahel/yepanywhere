/**
 * Screen tour (plan 182): the main screens in dark and light at desktop and
 * phone sizes, against the isolated E2E server and its fixture profile.
 *
 * Run before and after a control-family swap batch to review the fallout
 * side by side. On demand only: the `.tour.ts` suffix keeps it out of the
 * ordinary E2E suite and CI. `pnpm design:tour` runs it with capture enabled;
 * `pnpm design:tour --grep settings` narrows it to matching screens.
 */
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { UI_KEYS } from "../../src/lib/storageKeys.js";
import { e2ePaths, expect, test } from "../fixtures.js";
import { recordUiCapture } from "../support/ui-capture.js";

const mockProjectId = Buffer.from(
  join(e2ePaths.tempDir, "mockproject"),
).toString("base64url");
const gitProjectId = Buffer.from(
  join(e2ePaths.tempDir, "source-control-qmd-project"),
).toString("base64url");

const THEMES = ["dark", "light"] as const;
const VIEWPORTS = [
  { name: "desktop", width: 1000, height: 600 },
  { name: "phone", width: 375, height: 812 },
] as const;

/** The settings categories, in the order the settings sidebar lists them. */
const SETTINGS = [
  "appearance",
  "issues",
  "performance",
  "toolbar",
  "model",
  "cache-miss-billing",
  "message-delivery",
  "source-control",
  "browser-extension",
  "storage",
  "agent-context",
  "notifications",
  "webhooks",
  "devices",
  "local-access",
  "users",
  "project-templates",
  "apps",
  "remote",
  "server-connections",
  "providers",
  "speech",
  "environment",
  "about",
  "emulator",
  "development",
];

interface Screen {
  name: string;
  path: string;
  /** Visible once the screen has its data. */
  ready: (page: Page) => Promise<void>;
  /**
   * Also capture a dark 1000×2400 view. Settings panes scroll inside the
   * page, so a full-page screenshot cannot reach controls below the fold;
   * a tall viewport can.
   */
  tall?: boolean;
}

const TALL = { name: "tall", width: 1000, height: 2400 } as const;

const SCREENS: Screen[] = [
  {
    name: "projects",
    path: "/projects",
    ready: (page) =>
      expect(page.getByText("mockproject").first()).toBeVisible(),
  },
  {
    name: "session",
    path: `/projects/${mockProjectId}/sessions/code-fence-mermaid-001`,
    ready: (page) =>
      expect(page.locator("[data-ya-code-rendered] svg")).toBeVisible({
        timeout: 20_000,
      }),
  },
  {
    name: "new-session",
    path: `/new-session?projectId=${mockProjectId}`,
    ready: (page) => expect(page.locator("textarea").first()).toBeVisible(),
  },
  {
    name: "file-viewer",
    path: `/projects/${gitProjectId}/file?path=report.qmd`,
    ready: (page) =>
      expect(
        page.getByText("report.qmd").filter({ visible: true }).first(),
      ).toBeVisible(),
  },
  {
    name: "source-control",
    path: `/git-status?projectId=${gitProjectId}`,
    ready: (page) =>
      expect(
        page.getByText("report.qmd", { exact: true }).first(),
      ).toBeVisible(),
  },
  ...SETTINGS.map(
    (category): Screen => ({
      name: `settings-${category}`,
      path: `/settings/${category}`,
      ready: (page) =>
        expect(page.locator(".page-scroll-container").first()).toBeVisible(),
      tall: true,
    }),
  ),
];

test.use({ serviceWorkers: "block" });

for (const screen of SCREENS) {
  test(screen.name, async ({ page, baseURL }) => {
    test.setTimeout(90_000);
    const shots: {
      theme: (typeof THEMES)[number];
      viewport: { name: string; width: number; height: number };
    }[] = THEMES.flatMap((theme) =>
      VIEWPORTS.map((viewport) => ({ theme, viewport })),
    );
    if (screen.tall) shots.push({ theme: "dark", viewport: TALL });
    for (const { theme, viewport } of shots) {
      // Init scripts run in the order added, so the latest theme wins.
      await page.addInitScript(
        ([key, value]) => localStorage.setItem(key, value),
        [UI_KEYS.theme, theme] as const,
      );
      await page.setViewportSize(viewport);
      await page.goto(`${baseURL}${screen.path}`);
      await screen.ready(page);
      // Best effort: settings sections load their data after first paint.
      await page
        .waitForLoadState("networkidle", { timeout: 5_000 })
        .catch(() => {});
      await page.evaluate(() => document.fonts.ready);
      // Park the pointer so no hover state or tooltip lands in the shot.
      await page.mouse.move(0, 0);
      await page.waitForTimeout(300);
      await recordUiCapture(
        page,
        `${screen.name}-${theme}-${viewport.name}`,
        viewport,
      );
    }
  });
}
