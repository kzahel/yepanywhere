import launcherStyles from "./SidebarLauncher.module.css";
import { useI18n } from "../i18n";
import { ClearloopRemainingBadge } from "./ClearloopRemainingBadge";
import { ClientLogRecordingBadge } from "./ClientLogRecordingBadge";
import { GoalFlag } from "./GoalNotice";
import { HostIdentityMarker } from "./HostIdentityMarker";
import { ProjectAppIcon } from "./ProjectAppIcon";
import { ProviderBadge } from "./ProviderBadge";
import { ProviderChildSessionControl } from "./ProviderChildSessionControl";
import { RecentSessionsDropdown } from "./RecentSessionsDropdown";
import sessionHeaderStyles from "./SessionHeader.module.css";
import { SessionIssuesLink } from "./SessionIssuesLink";
import { SessionMenu } from "./SessionMenu";
import {
  SessionPublicShareControls,
  SessionShareMenuLabel,
} from "./SessionPublicShareControls";
import { SessionRenameEditor } from "./SessionRenameEditor";
import { SessionRouterAccountChip } from "./SessionRouterAccountChip";
import { SessionAppAction } from "./SessionRightPane";
import { Badge } from "./ui/Badge";
import { ButtonBase, IconButton } from "./ui/Button";
import { Menu, MenuGroup, MenuItem } from "./ui/Menu";
import {
  SERVER_CAPABILITIES,
  SIDEBAR_SESSION_RESUME_CAPABILITY,
  serverHasCapability,
} from "@yep-anywhere/shared";
import { Link } from "react-router-dom";
import type { DraftControls } from "../hooks/useDraftPersistence";
import type { useGeneratedTitleEnabled } from "../hooks/useGeneratedTitleEnabled";
import type { useLongPress } from "../hooks/useLongPress";
import type { useProjectCodeNamePreferences } from "../hooks/useProjectCodeNamePreferences";
import type { useProjectReclassifyMenu } from "../hooks/useProjectReclassifyMenu";
import type { useProject } from "../hooks/useProjects";
import type { usePublicShareStatus } from "../hooks/usePublicShareStatus";
import type { useRemoteBasePath } from "../hooks/useRemoteBasePath";
import type { useSession } from "../hooks/useSession";
import type { useSessionForkActions } from "../hooks/useSessionForkActions";
import type { useSessionHeaderActions } from "../hooks/useSessionHeaderActions";
import type { useSessionHeaderLayout } from "../hooks/useSessionHeaderLayout";
import type { useSessionRewindControls } from "../hooks/useSessionRewindControls";
import type { useSessionRightPane } from "../hooks/useSessionRightPane";
import type { useSessionTitleEditing } from "../hooks/useSessionTitleEditing";
import type { useVersion } from "../hooks/useVersion";
import type { useNavigationLayout } from "../layouts";
import type { SessionModelConfig } from "../lib/sessionModelConfig";
import type { MessageSubmissionMetadata } from "../types/messageSubmission";
import type {
  ProviderInfo,
  ProviderName,
  SlashCommandGoalDetails,
} from "@yep-anywhere/shared";
import type { Dispatch, RefObject, SetStateAction } from "react";
import type { useNavigate } from "react-router-dom";

