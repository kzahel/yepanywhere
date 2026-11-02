import { describe, expect, it } from "vitest";
import {
  ATTACHMENT_ONLY_SESSION_MESSAGES_CAPABILITY,
  CAPABILITY_ID_ALLOCATIONS,
  CAPABILITY_ID_ENCODING_VERSION,
  CACHE_MISS_BILLING_EXPECTED_EXPIRY_CAPABILITY,
  CACHE_MISS_BILLING_IGNORE_AFTER_CAPABILITY,
  CLAUDE_GATEWAY_DISABLE_PLAN_MODE_CAPABILITY,
  CODEX_PLAN_TOOL_SETTING_CAPABILITY,
  CODEX_REASONING_SUMMARY_SETTING_CAPABILITY,
  CODEX_STREAM_DURABLE_ID_ALIGNMENT_CAPABILITY,
  DEVICE_BRIDGE_CAPABILITY,
  DEVICE_BRIDGE_UPDATE_CAPABILITY,
  GIT_FILE_REVISION_CAPABILITY,
  GIT_INCLUSIVE_TO_HEAD_CAPABILITY,
  GIT_INCOMING_COMMITS_CAPABILITY,
  GIT_LIVE_WORKTREE_SETTING_CAPABILITY,
  GIT_WORKING_TREE_COMPLETE_SCAN_CAPABILITY,
  GIT_WORKING_TREE_FILES_CAPABILITY,
  GIT_WORKING_TREE_SECTIONS_CAPABILITY,
  PROJECT_QUEUE_ATTACHMENT_EDITING_CAPABILITY,
  PROJECT_SESSION_DEFAULTS_CAPABILITY,
  PROVIDER_HOST_CONTROL_CAPABILITY,
  PUBLIC_SHARE_MANAGEMENT_FREEZE_CAPABILITY,
  PUBLIC_SHARE_SESSION_CHUNKS_CAPABILITY,
  SUBAGENT_MAX_DEPTH_SETTING_CAPABILITY,
  VOICE_INPUT_CAPABILITY,
  encodeVersionedServerCapabilities,
  hasServerCapabilityAdvertisement,
  negotiateServerCapabilityEncoding,
  serverHasCapability,
  getSessionTextCreationCapability,
} from "../index.js";

