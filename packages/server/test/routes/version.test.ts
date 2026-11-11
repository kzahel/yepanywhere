import { describe, expect, it } from "vitest";
import {
  APPROVAL_AUDIT_LOG_CAPABILITY,
  BANG_COMMANDS_CAPABILITY,
  BROWSER_SETTINGS_BACKUP_CAPABILITY,
  CACHE_MISS_BILLING_EXPECTED_EXPIRY_CAPABILITY,
  CACHE_MISS_BILLING_IGNORE_AFTER_CAPABILITY,
  CLAUDE_GATEWAY_AUTOSTART_CAPABILITY,
  CLAUDE_GATEWAY_CAPABILITY,
  CLAUDE_GATEWAY_DISABLE_AGENT_CAPABILITY,
  CLAUDE_GATEWAY_DISABLE_PLAN_MODE_CAPABILITY,
  CODEX_CYBER_ACCESS_PROGRAM_SETTING_CAPABILITY,
  CODEX_PAGINATED_ROLLOUT_LINEAGE_CAPABILITY,
  CODEX_PLAN_TOOL_SETTING_CAPABILITY,
  CODEX_REASONING_SUMMARY_SETTING_CAPABILITY,
  GIT_DIRTY_FILE_EDITOR_CAPABILITY,
  GIT_INCLUSIVE_TO_HEAD_CAPABILITY,
  GIT_LIVE_WORKTREE_SETTING_CAPABILITY,
  GIT_WORKING_TREE_SECTIONS_CAPABILITY,
  GIT_WORKING_TREE_COMPLETE_SCAN_CAPABILITY,
  GLOSSARY_TOOLTIPS_CAPABILITY,
  GIT_SOURCE_REVIEW_CAPABILITY,
  GIT_SOURCE_REVIEW_PROJECTIONS_CAPABILITY,
  HOST_AWAKE_CONTROL_CAPABILITY,
  HOST_IDENTITY_CAPABILITY,
  IDLE_REAP_HOURS_SETTING_CAPABILITY,
  PROJECT_CAPTIONS_CAPABILITY,
  PROJECT_CODE_NAMES_CAPABILITY,
  PROJECT_NAMES_CAPABILITY,
  PROJECT_SESSION_DEFAULTS_CAPABILITY,
  PUBLIC_FILE_SHARES_CAPABILITY,
  PROVIDER_HOST_CONTROL_CAPABILITY,
  RELOAD_SAFE_CODEX_RUNTIME_SETTINGS_CAPABILITY,
  SESSION_SANDBOXING_CAPABILITY,
  SESSION_SANDBOX_NETWORK_FIREWALL_CAPABILITY,
  SESSION_SANDBOXING_STATUS_CAPABILITY,
  SESSION_FORK_TURN_INTENTS_CAPABILITY,
  SESSION_CREATION_PROVENANCE_CAPABILITY,
  SIDEBAR_SESSION_RESUME_CAPABILITY,
  SECURITY_CLIENT_AUDIT_CAPABILITY,
  SERVER_CAPABILITIES,
} from "@yep-anywhere/shared";
import { getServerCapabilities } from "../../src/routes/version.js";