export interface SessionHeaderProps {
  actualSessionId: ReturnType<typeof useSession>["actualSessionId"];
  attachTitleInput: ReturnType<
    typeof useSessionTitleEditing
  >["attachTitleInput"];
  basePath: ReturnType<typeof useRemoteBasePath>;
  canCreatePublicShares: boolean;
  canStopOwnedProcess: boolean;
  clearloopControls: ReturnType<
    typeof useSessionRewindControls
  >["clearloopControls"];
  cloneSession: ReturnType<typeof useSessionForkActions>["cloneSession"];
  closeProjectReclassifyMenu: ReturnType<
    typeof useProjectReclassifyMenu
  >["closeProjectReclassifyMenu"];
  condensedHeader: boolean;
  currentGoal: string | null | undefined;
  currentProviderInfo: ProviderInfo | null;
  displayTitle: string;
  draftControlsRef: RefObject<DraftControls | null>;
  effectiveModelConfig: SessionModelConfig | null;
  effectiveProvider: ProviderName | undefined;
  forkAfterDisabled: boolean;
  forkUnavailableMessage: string | undefined;
  generatedRetitle: ReturnType<
    typeof useSessionTitleEditing
  >["generatedRetitle"];
  generatedTitleEnabled: ReturnType<
    typeof useGeneratedTitleEnabled
  >["generatedTitleEnabled"];
  goalDetails: SlashCommandGoalDetails | undefined;
  handleAcceptGeneratedRetitle: ReturnType<
    typeof useSessionTitleEditing
  >["handleAcceptGeneratedRetitle"];
  handleCancelEditingTitle: ReturnType<
    typeof useSessionTitleEditing
  >["handleCancelEditingTitle"];
  handleCompactSession: (argument?: string) => Promise<void>;
  handleGenerateAndApplyTitle: ReturnType<
    typeof useSessionTitleEditing
  >["handleGenerateAndApplyTitle"];
  handleProjectBreadcrumbContextMenu: ReturnType<
    typeof useProjectReclassifyMenu
  >["handleProjectBreadcrumbContextMenu"];
  handleReclassifySessionProject: ReturnType<
    typeof useProjectReclassifyMenu
  >["handleReclassifySessionProject"];
  handleRestartProvider: ReturnType<
    typeof useSessionHeaderActions
  >["handleRestartProvider"];
  handleRestorePendingElsewhereWarning: () => void;
  handleSaveTitle: ReturnType<typeof useSessionTitleEditing>["handleSaveTitle"];
  handleSend: (
    text: string,
    metadata?: MessageSubmissionMetadata,
    options?: {
      preserveComposer?: boolean;
      preserveScroll?: boolean;
      localControl?: boolean;
    },
  ) => Promise<boolean>;
  handleShare: ReturnType<typeof useSessionHeaderActions>["handleShare"];
  handleShareIndicatorClick: ReturnType<
    typeof useSessionHeaderActions
  >["handleShareIndicatorClick"];
  handleShareIndicatorContextMenu: ReturnType<
    typeof useSessionHeaderActions
  >["handleShareIndicatorContextMenu"];
  handleStartEditingTitle: ReturnType<
    typeof useSessionTitleEditing
  >["handleStartEditingTitle"];
  handleTerminate: ReturnType<
    typeof useSessionHeaderActions
  >["handleTerminate"];
  handleTitleBlur: ReturnType<typeof useSessionTitleEditing>["handleTitleBlur"];
  handleTitleKeyDown: ReturnType<
    typeof useSessionTitleEditing
  >["handleTitleKeyDown"];
  handleToggleArchive: ReturnType<
    typeof useSessionHeaderActions
  >["handleToggleArchive"];
  handleTogglePromptSuggestions: ReturnType<
    typeof useSessionHeaderActions
  >["handleTogglePromptSuggestions"];
  handleToggleRead: ReturnType<
    typeof useSessionHeaderActions
  >["handleToggleRead"];
  handleToggleStar: ReturnType<
    typeof useSessionHeaderActions
  >["handleToggleStar"];
  hasPendingToolCalls: boolean;
  hasUnread: ReturnType<typeof useSessionHeaderActions>["hasUnread"];
  headerLayout: ReturnType<typeof useSessionHeaderLayout>["layout"];
  headerRef: ReturnType<typeof useSessionHeaderLayout>["headerRef"];
  hideHeaderSecondary: boolean;
  isArchived: boolean;
  isDomLingerParked: boolean;
  isEditingTitle: ReturnType<typeof useSessionTitleEditing>["isEditingTitle"];
  isReclassifyingProject: ReturnType<
    typeof useProjectReclassifyMenu
  >["isReclassifyingProject"];
  isRenaming: ReturnType<typeof useSessionTitleEditing>["isRenaming"];
  isStarred: boolean;
  isWideScreen: ReturnType<typeof useNavigationLayout>["isWideScreen"];
  liveBadgeModel: string | undefined;
  loading: ReturnType<typeof useSession>["loading"];
  manualCompactBlocked: boolean;
  messages: ReturnType<typeof useSession>["messages"];
  navigate: ReturnType<typeof useNavigate>;
  openSessionInfo: () => void;
  openSidebar: ReturnType<typeof useNavigationLayout>["openSidebar"];
  pendingElsewhereDismissed: boolean;
  processState: ReturnType<typeof useSession>["processState"];
  project: ReturnType<typeof useProject>["project"];
  projectAppEnabled: boolean;
  projectAppOpen: boolean;
  projectAppPress: ReturnType<typeof useLongPress>;
  projectBreadcrumbRef: ReturnType<
    typeof useProjectReclassifyMenu
  >["projectBreadcrumbRef"];
  projectCodeNamesEnabled: ReturnType<
    typeof useProjectCodeNamePreferences
  >["projectCodeNamesEnabled"];
  projectId: string;
  projectReclassifyOptions: ReturnType<
    typeof useProjectReclassifyMenu
  >["projectReclassifyOptions"];
  promptSuggestionMode: "off" | "native";
  publicShareActionAvailable: boolean;
  publicShareGlobalStatus: ReturnType<typeof usePublicShareStatus>["status"];
  publicShareInitialPrompt: string | null;
  publicShareManagementAvailable: boolean;
  publicSharesEnabled: boolean;
  renamePresentation: ReturnType<
    typeof useSessionTitleEditing
  >["renamePresentation"];
  renameValue: ReturnType<typeof useSessionTitleEditing>["renameValue"];
  rightPane: ReturnType<typeof useSessionRightPane>;
  routedSession: boolean;
  saveTitleValue: ReturnType<typeof useSessionTitleEditing>["saveTitleValue"];
  session: ReturnType<typeof useSession>["session"];
  sessionId: string;
  setModelPanelInitialTab: Dispatch<
    SetStateAction<"model" | "account" | "info">
  >;
  setProjectAppFull: Dispatch<SetStateAction<boolean>>;
  setProjectAppOpen: Dispatch<SetStateAction<boolean>>;
  setProjectAppOpenedBy: Dispatch<SetStateAction<"session" | "user">>;
  setRenameValue: ReturnType<typeof useSessionTitleEditing>["setRenameValue"];
  setShareModalAnchor: ReturnType<
    typeof useSessionHeaderActions
  >["setShareModalAnchor"];
  setShowHandoffModal: Dispatch<SetStateAction<boolean>>;
  setShowModelSwitchModal: Dispatch<SetStateAction<boolean>>;
  setShowProjectSettingsModal: Dispatch<SetStateAction<boolean>>;
  setShowRecapModal: Dispatch<SetStateAction<boolean>>;
  setShowRecentSessions: Dispatch<SetStateAction<boolean>>;
  setShowShareModal: ReturnType<
    typeof useSessionHeaderActions
  >["setShowShareModal"];
  shareModalAnchor: ReturnType<
    typeof useSessionHeaderActions
  >["shareModalAnchor"];
  shareModalView: ReturnType<typeof useSessionHeaderActions>["shareModalView"];
  showProjectReclassifyMenu: ReturnType<
    typeof useProjectReclassifyMenu
  >["showProjectReclassifyMenu"];
  showRecentSessions: boolean;
  showShareModal: ReturnType<typeof useSessionHeaderActions>["showShareModal"];
  status: ReturnType<typeof useSession>["status"];
  supportsForkFromTurn: boolean;
  supportsManualCompact: boolean;
  supportsProjectSettings: boolean;
  supportsTitleGeneration: boolean;
  titleEditControlsRef: ReturnType<
    typeof useSessionTitleEditing
  >["titleEditControlsRef"];
  titleEditMode: ReturnType<typeof useSessionTitleEditing>["titleEditMode"];
  titleRowRef: RefObject<HTMLDivElement | null>;
  titleTooltip: string;
  versionInfo: ReturnType<typeof useVersion>["version"];
}

