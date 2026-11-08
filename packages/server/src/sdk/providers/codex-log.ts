import { getLogger } from "../../logging/logger.js";

export const log = {
  debug(bindings: Record<string, unknown>, message: string): void {
    getLogger().debug({ component: "codex-provider", ...bindings }, message);
  },
  info(bindings: Record<string, unknown>, message: string): void {
    getLogger().info({ component: "codex-provider", ...bindings }, message);
  },
  warn(bindings: Record<string, unknown>, message: string): void {
    getLogger().warn({ component: "codex-provider", ...bindings }, message);
  },
  error(bindings: Record<string, unknown>, message: string): void {
    getLogger().error({ component: "codex-provider", ...bindings }, message);
  },
};
