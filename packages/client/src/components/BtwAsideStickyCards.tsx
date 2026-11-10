import { btwAsideStatusClasses } from "./btwAsideStatusClasses";
import btwStyles from "./BtwAsideTranscript.module.css";
import { useI18n } from "../i18n";
import { BtwAsideTranscript, type BtwAsidePaneItem } from "./BtwAsidePane";
import styles from "./BtwAsideStickyCards.module.css";
import { Banner } from "./ui/Banner";
import { Button, ButtonBase } from "./ui/Button";

export interface BtwAsideStickyCardItem extends BtwAsidePaneItem {
  preview?: string;
  expanded?: boolean;
}

interface BtwAsideStickyCardsProps {
  asides: BtwAsideStickyCardItem[];
  focusedAsideId: string | null;
  onFocusAside: (asideId: string) => void;
  onToggleAsideExpanded: (asideId: string) => void;
  onDoneAside: (asideId: string) => void;
  onHideAside: (asideId: string) => void;
  onStopAside: (asideId: string) => void;
  onTransferToComposer: (text: string) => void;
}

function canExpandBtwAside(aside: BtwAsideStickyCardItem): boolean {
  return Boolean(
    aside.request ||
      aside.followUps.length > 0 ||
      aside.responses.length > 0 ||
      (aside.turns?.length ?? 0) > 0,
  );
}

export function BtwAsideStickyCards({
  asides,
  focusedAsideId,
  onFocusAside,
  onToggleAsideExpanded,
  onDoneAside,
  onHideAside,
  onStopAside,
  onTransferToComposer,
}: BtwAsideStickyCardsProps) {
  const { t } = useI18n();

  if (asides.length === 0) {
    return null;
  }

  return (
    <div
      className={btwStyles.btwAsideStack}
      data-btw-aside-stack
      role="region"
      aria-label="/btw asides"
    >
      {asides.map((aside) => {
        const isFocused = focusedAsideId === aside.id;
        const canExpand = canExpandBtwAside(aside);
        return (
          <div
            key={aside.id}
            className={`${btwStyles.btwAsideCard} ${btwAsideStatusClasses[aside.status] ?? ""} ${
              isFocused ? `${btwStyles["is-focused"]}` : ""
            }`}
            data-btw-aside-card
            data-is-failed={aside.status === "failed" || undefined}
            data-is-stopped={aside.status === "stopped" || undefined}
            data-is-focused={isFocused || undefined}
          >
            <ButtonBase
              className={btwStyles.btwAsideMain}
              data-btw-aside-main
              onClick={() => onFocusAside(aside.id)}
            >
              <span className={btwStyles.btwAsideMeta} data-btw-aside-meta>
                /btw {aside.status}
              </span>
              <span
                className={btwStyles.btwAsideRequest}
                data-btw-aside-request
              >
                {aside.request || "New aside"}
              </span>
              {aside.followUps.length > 0 && (
                <span
                  className={btwStyles.btwAsideFollowups}
                  data-btw-aside-followups
                >
                  +{aside.followUps.length} follow-up
                  {aside.followUps.length === 1 ? "" : "s"}
                </span>
              )}
              {aside.preview && (
                <span
                  className={btwStyles.btwAsidePreview}
                  data-btw-aside-preview
                >
                  {aside.preview}
                </span>
              )}
            </ButtonBase>
            {aside.error && (
              <Banner tone="error" compact className={styles.failure}>
                {aside.error}
              </Banner>
            )}
            {aside.expanded && canExpand && (
              <BtwAsideTranscript
                aside={aside}
                autoScrollLatest
                onTransferToComposer={onTransferToComposer}
              />
            )}
            <div className={btwStyles.btwAsideActions} data-btw-aside-actions>
              {canExpand && (
                <Button
                  size="small"
                  className={btwStyles.btwAsideAction}
                  data-btw-aside-action
                  onClick={() => onToggleAsideExpanded(aside.id)}
                >
                  {aside.expanded ? "Less" : "Show"}
                </Button>
              )}
              {isFocused && (
                <Button
                  size="small"
                  className={btwStyles.btwAsideAction}
                  data-btw-aside-action
                  onClick={() => onDoneAside(aside.id)}
                  title={t("btwAsideReturnComposerTitle")}
                >
                  Done
                </Button>
              )}
              {(aside.status === "starting" || aside.status === "running") && (
                <Button
                  size="small"
                  className={btwStyles.btwAsideAction}
                  data-btw-aside-action
                  onClick={() => onStopAside(aside.id)}
                  title={
                    isFocused
                      ? "Stop this /btw aside and return to the main session"
                      : "Stop this /btw aside"
                  }
                >
                  Stop
                </Button>
              )}
              <Button
                size="small"
                className={btwStyles.btwAsideAction}
                data-btw-aside-action
                onClick={() => onHideAside(aside.id)}
                title={t("btwAsideMoveToHistoryTitle")}
              >
                Hide
              </Button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
