import { describe, expect, it } from "vitest";
import { app } from "../src/app.js";
import { MockServerClaudeProvider } from "../src/sdk/mock.js";
import { ScriptedClaudeProvider } from "./support/scripted-provider.js";
import { createApp } from "./setup/create-app.js";

describe("GET /health", () => {
  it("returns ok status", async () => {
    const res = await app.request("/health");
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.status).toBe("ok");
    expect(json.timestamp).toBeDefined();
  });

  it("allows macOS Tauri desktop origin in the full app", async () => {
    const { app } = createApp({ provider: new ScriptedClaudeProvider() });
    const res = await app.request("/health", {
      headers: { Origin: "tauri://localhost" },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe(
      "tauri://localhost",
    );
  });

  it("allows Windows Tauri desktop origin in the full app", async () => {
    const { app } = createApp({ provider: new ScriptedClaudeProvider() });
    const res = await app.request("/health", {
      headers: { Origin: "http://tauri.localhost" },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe(
      "http://tauri.localhost",
    );
  });

  it("uses an explicit provider override for provider discovery", async () => {
    const { app } = createApp({ provider: new MockServerClaudeProvider() });
    const res = await app.request("/api/providers");
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.providers).toEqual([
      expect.objectContaining({
        name: "claude",
        models: [
          expect.objectContaining({ id: "mock-model", name: "Mock Model" }),
        ],
      }),
    ]);
  });

  it("keeps explicitly disabled apps out of provider discovery", async () => {
    const { app } = createApp({ provider: null });
    const res = await app.request("/api/providers");

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ providers: [] });
  });
});
