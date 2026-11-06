import type { ProviderInfo } from "@yep-anywhere/shared";
import { describe, expect, it } from "vitest";
import {
  providerSupportsLocalSessionSandbox,
  resolveSessionProviderCapabilities,
  resolveSteerNowDefault,
} from "../providerCapabilities";

function provider(
  name: ProviderInfo["name"],
  supportsSteering?: boolean,
  supportsSteerNow?: boolean,
): ProviderInfo {
  return {
    name,
    displayName: name,
    installed: true,
    authenticated: true,
    enabled: true,
    supportsSteering,
    supportsSteerNow,
  };
}

describe("resolveSessionProviderCapabilities", () => {
  it("uses static Codex steering while provider metadata is still loading", () => {
    const capabilities = resolveSessionProviderCapabilities({
      providers: [],
      providerName: "codex",
    });

    expect(capabilities.providerInfo).toBeNull();
    expect(capabilities.generallySupportsSteering).toBe(true);
    expect(capabilities.supportsCurrentTurnSteering).toBe(true);
    expect(capabilities.supportsSteerNow).toBe(false);
  });

  it("uses fetched metadata once it is available", () => {
    const capabilities = resolveSessionProviderCapabilities({
      providers: [provider("codex", false)],
      providerName: "codex",
    });

    expect(capabilities.generallySupportsSteering).toBe(true);
    expect(capabilities.supportsCurrentTurnSteering).toBe(false);
    expect(capabilities.supportsSteerNow).toBe(false);
  });

  it("does not treat codex-oss as steerable without provider metadata", () => {
    const capabilities = resolveSessionProviderCapabilities({
      providers: [],
      providerName: "codex-oss",
    });

    expect(capabilities.generallySupportsSteering).toBe(false);
    expect(capabilities.supportsCurrentTurnSteering).toBe(false);
    expect(capabilities.supportsSteerNow).toBe(false);
  });

  it("honors non-Codex providers that advertise steering", () => {
    const capabilities = resolveSessionProviderCapabilities({
      providers: [provider("gemini", true)],
      providerName: "gemini",
    });

    expect(capabilities.generallySupportsSteering).toBe(true);
    expect(capabilities.supportsCurrentTurnSteering).toBe(true);
    expect(capabilities.supportsSteerNow).toBe(false);
  });

  it("uses static Grok steering while provider metadata is still loading", () => {
    const beforeMetadata = resolveSessionProviderCapabilities({
      providers: [],
      providerName: "grok",
    });
    expect(beforeMetadata.generallySupportsSteering).toBe(true);
    expect(beforeMetadata.supportsCurrentTurnSteering).toBe(true);
    expect(beforeMetadata.supportsSteerNow).toBe(false);

    const withMetadata = resolveSessionProviderCapabilities({
      providers: [provider("grok", true)],
      providerName: "grok",
    });
    expect(withMetadata.generallySupportsSteering).toBe(true);
    expect(withMetadata.supportsCurrentTurnSteering).toBe(true);
    expect(withMetadata.supportsSteerNow).toBe(false);
  });

  it("reports soft-immediate steering only when metadata says so", () => {
    const capabilities = resolveSessionProviderCapabilities({
      providers: [provider("claude", true, true)],
      providerName: "claude",
    });

    expect(capabilities.generallySupportsSteering).toBe(true);
    expect(capabilities.supportsCurrentTurnSteering).toBe(true);
    expect(capabilities.supportsSteerNow).toBe(true);
  });
});

describe("providerSupportsLocalSessionSandbox", () => {
  it.each(["claude", "claude-gateway", "claude-ollama", "codex"] as const)(
    "supports the implemented local %s backend",
    (providerName) => {
      expect(providerSupportsLocalSessionSandbox(providerName)).toBe(true);
    },
  );

  it.each([
    "codex-oss",
    "gemini",
    "gemini-acp",
    "grok",
    "opencode",
    "pi",
  ] as const)("hides the unimplemented %s backend", (providerName) => {
    expect(providerSupportsLocalSessionSandbox(providerName)).toBe(false);
  });
});

describe("resolveSteerNowDefault", () => {
  const defaults = {
    steerNowDefault: true,
    steerNowDefaultByProvider: { "claude-gateway": false },
  };

  it("prefers the provider's override, else inherits the global default", () => {
    expect(resolveSteerNowDefault(defaults, "claude-gateway")).toBe(false);
    expect(resolveSteerNowDefault(defaults, "claude")).toBe(true);
    expect(resolveSteerNowDefault({ steerNowDefault: false }, "claude")).toBe(
      false,
    );
    expect(resolveSteerNowDefault(undefined, undefined)).toBe(true);
  });
});
