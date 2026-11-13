import {
  type EffortLevel,
  HELPER_SIDE_MODEL_CHEAPEST,
  HELPER_SIDE_MODEL_SAME_AS_MAIN,
  type ProviderInfo,
  type ProviderName,
  SERVER_CAPABILITIES,
  type SessionSandboxLevel,
  type ThinkingMode,
  type ThinkingOption,
  resolveModel,
  resolveRouterModel,
  routerAliasTargets,
  serverHasCapability,
} from "@yep-anywhere/shared";
import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { api } from "../api/client";
import { useMachineControlStatus } from "./useMachineControlStatus";
import type { FilterOption } from "../components/FilterDropdown";
import {
  restoreRouterSelection,
  routedAccounts,
  routedModels,
  routerPoolMembers,
} from "../components/RouterPoolSelector";
import type { useI18n } from "../i18n";
import {
  getEffortLevelOptions,
  getThinkingModeOptions,
  resolveSupportedEffortLevel,
  resolveSupportedThinkingMode,
} from "../lib/effortLevels";
import type { LaunchLock } from "../lib/limitedLaunchLock";
import {
  buildRouterModelList,
  withProviderVisibleModelSelection,
} from "../lib/modelCatalog";
import {
  getProviderSessionDefaults,
  hasRequiredProviderModel,
} from "../lib/newSessionDefaults";
import {
  INITIAL_NEW_SESSION_OPTIONS,
  type NewSessionOptionsAction,
  fillCatalogModel,
  fillGatewayModel,
  newSessionDefaultsToSave,
  newSessionOptionsReducer,
  seedNewSessionOptions,
  switchNewSessionProvider,
} from "../lib/newSessionOptionsState";
import { getPermissionModeOptions } from "../lib/permissionModes";
import { providerSupportsLocalSessionSandbox } from "../lib/providerCapabilities";
import { selectableServiceTiers } from "../lib/serviceTiers";
import {
  describeUnavailableSessionSandbox,
  serverHasAvailableSessionSandbox,
} from "../lib/sessionSandboxAvailability";
import type { PermissionMode } from "../types";
import { getModelSetting } from "./useModelSettings";
import { useProviderDescriptors } from "./useProviderDescriptors";
import { useProviderRow, useProviders } from "./useProviders";
import { useProviderSubscriptionUsage } from "./useProviderSubscriptionUsage";
import { useRouterDiscovery } from "./useRouterDiscovery";
import { useServerSettings } from "./useServerSettings";
import type { useVersion } from "./useVersion";

/**
 * The New Session form's option state: one reducer over the sixteen choices,
 * the provider, settings and router reads they depend on, every value derived
 * from them, and the effects that seed, lock, refill and save them
 * (docs/tactical/180-new-session-options-and-start.md, slice 2).
 */
