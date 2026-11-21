import type { EffortLevel } from "@yep-anywhere/shared";

const DEFAULT_IN_PROGRESS_REASON =
  "Session configuration change is in progress";
const DEFAULT_ROLLBACK_FAILED_REASON =
  "Session configuration rollback failed; queued work is paused until recovered";

/**
 * Holds queue delivery across multi-step live configuration transitions and
 * keeps queued work paused if a rollback fails until a later switch recovers.
 */
export class ConfigurationHold {
  private _reason: string | null = null;

  get active(): boolean {
    return this._reason !== null;
  }

  get reason(): string | null {
    return this._reason;
  }

  async run<T>(
    fn: (keepHeld: () => void) => Promise<T>,
    onRelease: () => void,
  ): Promise<T> {
    const priorReason = this._reason;
    this._reason = priorReason ?? DEFAULT_IN_PROGRESS_REASON;
    let release = true;
    let recovered = false;
    try {
      const result = await fn(() => {
        release = false;
        this._reason = DEFAULT_ROLLBACK_FAILED_REASON;
      });
      recovered = result !== false;
      return result;
    } finally {
      if (release && (recovered || !priorReason)) {
        this._reason = null;
        onRelease();
      } else if (release && priorReason) {
        this._reason = priorReason;
      }
    }
  }
}

export async function applyModelAndEffort(
  setModel: (model?: string) => Promise<void>,
  setEffort: (effort?: EffortLevel) => Promise<void>,
  next: { model?: string; effort?: EffortLevel },
  previous: { model?: string; effort?: EffortLevel },
  keepHeld: () => void,
): Promise<void> {
  try {
    await setModel(next.model);
    await setEffort(next.effort);
  } catch (error) {
    try {
      await setModel(previous.model);
      await setEffort(previous.effort);
    } catch (rollbackError) {
      keepHeld();
      throw new Error(DEFAULT_ROLLBACK_FAILED_REASON, {
        cause: new AggregateError([error, rollbackError]),
      });
    }
    throw error;
  }
}
