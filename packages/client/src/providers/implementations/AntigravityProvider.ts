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
      "Experimental local integration; enable antigravity in ENABLED_PROVIDERS",
      "Requires the official ACP runtime, signed in externally",
      "Text and file references only",
    ],
    website: "https://antigravity.google/docs/",
    cliName: "agy_acp_server.par",
  };
}
