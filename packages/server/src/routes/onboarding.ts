import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";

interface OnboardingState {
  complete: boolean;
  completedAt?: string;
}

const ONBOARDING_FILE = "onboarding.json";

function loadOnboardingState(dataDir: string): OnboardingState {
  const filePath = join(dataDir, ONBOARDING_FILE);
  if (existsSync(filePath)) {
    try {
      return JSON.parse(readFileSync(filePath, "utf-8"));
    } catch {
      // If file is corrupted, treat as incomplete
    }
  }
  return { complete: false };
}

function saveOnboardingState(dataDir: string, state: OnboardingState): void {
  const filePath = join(dataDir, ONBOARDING_FILE);
  writeFileSync(filePath, JSON.stringify(state, null, 2));
}

export interface OnboardingRoutesOptions {
  dataDir: string;
}

export function createOnboardingRoutes(options: OnboardingRoutesOptions): Hono {
  const app = new Hono();

  // GET /api/onboarding - Get onboarding status
  app.get("/", (c) => {
    const state = loadOnboardingState(options.dataDir);
    return c.json({ complete: state.complete });
  });

  // POST /api/onboarding/complete - Mark onboarding as complete
  app.post("/complete", (c) => {
    const state: OnboardingState = {
      complete: true,
      completedAt: new Date().toISOString(),
    };
    saveOnboardingState(options.dataDir, state);
    return c.json({ success: true });
  });

  // POST /api/onboarding/reset - Reset onboarding (for re-launching)
  app.post("/reset", (c) => {
    const state: OnboardingState = { complete: false };
    saveOnboardingState(options.dataDir, state);
    return c.json({ success: true });
  });

  return app;
}
