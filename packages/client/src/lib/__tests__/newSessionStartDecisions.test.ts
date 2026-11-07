import type { ProviderInfo } from "@yep-anywhere/shared";
import { describe, expect, it } from "vitest";
import type { LaunchLock } from "../limitedLaunchLock";
import {
  buildNewSessionStartOptions,
  buildProjectQueueNewSessionTarget,
  newSessionStartErrorMessage,
  planNewSessionProjectQueue,
  planNewSessionStart,
  projectQueueRefusalBeforeDefer,
} from "../newSessionStartDecisions";

const t = (key: string, vars?: Record<string, string | number>) =>
  vars ? `${key}:${JSON.stringify(vars)}` : key;
const unlocked: LaunchLock = {
  limited: false,
  provider: null,
  model: null,
  effort: null,
};
const limited: LaunchLock = {
  limited: true,
  provider: "codex",
  model: "gpt-6",
  effort: "medium",
};
const current = {
  capabilities: ["turn-effort-modifiers", "attachment-only-session-messages"],
};

type StartInput = Parameters<typeof planNewSessionStart>[0];
const start = (input: Partial<StartInput> = {}) =>
  planNewSessionStart({
    finalMessage: "hello",
    submissionFileCount: 0,
    pendingFileCount: 0,
    speechPrefix: null,
    propagateFailure: false,
    routedSourceKey: null,
    sourceKey: "host:a",
    routerCapable: true,
    launchLimited: false,
    effectiveSandboxLevel: "none",
    hasLaunch: false,
    composerMuted: false,
    creatingTemplateProject: false,
    templateProjectBusy: false,
    isStarting: false,
    displayDefaultsPending: false,
    hasSelectedProviderModel: true,
    projectPending: false,
    serverCapabilitiesPending: false,
    selectedProvider: "claude",
    version: current,
    ...input,
  });

describe("planNewSessionStart", () => {
  it("refuses a routed selection this launch cannot use, before anything else", () => {
    const routed = { routedSourceKey: "host:a" };
    expect(start(routed)).toMatchObject({ kind: "proceed" });
    for (const unusable of [
      { routedSourceKey: "host:b" },
      { ...routed, routerCapable: false },
      { ...routed, launchLimited: true },
      { ...routed, effectiveSandboxLevel: "project-write" as const },
      { ...routed, hasLaunch: true },
    ]) {
      // Even a draft that is not ready gets the routed refusal first.
      expect(start({ ...unusable, isStarting: true })).toEqual({
        kind: "refuse",
        toastKey: "routerLaunchUnsupported",
      });
    }
  });

  it("returns without a toast while not ready, throwing only for a memo start", () => {
    for (const notReady of [
      { finalMessage: "  " },
      { creatingTemplateProject: true },
      { templateProjectBusy: true },
      { isStarting: true },
      { displayDefaultsPending: true },
      { hasSelectedProviderModel: false },
      { projectPending: true },
      { serverCapabilitiesPending: true },
    ]) {
      expect(start(notReady)).toEqual({
        kind: "silent",
        throwCannotStart: false,
      });
      expect(start({ ...notReady, propagateFailure: true })).toEqual({
        kind: "silent",
        throwCannotStart: true,
      });
    }
  });

  it("lets a muted launch composer and an attachment start with no text", () => {
    expect(start({ finalMessage: "", composerMuted: true })).toEqual({
      kind: "proceed",
      text: "",
      hasCommand: false,
    });
    expect(
      start({ finalMessage: "", submissionFileCount: 1, pendingFileCount: 1 }),
    ).toEqual({ kind: "proceed", text: "", hasCommand: false });
  });

  it("prefixes speech only when there is content, including attachments alone", () => {
    expect(start({ finalMessage: " hi ", speechPrefix: "ASR:" })).toMatchObject(
      { text: "ASR: hi" },
    );
    expect(
      start({
        finalMessage: "",
        speechPrefix: "ASR:",
        submissionFileCount: 1,
        pendingFileCount: 1,
      }),
    ).toMatchObject({ text: "ASR:" });
    expect(
      start({ finalMessage: "", speechPrefix: "ASR:", composerMuted: true }),
    ).toMatchObject({ text: "" });
  });

  it("turns a one-turn effort command into direct metadata, or refuses it", () => {
    expect(start({ finalMessage: "/slow careful review" })).toEqual({
      kind: "proceed",
      text: "careful review",
      hasCommand: true,
      metadata: { deliveryIntent: "direct", turnEffort: "slow" },
    });
    for (const unsupported of [
      { version: { capabilities: [] } },
      { hasLaunch: true },
      { selectedProvider: "gemini" as const },
    ]) {
      expect(
        start({ finalMessage: "/slow careful review", ...unsupported }),
      ).toEqual({ kind: "refuse", toastKey: "turnEffortUnavailable" });
    }
    expect(start({ finalMessage: "/slow" })).toEqual({
      kind: "refuse",
      toastKey: "turnEffortNeedsMessage",
    });
    // An unsupported provider is refused before an empty argument.
    expect(
      start({ finalMessage: "/slow", selectedProvider: "gemini" }),
    ).toEqual({ kind: "refuse", toastKey: "turnEffortUnavailable" });
    // Any other command is sent as typed.
    expect(start({ finalMessage: "/compact now" })).toEqual({
      kind: "proceed",
      text: "/compact now",
      hasCommand: true,
    });
  });

  it("refuses an attachment-only start on an old server by the rendered file count", () => {
    const old = { version: { capabilities: ["turn-effort-modifiers"] } };
    // It reads the typed text, not the text with its speech prefix.
    expect(
      start({
        ...old,
        finalMessage: "",
        speechPrefix: "ASR:",
        submissionFileCount: 1,
        pendingFileCount: 1,
      }),
    ).toEqual({
      kind: "refuse",
      toastKey: "attachmentOnlyRequiresServerUpdate",
    });
    // The refusal counts the render's files, the content check the ref's.
    expect(
      start({
        ...old,
        finalMessage: "",
        submissionFileCount: 1,
        pendingFileCount: 0,
      }),
    ).toMatchObject({ kind: "proceed" });
  });
});