describe("server capability advertisements", () => {
  it("requires the Pi-specific text creation bit across supported releases", () => {
    const name = getSessionTextCreationCapability("pi")!.name;
    expect(name).toBe(CAPABILITY_ID_ALLOCATIONS.piTextCreation.name);
    expect(getSessionTextCreationCapability("unqualified")).toBeUndefined();
    for (const current of ["0.8.0", "0.9.0", "0.10.0", "0.11.0", "99.0.0"]) {
      expect(serverHasCapability({ current }, name)).toBe(false);
      expect(
        serverHasCapability(
          {
            current,
            ...encodeVersionedServerCapabilities(
              [
                CAPABILITY_ID_ALLOCATIONS.codexTextCreation.name,
                CAPABILITY_ID_ALLOCATIONS.claudeTextCreation.name,
              ],
              current,
            ),
          },
          name,
        ),
      ).toBe(false);
      expect(
        serverHasCapability(
          { current, ...encodeVersionedServerCapabilities([name], current) },
          name,
        ),
      ).toBe(true);
    }
  });

  it("requires the OpenCode-specific text creation bit across supported releases", () => {
    const name = getSessionTextCreationCapability("opencode")!.name;
    expect(name).toBe(CAPABILITY_ID_ALLOCATIONS.opencodeTextCreation.name);
    expect(getSessionTextCreationCapability("unqualified")).toBeUndefined();
    for (const current of ["0.8.0", "0.9.0", "0.10.0", "0.11.0", "99.0.0"]) {
      expect(serverHasCapability({ current }, name)).toBe(false);
      expect(
        serverHasCapability(
          {
            current,
            ...encodeVersionedServerCapabilities(
              [
                CAPABILITY_ID_ALLOCATIONS.codexTextCreation.name,
                CAPABILITY_ID_ALLOCATIONS.claudeTextCreation.name,
              ],
              current,
            ),
          },
          name,
        ),
      ).toBe(false);
      expect(
        serverHasCapability(
          { current, ...encodeVersionedServerCapabilities([name], current) },
          name,
        ),
      ).toBe(true);
    }
  });

  it("requires separate explicit router recovery support, including on an older router-capable server", () => {
    const base = CAPABILITY_ID_ALLOCATIONS.agentAuthRouter.name;
    const recovery = CAPABILITY_ID_ALLOCATIONS.agentAuthRouterRecovery.name;
    for (const current of ["0.9.0", "0.9.1", "0.9.2", "0.9.4"]) {
      expect(
        serverHasCapability(
          { current, ...encodeVersionedServerCapabilities([base], current) },
          recovery,
        ),
      ).toBe(false);
      expect(
        serverHasCapability(
          {
            current,
            ...encodeVersionedServerCapabilities([base, recovery], current),
          },
          recovery,
        ),
      ).toBe(true);
    }
  });
  it("requires explicit native push support on the stable release corpus", () => {
    const name = CAPABILITY_ID_ALLOCATIONS.nativePushSubscriptions.name;
    for (const current of ["0.9.0", "0.9.1", "0.9.2", "0.9.4"]) {
      expect(serverHasCapability({ current }, name)).toBe(false);
      expect(
        serverHasCapability(
          { current, ...encodeVersionedServerCapabilities([name], current) },
          name,
        ),
      ).toBe(true);
    }
  });
  it("requires explicit session-term support independently of vocabulary controls", () => {
    const name = CAPABILITY_ID_ALLOCATIONS.speechVocabularySessionTerms.name;
    const vocabulary = CAPABILITY_ID_ALLOCATIONS.speechVocabulary.name;
    for (const current of ["0.8.0", "0.8.1", "0.8.2"]) {
      expect(serverHasCapability({ current }, name)).toBe(false);
      expect(
        serverHasCapability({ current, capabilities: [vocabulary] }, name),
      ).toBe(false);
      expect(serverHasCapability({ current, capabilities: [name] }, name)).toBe(
        true,
      );
    }
  });

  it("gates recent local speech models without changing older voice support", () => {
    const name = CAPABILITY_ID_ALLOCATIONS.localSpeechModelSelection.name;
    for (const current of ["0.8.0", "0.8.1"]) {
      expect(serverHasCapability({ current }, name)).toBe(false);
      expect(serverHasCapability({ current, capabilities: [name] }, name)).toBe(
        true,
      );
    }
    expect(serverHasCapability({ current: "0.8.2" }, name)).toBe(true);
  });

  it("gates speech backend setup without changing older voice support", () => {
    const name = CAPABILITY_ID_ALLOCATIONS.speechBackendSetup.name;
    expect(CAPABILITY_ID_ALLOCATIONS.speechBackendSetup.id).toBe(74);
    for (const current of ["0.8.0", "0.8.1"]) {
      expect(serverHasCapability({ current }, name)).toBe(false);
    }
    expect(serverHasCapability({ current: "0.8.2" }, name)).toBe(true);
  });

  it("gates chosen project names with permanent ID 80 and release 0.8.2", () => {
    const name = CAPABILITY_ID_ALLOCATIONS.projectNames.name;
    expect(CAPABILITY_ID_ALLOCATIONS.projectNames.id).toBe(80);
    expect(serverHasCapability({ current: "0.8.1" }, name)).toBe(false);
    expect(serverHasCapability({ current: "0.8.2" }, name)).toBe(true);
  });

  it("gates turn effort with permanent ID 58 and release 0.8.2", () => {
    const name = CAPABILITY_ID_ALLOCATIONS.turnEffortModifiers.name;
    expect(CAPABILITY_ID_ALLOCATIONS.turnEffortModifiers.id).toBe(58);
    expect(serverHasCapability({ current: "0.8.1" }, name)).toBe(false);
    expect(serverHasCapability({ current: "0.8.2" }, name)).toBe(true);
    const advertisement = encodeVersionedServerCapabilities(
      [name],
      "0.8.1-1-gabcdef",
    );
    expect(advertisement).toEqual({
      capabilityEncoding: CAPABILITY_ID_ENCODING_VERSION,
      capabilityBits: [[1, 2 ** 26]],
    });
    expect(serverHasCapability(advertisement, name)).toBe(true);
  });

  it("distinguishes absent legacy advertisements from empty ID sets", () => {
    expect(hasServerCapabilityAdvertisement({ current: "0.7.0" })).toBe(false);
    expect(
      hasServerCapabilityAdvertisement({
        capabilityEncoding: CAPABILITY_ID_ENCODING_VERSION,
        capabilityBits: [],
      }),
    ).toBe(true);
  });

  it("infers monotonic capabilities from the server release", () => {
    expect(
      serverHasCapability(
        { current: "0.7.1" },
        PROJECT_SESSION_DEFAULTS_CAPABILITY,
      ),
    ).toBe(true);
    expect(
      serverHasCapability(
        { current: "0.7.1-3-gabcdef" },
        PROJECT_SESSION_DEFAULTS_CAPABILITY,
      ),
    ).toBe(true);
    expect(
      serverHasCapability(
        { current: "0.7.1-beta.1" },
        PROJECT_SESSION_DEFAULTS_CAPABILITY,
      ),
    ).toBe(false);
    expect(
      serverHasCapability(
        { current: "0.7.0" },
        PROJECT_SESSION_DEFAULTS_CAPABILITY,
      ),
    ).toBe(false);
    expect(
      serverHasCapability(
        { current: "0.7.1" },
        SUBAGENT_MAX_DEPTH_SETTING_CAPABILITY,
      ),
    ).toBe(true);
    expect(
      serverHasCapability(
        { current: "0.7.0" },
        SUBAGENT_MAX_DEPTH_SETTING_CAPABILITY,
      ),
    ).toBe(false);
    expect(CAPABILITY_ID_ALLOCATIONS.subagentMaxDepthSetting.id).toBe(34);
    expect(
      serverHasCapability(
        { current: "0.7.1" },
        CODEX_REASONING_SUMMARY_SETTING_CAPABILITY,
      ),
    ).toBe(true);
    expect(
      serverHasCapability(
        { current: "0.7.0" },
        CODEX_REASONING_SUMMARY_SETTING_CAPABILITY,
      ),
    ).toBe(false);
    expect(CAPABILITY_ID_ALLOCATIONS.codexReasoningSummarySetting.id).toBe(35);
    expect(
      serverHasCapability(
        { current: "0.7.1" },
        CLAUDE_GATEWAY_DISABLE_PLAN_MODE_CAPABILITY,
      ),
    ).toBe(true);
    expect(
      serverHasCapability(
        { current: "0.7.0" },
        CLAUDE_GATEWAY_DISABLE_PLAN_MODE_CAPABILITY,
      ),
    ).toBe(false);
    expect(CAPABILITY_ID_ALLOCATIONS.claudeGatewayDisablePlanMode.id).toBe(36);
    expect(
      serverHasCapability(
        { current: "0.7.1" },
        GIT_WORKING_TREE_FILES_CAPABILITY,
      ),
    ).toBe(true);
    expect(
      serverHasCapability(
        { current: "0.7.0" },
        GIT_WORKING_TREE_FILES_CAPABILITY,
      ),
    ).toBe(false);
    expect(CAPABILITY_ID_ALLOCATIONS.gitWorkingTreeFiles.id).toBe(38);
    expect(
      serverHasCapability(
        { current: "0.7.1" },
        GIT_INCOMING_COMMITS_CAPABILITY,
      ),
    ).toBe(true);
    expect(
      serverHasCapability(
        { current: "0.7.0" },
        GIT_INCOMING_COMMITS_CAPABILITY,
      ),
    ).toBe(false);
    expect(CAPABILITY_ID_ALLOCATIONS.gitIncomingCommits.id).toBe(39);
    expect(
      serverHasCapability(
        { current: "0.8.1" },
        PROJECT_QUEUE_ATTACHMENT_EDITING_CAPABILITY,
      ),
    ).toBe(true);
    expect(
      serverHasCapability(
        { current: "0.8.0" },
        PROJECT_QUEUE_ATTACHMENT_EDITING_CAPABILITY,
      ),
    ).toBe(false);
    expect(CAPABILITY_ID_ALLOCATIONS.projectQueueAttachmentEditing.id).toBe(55);
  });

  it("lets a negative bit override an otherwise implied capability", () => {
    const deniedCapabilityBits = [
      [0, 2 ** CAPABILITY_ID_ALLOCATIONS.projectSessionDefaults.id],
    ] as const;

    expect(
      serverHasCapability(
        {
          current: "0.7.1",
          capabilities: [PROJECT_SESSION_DEFAULTS_CAPABILITY],
          deniedCapabilityBits,
        },
        PROJECT_SESSION_DEFAULTS_CAPABILITY,
      ),
    ).toBe(false);
    expect(
      serverHasCapability(
        {
          current: "0.7.1",
          deniedCapabilityBits: [[31, 2 ** 7]],
        },
        PROJECT_SESSION_DEFAULTS_CAPABILITY,
      ),
    ).toBe(true);
  });

  it("encodes optional capability presence in sparse 32-bit words", () => {
    const { capabilityBits } = encodeVersionedServerCapabilities(
      [
        VOICE_INPUT_CAPABILITY,
        DEVICE_BRIDGE_UPDATE_CAPABILITY,
        VOICE_INPUT_CAPABILITY,
      ],
      "99.0.0",
    );
    const source = { current: "99.0.0", capabilityBits };

    expect(capabilityBits).toEqual([[0, 17]]);
    expect(serverHasCapability(source, VOICE_INPUT_CAPABILITY)).toBe(true);
    expect(serverHasCapability(source, DEVICE_BRIDGE_UPDATE_CAPABILITY)).toBe(
      true,
    );
    expect(serverHasCapability(source, DEVICE_BRIDGE_CAPABILITY)).toBe(false);
  });

  it("keeps provider-host control optional at its permanent id", () => {
    const { capabilityBits } = encodeVersionedServerCapabilities(
      [PROVIDER_HOST_CONTROL_CAPABILITY],
      "0.7.1",
    );
    expect(capabilityBits).toEqual([
      [0, 2 ** CAPABILITY_ID_ALLOCATIONS.providerHostControl.id],
    ]);
    expect(
      serverHasCapability(
        { current: "0.7.1", capabilityBits },
        PROVIDER_HOST_CONTROL_CAPABILITY,
      ),
    ).toBe(true);
    expect(
      serverHasCapability(
        { current: "0.7.1", capabilityBits: [] },
        PROVIDER_HOST_CONTROL_CAPABILITY,
      ),
    ).toBe(false);
  });

  it("encodes source-ahead capabilities by permanent ID", () => {
    const capabilities = [
      PROJECT_SESSION_DEFAULTS_CAPABILITY,
      VOICE_INPUT_CAPABILITY,
    ];

    expect(encodeVersionedServerCapabilities(capabilities, "0.7.1")).toEqual({
      capabilityEncoding: CAPABILITY_ID_ENCODING_VERSION,
      capabilityBits: [[0, 1]],
    });

    const sourceAdvertisement = encodeVersionedServerCapabilities(
      capabilities,
      "0.7.0-741-gabcdef",
    );
    expect(sourceAdvertisement).toEqual({
      capabilityEncoding: CAPABILITY_ID_ENCODING_VERSION,
      capabilityBits: [
        [0, 2 ** CAPABILITY_ID_ALLOCATIONS.projectSessionDefaults.id + 1],
      ],
    });
    expect(
      serverHasCapability(
        { current: "0.7.0-741-gabcdef", ...sourceAdvertisement },
        PROJECT_SESSION_DEFAULTS_CAPABILITY,
      ),
    ).toBe(true);
  });

  it("assigns inclusive To HEAD to permanent capability ID 40", () => {
    expect(CAPABILITY_ID_ALLOCATIONS.gitInclusiveToHead.id).toBe(40);
    const advertisement = encodeVersionedServerCapabilities(
      [GIT_INCLUSIVE_TO_HEAD_CAPABILITY],
      "0.7.0-741-gabcdef",
    );
    expect(advertisement).toEqual({
      capabilityEncoding: CAPABILITY_ID_ENCODING_VERSION,
      capabilityBits: [[1, 2 ** 8]],
    });
  });

  it("assigns Working Tree sections to permanent capability ID 41", () => {
    expect(CAPABILITY_ID_ALLOCATIONS.gitWorkingTreeSections.id).toBe(41);
    const advertisement = encodeVersionedServerCapabilities(
      [GIT_WORKING_TREE_SECTIONS_CAPABILITY],
      "0.7.0-741-gabcdef",
    );
    expect(advertisement).toEqual({
      capabilityEncoding: CAPABILITY_ID_ENCODING_VERSION,
      capabilityBits: [[1, 2 ** 9]],
    });
  });

  it("assigns complete Working Tree scans to permanent capability ID 42", () => {
    expect(CAPABILITY_ID_ALLOCATIONS.gitWorkingTreeCompleteScan.id).toBe(42);
    const advertisement = encodeVersionedServerCapabilities(
      [GIT_WORKING_TREE_COMPLETE_SCAN_CAPABILITY],
      "0.7.0-741-gabcdef",
    );
    expect(advertisement).toEqual({
      capabilityEncoding: CAPABILITY_ID_ENCODING_VERSION,
      capabilityBits: [[1, 2 ** 10]],
    });
  });

  it("assigns file revision metadata to permanent capability ID 47", () => {
    expect(CAPABILITY_ID_ALLOCATIONS.gitFileRevision.id).toBe(47);
    expect(
      serverHasCapability({ current: "0.7.2" }, GIT_FILE_REVISION_CAPABILITY),
    ).toBe(true);
    expect(
      serverHasCapability({ current: "0.7.1" }, GIT_FILE_REVISION_CAPABILITY),
    ).toBe(false);
  });

  it("assigns Codex stream/durable identity to permanent capability ID 48", () => {
    expect(CAPABILITY_ID_ALLOCATIONS.codexStreamDurableIdAlignment.id).toBe(48);
    expect(
      serverHasCapability(
        { current: "0.7.2" },
        CODEX_STREAM_DURABLE_ID_ALIGNMENT_CAPABILITY,
      ),
    ).toBe(true);
    expect(
      serverHasCapability(
        { current: "0.7.1" },
        CODEX_STREAM_DURABLE_ID_ALIGNMENT_CAPABILITY,
      ),
    ).toBe(false);

    const sourceAdvertisement = encodeVersionedServerCapabilities(
      [CODEX_STREAM_DURABLE_ID_ALIGNMENT_CAPABILITY],
      "0.7.0-741-gabcdef",
    );
    expect(sourceAdvertisement).toEqual({
      capabilityEncoding: CAPABILITY_ID_ENCODING_VERSION,
      capabilityBits: [[1, 2 ** 16]],
    });
    expect(
      serverHasCapability(
        { current: "0.7.0-741-gabcdef", ...sourceAdvertisement },
        CODEX_STREAM_DURABLE_ID_ALIGNMENT_CAPABILITY,
      ),
    ).toBe(true);
  });

  it("assigns cache-billing ignore-after to permanent capability ID 43", () => {
    expect(CAPABILITY_ID_ALLOCATIONS.cacheMissBillingIgnoreAfter.id).toBe(43);
    const advertisement = encodeVersionedServerCapabilities(
      [CACHE_MISS_BILLING_IGNORE_AFTER_CAPABILITY],
      "0.7.0-741-gabcdef",
    );
    expect(advertisement).toEqual({
      capabilityEncoding: CAPABILITY_ID_ENCODING_VERSION,
      capabilityBits: [[1, 2 ** 11]],
    });
  });

  it("assigns expected cache expiry to permanent capability ID 49", () => {
    expect(CAPABILITY_ID_ALLOCATIONS.cacheMissBillingExpectedExpiry.id).toBe(
      49,
    );
    expect(
      serverHasCapability(
        { current: "0.7.2" },
        CACHE_MISS_BILLING_EXPECTED_EXPIRY_CAPABILITY,
      ),
    ).toBe(true);
    expect(
      serverHasCapability(
        { current: "0.7.1" },
        CACHE_MISS_BILLING_EXPECTED_EXPIRY_CAPABILITY,
      ),
    ).toBe(false);
  });

  it("assigns attachment-only messages to permanent capability ID 50", () => {
    expect(CAPABILITY_ID_ALLOCATIONS.attachmentOnlySessionMessages.id).toBe(50);
    expect(
      serverHasCapability(
        { current: "0.7.2" },
        ATTACHMENT_ONLY_SESSION_MESSAGES_CAPABILITY,
      ),
    ).toBe(true);
    expect(
      serverHasCapability(
        { current: "0.7.1" },
        ATTACHMENT_ONLY_SESSION_MESSAGES_CAPABILITY,
      ),
    ).toBe(false);

    const sourceAdvertisement = encodeVersionedServerCapabilities(
      [ATTACHMENT_ONLY_SESSION_MESSAGES_CAPABILITY],
      "0.7.0-741-gabcdef",
    );
    expect(sourceAdvertisement).toEqual({
      capabilityEncoding: CAPABILITY_ID_ENCODING_VERSION,
      capabilityBits: [[1, 2 ** 18]],
    });
  });

  it("assigns the live worktree setting to permanent capability ID 44", () => {
    expect(CAPABILITY_ID_ALLOCATIONS.gitLiveWorktreeSetting.id).toBe(44);
    const advertisement = encodeVersionedServerCapabilities(
      [GIT_LIVE_WORKTREE_SETTING_CAPABILITY],
      "0.7.0-741-gabcdef",
    );
    expect(advertisement).toEqual({
      capabilityEncoding: CAPABILITY_ID_ENCODING_VERSION,
      capabilityBits: [[1, 2 ** 12]],
    });
  });

  it("does not infer optional live worktree protocols from the release", () => {
    expect(
      serverHasCapability(
        { current: "0.7.2" },
        GIT_WORKING_TREE_SECTIONS_CAPABILITY,
      ),
    ).toBe(false);
    expect(
      serverHasCapability(
        { current: "0.7.2" },
        GIT_WORKING_TREE_COMPLETE_SCAN_CAPABILITY,
      ),
    ).toBe(false);
  });

  it("encodes selective share freeze in the second capability word", () => {
    const advertisement = encodeVersionedServerCapabilities(
      [PUBLIC_SHARE_MANAGEMENT_FREEZE_CAPABILITY],
      "0.7.0-741-gabcdef",
    );

    expect(advertisement).toEqual({
      capabilityEncoding: CAPABILITY_ID_ENCODING_VERSION,
      capabilityBits: [[1, 1]],
    });
    expect(
      serverHasCapability(
        { current: "0.7.0-741-gabcdef", ...advertisement },
        PUBLIC_SHARE_MANAGEMENT_FREEZE_CAPABILITY,
      ),
    ).toBe(true);
  });

  it("encodes the source-ahead Codex setting in the second capability word", () => {
    const advertisement = encodeVersionedServerCapabilities(
      [CODEX_REASONING_SUMMARY_SETTING_CAPABILITY],
      "0.7.0-741-gabcdef",
    );

    expect(advertisement).toEqual({
      capabilityEncoding: CAPABILITY_ID_ENCODING_VERSION,
      capabilityBits: [[1, 8]],
    });
    expect(
      serverHasCapability(
        { current: "0.7.0-741-gabcdef", ...advertisement },
        CODEX_REASONING_SUMMARY_SETTING_CAPABILITY,
      ),
    ).toBe(true);
  });

  it("encodes the source-ahead Codex plan-tool setting by permanent ID", () => {
    const advertisement = encodeVersionedServerCapabilities(
      [CODEX_PLAN_TOOL_SETTING_CAPABILITY],
      "0.8.0-3-gabcdef",
    );

    expect(advertisement).toEqual({
      capabilityEncoding: CAPABILITY_ID_ENCODING_VERSION,
      capabilityBits: [
        [1, 2 ** (CAPABILITY_ID_ALLOCATIONS.codexPlanToolSetting.id % 32)],
      ],
    });
    expect(
      serverHasCapability(
        { current: "0.8.0-3-gabcdef", ...advertisement },
        CODEX_PLAN_TOOL_SETTING_CAPABILITY,
      ),
    ).toBe(true);
  });

  it("encodes withdrawals only when the release would imply support", () => {
    expect(
      encodeVersionedServerCapabilities([], "0.7.1", [
        PROJECT_SESSION_DEFAULTS_CAPABILITY,
      ]),
    ).toEqual({
      capabilityEncoding: CAPABILITY_ID_ENCODING_VERSION,
      capabilityBits: [],
      deniedCapabilityBits: [
        [0, 2 ** CAPABILITY_ID_ALLOCATIONS.projectSessionDefaults.id],
      ],
    });
    expect(
      encodeVersionedServerCapabilities([], "0.7.0-741-gabcdef", [
        PROJECT_SESSION_DEFAULTS_CAPABILITY,
      ]),
    ).toEqual({
      capabilityEncoding: CAPABILITY_ID_ENCODING_VERSION,
      capabilityBits: [],
    });
    expect(() =>
      encodeVersionedServerCapabilities([], "0.7.1", [VOICE_INPUT_CAPABILITY]),
    ).toThrow("Only version-implied server capabilities can be denied");
  });

  it("chooses the newest mutually supported capability encoding", () => {
    expect(negotiateServerCapabilityEncoding(undefined, "0.7.1")).toBeNull();
    expect(negotiateServerCapabilityEncoding("0.7.0", "0.7.1")).toBeNull();
    expect(negotiateServerCapabilityEncoding("0.7.1-beta.1", "0.7.1")).toBe(
      CAPABILITY_ID_ENCODING_VERSION,
    );
    expect(
      negotiateServerCapabilityEncoding(
        "0.7.0-741-gabcdef",
        "0.7.0-750-g1234567",
      ),
    ).toBe(CAPABILITY_ID_ENCODING_VERSION);
    expect(negotiateServerCapabilityEncoding("99.0.0", "0.7.1")).toBe(
      CAPABILITY_ID_ENCODING_VERSION,
    );
  });

  it("keeps legacy and scoped capability-name checks", () => {
    expect(
      serverHasCapability(
        { capabilities: [PUBLIC_SHARE_SESSION_CHUNKS_CAPABILITY] },
        PUBLIC_SHARE_SESSION_CHUNKS_CAPABILITY,
      ),
    ).toBe(true);
    expect(
      serverHasCapability(
        {
          current: "0.7.0-741-gabcdef",
          capabilities: [PROJECT_SESSION_DEFAULTS_CAPABILITY],
        },
        PROJECT_SESSION_DEFAULTS_CAPABILITY,
      ),
    ).toBe(true);
  });
});
