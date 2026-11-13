import { api } from "../api/client";
import { useToastContext } from "../contexts/ToastContext";
import { getThinkingSetting } from "../hooks/useModelSettings";
import { useI18n } from "../i18n";
import { toBrowserAppHref } from "../lib/appHref";
import { createSessionNavigationState } from "../lib/sessionNavigationState";
import { LongContextEffortWarningModal } from "./LongContextEffortWarningModal";
import { SessionRouterAccountPane } from "./SessionRouterAccountPane";
import type { SessionModelPanelTab } from "./ModelSwitchModal";
import type { DraftControls } from "../hooks/useDraftPersistence";
import { ModelSwitchModal } from "./ModelSwitchModal";
import { ProcessInfoBody } from "./ProcessInfoModal";
import { ProjectSessionDefaultsModal } from "./ProjectSessionDefaultsModal";
import { RestartSessionModal } from "./RestartSessionModal";
import { SessionRecapModal } from "./SessionRecapModal";
import { SERVER_CAPABILITIES, serverHasCapability } from "@yep-anywhere/shared";
import type { useActingPrincipal } from "../hooks/useActingPrincipal";
import type { useLongContextEffortGuard } from "../hooks/useLongContextEffortGuard";
import type { useProject, useProjects } from "../hooks/useProjects";
import type { useProviders } from "../hooks/useProviders";
import type { useRemoteBasePath } from "../hooks/useRemoteBasePath";
import type { useSession } from "../hooks/useSession";
import type { useVersion } from "../hooks/useVersion";
import type { useProviderRuntimeStatusForSession } from "../lib/clientSummaryStore";
import type {
  EffectiveSessionLaunchSettings,
  ModelServiceTier,
  PermissionMode,
  ProviderInfo,
  ProviderName,
} from "@yep-anywhere/shared";
import type { Dispatch, RefObject, SetStateAction } from "react";
import type { useNavigate } from "react-router-dom";

export interface SessionPageModalsProps {
  draftControlsRef: RefObject<DraftControls | null>;
  actualSessionId: ReturnType<typeof useSession>["actualSessionId"];
  basePath: ReturnType<typeof useRemoteBasePath>;
  chooseLongContextEffortWarning: ReturnType<
    typeof useLongContextEffortGuard
  >["choose"];
  creationPrincipal: ReturnType<typeof useActingPrincipal>["principal"];
  creationPrincipalResolved: ReturnType<typeof useActingPrincipal>["resolved"];
  currentProviderInfo: ProviderInfo | null;
  effectiveProvider: ProviderName | undefined;
  guardEffortChange: ReturnType<
    typeof useLongContextEffortGuard
  >["guardEffortChange"];
  handleModelChanged: (next: {
    processId: string;
    model?: string;
    thinking?: { type: string };
    effort?: string;
  }) => void;
  isDomLingerParked: boolean;
  lastStreamActivityAt: ReturnType<typeof useSession>["lastStreamActivityAt"];
  liveBadgeModel: string | undefined;
  longContextEffortWarning: ReturnType<
    typeof useLongContextEffortGuard
  >["warning"];
  modelPanelInitialTab: SessionModelPanelTab;
  navigate: ReturnType<typeof useNavigate>;
  permissionMode: PermissionMode;
  processState: ReturnType<typeof useSession>["processState"];
  project: ReturnType<typeof useProject>["project"];
  projectId: string;
  projects: ReturnType<typeof useProjects>["projects"];
  providerRuntimeStatus: ReturnType<typeof useProviderRuntimeStatusForSession>;
  providers: ReturnType<typeof useProviders>["providers"];
  providerServiceTiers: ModelServiceTier[] | undefined;
  routedSession: boolean;
  savedLaunchSettings: EffectiveSessionLaunchSettings | undefined;
  session: ReturnType<typeof useSession>["session"];
  sessionLiveness: ReturnType<typeof useSession>["sessionLiveness"];
  sessionUpdatesConnected: ReturnType<
    typeof useSession
  >["sessionUpdatesConnected"];
  setShowHandoffModal: Dispatch<SetStateAction<boolean>>;
  setShowModelSwitchModal: Dispatch<SetStateAction<boolean>>;
  setShowProjectSettingsModal: Dispatch<SetStateAction<boolean>>;
  setShowRecapModal: Dispatch<SetStateAction<boolean>>;
  setStatus: ReturnType<typeof useSession>["setStatus"];
  showHandoffModal: boolean;
  showModelSwitchModal: boolean;
  showProjectSettingsModal: boolean;
  showRecapModal: boolean;
  status: ReturnType<typeof useSession>["status"];
  supportsProjectSettings: boolean;
  titleTooltip: string;
  versionInfo: ReturnType<typeof useVersion>["version"];
}

