import { SERVER_CAPABILITIES, serverHasCapability } from "@yep-anywhere/shared";
import { useEffect, useState } from "react";
import { useCurrentSourceRuntime } from "../../contexts/SourceRuntimeContext";
import { useVersion } from "../../hooks/useVersion";
import { useI18n } from "../../i18n";
import { SettingsSection } from "./SettingsSection";
import styles from "./ComputerControlSettings.module.css";

interface Status {
  enabled: boolean;
  available: boolean;
  running: boolean;
  busy: boolean;
  idleMs: number;
  grantMs: number;
  lastError?: string;
  preview?: { packageDirectory: string; trustedPublisher: string };
  sessions: Array<{ sessionId: string; expiresAt: number }>;
}
export function ComputerControlSettings() {
  const { version } = useVersion();
  const { sourceKey } = useCurrentSourceRuntime();
  const { t } = useI18n();
  const supported = serverHasCapability(
    version,
    SERVER_CAPABILITIES.computerControl.name,
  );
  return (
    <SettingsSection
      title={t("computerTitle")}
      description={t("computerDescription")}
    >
      {supported ? (
        <Controls key={sourceKey} />
      ) : (
        <p>{t("computerUnsupportedServer")}</p>
      )}
    </SettingsSection>
  );
}
function Controls() {
  const { transport } = useCurrentSourceRuntime();
  const { t } = useI18n();
  const [status, setStatus] = useState<Status>();
  const [directory, setDirectory] = useState("");
  const [publisher, setPublisher] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let disposed = false;
    void transport
      .fetch<Status>("/computer-control")
      .then((value) => {
        if (disposed) return;
        setStatus(value);
        setDirectory(value.preview?.packageDirectory ?? "");
        setPublisher(value.preview?.trustedPublisher ?? "");
      })
      .catch(() => {
        if (!disposed) setError(t("computerRequestFailed"));
      });
    return () => {
      disposed = true;
    };
  }, [transport, t]);
  const action = async (route: string, method: string, body?: unknown) => {
    setBusy(true);
    setError("");
    try {
      await transport.fetch(`/computer-control${route}`, {
        method,
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      setStatus(await transport.fetch<Status>("/computer-control"));
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : t("computerRequestFailed"),
      );
    } finally {
      setBusy(false);
    }
  };
  if (!status) return <p role="status">{error || t("computerLoading")}</p>;
  if (!status.available) return <p>{t("computerUnavailable")}</p>;
  return (
    <div className={styles.controls}>
      <p>{t("computerTrustHelp")}</p>
      <label>
        {t("computerPackageDirectory")}
        <input
          value={directory}
          onChange={(event) => setDirectory(event.currentTarget.value)}
          disabled={busy}
        />
      </label>
      <label>
        {t("computerTrustedPublisher")}
        <input
          value={publisher}
          onChange={(event) => setPublisher(event.currentTarget.value)}
          disabled={busy}
        />
      </label>
      <button
        type="button"
        disabled={busy || !directory.trim() || !publisher.trim()}
        onClick={() =>
          void action("/install", "POST", {
            packageDirectory: directory,
            trustedPublisher: publisher,
          })
        }
      >
        {t("computerInstall")}
      </button>
      <label className={styles.toggle}>
        <input
          type="checkbox"
          checked={status.enabled}
          disabled={busy || !status.preview}
          onChange={(event) =>
            void action("/settings", "PUT", {
              enabled: event.currentTarget.checked,
              idleMs: status.idleMs,
              grantMs: status.grantMs,
            })
          }
        />
        {t("computerEnable")}
      </label>
      <p role="status">
        {t(status.running ? "computerRunning" : "computerStopped")}
      </p>
      <p>{t("computerSessionScope")}</p>
      <div className={styles.actions}>
        <button
          type="button"
          disabled={busy}
          onClick={() => void action("", "GET")}
        >
          {t("computerRefresh")}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void action("/stop", "POST")}
        >
          {t("computerDisable")}
        </button>
        <button
          type="button"
          disabled={busy || !status.preview}
          onClick={() => void action("/installation", "DELETE")}
        >
          {t("computerRemove")}
        </button>
      </div>
      {status.sessions.map((session) => (
        <div className={styles.session} key={session.sessionId}>
          <code>{session.sessionId}</code>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void action(
                `/sessions/${encodeURIComponent(session.sessionId)}`,
                "DELETE",
              )
            }
          >
            {t("computerRevoke")}
          </button>
        </div>
      ))}
      {(error || status.lastError) && (
        <p role="alert">{error || status.lastError}</p>
      )}
    </div>
  );
}
