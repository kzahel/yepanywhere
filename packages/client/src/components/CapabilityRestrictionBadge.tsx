import type {
  CapabilityRestrictionEvent,
  CapabilityRestrictionSummary,
} from "@yep-anywhere/shared/transcript/capabilityRestriction";
import type { Message } from "@yep-anywhere/shared/transcript/message";
import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { sessionCapabilityRestriction } from "../lib/capabilityRestriction";
import { useMinuteNow } from "../hooks/useRelativeNow";
import { useTextTooltipAttributes } from "../hooks/useTooltipAppearance";
import { useI18n } from "../i18n";
import { toBrowserAppHref } from "../lib/appHref";
import { formatCompactRelativeAge, parseTimestampMs } from "../lib/messageAge";
import styles from "./CapabilityRestrictionBadge.module.css";
import { Button } from "./ui/Button";
import { Menu, MenuGroup, MenuLinkItem, useMenuTrigger } from "./ui/Menu";

function RestrictedIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 3 5 6v5c0 4.5 2.9 8.3 7 10 4.1-1.7 7-5.5 7-10V6l-7-3Z" />
      <path d="m9 10.5 3 3 3-3" />
    </svg>
  );
}

function RestrictionEventRow({
  event,
  sessionHref,
  nowMs,
}: {
  event: CapabilityRestrictionEvent;
  /** Router path of the session whose transcript holds the event's row. */
  sessionHref: string;
  nowMs: number;
}) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const href = `${sessionHref}?${new URLSearchParams({ searchMatch: event.messageId })}`;
  const atMs = parseTimestampMs(event.at);
  const details = [
    event.category &&
      t("capabilityRestrictionCategory", { category: event.category }),
    event.scope === "response" && t("capabilityRestrictionOneReply"),
    atMs !== null && formatCompactRelativeAge(atMs, nowMs),
  ].filter(Boolean);
  return (
    <MenuLinkItem
      href={toBrowserAppHref(href)}
      description={details.join(" · ") || undefined}
      onNavigate={(click) => {
        click.preventDefault();
        navigate(href);
      }}
    >
      <span className={styles.models}>
        {t("capabilityRestrictionModels", {
          from: event.fromModel,
          to: event.toModel,
        })}
      </span>
    </MenuLinkItem>
  );
}

/** The badge for an open session, current with its loaded transcript. */
export function SessionCapabilityRestrictionBadge({
  summary,
  messages,
  ...badge
}: {
  summary: CapabilityRestrictionSummary | undefined;
  messages: readonly Message[];
  sessionHref: string;
  compact?: boolean;
}) {
  // One pass of two property reads per row; a streaming tick repeats it.
  const restriction = useMemo(
    () => sessionCapabilityRestriction(summary, messages),
    [summary, messages],
  );
  return <CapabilityRestrictionBadge restriction={restriction} {...badge} />;
}

/**
 * Restricted capability badge: shown once a session's transcript records a
 * refusal fallback, and lists each one as a link to its transcript row.
 * Warning-colored while the fallback model is still the one answering.
 */
export function CapabilityRestrictionBadge({
  restriction,
  sessionHref,
  compact = false,
}: {
  restriction: CapabilityRestrictionSummary | undefined;
  sessionHref: string;
  /** Icon only, for narrow headers and list rows. */
  compact?: boolean;
}) {
  const { t } = useI18n();
  const menu = useMenuTrigger();
  const nowMs = useMinuteNow();
  const activeModel = restriction?.activeModel;
  const status = activeModel
    ? t("capabilityRestrictionActive", { model: activeModel })
    : t("capabilityRestrictionInactive");
  const tooltip = useTextTooltipAttributes(status);
  if (!restriction) return null;
  return (
    <>
      <Button
        variant={activeModel ? "attention-outline" : "secondary"}
        size="dense"
        {...menu.triggerProps}
        className={styles.trigger}
        aria-label={status}
        data-capability-restriction={activeModel ? "active" : "past"}
        {...tooltip}
      >
        <RestrictedIcon />
        {activeModel && !compact && (
          <span>{t("capabilityRestrictionLabel")}</span>
        )}
      </Button>
      <Menu
        open={menu.open}
        onClose={menu.close}
        anchorRef={menu.anchorRef}
        placement="bottom-end"
        maxHeight="min(60vh, 520px)"
        aria-label={t("capabilityRestrictionTitle")}
      >
        <MenuGroup label={t("capabilityRestrictionTitle")}>
          <p className={styles.status}>
            {activeModel
              ? t("capabilityRestrictionActiveStatus", { model: activeModel })
              : t("capabilityRestrictionInactiveStatus")}
          </p>
          {restriction.omitted && (
            <p className={styles.status}>
              {t("capabilityRestrictionEarlierOmitted")}
            </p>
          )}
          {[...restriction.events].reverse().map((event) => (
            <RestrictionEventRow
              key={event.messageId}
              event={event}
              sessionHref={sessionHref}
              nowMs={nowMs}
            />
          ))}
        </MenuGroup>
      </Menu>
    </>
  );
}
