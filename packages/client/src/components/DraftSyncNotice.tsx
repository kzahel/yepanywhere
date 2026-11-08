import { useEffect, useState } from "react";
import type { DraftPayload } from "@yep-anywhere/shared";
import { useI18n } from "../i18n";
import {
  DRAFT_SYNC_STATUS_EVENT,
  acceptPendingDraft,
  discardPendingDraft,
  draftAddress,
  draftSyncPending,
  resolvePendingDraft,
  retryPendingDraft,
  type DraftResolution,
  type PendingDraft,
} from "../lib/draftSyncStorage";
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

function DraftNotice({ draft }: { draft: PendingDraft }) {
  const { t } = useI18n();
  const [reviewing, setReviewing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [changed, setChanged] = useState(false);
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
    <aside
      className={styles.notice}
      data-draft-notice=""
      role="status"
      aria-label={t("draftSyncNotice")}
    >
      <strong>{t(`draftSyncSlot_${draft.slot.kind}`)}</strong>
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
        <Button
          onClick={() => setReviewing(!reviewing)}
          aria-expanded={reviewing}
        >
          {t("draftSyncReview")}
        </Button>
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
                <Button
                  variant="danger-outline"
                  onClick={() => discardPendingDraft(draft.key)}
                >
                  {t("draftSyncDiscard")}
                </Button>
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
    </aside>
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
