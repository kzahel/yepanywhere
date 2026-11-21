import type { ProviderName } from "./types.js";

export const RETIRED_GEMINI_MESSAGE =
  "Gemini CLI sessions are read-only. Start a new Antigravity session to continue.";

export function isRetiredProvider(
  provider: unknown,
): provider is Extract<ProviderName, "gemini" | "gemini-acp"> {
  return provider === "gemini" || provider === "gemini-acp";
}

export class RetiredProviderError extends Error {
  constructor() {
    super(RETIRED_GEMINI_MESSAGE);
    this.name = "RetiredProviderError";
  }
}

export function assertProviderExecutable(...providers: unknown[]): void {
  if (providers.some(isRetiredProvider)) throw new RetiredProviderError();
}