/**
 * The session page's pop-ups: project session defaults, recaps, the
 * long-context effort warning, the model and info panel, and handoff.
 * Moved verbatim from `SessionPage.tsx`
 * (docs/tactical/182-session-page-header-and-footer.md slice 3).
 */
export function SessionPageModals({
  draftControlsRef,
  actualSessionId,
  basePath,
  chooseLongContextEffortWarning,
  creationPrincipal,
  creationPrincipalResolved,
  currentProviderInfo,
  effectiveProvider,
  guardEffortChange,
  handleModelChanged,
  isDomLingerParked,
  lastStreamActivityAt,
  liveBadgeModel,
  longContextEffortWarning,
  modelPanelInitialTab,
  navigate,
  permissionMode,
  processState,
  project,
  projectId,
  projects,
  providerRuntimeStatus,
  providers,
  providerServiceTiers,
  routedSession,
  savedLaunchSettings,
  session,
  sessionLiveness,
  sessionUpdatesConnected,
  setShowHandoffModal,
  setShowModelSwitchModal,
  setShowProjectSettingsModal,
  setShowRecapModal,
  setStatus,
  showHandoffModal,
  showModelSwitchModal,
  showProjectSettingsModal,
  showRecapModal,
  status,
  supportsProjectSettings,
  titleTooltip,
  versionInfo,
}: SessionPageModalsProps) {
  const { t } = useI18n();
  const { showToast } = useToastContext();
  return (
    <>
      {showProjectSettingsModal && supportsProjectSettings && (
        <ProjectSessionDefaultsModal
          projectId={projectId}
          projectName={project?.name}
          onClose={() => setShowProjectSettingsModal(false)}
        />
      )}

      {showRecapModal && status.owner === "self" && (
        <SessionRecapModal
          sessionId={actualSessionId}
          processId={status.processId}
          provider={effectiveProvider}
          currentModel={liveBadgeModel}
          onClose={() => setShowRecapModal(false)}
          onSaved={(settings) => {
            setStatus((prev) =>
              prev.owner === "self" && prev.processId === status.processId
                ? {
                    ...prev,
                    recapAfterSeconds: settings.recapAfterSeconds,
                  }
                : prev,
            );
            showToast(t("sessionRecapSaved"), "success");
          }}
        />
      )}

      {longContextEffortWarning && (
        <LongContextEffortWarningModal
          contextTokens={longContextEffortWarning.contextTokens}
          currentEffortLabel={longContextEffortWarning.currentEffortLabel}
          nextEffortLabel={longContextEffortWarning.nextEffortLabel}
          canFork={longContextEffortWarning.canFork}
          busy={longContextEffortWarning.busy}
          onChoose={(choice) => void chooseLongContextEffortWarning(choice)}
        />
      )}

      {/* Model Switch Modal */}
      {showModelSwitchModal && !isDomLingerParked && (
        <ModelSwitchModal
          routed={routedSession}
          processId={status.owner === "self" ? status.processId : undefined}
          sessionId={actualSessionId}
          currentModel={session?.model}
          sessionProvider={effectiveProvider}
          onModelChanged={handleModelChanged}
          guardEffortChange={guardEffortChange}
          initialTab={modelPanelInitialTab}
          accountPane={
            session &&
            serverHasCapability(
              versionInfo,
              SERVER_CAPABILITIES.agentAuthRouter,
            ) &&
            (effectiveProvider === "claude" ||
              effectiveProvider === "codex") ? (
              <SessionRouterAccountPane
                sessionId={actualSessionId}
                binding={session.routerBinding}
                provider={effectiveProvider}
                launch={{
                  models: [liveBadgeModel, savedLaunchSettings?.requestedModel],
                  thinking: savedLaunchSettings?.thinking,
                  effort: savedLaunchSettings?.effort,
                  serviceTier: savedLaunchSettings?.serviceTier,
                }}
                canSwitch={
                  creationPrincipalResolved &&
                  creationPrincipal.username === null &&
                  serverHasCapability(
                    versionInfo,
                    SERVER_CAPABILITIES.agentAuthRouterSessionSwitch,
                  ) &&
                  !session.executor &&
                  session.sandboxLevel !== "project-write"
                }
                onSwitched={() => {
                  draftControlsRef.current?.flushDraft();
                  window.location.reload();
                }}
              />
            ) : null
          }
          infoPane={
            session ? (
              <ProcessInfoBody
                onRelationshipNavigate={() => setShowModelSwitchModal(false)}
                relationshipProjectId={
                  creationPrincipalResolved &&
                  creationPrincipal.superuser &&
                  serverHasCapability(
                    versionInfo,
                    SERVER_CAPABILITIES.sessionRelationships,
                  )
                    ? projectId
                    : undefined
                }
                sessionId={actualSessionId}
                sessionTitle={titleTooltip}
                provider={session.provider}
                model={session.model}
                savedServiceTier={savedLaunchSettings?.serviceTier}
                serviceTiers={providerServiceTiers}
                status={status}
                processState={processState}
                sessionLiveness={sessionLiveness}
                providerRuntimeStatus={providerRuntimeStatus}
                contextUsage={session.contextUsage}
                originator={session.originator}
                cliVersion={session.cliVersion}
                sessionSource={session.source}
                approvalPolicy={session.approvalPolicy}
                sandboxPolicy={session.sandboxPolicy}
                createdAt={session.createdAt}
                routerBinding={session.routerBinding}
                sessionStreamConnected={sessionUpdatesConnected}
                lastSessionEventAt={lastStreamActivityAt}
              />
            ) : null
          }
          onActivate={async () => {
            const result = await api.reactivateSession(
              projectId,
              actualSessionId,
            );
            setStatus({
              owner: "self",
              processId: result.processId,
              permissionMode: result.permissionMode,
              appliedPermissionMode: result.appliedPermissionMode,
              modeVersion: result.modeVersion,
              recapAfterSeconds: result.recapAfterSeconds,
            });
          }}
          onClose={() => setShowModelSwitchModal(false)}
        />
      )}

      {showHandoffModal && effectiveProvider && !routedSession && (
        <RestartSessionModal
          projectId={projectId}
          sessionId={actualSessionId}
          provider={effectiveProvider}
          providerDisplayName={currentProviderInfo?.displayName}
          providers={providers}
          models={currentProviderInfo?.models}
          currentModel={liveBadgeModel}
          mode={permissionMode}
          thinking={getThinkingSetting()}
          executor={session?.executor}
          project={projects.find((candidate) => candidate.id === projectId)}
          providerRuntimeStatus={providerRuntimeStatus}
          onRestarted={(result, options) => {
            setShowHandoffModal(false);
            showToast(t("sessionHandoffStarted"), "success");
            const handoffUrl = `${basePath}/projects/${projectId}/sessions/${result.sessionId}`;
            const handoffHref = toBrowserAppHref(handoffUrl);
            if (options?.targetWindow && !options.targetWindow.closed) {
              options.targetWindow.location.href = handoffHref;
              return;
            }
            if (options?.openInNewWindow) {
              window.open(handoffHref, "_blank", "noopener");
              return;
            }
            navigate(handoffUrl, {
              state: createSessionNavigationState({
                initialStatus: {
                  owner: "self",
                  processId: result.processId,
                  permissionMode: result.permissionMode,
                  appliedPermissionMode: result.appliedPermissionMode,
                  modeVersion: result.modeVersion,
                  recapAfterSeconds: result.recapAfterSeconds,
                },
                initialTitle: result.title,
                initialModel: result.model ?? liveBadgeModel,
                initialProvider: result.provider ?? effectiveProvider,
              }),
            });
          }}
          onClose={() => setShowHandoffModal(false)}
        />
      )}
    </>
  );
}
