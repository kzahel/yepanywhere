import type {
  ModelInfo,
  ProviderInfo,
  ProviderName,
  ProviderRuntimeStatus,
  ThinkingOption,
} from "@yep-anywhere/shared";
import {
  type MouseEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { type SessionOptions, api } from "../api/client";
import { useI18n } from "../i18n";
import type { PermissionMode, Project } from "../types";
import { NewSessionForm } from "./NewSessionForm";
import { Banner } from "./ui/Banner";
import { Button } from "./ui/Button";
import { Modal } from "./ui/Modal";
import { SegmentedControl } from "./ui/SegmentedControl";
import { Switch } from "./ui/Switch";

interface RestartSessionModalProps {
  projectId: string;
  sessionId: string;
  /** The source session's project; the successor always lands in it. */
  project?: Project | null;
  provider: ProviderName;
  providerDisplayName?: string;
  providers?: ProviderInfo[];
  models?: ModelInfo[];
  currentModel?: string;
  mode?: PermissionMode;
  thinking?: ThinkingOption;
  executor?: string;
  /** Source-session runtime state; a rate-limited session cannot fork. */
  providerRuntimeStatus?: ProviderRuntimeStatus;
  onRestarted: (
    result: {
      sessionId: string;
      processId: string;
      provider?: ProviderName;
      model?: string;
      title?: string;
      permissionMode: PermissionMode;
      appliedPermissionMode?: PermissionMode;
      modeVersion: number;
      recapAfterSeconds?: number;
      oldProcessAborted: boolean;
    },
    options?: {
      openInNewWindow?: boolean;
      targetWindow?: Window | null;
    },
  ) => void;
  onClose: () => void;
}

/**
 * Handoff Session: the New Session composer and launch controls, pointed at
 * an existing session.
 *
 * Handoff seeds the composer with the message the successor would receive so
 * the user can edit it before sending. Fork copies the real provider
 * transcript instead, so it sends no message: its composer is hidden, and it
 * is pinned to the source session's provider and model because a fork that
 * changed either would not be a fork.
 */
export function RestartSessionModal({
  projectId,
  sessionId,
  project,
  provider,
  providerDisplayName,
  providers = [],
  models = [],
  currentModel,
  mode,
  thinking,
  providerRuntimeStatus,
  onRestarted,
  onClose,
}: RestartSessionModalProps) {
  const { t } = useI18n();
  const providerOptions = useMemo<ProviderInfo[]>(() => {
    if (providers.length > 0) return providers;
    return [
      {
        name: provider,
        displayName: providerDisplayName ?? provider,
        installed: true,
        authenticated: true,
        enabled: true,
        models,
      },
    ];
  }, [models, provider, providerDisplayName, providers]);
  const sourceProviderInfo = providerOptions.find((p) => p.name === provider);

  // A rate-limited source cannot fork: a fork replays the whole transcript on
  // the same provider, so it would walk straight back into the limit that
  // stopped the session. Handoff stays available — its bounded summary is the
  // way out.
  const isRateLimited =
    providerRuntimeStatus?.kind === "retrying" &&
    providerRuntimeStatus.reason === "rate_limit";
  const forkRetryAt =
    providerRuntimeStatus?.kind === "retrying"
      ? providerRuntimeStatus.retryAt
      : undefined;
  // Fork is a real transcript copy; only offered when the source provider has
  // the primitive (never emulated). See topics/session-context-actions.md.
  const canFork =
    sourceProviderInfo?.supportsForkSession === true && !isRateLimited;
  const [restartMode, setRestartMode] = useState<"handoff" | "fork">("handoff");
  const isFork = canFork && restartMode === "fork";

  const [openInNewWindow, setOpenInNewWindow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [draftError, setDraftError] = useState<string | null>(null);

  // A popup must be opened inside the user gesture or the browser blocks it,
  // but the form's submit runs after its own awaits. Claim the window during
  // the click that starts the launch and hand it to `submit` afterwards.
  const pendingWindowRef = useRef<Window | null>(null);
  const claimTargetWindow = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      const target = event.target as HTMLElement | null;
      if (!target?.closest("button")) return;
      const wantsNewWindow =
        openInNewWindow ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.button === 1;
      if (!wantsNewWindow) {
        pendingWindowRef.current = null;
        return;
      }
      const opened = window.open("about:blank", "_blank");
      if (opened) opened.opener = null;
      pendingWindowRef.current = opened;
    },
    [openInNewWindow],
  );

  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    setDraft(null);
    setDraftError(null);
    api
      .getRestartHandoff(projectId, sessionId, {
        // The source session page the user is on now; surfaced verbatim in the
        // handoff's Source Session block as a self-documenting pointer back.
        sourceUrl: window.location.href,
      })
      .then((result) => {
        if (!cancelled) setDraft(result.handoff);
      })
      .catch((err) => {
        if (cancelled) return;
        setDraftError(
          err instanceof Error ? err.message : t("sessionRestartFailed"),
        );
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, sessionId, t]);

  const submit = useCallback(
    async ({
      message,
      options,
    }: {
      message: string;
      options: SessionOptions;
      clientTimestamp: number;
    }) => {
      const targetWindow = pendingWindowRef.current;
      pendingWindowRef.current = null;
      setError(null);
      try {
        const result = await api.restartSession(projectId, sessionId, {
          ...options,
          // Fork keeps the source provider; the server rejects a mismatch.
          provider: isFork ? provider : options.provider,
          restartMode: isFork ? "fork" : undefined,
          // For fork the reason would become the forked session's first user
          // message; omit it so the server's neutral continuation text is used.
          reason: isFork ? undefined : "Manual restart from Yep Anywhere",
          sourceUrl: isFork ? undefined : window.location.href,
          handoffText: isFork ? undefined : message,
        });
        onRestarted(result, {
          openInNewWindow: Boolean(targetWindow) || openInNewWindow,
          targetWindow,
        });
      } catch (err) {
        targetWindow?.close();
        setError(
          err instanceof Error ? err.message : t("sessionRestartFailed"),
        );
        throw err;
      }
    },
    [isFork, onRestarted, openInNewWindow, projectId, provider, sessionId, t],
  );

  return (
    <Modal title={t("sessionRestartTitle")} onClose={onClose}>
      <div className="model-switch-content">
        {error && (
          <Banner tone="error" compact>
            {error}
          </Banner>
        )}
        {draftError && !isFork && (
          <Banner tone="error" compact>
            {draftError}
          </Banner>
        )}

        {canFork && (
          <section className="model-switch-section">
            <div className="model-switch-section-header">
              <strong>{t("sessionRestartModeTitle")}</strong>
            </div>
            <SegmentedControl
              aria-label={t("sessionRestartModeTitle")}
              options={[
                {
                  value: "handoff",
                  label: t("sessionRestartModeHandoff"),
                  tooltip: t("sessionRestartModeHandoffDescription"),
                },
                {
                  value: "fork",
                  label: t("sessionRestartModeFork"),
                  tooltip: t("sessionRestartModeForkDescription"),
                },
              ]}
              value={isFork ? "fork" : "handoff"}
              onChange={setRestartMode}
            />
            {isFork && (
              <div className="model-switch-section-note">
                {t("sessionRestartForkKeepsProvider", {
                  provider:
                    sourceProviderInfo?.displayName ??
                    providerDisplayName ??
                    provider,
                })}
              </div>
            )}
          </section>
        )}

        {isRateLimited && sourceProviderInfo?.supportsForkSession === true && (
          <div className="model-switch-section-note">
            {forkRetryAt
              ? t("sessionRestartForkRateLimitedUntil", { time: forkRetryAt })
              : t("sessionRestartForkRateLimited")}
          </div>
        )}

        {/* Remounting on mode change re-seeds every control, which is how fork
            pins itself to the source session's provider and model. */}
        <div
          onClickCapture={claimTargetWindow}
          onAuxClickCapture={claimTargetWindow}
        >
          <NewSessionForm
            key={isFork ? "fork" : "handoff"}
            projectId={projectId}
            selectedProject={project ?? null}
            autoFocus={!isFork}
            preferredProvider={provider}
            preferredModel={currentModel}
            preferredThinking={thinking}
            preferredPermissionMode={mode}
            launch={{
              draftKey: `draft-handoff:${sessionId}`,
              initialMessage: draft ?? "",
              fixedProject: true,
              allowAttachments: false,
              allowProjectQueue: false,
              composer: isFork ? "muted" : "editable",
              fixedProviderModel: isFork,
              startLabel: isFork
                ? t("sessionRestartStartFork")
                : t("sessionRestartStart"),
              startingLabel: isFork
                ? t("sessionRestartForking")
                : t("sessionRestarting"),
              submit,
            }}
          />
        </div>

        <Switch
          checked={openInNewWindow}
          onCheckedChange={setOpenInNewWindow}
          label={t("sessionRestartOpenNewWindow")}
        />

        <div className="model-switch-actions">
          <Button onClick={onClose}>{t("modalCancel")}</Button>
        </div>
      </div>
    </Modal>
  );
}