describe("Version Routes", () => {
  it("advertises installed MC only with its mounted supported-host route", () => {
    const name = SERVER_CAPABILITIES.installedMachineControl.name;
    expect(getServerCapabilities()).not.toContain(name);
    expect(
      getServerCapabilities({ installedMachineControlAvailable: true }),
    ).toContain(name);
    expect(
      getServerCapabilities({
        installedMachineControlAvailable: true,
        deniedCapabilities: [name],
      }),
    ).not.toContain(name);
  });
  it("advertises native push only with a configured mounted adapter", () => {
    const name = SERVER_CAPABILITIES.nativePushSubscriptions.name;
    expect(
      getServerCapabilities({ securityClientAuditAvailable: true }),
    ).not.toContain(name);
    const nativePush = {
      protocolVersion: 1 as const,
      brokerUrl: "https://push.example.test",
      privacyModes: ["generic"] as ["generic"],
    };
    expect(getServerCapabilities({ nativePush })).toContain(name);
    expect(
      getServerCapabilities({ nativePush, deniedCapabilities: [name] }),
    ).not.toContain(name);
  });
  it("advertises the sidebar snapshot only with its retained owner", () => {
    const name = SERVER_CAPABILITIES.sidebarSessionSnapshot.name;
    expect(getServerCapabilities()).not.toContain(name);
    expect(
      getServerCapabilities({ collectionQueryUpdatesAvailable: true }),
    ).toContain(name);
  });
  // A version-implied capability is inferred only from a release at least
  // its introducedIn. A source build between releases reports the previous
  // tag's version, so a capability left out of this list is invisible to the
  // client until that release ships; three went unseen this way on
  // 2026-09-28. Listing one a release already implies costs nothing: the
  // versioned encoding drops it.
  it("advertises every version-implied capability explicitly when available", () => {
    const advertised = new Set(
      getServerCapabilities({ collectionQueryUpdatesAvailable: true }),
    );
    const missing = Object.values(SERVER_CAPABILITIES)
      .filter(
        (definition) =>
          definition.advertisement.kind === "version-implied" &&
          definition.name !== SERVER_CAPABILITIES.projectSessionDefaults.name &&
          !advertised.has(definition.name),
      )
      .map((definition) => definition.name);
    expect(missing).toEqual([]);
  });

  it("advertises recent local speech model selection", () => {
    expect(getServerCapabilities()).toContain("local-speech-model-selection");
  });
  it("advertises session creation provenance", () => {
    expect(getServerCapabilities()).toContain(
      SESSION_CREATION_PROVENANCE_CAPABILITY,
    );
  });
  it("advertises compiled glossary artifacts", () => {
    expect(getServerCapabilities()).toContain(GLOSSARY_TOOLTIPS_CAPABILITY);
  });

  it("advertises approval audit log control", () => {
    expect(getServerCapabilities()).toContain(APPROVAL_AUDIT_LOG_CAPABILITY);
  });

  it("advertises explicitly enabled local command support", () => {
    expect(getServerCapabilities()).toContain(BANG_COMMANDS_CAPABILITY);
  });

  it("advertises browser settings backup storage", () => {
    expect(
      getServerCapabilities({ browserSettingsBackupAvailable: true }),
    ).toContain(BROWSER_SETTINGS_BACKUP_CAPABILITY);
    expect(getServerCapabilities()).not.toContain(
      BROWSER_SETTINGS_BACKUP_CAPABILITY,
    );
  });

  it("advertises security-client audit only when its routes are mounted", () => {
    expect(
      getServerCapabilities({ securityClientAuditAvailable: true }),
    ).toContain(SECURITY_CLIENT_AUDIT_CAPABILITY);
    expect(getServerCapabilities()).not.toContain(
      SECURITY_CLIENT_AUDIT_CAPABILITY,
    );
  });

  it("advertises host identity persistence", () => {
    expect(getServerCapabilities()).toContain(HOST_IDENTITY_CAPABILITY);
  });

  it("advertises host-awake settings and status", () => {
    expect(getServerCapabilities()).toContain(HOST_AWAKE_CONTROL_CAPABILITY);
  });

  it("advertises configurable idle provider reaping", () => {
    expect(getServerCapabilities()).toContain(
      IDLE_REAP_HOURS_SETTING_CAPABILITY,
    );
  });

  it("advertises project code-name support", () => {
    expect(getServerCapabilities()).toContain(PROJECT_CODE_NAMES_CAPABILITY);
  });

  // Version-implied capabilities are only implied at or past their release.
  // A development build is versioned below that release, so the client would
  // never see these unless the explicit list carries them until then.
  it("advertises project captions and chosen names ahead of their release", () => {
    expect(getServerCapabilities()).toContain(PROJECT_CAPTIONS_CAPABILITY);
    expect(getServerCapabilities()).toContain(PROJECT_NAMES_CAPABILITY);
  });

  it("advertises isolated Claude gateway configuration", () => {
    expect(getServerCapabilities()).toContain(CLAUDE_GATEWAY_CAPABILITY);
    expect(getServerCapabilities()).toContain(
      CLAUDE_GATEWAY_AUTOSTART_CAPABILITY,
    );
    expect(getServerCapabilities()).toContain(
      CLAUDE_GATEWAY_DISABLE_AGENT_CAPABILITY,
    );
    expect(getServerCapabilities()).toContain(
      CLAUDE_GATEWAY_DISABLE_PLAN_MODE_CAPABILITY,
    );
  });

  it("retains the reload-safe Codex settings compatibility schema", () => {
    expect(getServerCapabilities()).toContain(
      RELOAD_SAFE_CODEX_RUNTIME_SETTINGS_CAPABILITY,
    );
  });

  it("advertises the Codex reasoning-summary setting", () => {
    expect(getServerCapabilities()).toContain(
      CODEX_REASONING_SUMMARY_SETTING_CAPABILITY,
    );
  });

  it("advertises the Codex plan-tool setting", () => {
    expect(getServerCapabilities()).toContain(
      CODEX_PLAN_TOOL_SETTING_CAPABILITY,
    );
  });

  it("advertises the Codex cyber access program setting", () => {
    expect(getServerCapabilities()).toContain(
      CODEX_CYBER_ACCESS_PROGRAM_SETTING_CAPABILITY,
    );
  });

  it("advertises reference-backed Codex rollout history", () => {
    expect(getServerCapabilities()).toContain(
      CODEX_PAGINATED_ROLLOUT_LINEAGE_CAPABILITY,
    );
  });

  it("advertises the complete source browser and review contract", () => {
    expect(getServerCapabilities()).toContain(GIT_SOURCE_REVIEW_CAPABILITY);
  });

  it("advertises dirty-file editor attribution", () => {
    expect(getServerCapabilities()).toContain(GIT_DIRTY_FILE_EDITOR_CAPABILITY);
  });

  it("advertises Source Control diff projections", () => {
    expect(getServerCapabilities()).toContain(
      GIT_SOURCE_REVIEW_PROJECTIONS_CAPABILITY,
    );
    expect(getServerCapabilities()).toContain(GIT_INCLUSIVE_TO_HEAD_CAPABILITY);
  });

  it("advertises the default-off live worktree setting", () => {
    expect(getServerCapabilities()).toContain(
      GIT_LIVE_WORKTREE_SETTING_CAPABILITY,
    );
  });

  it("advertises live worktree protocols only while enabled", () => {
    expect(getServerCapabilities()).not.toContain(
      GIT_WORKING_TREE_COMPLETE_SCAN_CAPABILITY,
    );
    expect(getServerCapabilities()).not.toContain(
      GIT_WORKING_TREE_SECTIONS_CAPABILITY,
    );
    const enabledCapabilities = getServerCapabilities({
      isLiveWorktreeMonitoringEnabled: () => true,
    });
    expect(enabledCapabilities).toContain(
      GIT_WORKING_TREE_COMPLETE_SCAN_CAPABILITY,
    );
    expect(enabledCapabilities).toContain(GIT_WORKING_TREE_SECTIONS_CAPABILITY);
  });

  it("advertises the cache-billing ignore-after setting", () => {
    expect(getServerCapabilities()).toContain(
      CACHE_MISS_BILLING_IGNORE_AFTER_CAPABILITY,
    );
  });

  it("advertises expected cache-expiry evidence", () => {
    expect(getServerCapabilities()).toContain(
      CACHE_MISS_BILLING_EXPECTED_EXPIRY_CAPABILITY,
    );
  });

  it("advertises sandbox protocols only when preflight passes", () => {
    expect(getServerCapabilities()).toContain(
      SESSION_SANDBOXING_STATUS_CAPABILITY,
    );
    expect(getServerCapabilities()).not.toContain(
      SESSION_SANDBOXING_CAPABILITY,
    );
    expect(getServerCapabilities()).toContain(
      SESSION_SANDBOX_NETWORK_FIREWALL_CAPABILITY,
    );
    const capabilities = getServerCapabilities({
      sessionSandboxAvailability: {
        state: "available",
        platform: "linux",
        backend: "bubblewrap",
        version: "0.4.0",
      },
    });
    expect(capabilities).toContain(SESSION_SANDBOXING_CAPABILITY);
    expect(capabilities).toContain(SESSION_SANDBOX_NETWORK_FIREWALL_CAPABILITY);
  });

  it("advertises server-resolved session fork intents", () => {
    expect(getServerCapabilities()).toContain(
      SESSION_FORK_TURN_INTENTS_CAPABILITY,
    );
  });

  it("advertises sidebar-safe session resume summaries", () => {
    expect(getServerCapabilities()).toContain(
      SIDEBAR_SESSION_RESUME_CAPABILITY,
    );
  });

  it("withdraws retired project heartbeat defaults", () => {
    expect(getServerCapabilities()).not.toContain(
      PROJECT_SESSION_DEFAULTS_CAPABILITY,
    );
  });

  it("advertises live public file shares", () => {
    expect(getServerCapabilities()).toContain(PUBLIC_FILE_SHARES_CAPABILITY);
  });

  it("advertises provider-host control only while registered", () => {
    expect(getServerCapabilities()).not.toContain(
      PROVIDER_HOST_CONTROL_CAPABILITY,
    );
    expect(
      getServerCapabilities({ providerHostControlAvailable: true }),
    ).toContain(PROVIDER_HOST_CONTROL_CAPABILITY);
  });
});

it("advertises draft synchronization only when its SQLite-backed store is ready", () => {
  expect(getServerCapabilities()).not.toContain("draft-sync-v1");
  expect(
    getServerCapabilities({ getDraftSyncAvailable: () => false }),
  ).not.toContain("draft-sync-v1");
  expect(
    getServerCapabilities({ getDraftSyncAvailable: () => true }),
  ).toContain("draft-sync-v1");
});
