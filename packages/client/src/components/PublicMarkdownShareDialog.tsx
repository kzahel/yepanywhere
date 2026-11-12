import { useEffect, useRef, useState } from "react";
import type {
  CreatePublicFileShareResponse,
  ProjectFileLinks,
  PublicFileShareListResponse,
} from "@yep-anywhere/shared";
import { useCurrentSourceRuntime } from "../contexts/SourceRuntimeContext";
import { useCanUseBearerGrants } from "../hooks/useActingPrincipal";
import { useI18n } from "../i18n";
import { writeClipboardTextLater } from "../lib/clipboard";
import {
  copyFileKey,
  renderPublicMarkdownCopy,
  type PublicMarkdownCopy,
} from "../lib/publicMarkdownCopy";
import { Dialog } from "./ui/Dialog";
import { Button } from "./ui/Button";
import { Banner } from "./ui/Banner";
import { Field, Textarea } from "./ui/Field";

export function PublicMarkdownShareDialog({
  copy,
  apps,
  onClose,
}: {
  copy: PublicMarkdownCopy;
  apps: ReadonlyMap<string, ProjectFileLinks>;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const { transport } = useCurrentSourceRuntime();
  const canShare = useCanUseBearerGrants();
  const [working, setWorking] = useState(false);
  const [shares, setShares] = useState(new Map<string, string>());
  const [error, setError] = useState<string | null>(null);
  const [manual, setManual] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const close = () => {
    alive.current = false;
    onClose();
  };
  const pending = renderPublicMarkdownCopy(copy, apps, shares).unresolved;
  const create = () => {
    setWorking(true);
    setError(null);
    const next = new Map(shares);
    const request = (async () => {
      for (const file of pending) {
        if (!alive.current) throw new Error("File sharing cancelled");
        const params = new URLSearchParams({
          projectId: file.projectId,
          path: file.path,
        });
        const existing = await transport.fetch<PublicFileShareListResponse>(
          `/public-file-shares?${params}`,
        );
        if (!alive.current) throw new Error("File sharing cancelled");
        const url =
          existing.items[0]?.url ??
          (
            await transport.fetch<CreatePublicFileShareResponse>(
              "/public-file-shares",
              {
                method: "POST",
                body: JSON.stringify({
                  projectId: file.projectId,
                  path: file.path,
                }),
              },
            )
          ).url;
        next.set(copyFileKey(file), url);
        if (alive.current) setShares(new Map(next));
      }
      if (!alive.current) throw new Error("File sharing cancelled");
      return renderPublicMarkdownCopy(copy, apps, next).markdown;
    })();
    const clipboard = writeClipboardTextLater(request);
    void request
      .then(
        async (markdown) => {
          if (!alive.current) return;
          if (await clipboard) onClose();
          else setManual(markdown);
        },
        (failure: unknown) => {
          if (!alive.current) return;
          setError(
            failure instanceof Error
              ? failure.message
              : t("publicFileShareCreateFailed"),
          );
        },
      )
      .finally(() => {
        if (alive.current) setWorking(false);
      });
  };
  return (
    <Dialog
      title={t("publicMarkdownCreateLinks")}
      description={t("publicMarkdownShareDescription")}
      onClose={close}
      size="medium"
      footer={
        <>
          <Button onClick={close}>{t("cancel")}</Button>
          <Button
            variant="primary"
            disabled={working || !canShare}
            onClick={create}
          >
            {t(
              working
                ? "publicFileShareCreating"
                : "publicMarkdownCreateAndCopy",
            )}
          </Button>
        </>
      }
    >
      <Banner tone="warning" role="none">
        {t("publicFileShareWarning")}
      </Banner>
      <ul>
        {pending.map((file) => (
          <li key={copyFileKey(file)}>
            <code>{file.localPath}</code>
          </li>
        ))}
      </ul>
      {error && <Banner tone="error">{error}</Banner>}
      {manual && (
        <Field label={t("publicMarkdownManualCopy")}>
          <Textarea readOnly value={manual} />
        </Field>
      )}
    </Dialog>
  );
}
