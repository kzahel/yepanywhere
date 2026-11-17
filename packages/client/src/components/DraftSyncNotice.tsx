import { useEffect, useState } from "react";
import type { DraftPayload } from "@yep-anywhere/shared";
import { useI18n } from "../i18n";
import {
  DRAFT_SYNC_STATUS_EVENT,
  acceptPendingDraft,
  draftAddress,
  draftSyncPending,
  resolvePendingDraft,
  retryPendingDraft,
  type DraftResolution,
  type PendingDraft,
} from "../lib/draftSyncStorage";
import { Banner } from "./ui/Banner";
import { Button } from "./ui/Button";
import styles from "./DraftSyncNotice.module.css";

function DraftPreview({ value }: { value: DraftPayload }) {
  const { t } = useI18n();
  const texts = Object.entries(value.fields).filter(
    ([key]) => !key.endsWith("/meta"),
  );
  return (
    <div className={styles.preview}>
      {texts.length ? (
        texts.map(([key, text]) => <pre key={key}>{text}</pre>)
      ) : (
        <p>{t("draftSyncEmpty")}</p>
      )}
      {value.attachments.length > 0 && (
        <div>
          <p>
            {t("draftSyncAttachments", { count: value.attachments.length })}
          </p>
          {value.attachments.map((attachment) => (
            <p key={attachment.id}>{attachment.originalName}</p>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Notices this tab's user dismissed, by draft and condition, so navigating
 * back does not resurrect them; a different condition shows again.
 */
const dismissedNotices = new Set<string>();
function noticeCondition(draft: PendingDraft): string | null {
  if (draft.error) return `${draft.key}|error:${draft.error}`;
  if (draft.recovery) return `${draft.key}|recovery`;
  // Overlapping edits still require an explicit review choice.
  return null;
}

/**
 * No action here erases the composer's text: the composer itself is where
 * text is deleted. Actions resolve sync state or drop a separate copy.
 */
function DraftNotice({ draft }: { draft: PendingDraft }) {
  const { t } = useI18n();
  const [reviewing, setReviewing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [changed, setChanged] = useState(false);
  const condition = noticeCondition(draft);
  const [, rerender] = useState(0);
  if (condition && dismissedNotices.has(condition)) return null;
  const dismiss = () => {
    if (!condition) return;
    dismissedNotices.add(condition);
    rerender((n) => n + 1);
  };
  const resolve = async (choice: DraftResolution) => {
    setBusy(true);
    const applied = await resolvePendingDraft(
      draft.key,
      choice,
      draft.remote?.revision ?? null,
    );
    setChanged(!applied);
    setBusy(false);
  };
  return (
    <Banner
      tone="warning"
      role="status"
      className={styles.notice}
      title={t(`draftSyncSlot_${draft.slot.kind}`)}
      data-draft-notice=""
      aria-label={t("draftSyncNotice")}
    >
      <div className={styles.summary}>
        <span>
          {draft.error === "local"
            ? t("draftSyncLocalFailure")
            : draft.error
              ? t("draftSyncWaiting")
              : draft.recovery
                ? t("draftSyncRecovery")
                : t("draftSyncPending")}
        </span>
        <div className={styles.summaryActions}>
          <Button
            onClick={() => setReviewing(!reviewing)}
            aria-expanded={reviewing}
          >
            {t("draftSyncReview")}
          </Button>
          {condition && (
            <Button onClick={dismiss} aria-label={t("draftSyncDismiss")}>
              {t("draftSyncDismissShort")}
            </Button>
          )}
        </div>
      </div>
      {reviewing && (
        <div className={styles.review}>
          {changed && <p>{t("draftSyncChanged")}</p>}
          <div className={styles.versions}>
            <section>
              <h4>{t("draftSyncMine")}</h4>
              <DraftPreview value={draft.local} />
            </section>
            {(draft.remote || draft.submitted) && (
              <section>
                <h4>
                  {draft.remote ? t("draftSyncOther") : t("draftSyncSubmitted")}
                </h4>
                <DraftPreview
                  value={draft.remote?.payload ?? draft.submitted!}
                />
              </section>
            )}
          </div>
          <div className={styles.actions}>
            {draft.error || draft.recovery ? (
              <>
                <Button
                  variant="primary"
                  onClick={() =>
                    draft.error
                      ? retryPendingDraft(draft.key)
                      : acceptPendingDraft(draft.key)
                  }
                >
                  {draft.error ? t("draftSyncRetry") : t("draftSyncRecover")}
                </Button>
                {!draft.error && draft.submitted && (
                  <Button
                    variant="danger-outline"
                    onClick={() => acceptPendingDraft(draft.key, false)}
                  >
                    {t("draftSyncDiscardRecoveryCopy")}
                  </Button>
                )}
              </>
            ) : (
              <>
                <Button disabled={busy} onClick={() => void resolve("local")}>
                  {t("draftSyncKeepMine")}
                </Button>
                <Button disabled={busy} onClick={() => void resolve("remote")}>
                  {t("draftSyncUseOther")}
                </Button>
                <Button disabled={busy} onClick={() => void resolve("combine")}>
                  {t("draftSyncCombine")}
                </Button>
              </>
            )}
            <Button disabled={busy} onClick={() => setReviewing(false)}>
              {t("draftSyncClose")}
            </Button>
          </div>
        </div>
      )}
    </Banner>
  );
}

/** Session composers also expose that session's question/comment recovery. */
export function DraftSyncNotice({
  draftKey,
  sessionId,
}: {
  draftKey: string;
  sessionId?: string;
}) {
  const [pending, setPending] = useState<PendingDraft[]>([]);
  const address = draftAddress(draftKey);
  const source = address?.source;
  useEffect(() => {
    const update = () => setPending(draftSyncPending(source));
    window.addEventListener(DRAFT_SYNC_STATUS_EVENT, update);
    update();
    return () => window.removeEventListener(DRAFT_SYNC_STATUS_EVENT, update);
  }, [source]);
  return (
    <>
      {pending
        .filter(
          (draft) =>
            draft.key === draftKey ||
            (!!sessionId && draft.slot.sessionId === sessionId),
        )
        .map((draft) => (
          <DraftNotice key={draft.key} draft={draft} />
        ))}
    </>
  );
}
