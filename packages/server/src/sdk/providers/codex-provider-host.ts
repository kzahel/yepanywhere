import type { ModelInfo } from "@yep-anywhere/shared";
import type { CodexAppServerClient } from "./codex-app-server-client.js";

/**
 * The provider services that Codex helpers outside `CodexProvider` may use.
 * The provider builds it from arrows that call its own methods at call time,
 * so a test that spies on a provider method after construction still takes
 * effect through the host.
 */
export interface CodexProviderHost {
  readonly name: "codex";
  resolveCodexCommand(): Promise<string>;
  getCodexEnv(): NodeJS.ProcessEnv;
  initializeAppServer(
    appServer: CodexAppServerClient,
    clientName?: string,
    mcpAppViews?: boolean,
  ): Promise<boolean>;
  getAvailableModels(): Promise<ModelInfo[]>;
}
