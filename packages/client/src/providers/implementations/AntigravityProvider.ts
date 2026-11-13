import type { Provider } from "../types";

export class AntigravityProvider implements Provider {
  readonly id = "antigravity";
  readonly displayName = "Antigravity";
  readonly capabilities = {
    supportsDag: false,
    supportsCloning: false,
    needsApproxMessageDedup: false,
  };
  readonly metadata = {
    description:
      "Google's native Antigravity ACP agent using its existing sign-in.",
    limitations: [
      "Experimental local integration",
      "Requires the agy CLI (or the standalone ACP runtime), signed in",
      "Text and file references only",
    ],
    website: "https://antigravity.google/docs/",
    cliName: "agy",
  };
}