describe("buildNewSessionStartOptions", () => {
  type OptionsInput = Parameters<typeof buildNewSessionStartOptions>[0];
  const options = (input: Partial<OptionsInput> = {}) =>
    buildNewSessionStartOptions({
      creationProvenance: undefined,
      supportsInstalledMachineControl: false,
      machineControlSelected: false,
      machineControlEligible: false,
      mode: "plan",
      routed: null,
      routedModel: "claude-opus-4-8",
      selectedModel: "opus",
      routerCapable: true,
      routerAccountId: "account",
      routerPolicy: "round-robin",
      routerClaudeAiConnectors: false,
      routerThinking: "on:high",
      thinking: "on:low",
      showThinking: "default",
      effectiveServiceTier: null,
      selectedProvider: "claude",
      supportsSessionSandboxing: false,
      effectiveSandboxLevel: "none",
      effectiveSandboxNetworkFirewall: false,
      recapMode: "off",
      recapAfterSeconds: 300,
      promptSuggestionMode: "off",
      helperSideModel: "cheapest",
      launchLock: unlocked,
      ...input,
    });

  it("sends the direct choices and only the fields the server takes", () => {
    expect(options()).toEqual({
      creationProvenance: undefined,
      mode: "plan",
      model: "opus",
      thinking: "on:low",
      showThinking: "default",
      provider: "claude",
      recapMode: "off",
      recapAfterSeconds: 300,
      promptSuggestionMode: "off",
      helperSideModel: "cheapest",
    });
    expect(
      options({
        supportsInstalledMachineControl: true,
        machineControlSelected: true,
        machineControlEligible: false,
        effectiveServiceTier: "priority",
        supportsSessionSandboxing: true,
        effectiveSandboxLevel: "project-write",
        effectiveSandboxNetworkFirewall: true,
      }),
    ).toMatchObject({
      machineControl: false,
      serviceTier: "priority",
      sandboxLevel: "project-write",
      sandboxNetworkFirewall: true,
    });
    expect(
      options({ supportsSessionSandboxing: true }).sandboxNetworkFirewall,
    ).toBeUndefined();
  });

  it("sends the routed model, thinking and router fields for a pool", () => {
    expect(
      options({
        routed: { poolId: "work" },
        routerClaudeAiConnectors: true,
      }),
    ).toMatchObject({
      model: "claude-opus-4-8",
      thinking: "on:high",
      routerAccountId: "account",
      routerPoolId: "work",
      routerPolicy: "round-robin",
      routerClaudeAiConnectors: true,
    });
    const incapable = options({
      routed: { poolId: "work" },
      routerCapable: false,
    });
    expect(incapable.routerPoolId).toBeUndefined();
    expect(incapable.model).toBe("claude-opus-4-8");
  });

  it("lets a limited user's lock have the last word", () => {
    expect(options({ launchLock: limited })).toMatchObject({
      provider: "codex",
      model: "gpt-6",
      thinking: "on:medium",
      sandboxLevel: "project-write",
    });
  });
});