/**
 * The session page's header: the sidebar opener, the app actions, the
 * project breadcrumb and its move menu, the title row (title, rename and
 * retitle fields, router chip, goal, recent sessions, generate title), and
 * the right-hand controls (child sessions, sharing, issues, the model
 * badge and the session menu).
 * Moved verbatim from `SessionPage.tsx`
 * (docs/tactical/182-session-page-header-and-footer.md slice 4).
 */
export function SessionHeader({
  actualSessionId,
  attachTitleInput,
  basePath,
  canCreatePublicShares,
  canStopOwnedProcess,
  clearloopControls,
  cloneSession,
  closeProjectReclassifyMenu,
  condensedHeader,
  currentGoal,
  currentProviderInfo,
  displayTitle,
  draftControlsRef,
  effectiveModelConfig,
  effectiveProvider,
  forkAfterDisabled,
  forkUnavailableMessage,
  generatedRetitle,
  generatedTitleEnabled,
  goalDetails,
  handleAcceptGeneratedRetitle,
  handleCancelEditingTitle,
  handleCompactSession,
  handleGenerateAndApplyTitle,
  handleProjectBreadcrumbContextMenu,
  handleReclassifySessionProject,
  handleRestartProvider,
  handleRestorePendingElsewhereWarning,
  handleSaveTitle,
  handleSend,
  handleShare,
  handleShareIndicatorClick,
  handleShareIndicatorContextMenu,
  handleStartEditingTitle,
  handleTerminate,
  handleTitleBlur,
  handleTitleKeyDown,
  handleToggleArchive,
  handleTogglePromptSuggestions,
  handleToggleRead,
  handleToggleStar,
  hasPendingToolCalls,
  hasUnread,
  headerLayout,
  headerRef,
  hideHeaderSecondary,
  isArchived,
  isDomLingerParked,
  isEditingTitle,
  isReclassifyingProject,
  isRenaming,
  isStarred,
  isWideScreen,
  liveBadgeModel,
  loading,
  manualCompactBlocked,
  messages,
  navigate,
  openSessionInfo,
  openSidebar,
  pendingElsewhereDismissed,
  processState,
  project,
  projectAppEnabled,
  projectAppOpen,
  projectAppPress,
  projectBreadcrumbRef,
  projectCodeNamesEnabled,
  projectId,
  projectReclassifyOptions,
  promptSuggestionMode,
  publicShareActionAvailable,
  publicShareGlobalStatus,
  publicShareInitialPrompt,
  publicShareManagementAvailable,
  publicSharesEnabled,
  renamePresentation,
  renameValue,
  rightPane,
  routedSession,
  saveTitleValue,
  session,
  sessionId,
  setModelPanelInitialTab,
  setProjectAppFull,
  setProjectAppOpen,
  setProjectAppOpenedBy,
  setRenameValue,
  setShareModalAnchor,
  setShowHandoffModal,
  setShowModelSwitchModal,
  setShowProjectSettingsModal,
  setShowRecapModal,
  setShowRecentSessions,
  setShowShareModal,
  shareModalAnchor,
  shareModalView,
  showProjectReclassifyMenu,
  showRecentSessions,
  showShareModal,
  status,
  supportsForkFromTurn,
  supportsManualCompact,
  supportsProjectSettings,
  supportsTitleGeneration,
  titleEditControlsRef,
  titleEditMode,
  titleRowRef,
  titleTooltip,
  versionInfo,
}: SessionHeaderProps) {
  const { t } = useI18n();
  // Sidebar icon component
  const SidebarIcon = () => (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <line x1="9" y1="3" x2="9" y2="21" />
    </svg>
  );

  return (
    <header
      ref={headerRef}
      data-session-read-scope={sessionId}
      className={`session-header ${sessionHeaderStyles.header}`}
      data-header-layout={headerLayout}
      data-inline-rename={
        isEditingTitle &&
        titleEditMode === "manual" &&
        renamePresentation === "inline"
          ? "true"
          : undefined
      }
    >
      <div
        className={`session-header-inner ${sessionHeaderStyles.row}${isWideScreen ? ` ${sessionHeaderStyles.noLeadingControl}` : ""}`}
      >
        <div className={`session-header-left ${sessionHeaderStyles.left}`}>
          {/* Sidebar opener for the overlay sidebar only. On desktop the
            sidebar owns its own toggle, expanded or collapsed. */}
          {!isWideScreen && (
            <IconButton
              className={launcherStyles.sidebarToggle}
              data-sidebar-toggle
              size="large"
              onClick={openSidebar}
              label={t("sessionOpenSidebar")}
            >
              <SidebarIcon />
            </IconButton>
          )}
          <HostIdentityMarker />
          <SessionAppAction
            pane={{
              ...rightPane,
              select: (url) => {
                setProjectAppOpen(false);
                return rightPane.select(url);
              },
            }}
          />
          {projectAppEnabled && (
            <IconButton
              className={sessionHeaderStyles.projectAppButton}
              aria-pressed={projectAppOpen}
              label={t("projectAppLabel")}
              tooltip={t("projectAppFullViewHint")}
              {...projectAppPress.handlers}
              onClick={projectAppPress.click(() => {
                setProjectAppFull(false);
                setProjectAppOpenedBy("user");
                setProjectAppOpen((value) => !value);
              })}
            >
              <ProjectAppIcon />
            </IconButton>
          )}
          {/* Project breadcrumb */}
          {project?.name && (
            <div
              className={`project-breadcrumb-wrapper ${sessionHeaderStyles.project}`}
            >
              <Link
                ref={projectBreadcrumbRef}
                to={`${basePath}/sessions?project=${projectId}`}
                className="project-breadcrumb"
                title={
                  project.caption
                    ? `${project.name}\n${project.caption.text}`
                    : project.name
                }
                aria-label={project.name}
                onContextMenu={handleProjectBreadcrumbContextMenu}
              >
                {projectCodeNamesEnabled && project.codeName
                  ? project.codeName
                  : project.name}
              </Link>
              <Menu
                open={showProjectReclassifyMenu}
                onClose={closeProjectReclassifyMenu}
                anchorRef={projectBreadcrumbRef}
                placement="bottom-start"
                aria-label={t("sessionReclassifyProjectMenu")}
                className={sessionHeaderStyles.reclassifyMenu}
              >
                <MenuGroup label={t("sessionReclassifyProjectMenu")}>
                  {projectReclassifyOptions.map((candidate) => (
                    // The move closes the menu once it succeeds; a failure
                    // leaves it open to pick again.
                    <MenuItem
                      key={candidate.id}
                      keepOpen
                      disabled={isReclassifyingProject}
                      description={candidate.path}
                      onSelect={() =>
                        void handleReclassifySessionProject(candidate)
                      }
                    >
                      {candidate.name}
                    </MenuItem>
                  ))}
                </MenuGroup>
              </Menu>
            </div>
          )}
          <div
            ref={titleRowRef}
            className={`session-title-row ${sessionHeaderStyles.titleRow}`}
          >
            {isStarred && (
              <svg
                className="star-indicator-inline"
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="currentColor"
                stroke="currentColor"
                strokeWidth="2"
                role="img"
                aria-label={t("sessionStarredLabel")}
              >
                <title>{t("sessionStarredLabel")}</title>
                <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
              </svg>
            )}
            {loading ? (
              <span className="session-title-skeleton" />
            ) : isEditingTitle &&
              !isDomLingerParked &&
              titleEditMode === "manual" ? (
              <SessionRenameEditor
                initialTitle={displayTitle}
                presentation={renamePresentation}
                onSave={saveTitleValue}
                onCancel={handleCancelEditingTitle}
              />
            ) : isEditingTitle ? (
              <div ref={titleEditControlsRef} className="session-title-edit">
                <div
                  className="session-title-edit-row"
                  title={
                    generatedRetitle?.deferredInsertion
                      ? generatedRetitle.submittedTurnText
                      : undefined
                  }
                >
                  <input
                    ref={attachTitleInput}
                    type="text"
                    className="session-title-input"
                    value={
                      generatedRetitle?.deferredInsertion ? "" : renameValue
                    }
                    placeholder={
                      generatedRetitle?.deferredInsertion
                        ? t("sessionRetitleDeferred")
                        : undefined
                    }
                    onChange={(e) => setRenameValue(e.target.value)}
                    onKeyDown={handleTitleKeyDown}
                    onBlur={handleTitleBlur}
                    disabled={
                      isRenaming || !!generatedRetitle?.deferredInsertion
                    }
                    title={
                      generatedRetitle?.deferredInsertion
                        ? generatedRetitle.submittedTurnText
                        : undefined
                    }
                  />
                  {titleEditMode === "retitle" && (
                    <IconButton
                      size="small"
                      className={`session-title-retitle-accept${
                        generatedRetitle?.deferredInsertion ? " is-armed" : ""
                      }`}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={handleAcceptGeneratedRetitle}
                      disabled={
                        isRenaming ||
                        !generatedRetitle ||
                        !!generatedRetitle.deferredInsertion ||
                        generatedRetitle.status === "error"
                      }
                      label={
                        generatedRetitle?.status === "generating"
                          ? t("sessionRetitleUseGeneratedWhenReady")
                          : t("sessionRetitleUseGenerated")
                      }
                    >
                      <svg
                        width="15"
                        height="15"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                      >
                        <path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5z" />
                        <path d="m11 8 4 4-4 4" />
                        <path d="M8 12h7" />
                      </svg>
                    </IconButton>
                  )}
                  <IconButton
                    size="small"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={handleSaveTitle}
                    disabled={
                      isRenaming || !!generatedRetitle?.deferredInsertion
                    }
                    label={
                      titleEditMode === "retitle"
                        ? t("sessionRetitleSaveAsTyped")
                        : t("sessionTitleSave")
                    }
                  >
                    <svg
                      width="15"
                      height="15"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
                      <path d="M17 21v-8H7v8" />
                      <path d="M7 3v5h8" />
                    </svg>
                  </IconButton>
                  <IconButton
                    size="small"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={handleCancelEditingTitle}
                    disabled={isRenaming}
                    label={t("sessionRetitleCancel")}
                  >
                    <svg
                      width="15"
                      height="15"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <path d="M18 6 6 18" />
                      <path d="m6 6 12 12" />
                    </svg>
                  </IconButton>
                </div>
                {titleEditMode === "retitle" &&
                  generatedRetitle &&
                  !generatedRetitle.deferredInsertion && (
                    <div
                      className={`session-title-retitle-status is-${generatedRetitle.status}`}
                      title={
                        generatedRetitle.status === "generating"
                          ? generatedRetitle.submittedTurnText
                          : undefined
                      }
                    >
                      {generatedRetitle.status === "generating"
                        ? t("sessionRetitleGenerating")
                        : generatedRetitle.status === "ready" &&
                            generatedRetitle.title
                          ? `${t("sessionRetitleProposalLabel")} ${generatedRetitle.title}`
                          : (generatedRetitle.error ??
                            t("sessionRetitleFailed"))}
                    </div>
                  )}
              </div>
            ) : (
              <>
                <ButtonBase
                  className={`session-title session-title-recent-trigger ${sessionHeaderStyles.titleWithBadge}`}
                  onClick={() => setShowRecentSessions(!showRecentSessions)}
                  title={titleTooltip}
                  aria-haspopup="dialog"
                  aria-expanded={showRecentSessions}
                >
                  <span className="session-title-text">{displayTitle}</span>
                  {session?.clearloop !== undefined && (
                    <ClearloopRemainingBadge
                      badge={session.clearloop}
                      controls={clearloopControls}
                    />
                  )}
                </ButtonBase>
                {serverHasCapability(
                  versionInfo,
                  SERVER_CAPABILITIES.agentAuthRouter.name,
                ) && (
                  <SessionRouterAccountChip
                    binding={session?.routerBinding}
                    provider={effectiveProvider ?? null}
                    canSwitch={
                      serverHasCapability(
                        versionInfo,
                        SERVER_CAPABILITIES.agentAuthRouterSessionSwitch.name,
                      ) &&
                      (effectiveProvider === "claude" ||
                        effectiveProvider === "codex") &&
                      !session?.executor &&
                      session?.sandboxLevel !== "project-write"
                    }
                    className={sessionHeaderStyles.routerAccount}
                    onDetails={() => {
                      setModelPanelInitialTab("account");
                      setShowModelSwitchModal(true);
                    }}
                  />
                )}
                {currentGoal && (
                  <GoalFlag
                    objective={currentGoal}
                    status={goalDetails?.goalStatus}
                    key={actualSessionId}
                    onCommand={(argument) =>
                      handleSend(`/goal ${argument}`, undefined, {
                        preserveComposer: true,
                        localControl: true,
                      })
                    }
                    onEdit={() => {
                      const controls = draftControlsRef.current;
                      if (!controls || controls.getDraft().trim()) return;
                      controls.setDraft(`/goal ${currentGoal}`);
                      controls.focus?.();
                    }}
                  />
                )}
                <IconButton
                  size="small"
                  className={`session-title-chevron-trigger${
                    showRecentSessions ? " is-open" : ""
                  }`}
                  onClick={() => setShowRecentSessions(!showRecentSessions)}
                  label={
                    showRecentSessions
                      ? t("sessionCloseRecentSessions")
                      : t("sessionRecentSessions")
                  }
                  aria-haspopup="dialog"
                  aria-expanded={showRecentSessions}
                >
                  <svg
                    className="session-title-chevron"
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <polyline points="6 9 12 15 18 9" />
                  </svg>
                </IconButton>
                {supportsTitleGeneration && generatedTitleEnabled && (
                  <IconButton
                    size="small"
                    onClick={handleGenerateAndApplyTitle}
                    label={t("sessionGenerateNewTitle")}
                  >
                    <svg
                      width="15"
                      height="15"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.75"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5z" />
                      <path d="m11 8 4 4-4 4" />
                      <path d="M8 12h7" />
                    </svg>
                  </IconButton>
                )}
                <RecentSessionsDropdown
                  currentSessionId={sessionId}
                  currentSessionTitle={titleTooltip}
                  isOpen={showRecentSessions}
                  onClose={() => setShowRecentSessions(false)}
                  onNavigate={() => setShowRecentSessions(false)}
                  triggerRef={titleRowRef}
                  basePath={basePath}
                />
              </>
            )}
            {!loading && isArchived && (
              <Badge
                className={sessionHeaderStyles.archivedBadge}
                data-testid="session-archived-badge"
              >
                {t("sessionArchivedBadge")}
              </Badge>
            )}
          </div>
        </div>
        <div className={`session-header-right ${sessionHeaderStyles.actions}`}>
          <ProviderChildSessionControl
            projectId={projectId}
            sessionId={actualSessionId}
            basePath={basePath}
            childrenFromSession={session?.providerChildren}
            processState={processState}
          />
          <ClientLogRecordingBadge inline />
          <SessionPublicShareControls
            indicatorVisible={!hideHeaderSecondary}
            enabled={publicSharesEnabled}
            projectId={projectId}
            sessionId={actualSessionId}
            storageState={publicShareGlobalStatus?.storageState}
            canCreateShares={canCreatePublicShares}
            managementAvailable={publicShareManagementAvailable}
            modalOpen={showShareModal}
            modalAnchorRect={shareModalAnchor}
            modalInitialView={shareModalView}
            initialPrompt={publicShareInitialPrompt}
            title={displayTitle}
            onIndicatorClick={handleShareIndicatorClick}
            onIndicatorContextMenu={
              publicShareManagementAvailable
                ? handleShareIndicatorContextMenu
                : undefined
            }
            onCloseModal={() => {
              setShowShareModal(false);
              setShareModalAnchor(null);
            }}
            t={t}
          />
          {!hideHeaderSecondary && !loading && actualSessionId && (
            <SessionIssuesLink
              sessionId={actualSessionId}
              projectId={projectId}
              messageCount={messages.length}
            />
          )}
          {!loading && effectiveProvider && (
            <ButtonBase
              className={`provider-badge-button ${sessionHeaderStyles.modelButton}`}
              onClick={() => {
                setModelPanelInitialTab("model");
                setShowModelSwitchModal(true);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                setModelPanelInitialTab("info");
                setShowModelSwitchModal(true);
              }}
              title={
                status.owner === "self" && status.processId
                  ? t("sessionConfigureModel")
                  : t("sessionViewInfo")
              }
            >
              <ProviderBadge
                condensed={condensedHeader}
                provider={effectiveProvider}
                model={liveBadgeModel}
                thinking={effectiveModelConfig?.thinking}
                effort={effectiveModelConfig?.effort}
                isThinking={canStopOwnedProcess}
              />
            </ButtonBase>
          )}
          {!loading && (
            <SessionMenu
              sessionId={sessionId}
              projectId={projectId}
              isStarred={isStarred}
              isArchived={isArchived}
              hasUnread={hasUnread}
              provider={session?.provider}
              processId={status.owner === "self" ? status.processId : undefined}
              onToggleStar={handleToggleStar}
              onToggleArchive={handleToggleArchive}
              onToggleRead={handleToggleRead}
              onRename={handleStartEditingTitle}
              onShowInfo={openSessionInfo}
              onGenerateTitle={
                supportsTitleGeneration
                  ? handleGenerateAndApplyTitle
                  : undefined
              }
              onClone={supportsForkFromTurn ? cloneSession : undefined}
              cloneUnavailableMessage={forkUnavailableMessage}
              cloneDisabled={forkAfterDisabled}
              onConfigureProjectSettings={
                supportsProjectSettings
                  ? () => setShowProjectSettingsModal(true)
                  : undefined
              }
              onConfigureRecaps={
                status.owner === "self"
                  ? () => setShowRecapModal(true)
                  : undefined
              }
              promptSuggestionMode={promptSuggestionMode}
              onTogglePromptSuggestions={
                currentProviderInfo?.supportsNativePromptSuggestions
                  ? handleTogglePromptSuggestions
                  : undefined
              }
              warningRestoreAvailable={
                hasPendingToolCalls && pendingElsewhereDismissed
              }
              onRestoreWarnings={handleRestorePendingElsewhereWarning}
              onHandoff={
                effectiveProvider && !routedSession
                  ? () => setShowHandoffModal(true)
                  : undefined
              }
              onClear={() => {
                const params = new URLSearchParams({ projectId });
                if (effectiveProvider) {
                  params.set("provider", effectiveProvider);
                }
                if (liveBadgeModel) {
                  params.set("model", liveBadgeModel);
                }
                navigate(`${basePath}/new-session?${params.toString()}`);
              }}
              onCompact={
                supportsManualCompact ? handleCompactSession : undefined
              }
              compactDisabled={manualCompactBlocked}
              onTerminate={handleTerminate}
              onRestartProvider={
                serverHasCapability(
                  versionInfo,
                  SIDEBAR_SESSION_RESUME_CAPABILITY,
                )
                  ? handleRestartProvider
                  : undefined
              }
              onReload={() => window.location.reload()}
              onShare={publicShareActionAvailable ? handleShare : undefined}
              triggerClassName={sessionHeaderStyles.menuTrigger}
              triggerSize="large"
              shareLabel={
                hideHeaderSecondary ? (
                  <SessionShareMenuLabel
                    enabled={publicSharesEnabled}
                    projectId={projectId}
                    sessionId={actualSessionId}
                    storageState={publicShareGlobalStatus?.storageState}
                    t={t}
                  />
                ) : undefined
              }
              additionalItems={
                hideHeaderSecondary
                  ? (close) => (
                      <SessionIssuesLink
                        sessionId={actualSessionId}
                        projectId={projectId}
                        messageCount={messages.length}
                        presentation="menu"
                        onSelect={close}
                      />
                    )
                  : undefined
              }
              useEllipsisIcon
              onOpenChange={(open) => {
                if (open) setShowRecentSessions(false);
              }}
            />
          )}
        </div>
      </div>
    </header>
  );
}
