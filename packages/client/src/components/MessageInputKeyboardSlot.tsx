import type { ReactNode } from "react";
import actionStyles from "./ComposerActions.module.css";

/** Stable action-slot boundaries for the phone keyboard row. */
export function MessageInputKeyboardSlot({
  kind,
  children,
}: {
  kind: "projectQueue" | "newSession" | "sessionAlternate";
  children: ReactNode;
}) {
  return (
    <div
      className={actionStyles.messageInputKeyboardSecondarySlot}
      data-message-input-keyboard-secondary-slot
      data-message-input-keyboard-project-queue-slot={
        kind === "projectQueue" || undefined
      }
      data-message-input-keyboard-project-queue-new-session-slot={
        kind === "newSession" || undefined
      }
      data-message-input-keyboard-session-alternate-slot={
        kind === "sessionAlternate" || undefined
      }
    >
      {children}
    </div>
  );
}
