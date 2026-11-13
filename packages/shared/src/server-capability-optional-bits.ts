import { CAPABILITY_ID_ALLOCATIONS } from "./capability-ids.js";
import { SECURITY_CLIENT_AUDIT_CAPABILITY } from "./security-clients.js";

export const OPTIONAL_SERVER_CAPABILITY_BIT_ALLOCATIONS = {
  collectionMetadataFields: {
    name: "collection-metadata-fields",
    index: CAPABILITY_ID_ALLOCATIONS.collectionMetadataFields.id,
    introducedIn: "0.12.0",
  },
  sidebarSessionSnapshot: {
    name: "sidebar-session-snapshot",
    index: CAPABILITY_ID_ALLOCATIONS.sidebarSessionSnapshot.id,
    introducedIn: "0.12.0",
  },
  sessionCreationAdmission: {
    name: "session-creation-admission-v1",
    index: CAPABILITY_ID_ALLOCATIONS.sessionCreationAdmission.id,
    introducedIn: "0.11.1",
  },
  stagedSessionCreation: {
    name: "session-creation-staged-attachments",
    index: CAPABILITY_ID_ALLOCATIONS.stagedSessionCreation.id,
    introducedIn: "0.11.1",
  },
  piTextCreation: {
    name: "session-creation-pi-text",
    index: CAPABILITY_ID_ALLOCATIONS.piTextCreation.id,
    introducedIn: "0.11.1",
  },
  opencodeTextCreation: {
    name: "session-creation-opencode-text",
    index: CAPABILITY_ID_ALLOCATIONS.opencodeTextCreation.id,
    introducedIn: "0.11.1",
  },
  codexTextCreation: {
    name: "session-creation-codex-text",
    index: CAPABILITY_ID_ALLOCATIONS.codexTextCreation.id,
    introducedIn: "0.11.1",
  },
  claudeTextCreation: {
    name: "session-creation-claude-text",
    index: CAPABILITY_ID_ALLOCATIONS.claudeTextCreation.id,
    introducedIn: "0.11.1",
  },
  peerAuthenticationRefresh: {
    name: "peer-authentication-refresh",
    index: CAPABILITY_ID_ALLOCATIONS.peerAuthenticationRefresh.id,
    introducedIn: "0.11.1",
  },
  peerConnections: {
    name: "peer-connections",
    index: CAPABILITY_ID_ALLOCATIONS.peerConnections.id,
    introducedIn: "0.11.1",
  },
  agentApiManagement: {
    name: "agent-api-management",
    index: CAPABILITY_ID_ALLOCATIONS.agentApiManagement.id,
    introducedIn: "0.11.1",
  },
  agentApiBootstrap: {
    name: "agent-api-bootstrap",
    index: CAPABILITY_ID_ALLOCATIONS.agentApiBootstrap.id,
    introducedIn: "0.11.1",
  },
  agentAuthRouterServiceTiers: {
    name: "agent-auth-router-service-tiers",
    index: CAPABILITY_ID_ALLOCATIONS.agentAuthRouterServiceTiers.id,
    introducedIn: "0.11.1",
  },
  rendezCompose: {
    name: "rendez-active-compose",
    index: CAPABILITY_ID_ALLOCATIONS.rendezCompose.id,
    introducedIn: "0.11.1",
  },
  agentAuthRouterSessionSwitch: {
    name: "agent-auth-router-session-switch",
    index: CAPABILITY_ID_ALLOCATIONS.agentAuthRouterSessionSwitch.id,
    introducedIn: "0.11.1",
  },
  agentAuthRouterMostRemaining: {
    name: "agent-auth-router-most-remaining",
    index: CAPABILITY_ID_ALLOCATIONS.agentAuthRouterMostRemaining.id,
    introducedIn: "0.9.4",
  },
  agentAuthRouterOwnedPools: {
    name: "agent-auth-router-owned-pools",
    index: CAPABILITY_ID_ALLOCATIONS.agentAuthRouterOwnedPools.id,
    introducedIn: "0.9.4",
  },
  agentAuthRouterPools: {
    name: "agent-auth-router-pools",
    index: CAPABILITY_ID_ALLOCATIONS.agentAuthRouterPools.id,
    introducedIn: "0.9.4",
  },
  agentAuthRouterRecovery: {
    name: "agent-auth-router-recovery",
    index: CAPABILITY_ID_ALLOCATIONS.agentAuthRouterRecovery.id,
    introducedIn: "0.9.4",
  },
  agentAuthRouter: {
    name: "agent-auth-router",
    index: CAPABILITY_ID_ALLOCATIONS.agentAuthRouter.id,
    introducedIn: "0.9.4",
  },
  agentSessionView: {
    name: "agent-session-view",
    index: CAPABILITY_ID_ALLOCATIONS.agentSessionView.id,
    introducedIn: "0.9.4",
  },
  installedMachineControl: {
    name: "installed-machine-control",
    index: CAPABILITY_ID_ALLOCATIONS.installedMachineControl.id,
    introducedIn: "0.9.4",
  },
  machineControlSetting: {
    name: "machine-control-setting",
    index: CAPABILITY_ID_ALLOCATIONS.machineControlSetting.id,
    introducedIn: "0.12.0",
  },
  nativePushSubscriptions: {
    name: "native-push-subscriptions-v1",
    index: CAPABILITY_ID_ALLOCATIONS.nativePushSubscriptions.id,
    introducedIn: "0.9.4",
  },
  projectAppDeletion: {
    name: "project-app-deletion",
    index: CAPABILITY_ID_ALLOCATIONS.projectAppDeletion.id,
    introducedIn: "0.9.4",
  },
  vhostFileSiteReplacement: {
    name: "vhost-file-site-replacement",
    index: CAPABILITY_ID_ALLOCATIONS.vhostFileSiteReplacement.id,
    introducedIn: "0.9.4",
  },
  draftSync: {
    name: "draft-sync-v1",
    index: CAPABILITY_ID_ALLOCATIONS.draftSync.id,
    introducedIn: "0.9.4",
  },
  vhostBearerAccess: {
    name: "vhost-bearer-access",
    index: CAPABILITY_ID_ALLOCATIONS.vhostBearerAccess.id,
    introducedIn: "0.8.2",
  },
  vhostOauthAccess: {
    name: "vhost-oauth-access",
    index: CAPABILITY_ID_ALLOCATIONS.vhostOauthAccess.id,
    introducedIn: "0.9.4",
  },
  vhostAppControl: {
    name: "vhost-app-control",
    index: CAPABILITY_ID_ALLOCATIONS.vhostAppControl.id,
    introducedIn: "0.8.2",
  },
  computerControlReleases: {
    name: "computer-control-releases",
    index: CAPABILITY_ID_ALLOCATIONS.computerControlReleases.id,
    introducedIn: "0.8.2",
  },
  claudeGatewayServices: {
    name: "claude-gateway-services",
    index: CAPABILITY_ID_ALLOCATIONS.claudeGatewayServices.id,
    introducedIn: "0.8.2",
  },
  computerControl: {
    name: "optional-computer-control",
    index: CAPABILITY_ID_ALLOCATIONS.computerControl.id,
    introducedIn: "0.8.2",
  },
  experimentalConversation: {
    name: "experimental-simple-client-conversation",
    index: CAPABILITY_ID_ALLOCATIONS.experimentalConversation.id,
    introducedIn: "0.8.2",
  },
  githubStatusControls: {
    name: "github-status-controls",
    index: CAPABILITY_ID_ALLOCATIONS.githubStatusControls.id,
    introducedIn: "0.9.4",
  },
  issueSessionAssociations: {
    name: "issue-session-associations-v1",
    index: CAPABILITY_ID_ALLOCATIONS.issueSessionAssociations.id,
    introducedIn: "0.8.2",
  },
  speechVocabularySessionTerms: {
    name: "speech-vocabulary-session-terms",
    index: CAPABILITY_ID_ALLOCATIONS.speechVocabularySessionTerms.id,
    introducedIn: "0.8.2",
  },
  speechVocabulary: {
    name: "speech-vocabulary",
    index: CAPABILITY_ID_ALLOCATIONS.speechVocabulary.id,
    introducedIn: "0.8.2",
  },
  artifactViewer: {
    name: "artifact-viewer",
    index: CAPABILITY_ID_ALLOCATIONS.artifactViewer.id,
    introducedIn: "0.8.2",
  },
  voiceInput: {
    name: "voiceInput",
    index: CAPABILITY_ID_ALLOCATIONS.voiceInput.id,
    introducedIn: "0.6.0",
  },
  deviceBridgeAvailable: {
    name: "deviceBridge-available",
    index: CAPABILITY_ID_ALLOCATIONS.deviceBridgeAvailable.id,
    introducedIn: "0.6.0",
  },
  deviceBridge: {
    name: "deviceBridge",
    index: CAPABILITY_ID_ALLOCATIONS.deviceBridge.id,
    introducedIn: "0.6.0",
  },
  deviceBridgeDownload: {
    name: "deviceBridge-download",
    index: CAPABILITY_ID_ALLOCATIONS.deviceBridgeDownload.id,
    introducedIn: "0.6.0",
  },
  deviceBridgeUpdate: {
    name: "deviceBridge-update",
    index: CAPABILITY_ID_ALLOCATIONS.deviceBridgeUpdate.id,
    introducedIn: "0.6.0",
  },
  browserSettingsBackup: {
    name: "browser-settings-backup",
    index: CAPABILITY_ID_ALLOCATIONS.browserSettingsBackup.id,
    introducedIn: "0.6.3",
  },
  securityClientAudit: {
    name: SECURITY_CLIENT_AUDIT_CAPABILITY,
    index: CAPABILITY_ID_ALLOCATIONS.securityClientAudit.id,
    introducedIn: "0.7.1",
  },
  reloadSafeCodexRuntime: {
    name: "reload-safe-codex-runtime",
    index: CAPABILITY_ID_ALLOCATIONS.reloadSafeCodexRuntime.id,
    introducedIn: "0.7.1",
  },
  sessionSandboxing: {
    name: "session-sandboxing",
    index: CAPABILITY_ID_ALLOCATIONS.sessionSandboxing.id,
    introducedIn: "0.7.1",
  },
  providerHostControl: {
    name: "provider-host-control",
    index: CAPABILITY_ID_ALLOCATIONS.providerHostControl.id,
    introducedIn: "0.7.1",
  },
  gitWorkingTreeSections: {
    name: "git-working-tree-sections",
    index: CAPABILITY_ID_ALLOCATIONS.gitWorkingTreeSections.id,
    introducedIn: "0.7.2",
  },
  gitWorkingTreeCompleteScan: {
    name: "git-working-tree-complete-scan",
    index: CAPABILITY_ID_ALLOCATIONS.gitWorkingTreeCompleteScan.id,
    introducedIn: "0.7.2",
  },
} as const;
