import type { PermissionMode } from "@yep-anywhere/shared";
import type {
  AntigravityRuntime,
  AntigravitySessionSetup,
  AntigravityUpdate,
} from "./antigravity-runtime.js";

/**
 * `agy`'s native mode for a YA permission mode. It has no bypass mode: a
 * bypass session's server launched with `--dangerously-skip-permissions`
 * and keeps `default`.
 */
function nativeMode(mode: PermissionMode): string {
  switch (mode) {
    case "acceptEdits":
      return "accept-edits";
    case "auto":
    case "plan":
      return mode;
    default:
      return "default";
  }
}

/** Whether a runtime's session setup offers YA's Auto (`agy` 1.5.18 does). */
export function antigravityOffersAuto(setup: AntigravitySessionSetup): boolean {
  return !!setup.modes?.availableModes.some((entry) => entry.id === "auto");
}

/**
 * One session's native mode, set before each prompt from the mode that
 * prompt's input carries, so a mode chosen mid-session (looser or tighter)
 * applies from the next prompt. Steering joins the running prompt's mode.
 */
export class AntigravityModeControl {
  private readonly offered: Set<string>;
  private current: string | undefined;

  constructor(
    private readonly runtime: AntigravityRuntime,
    private readonly sessionId: string,
    setup: AntigravitySessionSetup,
  ) {
    this.offered = new Set(
      setup.modes?.availableModes.map((entry) => entry.id) ?? ["default"],
    );
    // ACP: a setup without modes is an agent without session modes.
    this.current = setup.modes?.currentModeId ?? "default";
  }

  /** At launch a mode the runtime does not offer fails the start. */
  async launch(mode: PermissionMode | undefined): Promise<void> {
    if (!mode) return;
    if (!this.offered.has(nativeMode(mode)))
      throw new Error(`Antigravity does not offer the ${mode} permission mode`);
    await this.set(nativeMode(mode));
  }

  /**
   * Before a prompt: a mode the runtime does not offer runs as Ask, never
   * as something looser. Returns the YA mode applied.
   */
  async prompt(mode: PermissionMode): Promise<PermissionMode> {
    const applied = this.offered.has(nativeMode(mode)) ? mode : "default";
    await this.set(nativeMode(applied));
    return applied;
  }

  /** `agy` reports its mode when it changes, including on its own. */
  observe(update: AntigravityUpdate): void {
    const { currentModeId } = update as { currentModeId?: unknown };
    if (
      update.sessionUpdate === "current_mode_update" &&
      typeof currentModeId === "string"
    )
      this.current = currentModeId;
  }

  private async set(modeId: string): Promise<void> {
    if (modeId === this.current) return;
    await this.runtime.call("session/set_mode", {
      sessionId: this.sessionId,
      modeId,
    });
    this.current = modeId;
  }
}
