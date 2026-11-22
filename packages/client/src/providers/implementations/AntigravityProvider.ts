import type { Provider } from "../types";

export class AntigravityProvider implements Provider {
  readonly id = "antigravity";
  readonly displayName = "Antigravity";
  readonly capabilities = {
    supportsDag: false,
    usesDurableOrderAnchors: true,
    usesDurableReplayIdentity: true,
    supportsCloning: false,
    needsApproxMessageDedup: false,
  };
  readonly metadata = {
    description:
      "Google's native Antigravity ACP agent using its existing sign-in.",
    limitations: [
      "Experimental local integration",
      "Requires the agy CLI 1.5.13 or later, signed in",
      "Text and file references only",
    ],
    website: "https://antigravity.google/docs/",
    cliName: "agy",
  };
}
