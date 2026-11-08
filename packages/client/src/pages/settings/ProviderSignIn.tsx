import type { ProviderLoginFlow, ProviderName } from "@yep-anywhere/shared";
import { useCallback, useEffect, useState } from "react";
import { api } from "../../api/client";
import { Button, buttonClassName } from "../../components/ui/Button";
import { useToastContext } from "../../contexts/ToastContext";
import { useI18n } from "../../i18n";
import styles from "./ProviderSignIn.module.css";

const POLL_INTERVAL_MS = 2000;

/**
 * Sign a provider CLI in through the server: the server runs the CLI's login,
 * and this panel relays its sign-in link, device code, and pasted-back code.
 */
export function ProviderSignIn({
  provider,
  displayName,
  supportsHostTerminal,
  onSignedIn,
}: {
  provider: ProviderName;
  displayName: string;
  supportsHostTerminal: boolean;
  onSignedIn: () => void;
}) {
  const { t } = useI18n();
  const { showToast } = useToastContext();
  const [flow, setFlow] = useState<ProviderLoginFlow | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const running = flow?.state === "running";
  const flowId = flow?.id;

  // Pick up a sign-in already started from another tab or device.
  useEffect(() => {
    let cancelled = false;
    api
      .getProviderLogin(provider)
      .then(({ flow: current }) => {
        if (!cancelled && current) setFlow(current);
      })
      .catch((error) => {
        if (!cancelled) setProblem(String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [provider]);

  // Follow a running sign-in until the CLI exits.
  // biome-ignore lint/correctness/useExhaustiveDependencies: each new flow snapshot re-arms this one-shot poll, including after a transient failure.
  useEffect(() => {
    if (!running || !flowId) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      api
        .getProviderLogin(provider)
        .then(({ flow: current }) => {
          if (cancelled) return;
          if (current?.id !== flowId) {
            setFlow(current);
            return;
          }
          setFlow(current);
          setProblem(null);
          if (current.state === "succeeded") onSignedIn();
        })
        .catch((error) => {
          // Keep polling; a transient failure should not strand the flow.
          if (!cancelled) {
            setProblem(String(error));
            setFlow((previous) => previous && { ...previous });
          }
        });
    }, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [flow, running, flowId, provider, onSignedIn]);

  const run = useCallback(
    async (action: () => Promise<void>) => {
      setBusy(true);
      setProblem(null);
      try {
        await action();
      } catch (error) {
        setProblem(error instanceof Error ? error.message : String(error));
        showToast(
          t("providersSignInError", {
            provider: displayName,
            error: error instanceof Error ? error.message : String(error),
          }),
          "error",
        );
      } finally {
        setBusy(false);
      }
    },
    [displayName, showToast, t],
  );

  const start = () =>
    run(async () => {
      setCode("");
      setFlow((await api.startProviderLogin(provider)).flow);
    });

  const openTerminal = () =>
    run(async () => {
      await api.openProviderLoginTerminal(provider);
      showToast(
        t("providersSignInTerminalOpened", { provider: displayName }),
        "success",
      );
    });

  const submitCode = () =>
    run(async () => {
      if (!flowId) return;
      setFlow((await api.submitProviderLoginCode(provider, flowId, code)).flow);
    });

  const cancel = () =>
    run(async () => {
      if (!flowId) return;
      setFlow((await api.cancelProviderLogin(provider, flowId)).flow);
    });

  const copyUserCode = async (userCode: string) => {
    try {
      await navigator.clipboard.writeText(userCode);
      showToast(t("providersSignInCodeCopied"), "success");
    } catch {
      showToast(t("providersSignInCodeCopyError"), "error");
    }
  };

  if (running && flow) {
    return (
      <div
        className={styles.panel}
        data-testid={`provider-sign-in-${provider}`}
      >
        {problem && <p role="alert">{problem}</p>}
        {flow.url ? (
          <a
            className={buttonClassName()}
            href={flow.url}
            target="_blank"
            rel="noopener noreferrer"
          >
            {t("providersSignInOpenPage", { provider: displayName })}
          </a>
        ) : (
          <p className="settings-hint">{t("providersSignInStarting")}</p>
        )}
        {flow.userCode && (
          <div className={styles.row}>
            <span className="settings-hint">
              {t("providersSignInEnterCode")}
            </span>
            <code className={styles.userCode}>{flow.userCode}</code>
            <Button
              variant="ghost"
              size="small"
              onClick={() => void copyUserCode(flow.userCode as string)}
            >
              {t("providersSignInCopyCode")}
            </Button>
          </div>
        )}
        {flow.acceptsCode && flow.url && !flow.codeSubmitted && (
          <p className="settings-hint">{t("providersSignInCodeHint")}</p>
        )}
        {flow.acceptsCode && flow.url && !flow.codeSubmitted && (
          <form
            className={`${styles.row} ${styles.codeRow}`}
            onSubmit={(event) => {
              event.preventDefault();
              void submitCode();
            }}
          >
            <input
              type="text"
              className={styles.codeInput}
              value={code}
              onChange={(event) => setCode(event.target.value)}
              placeholder={t("providersSignInCodePlaceholder")}
              aria-label={t("providersSignInCodePlaceholder")}
              autoComplete="off"
              spellCheck={false}
            />
            <Button
              variant="primary"
              type="submit"
              disabled={busy || !code.trim()}
            >
              {t("providersSignInSubmitCode")}
            </Button>
          </form>
        )}
        {flow.codeSubmitted && (
          <p className="settings-hint">{t("providersSignInVerifying")}</p>
        )}
        {flow.output && (
          <pre
            role="region"
            className={styles.output}
            aria-label={t("providerSignInOutput")}
          >
            {flow.output}
          </pre>
        )}
        <div className={styles.row}>
          <Button onClick={() => void cancel()} disabled={busy}>
            {t("providersSignInCancel")}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.panel} data-testid={`provider-sign-in-${provider}`}>
      {problem && <p role="alert">{problem}</p>}
      {flow?.state === "succeeded" && (
        <p role="status">
          {t("providerSignInReady", { provider: displayName })}
        </p>
      )}
      {flow && flow.state !== "succeeded" && (
        <>
          <p className="settings-hint">
            {t(
              flow.state === "expired"
                ? "providersSignInExpired"
                : flow.state === "cancelled"
                  ? "providersSignInCancelled"
                  : "providersSignInFailed",
              { provider: displayName },
            )}
          </p>
          {flow.state === "failed" && flow.output && (
            <pre className={styles.output}>{flow.output}</pre>
          )}
        </>
      )}
      <div className={styles.row}>
        <Button onClick={() => void start()} disabled={busy}>
          {busy
            ? t("providersSignInStarting")
            : t("providersSignIn", { provider: displayName })}
        </Button>
        {supportsHostTerminal && (
          <Button onClick={() => void openTerminal()} disabled={busy}>
            {t("providersSignInHostTerminal")}
          </Button>
        )}
      </div>
    </div>
  );
}
