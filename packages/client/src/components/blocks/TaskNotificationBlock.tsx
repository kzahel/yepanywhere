import { memo } from "react";
import { getFilename } from "../../lib/parseUserPrompt";
import type { TaskNotificationItem } from "@yep-anywhere/shared/transcript/items";

interface Props {
  item: TaskNotificationItem;
}

/** Map a task status to a chip variant + leading glyph. */
function statusPresentation(status: string | undefined): {
  variant: string;
  icon: string;
} {
  switch (status) {
    case "completed":
      return { variant: "task-notification-completed", icon: "✓" };
    case "failed":
    case "error":
      return { variant: "task-notification-failed", icon: "!" };
    case "cancelled":
    case "canceled":
      return { variant: "task-notification-cancelled", icon: "⊘" };
    default:
      // No terminal status (e.g. a streaming Monitor progress event).
      return { variant: "task-notification-progress", icon: "⟳" };
  }
}

/**
 * Renders a Claude Code `<task-notification>` as an event chip. The summary line
 * is the human-readable text the SDK wrote (e.g. `Background command "…"
 * completed (exit code 0)`); status drives the icon/color. Progress events carry
 * a streaming `<event>` log body, shown in full inline beneath the summary.
 */
export const TaskNotificationBlock = memo(function TaskNotificationBlock({
  item,
}: Props) {
  const { variant, icon } = statusPresentation(item.status);
  const label = item.summary ?? item.raw.trim();

  return (
    <div className={`task-notification ${variant}`.trim()}>
      <div className="task-notification-head">
        <span className="task-notification-icon" aria-hidden="true">
          {icon}
        </span>
        <span className="task-notification-summary">{label}</span>
        {item.outputFile && (
          <span className="task-notification-output" title={item.outputFile}>
            {getFilename(item.outputFile)}
          </span>
        )}
      </div>
      {item.event && (
        <pre className="task-notification-event">{item.event.trim()}</pre>
      )}
    </div>
  );
});