describe("Project Queue decisions", () => {
  const refusal = (
    input: Partial<Parameters<typeof projectQueueRefusalBeforeDefer>[0]> = {},
  ) =>
    projectQueueRefusalBeforeDefer({
      routed: false,
      routerSelectionCustomized: false,
      machineControlSelected: false,
      machineControlEligible: false,
      creatingTemplateProject: false,
      templateProjectBusy: false,
      ...input,
    });

  it("refuses a chosen pool but queues a restored one directly (N1)", () => {
    expect(refusal({ routed: true, routerSelectionCustomized: true })).toEqual({
      kind: "refuse",
      toastKey: "routerQueueUnsupported",
    });
    expect(refusal({ routed: true })).toBeNull();
    // Choosing Direct explicitly is a customized choice that queues.
    expect(refusal({ routerSelectionCustomized: true })).toBeNull();
  });

  it("returns without a toast for machine control and a template (N3)", () => {
    expect(
      refusal({ machineControlSelected: true, machineControlEligible: true }),
    ).toEqual({ kind: "silent" });
    expect(refusal({ machineControlSelected: true })).toBeNull();
    expect(refusal({ templateProjectBusy: true })).toEqual({ kind: "silent" });
  });

  it("needs text and staged files, and prefixes speech", () => {
    const queue = (
      input: Partial<Parameters<typeof planNewSessionProjectQueue>[0]> = {},
    ) =>
      planNewSessionProjectQueue({
        finalMessage: " queued ",
        speechPrefix: null,
        submissionFileCount: 1,
        stagedFileCount: 1,
        isStarting: false,
        displayDefaultsPending: false,
        projectPending: false,
        hasDirectProviderModel: true,
        ...input,
      });
    expect(queue()).toEqual({ text: "queued" });
    expect(queue({ speechPrefix: "ASR:" })).toEqual({ text: "ASR: queued" });
    for (const notReady of [
      { finalMessage: " " },
      // A prefix alone is not text to queue.
      { finalMessage: " ", speechPrefix: "ASR:" },
      { stagedFileCount: 0 },
      { isStarting: true },
      { displayDefaultsPending: true },
      { projectPending: true },
      { hasDirectProviderModel: false },
    ]) {
      expect(queue(notReady)).toBeNull();
    }
  });

  it("resolves the queued session's thinking and tier against the direct catalog", () => {
    const providerInfo = {
      name: "claude",
      displayName: "Claude",
      installed: true,
      authenticated: true,
      models: [
        {
          id: "opus",
          name: "Opus",
          supportsAdaptiveThinking: true,
          supportsEffort: true,
          supportedEffortLevels: ["medium", "high"],
          serviceTiers: [{ id: "priority", name: "Fast" }],
        },
      ],
    } as unknown as ProviderInfo;
    const target = (
      input: Partial<
        Parameters<typeof buildProjectQueueNewSessionTarget>[0]
      > = {},
    ) =>
      buildProjectQueueNewSessionTarget({
        providerInfo,
        selectedProvider: "claude",
        selectedModel: "opus",
        selectedThinkingMode: "on",
        selectedEffortLevel: "low",
        selectedServiceTier: "priority",
        mode: "plan",
        showThinking: "default",
        supportsSessionSandboxing: false,
        effectiveSandboxLevel: "none",
        effectiveSandboxNetworkFirewall: false,
        launchLock: unlocked,
        title: "queued",
        t,
        ...input,
      });
    // "low" is not offered directly, so it resolves to a supported effort.
    expect(target()).toEqual({
      thinking: "on:medium",
      target: {
        type: "new-session",
        mode: "plan",
        model: "opus",
        serviceTier: "priority",
        thinking: "on:medium",
        showThinking: "default",
        provider: "claude",
        title: "queued",
      },
    });
    expect(
      target({ selectedServiceTier: "flex" }).target.serviceTier,
    ).toBeUndefined();
    expect(
      target({
        supportsSessionSandboxing: true,
        effectiveSandboxLevel: "project-write",
        effectiveSandboxNetworkFirewall: true,
        launchLock: limited,
      }).target,
    ).toMatchObject({
      sandboxLevel: "project-write",
      sandboxNetworkFirewall: true,
      provider: "codex",
      model: "gpt-6",
      thinking: "on:medium",
    });
  });
});

describe("newSessionStartErrorMessage", () => {
  it("maps a failed start to its toast", () => {
    const message = (err: unknown, provider = "claude" as const) =>
      newSessionStartErrorMessage(err, provider, "Claude", t);
    expect(message("plain")).toBe("newSessionStartError");
    expect(message(new Error("Queue is full"))).toBe("newSessionServerBusy");
    expect(message(new Error("Please run /login"))).toBe(
      'newSessionProviderAuthError:{"provider":"Claude"}',
    );
    for (const provider of ["claude", "gemini", "codex"] as const) {
      expect(
        newSessionStartErrorMessage(
          Object.assign(new Error("no"), { status: 401 }),
          provider,
          "Name",
          t,
        ),
      ).toBe('newSessionProviderAuthError:{"provider":"Name"}');
    }
    // Without a display name, the provider id, then "Provider".
    expect(
      newSessionStartErrorMessage(
        new Error("please run /login"),
        "codex",
        undefined,
        t,
      ),
    ).toBe('newSessionProviderAuthError:{"provider":"codex"}');
    expect(
      newSessionStartErrorMessage(
        new Error("please run /login"),
        null,
        undefined,
        t,
      ),
    ).toBe('newSessionProviderAuthError:{"provider":"Provider"}');
    expect(
      newSessionStartErrorMessage(
        Object.assign(new Error("no"), { status: 401 }),
        "opencode",
        undefined,
        t,
      ),
    ).toBe("no");
    expect(message(new Error("HTTP 503"))).toBe("newSessionServerCapacity");
    expect(message(new Error("HTTP 404"))).toBe("newSessionProjectNotFound");
    expect(message(new Error("network down"))).toBe("newSessionNetworkError");
    expect(message(new Error("odd"))).toBe("odd");
  });
});