export function useNewSessionOptions({
  clientSummarySourceKey,
  launch,
  launchLock,
  preferredProvider,
  preferredModel,
  preferredThinking,
  preferredPermissionMode,
  versionInfo,
  versionLoading,
  legacyEffortLevel,
  legacyThinkingMode,
  t,
}: {
  clientSummarySourceKey: string;
  /** A fixed launch (fork, handoff), which never routes or uses machine control. */
  launch: object | undefined;
  launchLock: LaunchLock;
  preferredProvider?: ProviderName;
  preferredModel?: string;
  preferredThinking?: ThinkingOption;
  preferredPermissionMode?: PermissionMode;
  versionInfo: ReturnType<typeof useVersion>["version"];
  versionLoading: boolean;
  legacyEffortLevel: EffortLevel;
  legacyThinkingMode: ThinkingMode;
  t: ReturnType<typeof useI18n>["t"];
}) {
  const [optionsState, dispatchOptions] = useReducer(
    newSessionOptionsReducer,
    INITIAL_NEW_SESSION_OPTIONS,
  );
  const {
    mode,
    selectedProvider,
    routerPreference,
    routerSelectionCustomized,
    routerConnectorsChoice,
    selectedModel,
    selectedServiceTier,
    selectedThinkingMode,
    selectedEffortLevel,
    selectedRecapMode,
    sandboxLevel,
    machineControlChoice,
    sandboxNetworkFirewall,
    recapAfterSeconds,
    selectedPromptSuggestionMode,
    helperSideModel,
  } = optionsState;
  useEffect(() => {
    dispatchOptions({
      type: "sourceChanged",
      sourceKey: clientSummarySourceKey,
    });
  }, [clientSummarySourceKey]);
  const selectMachineControl = useCallback((selected: boolean) => {
    dispatchOptions({
      type: "choose",
      field: "machineControlChoice",
      value: selected,
    });
  }, []);
  const {
    providers,
    loading: providersLoading,
    stale: providersStale,
    refetch: refetchProviders,
  } = useProviders();
  const selectedProviderQuery = useProviderRow(selectedProvider);
  const aggregateProviderInfo = providers.find(
    (p) => p.name === selectedProvider,
  );
  const selectedProviderInfo =
    selectedProviderQuery.row ?? aggregateProviderInfo;
  const hasSeededDefaultsRef = useRef(false);
  const hasInitializedDefaultsRef = useRef(false);
  const hasUserCustomizedDefaultsRef = useRef(false);
  const supportsSessionSandboxing =
    serverHasAvailableSessionSandbox(versionInfo);
  const canConfigureSessionSandbox =
    supportsSessionSandboxing &&
    providerSupportsLocalSessionSandbox(selectedProvider);
  // Where the toggle would sit, say what keeps a supported host from offering
  // it; a limited user cannot change the host, and its fixed launch says so.
  const sessionSandboxUnavailableReason =
    !supportsSessionSandboxing &&
    !launchLock.limited &&
    providerSupportsLocalSessionSandbox(selectedProvider)
      ? describeUnavailableSessionSandbox(versionInfo, t)
      : null;
  const effectiveSandboxLevel: SessionSandboxLevel = launchLock.limited
    ? "project-write"
    : canConfigureSessionSandbox
      ? sandboxLevel
      : "none";
  // The firewall is part of the sandbox a limited user cannot clear; the server
  // refuses a limited launch that turns it off.
  const effectiveSandboxNetworkFirewall =
    effectiveSandboxLevel === "project-write" &&
    (launchLock.limited || sandboxNetworkFirewall);
  // Open local access does not block the sandbox; it earns a standing warning.
  const sandboxLocalAuthOpen =
    effectiveSandboxLevel === "project-write" &&
    versionInfo?.sessionSandboxing?.localAuthEnforced === false;

  const { providers: providerDescriptors } = useProviderDescriptors(
    serverHasCapability(
      versionInfo,
      SERVER_CAPABILITIES.providerDescriptors.name,
    ),
  );
  const {
    settings,
    displayDefaults,
    isLoading: settingsLoading,
    error: settingsError,
    refetch: refetchSettings,
    updateSetting: updateServerSetting,
  } = useServerSettings();
  const displayDefaultsPending = displayDefaults !== undefined;
  const newSessionDefaultsRef = useRef(settings?.newSessionDefaults);
  useEffect(() => {
    newSessionDefaultsRef.current = settings?.newSessionDefaults;
  }, [settings?.newSessionDefaults]);

  const providerChoices = (providerDescriptors ?? providers).map(
    (descriptor) => ({
      ...descriptor,
      ...(descriptor.name === selectedProvider
        ? selectedProviderInfo
        : providers.find((provider) => provider.name === descriptor.name)),
    }),
  );
  const routerEnabled =
    serverHasCapability(
      versionInfo,
      SERVER_CAPABILITIES.agentAuthRouter.name,
    ) &&
    !launchLock.limited &&
    effectiveSandboxLevel === "none" &&
    (selectedProvider === "claude" || selectedProvider === "codex");
  const routerDiscovery = useRouterDiscovery(selectedProvider, routerEnabled);
  const routerThinking: ThinkingOption =
    selectedThinkingMode === "off"
      ? "off"
      : selectedThinkingMode === "auto"
        ? "auto"
        : `on:${selectedEffortLevel}`;
  const currentRouterPreference =
    routerPreference?.sourceKey === clientSummarySourceKey
      ? routerPreference
      : null;
  const routerSelection = useMemo(
    () =>
      routerSelectionCustomized
        ? currentRouterPreference
        : routerEnabled && !launch
          ? restoreRouterSelection(
              currentRouterPreference,
              routerDiscovery.error ? null : routerDiscovery.data,
              selectedProvider,
              selectedModel,
              routerThinking,
            )
          : null,
    [
      routerSelectionCustomized,
      currentRouterPreference,
      routerEnabled,
      launch,
      routerDiscovery.data,
      routerDiscovery.error,
      selectedProvider,
      selectedModel,
      routerThinking,
    ],
  );
  const routerRestorePending = Boolean(
    !routerSelectionCustomized &&
      currentRouterPreference &&
      routerEnabled &&
      !launch &&
      !routerDiscovery.data &&
      !routerDiscovery.loaded,
  );
  const { usage: subscriptionUsage } = useProviderSubscriptionUsage(
    routerSelection ? null : selectedProvider,
    { bootstrapTier: "supplementary" },
  );
  const routerAccounts = useMemo(
    () =>
      routedAccounts(
        routerDiscovery.data,
        selectedProvider,
        routerSelection?.poolId,
      ),
    [routerDiscovery.data, selectedProvider, routerSelection?.poolId],
  );
  const accountModels = useMemo(
    () =>
      routedModels(
        routerDiscovery.data,
        selectedProvider,
        routerSelection?.poolId,
      ),
    [routerDiscovery.data, selectedProvider, routerSelection?.poolId],
  );
  const routerAliases = useMemo(
    () => routerAliasTargets(routerAccounts),
    [routerAccounts],
  );
  const routerModelList = useMemo(
    () =>
      buildRouterModelList({
        direct: selectedProviderInfo?.models ?? [],
        accounts: routerAccounts,
        accountModels,
        routed: !!routerSelection,
        selectedModel,
      }),
    [
      selectedProviderInfo?.models,
      routerAccounts,
      accountModels,
      routerSelection,
      selectedModel,
    ],
  );
  const availableModels = routerModelList.models;
  // The pool's rows are as old as its least recently read member.
  const routerCatalogAt = routerAccounts
    .flatMap((a) => [a.catalogAt, a.cliModelsAt])
    .filter((at): at is string => !!at)
    .sort()[0];
  const [routerCatalogRefresh, setRouterCatalogRefresh] = useState<
    "idle" | "refreshing" | "failed"
  >("idle");
  const refreshRouterCatalog = useCallback(async () => {
    setRouterCatalogRefresh("refreshing");
    const results = await Promise.allSettled(
      routerAccounts.map((a) => api.routerRefreshOverview({ accountId: a.id })),
    );
    await routerDiscovery.reload();
    setRouterCatalogRefresh(
      results.some((r) => r.status === "rejected") ? "failed" : "idle",
    );
  }, [routerAccounts, routerDiscovery.reload]);
  const visibleModels = useMemo(
    () =>
      withProviderVisibleModelSelection(
        selectedProvider,
        availableModels,
        selectedModel,
        t("modelSelectionUnavailable"),
      ),
    [availableModels, selectedModel, selectedProvider, t],
  );
  const selectedProviderCatalogCurrent =
    selectedProvider !== "claude-gateway" ||
    (selectedProviderQuery.fresh &&
      !selectedProviderQuery.refreshing &&
      selectedProviderQuery.error === null);
  const routedModel = resolveRouterModel(
    selectedModel,
    accountModels,
    routerAliases,
  );
  const selectedModelInfo = visibleModels.find(
    (model) => model.id === selectedModel,
  );
  const routerTierSelection =
    routerDiscovery.data?.serviceTierSelection === true;
  const tierModel = routerSelection
    ? routerSelection.accountId
      ? routerAccounts
          .find((a) => a.id === routerSelection.accountId)
          ?.models.find((m) => m.id === routedModel)
      : accountModels.find((m) => m.id === routedModel)
    : selectedModelInfo;
  const serviceTierOptions =
    routerSelection && !routerTierSelection
      ? []
      : selectableServiceTiers(tierModel?.serviceTiers);
  const effectiveServiceTier =
    selectedServiceTier &&
    serviceTierOptions.some((tier) => tier.id === selectedServiceTier)
      ? selectedServiceTier
      : null;
  const compatibleMembers = routerSelection?.poolId
    ? routerPoolMembers(
        routerDiscovery.data,
        routerSelection.poolId,
        selectedProvider,
        selectedModel,
        routerThinking,
        effectiveServiceTier,
      )
    : [];
  const selectedRouterPool = routerDiscovery.data?.pools.find(
    (p) => p.id === routerSelection?.poolId,
  );
  // A picked account always pins with "manual"; otherwise the chosen policy
  // or the pool default decides. A Manual default with one fitting account
  // needs no pick.
  const routerAccountId =
    routerSelection?.accountId ||
    ((routerSelection?.policy ?? selectedRouterPool?.policy) === "manual" &&
    compatibleMembers.length === 1
      ? compatibleMembers[0]?.id
      : undefined);
  const routerPolicy = routerAccountId ? "manual" : routerSelection?.policy;
  const claudeAiConnectorsSupport =
    selectedProvider === "claude" && routerSelection && !routerDiscovery.error
      ? routerDiscovery.data?.claudeAiConnectors
      : undefined;
  const savedClaudeAiConnectors =
    getProviderSessionDefaults(settings?.newSessionDefaults, "claude")
      .routerClaudeAiConnectors === true;
  const preferClaudeAiConnectors =
    routerConnectorsChoice ?? savedClaudeAiConnectors;
  const routerClaudeAiConnectors =
    preferClaudeAiConnectors && !!claudeAiConnectorsSupport?.login;
  const selectedProviderRuntime = selectedProviderQuery.fresh
    ? selectedProviderQuery.row
    : !providersStale
      ? aggregateProviderInfo
      : undefined;
  const hasDirectProviderModel =
    (!selectedProvider || selectedProviderRuntime?.installed === true) &&
    selectedProviderCatalogCurrent &&
    (!currentRouterPreference ||
      !selectedProviderInfo?.models?.length ||
      selectedProviderInfo.models.some(
        (model) => model.id === selectedModel,
      )) &&
    hasRequiredProviderModel(
      selectedProvider,
      selectedProviderInfo?.models ?? [],
      selectedModel,
    );
  const hasSelectedProviderModel =
    !routerRestorePending &&
    (routerSelection
      ? !!(
          routerEnabled &&
          routedModel &&
          !routerDiscovery.error &&
          compatibleMembers.length &&
          (routerAccountId
            ? compatibleMembers.some((a) => a.id === routerAccountId)
            : (routerPolicy ?? selectedRouterPool?.policy) !== "manual")
        )
      : hasDirectProviderModel);
  const helperSelectableModels = useMemo(
    () => [...visibleModels],
    [visibleModels],
  );
  const helperSideModelOptions: FilterOption<string>[] = useMemo(
    () => [
      {
        value: HELPER_SIDE_MODEL_CHEAPEST,
        label: t("helperSideModelCheapest"),
      },
      {
        value: HELPER_SIDE_MODEL_SAME_AS_MAIN,
        label: t("helperSideModelSameAsMain"),
        description: selectedModel ?? undefined,
      },
      ...helperSelectableModels.map((model) => ({
        value: model.id,
        label: model.name,
        description: model.description,
      })),
    ],
    [helperSelectableModels, selectedModel, t],
  );
  // Default to true for backwards compatibility with providers that don't set these flags
  const supportsPermissionMode =
    selectedProviderInfo?.supportsPermissionMode ?? true;
  const supportsThinkingToggle =
    selectedProviderInfo?.supportsThinkingToggle ?? true;
  const effortOptions = useMemo(
    () =>
      getEffortLevelOptions({
        provider: selectedProviderInfo,
        model: selectedModelInfo,
        translate: t,
      }),
    [selectedModelInfo, selectedProviderInfo, t],
  );
  const effectiveEffortLevel = routerSelection
    ? selectedEffortLevel
    : resolveSupportedEffortLevel(selectedEffortLevel, effortOptions);
  const thinkingModeOptions = useMemo(
    () =>
      getThinkingModeOptions({
        provider: selectedProviderInfo,
        model: selectedModelInfo,
        effortOptions,
      }),
    [effortOptions, selectedModelInfo, selectedProviderInfo],
  );
  const effectiveThinkingMode = routerSelection
    ? selectedThinkingMode
    : resolveSupportedThinkingMode(selectedThinkingMode, thinkingModeOptions);
  // A locked effort also settles the thinking mode it implies, so the panel
  // that would let either be changed is withheld rather than shown inert.
  const showThinkingControls =
    supportsThinkingToggle &&
    !launchLock.effort &&
    thinkingModeOptions.some((option) => option !== "off");
  const permissionModeOptions = useMemo(
    () => getPermissionModeOptions({ model: selectedModelInfo }),
    [selectedModelInfo],
  );
  const effectivePermissionMode = permissionModeOptions.includes(mode)
    ? mode
    : "default";
  const installedMachineControlCapable = serverHasCapability(
    versionInfo,
    SERVER_CAPABILITIES.installedMachineControl.name,
  );
  const machineControlEligible =
    installedMachineControlCapable &&
    effectiveSandboxLevel === "none" &&
    !launch &&
    effectivePermissionMode !== "plan" &&
    (selectedProvider === "codex"
      ? effectivePermissionMode === "bypassPermissions"
      : ["claude", "claude-gateway", "claude-ollama"].includes(
          selectedProvider ?? "",
        ));
  const { status: machineControlStatus } = useMachineControlStatus(
    machineControlEligible,
  );
  const machineControlAvailable =
    machineControlEligible && machineControlStatus.available;
  // The choice made here, else the server's default for eligible launches.
  const machineControlSelected =
    machineControlAvailable &&
    (machineControlChoice ?? machineControlStatus.enabled);
  // A queued session carries no choice, so it starts with the server default.
  const machineControlQueueBlocked =
    machineControlAvailable &&
    machineControlSelected !== machineControlStatus.enabled;
  // Until readiness is known the launch says nothing and the server decides.
  const supportsInstalledMachineControl =
    installedMachineControlCapable &&
    (machineControlStatus.known || !machineControlEligible);
  useEffect(() => {
    if (!machineControlEligible)
      dispatchOptions({
        type: "choose",
        field: "machineControlChoice",
        value: null,
      });
  }, [machineControlEligible]);
  const getLegacyProviderDefaultSeed = useCallback(
    (providerName: ProviderName) => ({
      model:
        providerName === "claude" ? resolveModel(getModelSetting()) : undefined,
      thinkingMode: legacyThinkingMode,
      effortLevel: legacyEffortLevel,
    }),
    [legacyEffortLevel, legacyThinkingMode],
  );
  // A locked field is not a default anything may override, so every path that
  // seeds provider, model, effort, or sandbox ends here. It deliberately does
  // not mark the form customized: a lock the server imposed is not a
  // preference worth saving as this client's default.
  const applyLaunchLock = useCallback(() => {
    if (!launchLock.limited) return;
    dispatchOptions({ type: "lock", lock: launchLock });
  }, [launchLock]);

  // Apply saved defaults against whatever provider rows are known so far.
  // `providerRows` may be empty (nothing probed yet) or a previous visit's
  // snapshot; the standing choice is settings state, so an unknown catalog
  // seeds the saved provider rather than blanking the form.
  const applyInitialDefaults = useCallback(
    (providerRows: ProviderInfo[]) => {
      const patch = seedNewSessionOptions({
        providerRows,
        savedDefaults: settings?.newSessionDefaults ?? displayDefaults,
        preferredProvider,
        preferredModel,
        preferredThinking,
        preferredPermissionMode,
        supportsSessionSandboxing,
        sourceKey: clientSummarySourceKey,
        legacySeed: getLegacyProviderDefaultSeed,
      });
      if (!patch) return;
      dispatchOptions({ type: "seed", patch });
      // Last, so a saved default never outranks the acting principal's lock.
      applyLaunchLock();
    },
    [
      applyLaunchLock,
      clientSummarySourceKey,
      settings,
      displayDefaults,
      supportsSessionSandboxing,
      getLegacyProviderDefaultSeed,
      preferredProvider,
      preferredModel,
      preferredThinking,
      preferredPermissionMode,
    ],
  );

  // Saved display defaults can seed controls while current settings load.
  // Waiting for the provider catalog here would hand an unselected provider's
  // discovery cost to the saved one; see topics/session-defaults.md.
  useEffect(() => {
    if (hasSeededDefaultsRef.current || (settingsLoading && !displayDefaults))
      return;
    hasSeededDefaultsRef.current = !settingsLoading && !displayDefaultsPending;
    if (hasUserCustomizedDefaultsRef.current) return;
    applyInitialDefaults(providers);
  }, [
    applyInitialDefaults,
    providers,
    settingsLoading,
    displayDefaults,
    displayDefaultsPending,
  ]);

  // Reconcile that seed once the probed catalog and version capabilities land.
  useEffect(() => {
    if (
      hasInitializedDefaultsRef.current ||
      providersLoading ||
      settingsLoading ||
      versionLoading
    ) {
      return;
    }

    hasInitializedDefaultsRef.current = true;
    if (hasUserCustomizedDefaultsRef.current) {
      return;
    }

    if (providers.length === 0) return;
    applyInitialDefaults(providers);
  }, [
    applyInitialDefaults,
    providers,
    providersLoading,
    settingsLoading,
    versionLoading,
  ]);

  // Re-assert the lock for a principal that arrived after the first seed. The
  // seeding paths call applyLaunchLock themselves, so this covers only the
  // ordering where the acting-principal request settles last.
  useEffect(() => {
    applyLaunchLock();
  }, [applyLaunchLock]);

  // When provider changes, reset model based on user settings
  const handleProviderSelect = (providerName: ProviderName) => {
    hasUserCustomizedDefaultsRef.current = true;
    dispatchOptions({
      type: "switchProvider",
      patch: switchNewSessionProvider({
        providerName,
        providers,
        savedDefaults: settings?.newSessionDefaults,
        preferredThinking,
        sourceKey: clientSummarySourceKey,
        legacySeed: getLegacyProviderDefaultSeed,
      }),
    });
  };

  useEffect(() => {
    const patch = fillGatewayModel({
      selectedProvider,
      selectedModel,
      availableModels,
      savedDefaults: settings?.newSessionDefaults,
      legacySeed: getLegacyProviderDefaultSeed,
    });
    if (patch) dispatchOptions({ type: "fillModel", patch });
  }, [
    availableModels,
    getLegacyProviderDefaultSeed,
    selectedModel,
    selectedProvider,
    settings?.newSessionDefaults,
  ]);

  // A provider chosen before its catalog answered has no model yet. Fill the
  // provider-local saved default once its models arrive, leaving any existing
  // pick alone.
  useEffect(() => {
    const patch = fillCatalogModel({
      selectedProvider,
      selectedModel,
      availableModels,
      savedDefaults: settings?.newSessionDefaults,
      legacySeed: getLegacyProviderDefaultSeed,
    });
    if (patch) dispatchOptions({ type: "fillModel", patch });
  }, [
    availableModels,
    getLegacyProviderDefaultSeed,
    selectedModel,
    selectedProvider,
    settings?.newSessionDefaults,
  ]);

  // Handle model selection from FilterDropdown
  const handleModelSelect = useCallback((selected: string[]) => {
    hasUserCustomizedDefaultsRef.current = true;
    dispatchOptions({
      type: "choose",
      field: "selectedModel",
      value: selected[0] ?? null,
    });
  }, []);

  const handleModeSelect = (selectedMode: PermissionMode) => {
    hasUserCustomizedDefaultsRef.current = true;
    dispatchOptions({ type: "choose", field: "mode", value: selectedMode });
  };

  // Auto-persist new-session defaults: any user change to provider / model /
  // speed / router / permission / recap / suggestions / helper becomes the
  // default immediately
  // (no explicit "save as default" step). Skips the initial load — only fires
  // once the user has actually customized something — and stays silent to
  // avoid a toast on every click.
  useEffect(() => {
    if (
      !hasUserCustomizedDefaultsRef.current ||
      !selectedProvider ||
      displayDefaultsPending
    )
      return;
    void Promise.resolve(
      updateServerSetting(
        "newSessionDefaults",
        newSessionDefaultsToSave({
          saved: newSessionDefaultsRef.current,
          choices: {
            mode,
            selectedModel,
            selectedServiceTier,
            selectedThinkingMode,
            selectedEffortLevel,
            selectedRecapMode,
            recapAfterSeconds,
            selectedPromptSuggestionMode,
            sandboxLevel,
            sandboxNetworkFirewall,
            helperSideModel,
          },
          provider: selectedProvider,
          supportsSessionSandboxing,
          currentRouterPreference,
          preferClaudeAiConnectors,
          legacySeed: getLegacyProviderDefaultSeed,
        }),
      ),
    ).catch((err) => {
      console.error("Failed to save new session defaults:", err);
    });
  }, [
    getLegacyProviderDefaultSeed,
    helperSideModel,
    displayDefaultsPending,
    mode,
    recapAfterSeconds,
    sandboxLevel,
    sandboxNetworkFirewall,
    selectedModel,
    selectedServiceTier,
    currentRouterPreference,
    preferClaudeAiConnectors,
    selectedEffortLevel,
    selectedProvider,
    selectedPromptSuggestionMode,
    selectedRecapMode,
    selectedThinkingMode,
    supportsSessionSandboxing,
    updateServerSetting,
  ]);

  // A user's choice marks the form customized, which stops the seeding
  // effects and starts the automatic save, then applies the choice.
  const customizeOptions = useCallback((action: NewSessionOptionsAction) => {
    hasUserCustomizedDefaultsRef.current = true;
    dispatchOptions(action);
  }, []);

  return {
    availableModels,
    canConfigureSessionSandbox,
    claudeAiConnectorsSupport,
    displayDefaultsPending,
    effectiveEffortLevel,
    effectivePermissionMode,
    effectiveSandboxLevel,
    effectiveSandboxNetworkFirewall,
    effectiveServiceTier,
    effectiveThinkingMode,
    effortOptions,
    handleModeSelect,
    handleModelSelect,
    handleProviderSelect,
    hasDirectProviderModel,
    hasSelectedProviderModel,
    helperSideModel,
    helperSideModelOptions,
    machineControlAvailable,
    machineControlEligible,
    machineControlQueueBlocked,
    machineControlSelected,
    permissionModeOptions,
    providerChoices,
    providersLoading,
    providersStale,
    recapAfterSeconds,
    refetchProviders,
    refetchSettings,
    refreshRouterCatalog,
    routedModel,
    routerAccountId,
    routerCatalogAt,
    routerCatalogRefresh,
    routerClaudeAiConnectors,
    routerDiscovery,
    routerModelList,
    routerPolicy,
    routerSelection,
    routerSelectionCustomized,
    routerThinking,
    sandboxLevel,
    sandboxLocalAuthOpen,
    sandboxNetworkFirewall,
    selectMachineControl,
    selectedEffortLevel,
    selectedModel,
    selectedPromptSuggestionMode,
    selectedProvider,
    selectedProviderInfo,
    selectedProviderQuery,
    selectedRecapMode,
    selectedServiceTier,
    selectedThinkingMode,
    serviceTierOptions,
    sessionSandboxUnavailableReason,
    settingsError,
    settingsLoading,
    showThinkingControls,
    subscriptionUsage,
    supportsInstalledMachineControl,
    supportsPermissionMode,
    supportsSessionSandboxing,
    thinkingModeOptions,
    visibleModels,
    customizeOptions,
  };
}
