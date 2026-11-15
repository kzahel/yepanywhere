import { useEffect, useState } from "react";
import type { AgentAuthRouterStatus } from "@yep-anywhere/shared";
import { hostedRouterApi } from "../api/hostedRouter";
import { useI18n } from "../i18n";
import { Button, buttonClassName } from "./ui/Button";
import { Field, TextInput } from "./ui/Field";
import styles from "./AgentAuthRouterControls.module.css";

export function HostedRouterControls({
  status,
  busy,
  run,
}: {
  status: AgentAuthRouterStatus;
  busy: boolean;
  run: (action?: () => Promise<unknown>) => Promise<void>;
}) {
  const { t } = useI18n();
  const [url, setUrl] = useState(status.origin ?? "");
  const [name, setName] = useState(
    status.pairingName ?? status.defaultPairingName ?? "Yep Anywhere",
  );
  const [now, setNow] = useState(Date.now());
  const pairing = status.pairing;
  useEffect(() => {
    if (!pairing || status.pairingExpired) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [pairing, status.pairingExpired]);
  const seconds = pairing
    ? Math.max(0, Math.ceil((Date.parse(pairing.expiresAt) - now) / 1000))
    : 0;
  const expired = status.pairingExpired || (pairing && seconds === 0);
  if (status.state === "connected" || status.state === "revocation-pending")
    return status.state === "connected" ? null : (
      <p>{t("routerHostedCancelPending")}</p>
    );
  return (
    <>
      {status.state !== "pairing" || expired ? (
        <>
          {expired && <p role="status">{t("routerHostedExpired")}</p>}
          <Field label={t("routerHostedUrl")}>
            <TextInput
              type="url"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="https://aar.example.com"
            />
          </Field>
          <Field label={t("routerHostedName")} hint={t("routerHostedNameHelp")}>
            <TextInput
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={120}
            />
          </Field>
          <div className={styles.actions}>
            <Button
              variant="primary"
              disabled={busy || !url.trim() || !name.trim()}
              onClick={() =>
                void run(() => hostedRouterApi.connect(url.trim(), name.trim()))
              }
            >
              {expired ? t("routerHostedNewCode") : t("routerHostedConnect")}
            </Button>
          </div>
        </>
      ) : (
        <div className={styles.status}>
          {pairing ? (
            <>
              <strong className={styles.pairingCode}>{pairing.userCode}</strong>
              <p>{t("routerHostedInstructions")}</p>
              <a
                className={buttonClassName({ variant: "secondary" })}
                href={pairing.verificationUri}
                target="_blank"
                rel="noopener noreferrer"
              >
                {t("routerHostedDashboard")}
              </a>
              <p className={styles.muted}>
                {t("routerHostedExpiry", {
                  time: `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`,
                })}
              </p>
            </>
          ) : (
            <p>{t("routerHostedPreparing")}</p>
          )}
          <Button
            disabled={busy}
            onClick={() => void run(() => hostedRouterApi.cancel())}
          >
            {t("routerHostedCancel")}
          </Button>
        </div>
      )}
    </>
  );
}
