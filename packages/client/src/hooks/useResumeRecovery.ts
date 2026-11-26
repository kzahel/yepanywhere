import { useEffect, useRef } from "react";
import {
  RECOVERY_POLICY,
  RecoveryScheduler,
  observePageRecovery,
  realRecoveryClock,
} from "../lib/connection/RecoveryScheduler";

/** Initial acquisition only. Attached transports own their own recovery. */
export function useResumeRecovery(enabled: boolean, retry: () => void): void {
  const retryRef = useRef(retry);
  retryRef.current = retry;
  // Outlives each enabled interval so the cooldown spans a failed attempt.
  const scheduler = useRef<RecoveryScheduler<
    ReturnType<typeof setTimeout>
  > | null>(null);
  scheduler.current ??= new RecoveryScheduler(() => retryRef.current(), {
    clock: realRecoveryClock,
    isVisible: () => !document.hidden,
    policy: RECOVERY_POLICY,
  });
  useEffect(() => {
    const recovery = scheduler.current;
    if (!enabled || !recovery) return;
    recovery.arm();
    // Initial acquisition shows action buttons. Do not start a retry on
    // pointerdown/keydown and unmount those buttons before their click fires.
    const stopObserving = observePageRecovery(recovery, false);
    return () => {
      stopObserving();
      recovery.disarm();
    };
  }, [enabled]);
}
