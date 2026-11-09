import { AgentAuthRouterPools } from "./AgentAuthRouterPools";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  SERVER_CAPABILITIES,
  serverHasCapability,
  type AgentAuthRouterRecovery,
  type AgentAuthRouterStatus,
} from "@yep-anywhere/shared";
import { useClientSummarySourceKey } from "../lib/clientSummaryStore";
import { api } from "../api/client";
import { useVersion } from "../hooks/useVersion";
import { useI18n } from "../i18n";
import { SettingsDocLink } from "../pages/settings/SettingsDocLink";
import styles from "./AgentAuthRouterControls.module.css";
import { Button } from "./ui/Button";
import { Field, TextInput } from "./ui/Field";

type Account = Awaited<
  ReturnType<typeof api.routerAccounts>
>["accounts"][number];
const errorMessage = (error: unknown, fallback: string) =>
  error instanceof Error ? error.message : fallback;

export function AgentAuthRouterSettings() {
  const source = useClientSummarySourceKey();
  return <RouterSettingsForSource key={source} />;
}
function RouterSettingsForSource() {
  const { t } = useI18n();
  const { version } = useVersion();
  const supportsPools = serverHasCapability(
    version,
    SERVER_CAPABILITIES.agentAuthRouterPools.name,
  );
  const supportsRecovery = serverHasCapability(
    version,
    SERVER_CAPABILITIES.agentAuthRouterRecovery.name,
  );
  const [status, setStatus] = useState<AgentAuthRouterStatus>({
    state: "disconnected",
    routerId: null,
  });
  const [recovery, setRecovery] = useState<AgentAuthRouterRecovery | null>(
    null,
  );
  const [path, setPath] = useState("");
  const [editingSocket, setEditingSocket] = useState(false);
  // Bumped by each completed status read so the pool overview rereads too.
  const [checks, setChecks] = useState(0);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [usage, setUsage] = useState<
    Record<string, Awaited<ReturnType<typeof api.routerQuotas>>>
  >({});
  // Invalidate requests on unmount/source changes and before each new action.
  // A response from the previous source must not start a request on the next one.
  const request = useRef(0);
  const read = useCallback(
    async (id: number) => {
      if (supportsRecovery) {
        const result = await api.routerRecovery();
        if (request.current !== id) return;
        setStatus(result);
        setRecovery(result);
        setAccounts(result.accounts);
      } else {
        const result = await api.routerStatus();
        if (request.current !== id) return;
        setStatus(result);
        setRecovery(null);
        setAccounts([]);
        if (result.state === "connected") {
          const list = await api.routerAccounts();
          if (request.current !== id) return;
          setAccounts(list.accounts);
        }
      }
      setLoaded(true);
      setChecks((n) => n + 1);
    },
    [supportsRecovery],
  );
  const run = useCallback(
    async (action?: (id: number) => Promise<unknown>) => {
      const id = ++request.current;
      setBusy(true);
      setError("");
      try {
        if (action) {
          await action(id);
          window.dispatchEvent(new Event("router-connection-changed"));
        }
        if (request.current === id) await read(id);
      } catch (failure) {
        if (request.current !== id) return;
        setError(errorMessage(failure, t("routerUnavailable")));
        setAccounts([]);
        setRecovery(null);
        // A failed disconnect can still have durably changed local state.
        if (action) await read(id).catch(() => {});
      } finally {
        if (request.current === id) setBusy(false);
      }
    },
    [read, t],
  );
  useEffect(() => {
    void run();
    return () => {
      request.current++;
    };
  }, [run]);
  const state = status.state;
  const stateLabel =
    state === "connected"
      ? t("routerConnected")
      : state === "pairing"
        ? t("routerPairing")
        : state === "revocation-pending"
          ? t("routerRevocationPending")
          : t("routerDisconnected");
  const pending = recovery?.pendingCancellations ?? 0;
  const canReadAccounts = state === "connected" && !recovery?.issue && !error;
  const healthy = canReadAccounts && recovery?.reachable !== false;
  // A healthy pairing needs no socket choice; show it on trouble or request.
  const showSocket =
    state !== "revocation-pending" &&
    (state === "disconnected" || !healthy || editingSocket);
  const checkedAt = recovery?.checkedAt
    ? new Date(recovery.checkedAt).toLocaleTimeString()
    : null;
  return (
    <section
      className={styles.panel}
      aria-label={t("routerTitle")}
      aria-busy={busy}
    >
      <strong>{t("routerTitle")}</strong>
      <p>
        {t("routerDescription")}{" "}
        <SettingsDocLink doc="topics/agent-auth-router.md#set-up-and-use" />
      </p>
      <div className={styles.status} role="status">
        <strong>
          {!loaded
            ? t(busy ? "routerChecking" : "routerStatusUnknown")
            : stateLabel}
        </strong>
        {recovery?.issue && (
          <p>
            {state === "revocation-pending" &&
            recovery.issue.code === "unavailable"
              ? t("routerNotReachable")
              : recovery.issue.message}
          </p>
        )}
        {recovery?.reachable === true &&
          !recovery.issue &&
          state === "connected" && (
            <p>{t("routerReadyAt", { time: checkedAt ?? "" })}</p>
          )}
        {state !== "disconnected" && status.customSocket !== undefined && (
          <p className={styles.muted}>
            {status.customSocket ? (
              t("routerSocketCustom")
            ) : (
              <>
                {t("routerSocketDefault")}{" "}
                <code className={styles.path}>
                  ~/.agent-auth-router/control.sock
                </code>
              </>
            )}
          </p>
        )}
        {!supportsRecovery && state === "connected" && (
          <p>{t("routerLegacyStatus")}</p>
        )}
        {state === "revocation-pending" && <p>{t("routerRevocationHelp")}</p>}
        {state === "pairing" && <p>{t("routerPairingHelp")}</p>}
        {loaded && state === "disconnected" && (
          <p>{t("routerDisconnectedHelp")}</p>
        )}
      </div>
      {showSocket && (
        <Field label={t("routerSocket")}>
          <TextInput
            value={path}
            onChange={(event) => setPath(event.target.value)}
            placeholder={
              state === "disconnected"
                ? t("routerDefaultSocket")
                : t("routerSavedSocket")
            }
          />
        </Field>
      )}
      <div className={styles.actions}>
        {showSocket && (
          <Button
            variant="primary"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await api.routerConnect(path || undefined);
                setEditingSocket(false);
              })
            }
          >
            {state === "disconnected"
              ? t("routerConnect")
              : t("routerRetryConnection")}
          </Button>
        )}
        <Button disabled={busy} onClick={() => void run()}>
          {busy && loaded ? t("routerCheckingShort") : t("routerCheckStatus")}
        </Button>
        {!showSocket && state === "connected" && (
          <Button disabled={busy} onClick={() => setEditingSocket(true)}>
            {t("routerChangeSocket")}
          </Button>
        )}
        {state !== "disconnected" && (
          <Button
            variant="danger-outline"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await api.routerDisconnect();
                setUsage({});
              })
            }
          >
            {state === "revocation-pending"
              ? t("routerFinishDisconnect")
              : t("routerDisconnectAction")}
          </Button>
        )}
      </div>
      {error && error !== recovery?.issue?.message && (
        <p role="alert">{error}</p>
      )}
      {pending > 0 && (
        <div className={styles.status}>
          <strong>{t("routerPendingCleanup", { count: pending })}</strong>
          <p>{t("routerPendingCleanupHelp")}</p>
          {state === "connected" && (
            <Button
              disabled={busy}
              onClick={() => void run(() => api.routerRetryCancellations())}
            >
              {t("routerRetryCleanup")}
            </Button>
          )}
        </div>
      )}
      {canReadAccounts && accounts.length === 0 && loaded && (
        <p>{t("routerNoAccounts")}</p>
      )}
      {supportsPools && canReadAccounts && (
        <AgentAuthRouterPools reloadToken={checks} />
      )}
      {!supportsPools &&
        accounts.map((account) => (
          <div className={styles.account} key={account.id}>
            <strong>
              {account.provider} · {account.id}
            </strong>
            {!account.enabled && <p>{t("routerAccountDisabled")}</p>}
            <span>{t("routerRenewal", { state: account.renewal })}</span>
            <Button
              disabled={busy || !account.enabled || !canReadAccounts}
              onClick={() =>
                void run(async (id) => {
                  const snapshot = await api.routerQuotas(account.id);
                  if (request.current === id)
                    setUsage((old) => ({ ...old, [account.id]: snapshot }));
                })
              }
            >
              {t("routerRefreshUsage")}
            </Button>
            {usage[account.id] && (
              <div>
                <p>
                  {t("routerUsageObserved", {
                    time: new Date(
                      usage[account.id]!.observedAt,
                    ).toLocaleString(),
                  })}
                </p>
                {usage[account.id]?.status === "ok"
                  ? usage[account.id]?.windows.map((window) => (
                      <div key={window.bucket}>
                        {window.bucket}:{" "}
                        {window.remainingPercent === null
                          ? "?"
                          : `${window.remainingPercent}%`}{" "}
                        {t("routerRemaining")}{" "}
                        {window.resetsAt
                          ? new Date(window.resetsAt).toLocaleString()
                          : ""}
                      </div>
                    ))
                  : t("routerUsageUnavailable")}
              </div>
            )}
          </div>
        ))}
    </section>
  );
}
