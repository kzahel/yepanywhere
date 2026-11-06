import { CAPABILITY_ID_ALLOCATIONS } from "./capability-ids.js";
import { OPTIONAL_SERVER_CAPABILITY_BIT_ALLOCATIONS } from "./server-capability-optional-bits.js";
import type { ServerCapabilityDefinition } from "./server-capability-definition.js";

export const SETTINGS_SERVER_CAPABILITIES = {
  providerSteeringModes: {
    id: CAPABILITY_ID_ALLOCATIONS.providerSteeringModes.id,
    name: "provider-steering-modes",
    kind: "permanent",
    area: "settings",
    introducedIn: "0.11.1",
    advertisement: { kind: "version-implied" },
    description: "Provider steering selection scope and launch-mode settings.",
    clientFallback:
      "Keep existing steer controls; send no steering-mode setting to older servers.",
    serverContract: {
      routes: ["GET /api/providers", "GET /api/settings", "PUT /api/settings"],
      requestFields: ["steeringModes"],
      responseFields: ["steering", "steeringModes"],
    },
    lifecycle: {
      kind: "permanent",
      reason: "Gate launch-scoped steering settings on installed servers.",
    },
  },
  providerSteerNowDefaults: {
    id: CAPABILITY_ID_ALLOCATIONS.providerSteerNowDefaults.id,
    name: "provider-steer-now-defaults",
    kind: "permanent",
    area: "settings",
    introducedIn: "0.11.1",
    advertisement: { kind: "version-implied" },
    description:
      "Server stores per-provider overrides of the Steer now default in client defaults.",
    clientFallback:
      "Show only the global Steer now default and send no per-provider value.",
    serverContract: {
      routes: ["GET /api/settings", "PUT /api/settings", "GET /api/version"],
      requestFields: ["clientDefaults.steerNowDefaultByProvider"],
      responseFields: ["settings.clientDefaults.steerNowDefaultByProvider"],
    },
    lifecycle: {
      kind: "permanent",
      reason: "Older servers reject unknown client-default keys.",
    },
  },
  projectAppAutoStart: {
    id: CAPABILITY_ID_ALLOCATIONS.projectAppAutoStart.id,
    name: "project-app-auto-start",
    kind: "permanent",
    area: "settings",
    introducedIn: "0.9.4",
    advertisement: { kind: "version-implied" },
    description:
      "Opt-in start of a served process app when an authorized visit to its reserved address finds it stopped or unreachable, with a restart-loop pause.",
    clientFallback:
      "Hide the auto-start checkbox and make no auto-start request; a stopped app's address keeps showing that it is not serving.",
    serverContract: {
      routes: [
        "GET /api/projects/:projectId/app/address",
        "POST /api/projects/:projectId/app/address/auto-start",
      ],
      responseFields: ["autoStart"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Servers through 0.9.2 have no auto-start route, so a hosted client must not offer the setting there.",
    },
  },
  projectCreationGitChoice: {
    id: CAPABILITY_ID_ALLOCATIONS.projectCreationGitChoice.id,
    name: "project-creation-git-choice",
    kind: "permanent",
    area: "settings",
    introducedIn: "0.9.4",
    advertisement: { kind: "version-implied" },
    description:
      "Server honors gitInit: false when adding a project creates its folder, leaving the new folder without a repository.",
    clientFallback:
      "Show Git initialization as always on for a new folder and send no gitInit field.",
    serverContract: {
      routes: ["POST /api/projects"],
      requestFields: ["gitInit"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Servers through 0.9.2 always initialize Git in a folder they create and ignore the field, so a hosted client must not offer the choice there.",
    },
  },
  vhostFileSites: {
    id: CAPABILITY_ID_ALLOCATIONS.vhostFileSites.id,
    name: "vhost-file-sites",
    kind: "permanent",
    area: "settings",
    introducedIn: "0.9.4",
    advertisement: { kind: "version-implied" },
    description:
      "Vhost rows can serve one file or directory at name.localhost and name.<public root>, managed from Settings and the File Viewer share dialog.",
    clientFallback:
      "Hide the vhost Serves selector and the share dialog's address section; send no vhostSites field and no vhost-site requests.",
    serverContract: {
      routeModules: ["packages/server/src/routes/vhostSites.ts"],
      routes: [
        "GET /api/artifacts/vhost-sites",
        "POST /api/artifacts/vhost-sites",
        "DELETE /api/artifacts/vhost-sites/:name",
      ],
      requestFields: ["vhostSites"],
      responseFields: ["artifactViewer.vhostSites", "sites[].linkedFiles"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Older servers drop vhostSites on save and have no route to claim or serve a file address.",
    },
  },
  vhostFileSiteReplacement: {
    id: CAPABILITY_ID_ALLOCATIONS.vhostFileSiteReplacement.id,
    name: "vhost-file-site-replacement",
    kind: "permanent",
    area: "settings",
    introducedIn: "0.9.4",
    advertisement: {
      kind: "optional-bit",
      index: CAPABILITY_ID_ALLOCATIONS.vhostFileSiteReplacement.id,
    },
    description:
      "Explicit replacement of file vhosts, with creator ownership and project confinement for limited users.",
    clientFallback: "Hide replacement and keep file vhosts administrator-only.",
    serverContract: {
      routes: [
        "GET /api/artifacts/vhost-sites",
        "POST /api/artifacts/vhost-sites",
        "DELETE /api/artifacts/vhost-sites/:name",
      ],
      requestFields: ["replace", "projectId"],
      responseFields: ["sites[].ownerUsername"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Older servers reject collisions and do not support limited-user file vhosts.",
    },
  },
  projectLivePreview: {
    id: CAPABILITY_ID_ALLOCATIONS.projectLivePreview.id,
    name: "project-live-preview",
    kind: "permanent",
    area: "settings",
    introducedIn: "0.9.4",
    advertisement: { kind: "version-implied" },
    description:
      "Template-declared sandboxed live preview and authorized app WebSockets.",
    clientFallback:
      "Hide Live preview and send no live-preview start requests; retain built app and Reload.",
    serverContract: {
      routes: ["POST /api/projects/:projectId/app/start"],
      responseFields: ["projectApp.livePreview", "projectApp.mode"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Older app servers have neither a dev-service mode nor app WebSocket forwarding.",
    },
  },
  projectAppInventory: {
    id: CAPABILITY_ID_ALLOCATIONS.projectAppInventory.id,
    name: "project-app-inventory",
    kind: "permanent",
    area: "settings",
    introducedIn: "0.9.4",
    advertisement: { kind: "version-implied" },
    description:
      "Administrator inventory of project apps and retained addresses.",
    clientFallback:
      "Keep port forwards and show an update note without inventory requests.",
    serverContract: {
      routes: [
        "GET /api/project-apps",
        "POST /api/project-apps/address/release",
      ],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Older servers lack global app inventory and orphan reservation release.",
    },
  },
  projectAppDeletion: {
    id: CAPABILITY_ID_ALLOCATIONS.projectAppDeletion.id,
    name: "project-app-deletion",
    kind: "permanent",
    area: "settings",
    introducedIn: "0.9.4",
    advertisement: {
      kind: "optional-bit",
      index: CAPABILITY_ID_ALLOCATIONS.projectAppDeletion.id,
    },
    description:
      "Administrator deletion of app declarations, with service stop and address release.",
    clientFallback: "Hide app deletion and offer an update notice.",
    serverContract: { routes: ["DELETE /api/projects/:projectId/app"] },
    lifecycle: {
      kind: "permanent",
      reason:
        "Older servers cannot delete app declarations or clean up their addresses.",
    },
  },
  projectService: {
    id: CAPABILITY_ID_ALLOCATIONS.projectService.id,
    name: "project-service",
    kind: "permanent",
    area: "settings",
    introducedIn: "0.9.4",
    advertisement: { kind: "version-implied" },
    description:
      "Project App resolution, isolated delivery and sandboxed service lifecycle.",
    clientFallback: "Hide project App and send no project App requests.",
    serverContract: {
      routes: [
        "GET /api/projects/:projectId/app",
        "POST /api/projects/:projectId/app/open",
        "POST /api/projects/:projectId/app/start",
        "POST /api/projects/:projectId/app/stop",
        "POST /api/projects/:projectId/app/restore",
      ],
    },
    lifecycle: {
      kind: "permanent",
      reason: "Older servers lack project-owned app services.",
    },
  },
  projectAppReservations: {
    id: CAPABILITY_ID_ALLOCATIONS.projectAppReservations.id,
    name: "project-app-reservations",
    kind: "permanent",
    area: "settings",
    introducedIn: "0.9.4",
    advertisement: { kind: "version-implied" },
    description:
      "Retained first-claim project app addresses with separate administrator publication.",
    clientFallback:
      "Hide project address settings and send no reservation requests.",
    serverContract: {
      routes: [
        "GET /api/projects/:projectId/app/address",
        "POST /api/projects/:projectId/app/address/reserve",
        "POST /api/projects/:projectId/app/address/serve",
        "POST /api/projects/:projectId/app/address/release",
      ],
    },
    lifecycle: {
      kind: "permanent",
      reason: "Older servers lack persistent project app addresses.",
    },
  },
  personalProjectHiding: {
    id: CAPABILITY_ID_ALLOCATIONS.personalProjectHiding.id,
    name: "personal-project-hiding",
    kind: "permanent",
    area: "settings",
    introducedIn: "0.9.4",
    advertisement: { kind: "version-implied" },
    description:
      "Limited-user project removal hides the project only from that user's lists, retaining canonical metadata, files and audit history.",
    clientFallback:
      "Keep the existing project removal label and confirmation without promising personal-only removal; send no new request.",
    serverContract: {
      routes: ["DELETE /api/projects/:projectId", "GET /api/projects"],
      responseFields: ["personal"],
    },
    lifecycle: {
      kind: "permanent",
      reason: "Older servers hide a limited user's project globally.",
    },
  },
  projectTemplateSources: {
    id: CAPABILITY_ID_ALLOCATIONS.projectTemplateSources.id,
    name: "project-template-sources",
    kind: "permanent",
    area: "settings",
    introducedIn: "0.8.2",
    advertisement: { kind: "version-implied" },
    description:
      "Configure ordered GitHub and local template sources, retrieve pinned content, and inspect combined inventory without running setup.",
    clientFallback:
      "Hide Project templates settings and send no template-source requests.",
    serverContract: {
      routes: [
        "GET /api/project-template-source",
        "PUT /api/project-template-source",
      ],
      routeModules: ["packages/server/src/routes/project-template-source.ts"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Older servers have no template source retrieval or configuration surface.",
    },
  },
  projectTemplateCreation: {
    id: CAPABILITY_ID_ALLOCATIONS.projectTemplateCreation.id,
    name: "project-template-creation",
    kind: "permanent",
    area: "settings",
    introducedIn: "0.9.4",
    advertisement: { kind: "version-implied" },
    description:
      "Superuser creation from ready templates with retained operation status and preparation dispatch.",
    clientFallback:
      "Keep directory creation and send no template choice or creation requests.",
    serverContract: {
      routes: [
        "GET /api/project-templates/choices",
        "GET /api/project-templates/operations/:id",
        "POST /api/project-templates/operations",
      ],
      routeModules: ["packages/server/src/routes/project-templates.ts"],
    },
    lifecycle: {
      kind: "permanent",
      reason: "Older servers cannot create template projects.",
    },
  },
  limitedUserProjectTemplates: {
    id: CAPABILITY_ID_ALLOCATIONS.limitedUserProjectTemplates.id,
    name: "limited-user-project-templates",
    kind: "permanent",
    area: "settings",
    introducedIn: "0.9.4",
    advertisement: { kind: "version-implied" },
    description:
      "Per-user template creation grants, filtered choices, owned operations and sandboxed setup.",
    clientFallback:
      "Hide template grants and limited-user template creation; preserve older directory behavior.",
    serverContract: {
      routes: [
        "GET /api/project-templates/choices",
        "POST /api/project-templates/operations",
        "GET /api/project-templates/operations/:id",
      ],
      routeModules: ["packages/server/src/routes/project-templates.ts"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Superuser template creation does not imply limited-user authorization or confinement.",
    },
  },
  limitedUserInstructions: {
    id: CAPABILITY_ID_ALLOCATIONS.limitedUserInstructions.id,
    name: "limited-user-instructions",
    kind: "permanent",
    area: "settings",
    introducedIn: "0.9.4",
    advertisement: { kind: "version-implied" },
    description:
      "Shared append/replace instructions and per-user appended blocks for limited-user launches.",
    clientFallback:
      "Hide instruction controls and omit limitedUserInstructions and instructionBlocks from requests.",
    serverContract: {
      routes: [
        "GET /api/settings",
        "PUT /api/settings",
        "GET /api/users",
        "POST /api/users",
        "PATCH /api/users/:username",
      ],
      requestFields: ["limitedUserInstructions", "instructionBlocks"],
    },
    lifecycle: {
      kind: "permanent",
      reason: "Older servers do not apply limited-user prompt instructions.",
    },
  },
  limitedUserBrowserDefaults: {
    id: CAPABILITY_ID_ALLOCATIONS.limitedUserBrowserDefaults.id,
    name: "limited-user-browser-defaults",
    kind: "permanent",
    area: "settings",
    introducedIn: "0.9.4",
    advertisement: { kind: "version-implied" },
    description:
      "Server stores browser settings the superuser publishes for limited users' clients to apply once per revision.",
    clientFallback:
      "Hide the Users browser-defaults panel; limited users' clients fetch and apply nothing.",
    serverContract: {
      routes: [
        "GET /api/settings/limited-user-defaults",
        "PUT /api/settings/limited-user-defaults",
      ],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Older servers have no limited-user defaults slot to read or publish.",
    },
  },
  limitedUserPathGrants: {
    id: CAPABILITY_ID_ALLOCATIONS.limitedUserPathGrants.id,
    name: "limited-user-path-grants",
    kind: "permanent",
    area: "settings",
    introducedIn: "0.9.4",
    advertisement: { kind: "version-implied" },
    description:
      "Limited users carry directory grants giving an access level to every project at or beneath a path.",
    clientFallback:
      "Hide the Users directory-access editor and send no pathGrants field.",
    serverContract: {
      routes: ["POST /api/users", "PATCH /api/users/:username"],
      requestFields: ["pathGrants"],
      responseFields: ["users[].pathGrants"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Older servers ignore pathGrants, so a directory grant would appear saved and grant nothing.",
    },
  },
  projectAccessSharing: {
    id: CAPABILITY_ID_ALLOCATIONS.projectAccessSharing.id,
    name: "project-access-sharing",
    kind: "permanent",
    area: "settings",
    introducedIn: "0.9.4",
    advertisement: { kind: "version-implied" },
    description:
      "A project's settings let the superuser or the limited user who created it grant other limited users access to that project.",
    clientFallback:
      "Hide the project's sharing section; the superuser grants access in Settings → Users.",
    serverContract: {
      routes: [
        "GET /api/projects/:projectId/access",
        "PUT /api/projects/:projectId/access",
      ],
      routeModules: ["packages/server/src/routes/project-access.ts"],
    },
    lifecycle: {
      kind: "permanent",
      reason: "Older servers have no per-project sharing route.",
    },
  },
  projectCopy: {
    id: CAPABILITY_ID_ALLOCATIONS.projectCopy.id,
    name: "project-copy",
    kind: "permanent",
    area: "settings",
    introducedIn: "0.9.4",
    advertisement: { kind: "version-implied" },
    description:
      "Anyone who can see a project may copy its working tree into their own project directory as a new project.",
    clientFallback: "Hide the Copy action on project cards.",
    serverContract: {
      routes: ["POST /api/projects/:projectId/copy"],
      routeModules: ["packages/server/src/routes/project-copy.ts"],
    },
    lifecycle: {
      kind: "permanent",
      reason: "Older servers have no copy route.",
    },
  },
  limitedUserNoProjectSessions: {
    id: CAPABILITY_ID_ALLOCATIONS.limitedUserNoProjectSessions.id,
    name: "limited-user-no-project-sessions",
    kind: "permanent",
    area: "settings",
    introducedIn: "0.9.4",
    advertisement: { kind: "version-implied" },
    description:
      "Per-user permission to create sandboxed sessions in a private No project workspace.",
    clientFallback:
      "Hide the checkbox, omit allowNoProjectSessions, and prevent limited-user detached creation.",
    serverContract: {
      routes: [
        "POST /api/users",
        "PATCH /api/users/:username",
        "POST /api/sessions",
        "POST /api/sessions/create",
      ],
      requestFields: ["allowNoProjectSessions"],
      responseFields: ["allowNoProjectSessions"],
    },
    lifecycle: {
      kind: "permanent",
      reason: "Older servers admit detached creation only for the superuser.",
    },
  },
  projectAppAddressLinks: {
    id: CAPABILITY_ID_ALLOCATIONS.projectAppAddressLinks.id,
    name: "project-app-address-links",
    kind: "permanent",
    area: "settings",
    introducedIn: "0.9.4",
    advertisement: { kind: "version-implied" },
    description:
      "Authorized transferable address URLs and per-user public-app/private-link permissions.",
    clientFallback:
      "Omit the address URL row and the optional user permission fields on older servers.",
    serverContract: {
      routes: [
        "GET /api/projects/:projectId/app/address",
        "GET /api/projects/:projectId/app",
        "POST /api/projects/:projectId/app/address/serve",
        "POST /api/users",
        "PATCH /api/users/:username",
      ],
      requestFields: ["allowPublicApps", "allowPrivateAppLinks"],
      responseFields: [
        "reservations[].url",
        "canRelease",
        "canCopyLink",
        "updatedAt",
        "allowPublicApps",
        "allowPrivateAppLinks",
      ],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Older servers do not expose address links or these user permissions.",
    },
  },
  templatePreparationAttachments: {
    id: CAPABILITY_ID_ALLOCATIONS.templatePreparationAttachments.id,
    name: "template-preparation-attachments",
    kind: "permanent",
    area: "settings",
    introducedIn: "0.9.4",
    advertisement: { kind: "version-implied" },
    description:
      "Account-owned draft uploads and attachments in template preparation.",
    clientFallback:
      "Disable attachments for template creation on older servers.",
    serverContract: {
      routes: [
        "POST /api/project-templates/operations",
        "GET /api/attachments/staging/drafts/upload/ws",
      ],
      // These modules also serve earlier capabilities; only the listed
      // attachment semantics belong to this capability.
      requestFields: ["stagedAttachments"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Template creation alone does not imply attachment preparation support.",
    },
  },
  computerControlReleases: {
    id: CAPABILITY_ID_ALLOCATIONS.computerControlReleases.id,
    name: "computer-control-releases",
    kind: "permanent",
    retired: true,
    area: "settings",
    introducedIn: "0.8.2",
    advertisement: {
      kind: "optional-bit",
      index: CAPABILITY_ID_ALLOCATIONS.computerControlReleases.id,
    },
    description:
      "Retired in 0.9.4: YA-managed Windows release downloads and updates. ID reserved.",
    clientFallback:
      "Show server-update guidance; send no release-management requests.",
    lifecycle: {
      kind: "permanent",
      reason: "Optional managed Windows component.",
    },
  },
  rendezUploads: {
    id: CAPABILITY_ID_ALLOCATIONS.rendezUploads.id,
    name: "rendez-uploads",
    kind: "permanent",
    area: "settings",
    introducedIn: "0.9.4",
    advertisement: { kind: "version-implied" },
    description:
      "Configures opt-in project .rendez upload monitoring, project overrides and burst limits.",
    clientFallback:
      "Show server-update guidance and make no rendez settings write.",
    serverContract: {
      routes: ["GET /api/settings", "PUT /api/settings"],
      requestFields: ["settings.rendez"],
      responseFields: ["settings.rendez"],
    },
    lifecycle: {
      kind: "permanent",
      reason: "Older servers cannot monitor rendez uploads.",
    },
  },
  rendezProjectStatus: {
    id: CAPABILITY_ID_ALLOCATIONS.rendezProjectStatus.id,
    name: "rendez-project-status",
    kind: "permanent",
    area: "settings",
    introducedIn: "0.9.4",
    advertisement: { kind: "version-implied" },
    description:
      "Reports which projects' .rendez observers are running, for the settings project list.",
    clientFallback:
      "Show the project list without watching or waiting status and make no status request.",
    serverContract: {
      routes: ["GET /api/settings/rendez/status"],
      responseFields: ["watching"],
    },
    lifecycle: {
      kind: "permanent",
      reason: "Older servers do not report .rendez observer status.",
    },
  },
  projectAppStartCommand: {
    id: CAPABILITY_ID_ALLOCATIONS.projectAppStartCommand.id,
    name: "project-app-start-command",
    kind: "permanent",
    area: "settings",
    introducedIn: "0.11.1",
    advertisement: { kind: "version-implied" },
    description:
      "Replaces a process app's start command in the project's .project-template/app.json at the request of a principal with execution rights, only while the file still declares the command the editor loaded.",
    clientFallback:
      "Show the start command read-only and make no edit request; it can still be changed in app.json.",
    serverContract: {
      routes: ["PUT /api/projects/:projectId/app/start-command"],
      requestFields: ["expected", "argv"],
      responseFields: ["declaration", "restartRequired"],
    },
    lifecycle: {
      kind: "permanent",
      reason: "Older servers have no start-command route.",
    },
  },
  projectDirectoryStoragePolicy: {
    id: CAPABILITY_ID_ALLOCATIONS.projectDirectoryStoragePolicy.id,
    name: "project-directory-storage-policy",
    kind: "permanent",
    area: "settings",
    introducedIn: "0.7.1",
    advertisement: { kind: "version-implied" },
    description:
      "Server defaults project-scoped YA state to its data directory, supports explicit project-local opt-in, and reconciles revisioned mutable state before changing modes.",
    clientFallback:
      "Current clients assume this v0.8.0 baseline contract; older servers should update or use their bundled client. User preferences and runtime availability still apply.",
    serverContract: {
      routes: ["GET /api/settings", "PUT /api/settings"],
      requestFields: ["settings.projectDirectoryStorage"],
      responseFields: ["settings.projectDirectoryStorage"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Older servers may write YA-managed state into project directories without an opt-in.",
    },
  },
  idleReapHoursSetting: {
    id: CAPABILITY_ID_ALLOCATIONS.idleReapHoursSetting.id,
    name: "idle-reap-hours-setting",
    kind: "permanent",
    area: "settings",
    introducedIn: "0.7.1",
    advertisement: { kind: "version-implied" },
    description:
      "Server exposes a live-configurable best-effort grace before unviewed, verified-idle provider processes may be reaped.",
    clientFallback:
      "Current clients assume this v0.8.0 baseline contract; older servers should update or use their bundled client. User preferences and runtime availability still apply.",
    serverContract: {
      routes: ["GET /api/settings", "PUT /api/settings"],
      requestFields: ["settings.idleReapHours"],
      responseFields: ["settings.idleReapHours"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Hosted clients may outpace installed servers, and older servers do not expose a persisted idle-reap policy.",
    },
  },
  subagentMaxDepthSetting: {
    id: CAPABILITY_ID_ALLOCATIONS.subagentMaxDepthSetting.id,
    name: "subagent-max-depth-setting",
    kind: "permanent",
    area: "settings",
    introducedIn: "0.7.1",
    advertisement: { kind: "version-implied" },
    description:
      "Server persists a process-launch limit for supported providers' native subagent nesting depth.",
    clientFallback:
      "Current clients assume this v0.8.0 baseline contract; older servers should update or use their bundled client. User preferences and runtime availability still apply.",
    serverContract: {
      routes: ["GET /api/settings", "PUT /api/settings"],
      requestFields: ["settings.subagentMaxDepth"],
      responseFields: ["settings.subagentMaxDepth"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Hosted clients may outpace installed servers, and older servers do not expose a process-launch subagent-depth policy.",
    },
  },
  toolResultMediaPreservationPolicy: {
    id: CAPABILITY_ID_ALLOCATIONS.toolResultMediaPreservationPolicy.id,
    name: "tool-result-media-preservation-policy",
    kind: "permanent",
    area: "settings",
    introducedIn: "0.7.1",
    advertisement: { kind: "version-implied" },
    description:
      "Server loads tool-result images on demand by default and can preserve new live results when explicitly enabled.",
    clientFallback:
      "Current clients assume this v0.8.0 baseline contract; older servers should update or use their bundled client. User preferences and runtime availability still apply.",
    serverContract: {
      routes: ["GET /api/settings", "PUT /api/settings"],
      requestFields: ["settings.toolResultMediaPreservation"],
      responseFields: ["settings.toolResultMediaPreservation"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Older and development servers may use different tool-media storage semantics.",
    },
  },
  cacheMissBillingIgnoreAfter: {
    id: CAPABILITY_ID_ALLOCATIONS.cacheMissBillingIgnoreAfter.id,
    name: "cache-miss-billing-ignore-after",
    kind: "permanent",
    area: "settings",
    introducedIn: "0.7.2",
    advertisement: { kind: "version-implied" },
    description:
      "Server separates the cache-billing upper idle cutoff from the legacy recent-activity no-alert window.",
    clientFallback:
      "Current clients assume this v0.8.0 baseline contract; older servers should update or use their bundled client. User preferences and runtime availability still apply.",
    serverContract: {
      routes: ["GET /api/settings", "PUT /api/settings"],
      requestFields: ["settings.cacheMissBilling.ignoreAfterMinutes"],
      responseFields: ["settings.cacheMissBilling.ignoreAfterMinutes"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Older servers interpret recentActivityMinutes as a lower no-alert window, so the upper cutoff requires an additive field and permanent client gate.",
    },
  },
  cacheMissBillingExpectedExpiry: {
    id: CAPABILITY_ID_ALLOCATIONS.cacheMissBillingExpectedExpiry.id,
    name: "cache-miss-billing-expected-expiry",
    kind: "permanent",
    area: "settings",
    introducedIn: "0.7.2",
    advertisement: { kind: "version-implied" },
    description:
      "Server records post-freshness cache reads and input costs as expected expiry evidence behind an opt-in query and live event.",
    clientFallback:
      "Current clients assume this v0.8.0 baseline contract; older servers should update or use their bundled client. User preferences and runtime availability still apply.",
    serverContract: {
      routes: ["GET /api/settings/cache-miss-billing/events"],
      requestFields: ["includeExpectedExpiry"],
      responseFields: [
        "events[].expectedInputCost.freshEnough",
        "events[].outcome",
      ],
      events: ["cache-miss-billing-expected-expiry"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Older clients must not receive expected long-idle evidence through the legacy response or alert-oriented live event.",
    },
  },
  gitLiveWorktreeSetting: {
    id: CAPABILITY_ID_ALLOCATIONS.gitLiveWorktreeSetting.id,
    name: "git-live-worktree-setting",
    kind: "permanent",
    area: "settings",
    introducedIn: "0.7.2",
    advertisement: { kind: "version-implied" },
    description:
      "Server persists the default-off live worktree monitoring setting independently of whether the live protocol is active.",
    clientFallback:
      "Current clients assume this v0.8.0 baseline contract; older servers should update or use their bundled client. Settings, permissions, source readiness and runtime availability still apply.",
    serverContract: {
      routes: ["GET /api/settings", "PUT /api/settings"],
      requestFields: ["settings.liveWorktreeMonitoringEnabled"],
      responseFields: ["settings.liveWorktreeMonitoringEnabled"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Older servers lack the safety setting, so a current client must not interpret their source-ahead live capability as operator opt-in.",
    },
  },
  browserSettingsBackup: {
    id: CAPABILITY_ID_ALLOCATIONS.browserSettingsBackup.id,
    name: "browser-settings-backup",
    kind: "permanent",
    area: "settings",
    introducedIn: "0.6.3",
    advertisement: {
      kind: "optional-bit",
      index:
        OPTIONAL_SERVER_CAPABILITY_BIT_ALLOCATIONS.browserSettingsBackup.index,
    },
    description:
      "Server stores one explicit backup of portable browser settings for save/load controls.",
    clientFallback: "Hide browser settings save/load controls.",
    serverContract: {
      routes: [
        "GET /api/settings/browser-backup",
        "PUT /api/settings/browser-backup",
      ],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Hosted clients must not offer server-backed browser settings controls to older servers without the storage route.",
    },
  },
  projectSessionDefaults: {
    id: CAPABILITY_ID_ALLOCATIONS.projectSessionDefaults.id,
    name: "project-session-defaults",
    kind: "permanent",
    retired: true,
    area: "settings",
    introducedIn: "0.7.1",
    advertisement: { kind: "version-implied" },
    description:
      "Retired: project-scoped synthetic heartbeat defaults and recent messages. The permanent ID remains allocated; current servers withdraw this capability.",
    clientFallback:
      "Hide heartbeat-default controls and make no project-default requests. Project app and sharing controls use their own retained capabilities.",
    serverContract: {
      routes: [
        "GET /api/projects/:projectId/session-defaults",
        "PATCH /api/projects/:projectId/session-defaults",
      ],
      // Historical contract only: the retired route module no longer exists.
      requestFields: [
        "projectSessionDefaults.heartbeatTurnsAfterMinutes",
        "projectSessionDefaults.heartbeatTurnText",
      ],
      responseFields: [
        "projectSessionDefaults.projectId",
        "projectSessionDefaults.overrides",
        "projectSessionDefaults.recentHeartbeatTurnTexts",
      ],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Hosted clients can outpace installed servers, and project settings must never issue unsupported reads or writes to older servers.",
    },
  },
  projectCodeNames: {
    id: CAPABILITY_ID_ALLOCATIONS.projectCodeNames.id,
    name: "project-code-names",
    kind: "permanent",
    area: "settings",
    introducedIn: "0.7.2",
    advertisement: { kind: "version-implied" },
    description:
      "Server allocates, persists, and atomically edits unique project code names for compact project identity in browser titles and session lists.",
    clientFallback:
      "Current clients assume this v0.8.0 baseline contract; older servers should update or use their bundled client. User preferences and runtime availability still apply.",
    serverContract: {
      routes: [
        "GET /api/projects",
        "GET /api/projects/:projectId",
        "POST /api/projects",
        "PATCH /api/projects/:projectId/code-name",
      ],
      requestFields: ["projectCodeName.codeName"],
      responseFields: [
        "projects[].codeName",
        "project.codeName",
        "projectCodeName.assignments",
      ],
      events: ["project-code-names-changed"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Hosted clients can outpace installed servers, which neither return durable code names nor support conflict-safe edits.",
    },
  },
  projectCaptions: {
    id: CAPABILITY_ID_ALLOCATIONS.projectCaptions.id,
    name: "project-captions",
    kind: "permanent",
    area: "settings",
    introducedIn: "0.8.2",
    advertisement: { kind: "version-implied" },
    description:
      "Server derives a short project caption from README or manifest text, accepts a per-project override in app data, and reports the caption with its source on project responses.",
    clientFallback:
      "Show no caption on project cards or the session breadcrumb tooltip, hide caption editing, and make no caption request.",
    serverContract: {
      routes: [
        "GET /api/projects",
        "GET /api/projects/:projectId",
        "POST /api/projects",
        "PATCH /api/projects/:projectId/caption",
      ],
      requestFields: ["projectCaption.caption"],
      responseFields: [
        "projects[].caption",
        "project.caption",
        "projectCaption.caption",
      ],
      events: ["project-captions-changed"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Hosted clients can outpace installed servers, which neither derive captions nor accept caption overrides.",
    },
  },
  projectNames: {
    id: CAPABILITY_ID_ALLOCATIONS.projectNames.id,
    name: "project-names",
    kind: "permanent",
    area: "settings",
    introducedIn: "0.8.2",
    advertisement: { kind: "version-implied" },
    description:
      "Server accepts a chosen project name and code name when a project is added, stores a name override in app data, applies it wherever the project is named, and announces project list changes.",
    clientFallback:
      "Add projects by path alone, show the path's last component as the name, and make no name request.",
    serverContract: {
      routes: [
        "GET /api/projects",
        "GET /api/projects/:projectId",
        "POST /api/projects",
        "PATCH /api/projects/:projectId/name",
      ],
      requestFields: [
        "addProject.name",
        "addProject.codeName",
        "projectName.name",
      ],
      responseFields: ["projects[].name", "project.name"],
      events: ["projects-changed"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Hosted clients can outpace installed servers, which ignore a chosen name and would silently add the project under its path name.",
    },
  },
} as const satisfies Record<string, ServerCapabilityDefinition>;
