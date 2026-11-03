import {
  type BusyComposerDefaultAction,
  DEFAULT_CLEARLOOP_INACTIVITY_SECONDS,
  DEFAULT_PROJECT_QUEUE_QUIET_SECONDS,
  DEFAULT_PROJECT_QUEUE_CTRL_ENTER_ENABLED,
  DEFAULT_STEER_NOW_ENABLED,
  MAX_CLEARLOOP_INACTIVITY_SECONDS,
  MAX_PROJECT_QUEUE_QUIET_SECONDS,
  MIN_CLEARLOOP_INACTIVITY_SECONDS,
  PATIENT_TOPIC_SHIFT_CAPABILITY,
  PROJECT_QUEUE_READINESS_CHECK_CAPABILITY,
  type ProjectQueueReadinessCommand,
  RENDEZ_PROJECT_STATUS_CAPABILITY,
  RENDEZ_UPLOADS_CAPABILITY,
  SESSION_REWIND_CAPABILITY,
  clampClearloopInactivitySeconds,
  clampProjectQueueQuietSeconds,
  formatDurationSeconds,
  parseDurationSeconds,
  serverHasCapability,
  SERVER_CAPABILITIES,
  type SteeringModeSettings,
  type ProviderName,
} from "@yep-anywhere/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { CommittedRangeInput } from "../../components/ui/CommittedRangeInput";
import {
  type AttachmentUploadQuality,
  useAttachmentUploadQuality,
} from "../../hooks/useAttachmentUploadQuality";
import { useKeepMobileKeyboardOpenAfterDelivery } from "../../hooks/useKeepMobileKeyboardOpenAfterDelivery";
import { useBackgroundSessionCreation } from "../../hooks/useBackgroundSessionCreation";
import { useQuestionAsideSetting } from "../../hooks/useQuestionAsideSetting";
import { api } from "../../api/client";
import { useProjects } from "../../hooks/useProjects";
import { useServerSettings } from "../../hooks/useServerSettings";
import { useVersion } from "../../hooks/useVersion";
import { useI18n } from "../../i18n";

import { SettingsItem } from "./SettingsItem";
import { ProviderSteeringSettings } from "./ProviderSteeringSettings";
import { ProjectQueueReadinessSettings } from "./ProjectQueueReadinessSettings";
import { RendezSettings, type RendezSettingsValue } from "./RendezSettings";
import { useSettingsPaneTitle } from "./SettingsPaneTitleContext";
import { SettingsSection } from "./SettingsSection";
import { useSettingsUndo } from "./SettingsUndoContext";

const BUSY_COMPOSER_DEFAULT_ACTIONS: BusyComposerDefaultAction[] = [
  "steer",
  "queue",
];

type TurnTimestampsPlacement = "off" | "before" | "after";

const TURN_TIMESTAMPS_PLACEMENTS: TurnTimestampsPlacement[] = [
  "off",
  "before",
  "after",
];

const JOIN_WINDOW_SLIDER_MAX_SECONDS = 120;
const JOIN_WINDOW_MAX_SECONDS = 86400;
const SECONDS_SLIDER_SAVE_DEBOUNCE_MS = 400;

function parseJoinWindowSeconds(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.min(parsed, JOIN_WINDOW_MAX_SECONDS);
}

function parseProjectQueueQuietSeconds(value: string): number {
  const parsed = Number.parseInt(value, 10);
  return (
    clampProjectQueueQuietSeconds(parsed) ?? DEFAULT_PROJECT_QUEUE_QUIET_SECONDS
  );
}

/** `45s` / `2m` / `1h` text → clamped whole seconds, or null when unparseable. */
function parseClearloopInactivityText(value: string): number | null {
  const seconds = parseDurationSeconds(value);
  if (seconds === null) return null;
  return clampClearloopInactivitySeconds(seconds) ?? null;
}

/** 100 is Off, never "compact at full context" (topics/patient-topic-shift.md). */
const PATIENT_COMPACT_OFF_PERCENT = 100;

function PatientCompactThresholdItem({
  label,
  description,
  storedPercent,
  onCommit,
}: {
  label: string;
  description: string;
  storedPercent: number | undefined;
  onCommit: (percent: number) => void;
}) {
  const { t } = useI18n();
  const stored = storedPercent ?? PATIENT_COMPACT_OFF_PERCENT;
  const [draft, setDraft] = useState(stored);
  useEffect(() => {
    setDraft(stored);
  }, [stored]);
  const commit = (percent: number) => {
    const next = Math.min(
      PATIENT_COMPACT_OFF_PERCENT,
      Math.max(1, Math.round(percent) || PATIENT_COMPACT_OFF_PERCENT),
    );
    setDraft(next);
    if (next !== stored) onCommit(next);
  };
  const valueHint =
    draft >= PATIENT_COMPACT_OFF_PERCENT
      ? t("messageDeliveryPatientCompactOff")
      : t("messageDeliveryPatientCompactOn", { percent: String(draft) });
  return (
    <SettingsItem
      label={label}
      description={description}
      valueText={valueHint}
      className="model-settings-item"
    >
      <span className="output-appearance-slider-row">
        <CommittedRangeInput
          min={1}
          max={PATIENT_COMPACT_OFF_PERCENT}
          step={1}
          value={draft}
          aria-label={label}
          onDraftChange={setDraft}
          onCommit={commit}
        />
        <span className="output-appearance-number-wrap">
          <input
            type="number"
            className="settings-input-small output-appearance-number"
            min={1}
            max={PATIENT_COMPACT_OFF_PERCENT}
            step={1}
            value={draft}
            aria-label={label}
            onChange={(e) => setDraft(Number(e.target.value))}
            onBlur={() => commit(draft)}
          />
          <span className="output-appearance-unit">%</span>
        </span>
      </span>
      <span className="settings-hint">{valueHint}</span>
    </SettingsItem>
  );
}

function sameSteeringModes(
  a: SteeringModeSettings,
  b: SteeringModeSettings,
): boolean {
  return (
    Object.keys(a).length === Object.keys(b).length &&
    Object.entries(a).every(
      ([provider, mode]) => b[provider as ProviderName] === mode,
    )
  );
}

interface MessageDeliveryBaseline {
  steeringModes: SteeringModeSettings;
  joinWindowSeconds: number;
  projectQueueQuietSeconds: number;
  clearloopInactivitySeconds: number;
  projectQueueReadinessCheck: ProjectQueueReadinessCommand | null;
  composeAnchorsEnabled: boolean;
  turnTimestamps: TurnTimestampsPlacement;
  bangCommandsEnabled: boolean;
  busyComposerDefaultAction: BusyComposerDefaultAction;
  steerNowDefault: boolean;
  patientQueueDefault: boolean;
  patientQueueCompactAtPercent: number | undefined;
  topicShiftCompactAtPercent: number | undefined;
  projectQueueCtrlEnterEnabled: boolean;
  keepMobileKeyboardOpenAfterDelivery: boolean;
  questionAsidesEnabled: boolean;
  backgroundSessionCreation: boolean;
  attachmentQuality: AttachmentUploadQuality;
  rendez: RendezSettingsValue;
}

const RENDEZ_STATUS_REFRESH_MS = 10_000;
const RENDEZ_OFF: RendezSettingsValue = { enabled: false, projects: {} };

/** Same default, delivery and per-project choices, ignoring burst limits. */
function sameRendezChoices(
  a: RendezSettingsValue,
  b: RendezSettingsValue,
): boolean {
  const aKeys = Object.keys(a.projects);
  return (
    a.enabled === b.enabled &&
    (a.delivery ?? "auto") === (b.delivery ?? "auto") &&
    aKeys.length === Object.keys(b.projects).length &&
    aKeys.every((path) => a.projects[path] === b.projects[path])
  );
}

/**
 * Which projects' .rendez observers run, refreshed while the pane is open
 * and visible; null when the server does not report it.
 */
function useRendezWatching(supported: boolean): {
  watching: ReadonlySet<string> | null;
  refresh: () => void;
} {
  const [watching, setWatching] = useState<ReadonlySet<string> | null>(null);
  const mountedRef = useRef(true);
  const refresh = useCallback(() => {
    if (!supported || document.visibilityState === "hidden") return;
    void api.getRendezStatus().then(
      (status) => {
        if (mountedRef.current) setWatching(new Set(status.watching));
      },
      () => {
        // Status is advisory; rows stay configurable without it.
      },
    );
  }, [supported]);
  useEffect(() => {
    mountedRef.current = true;
    if (!supported) {
      setWatching(null);
      return;
    }
    refresh();
    const timer = setInterval(refresh, RENDEZ_STATUS_REFRESH_MS);
    return () => {
      mountedRef.current = false;
      clearInterval(timer);
    };
  }, [supported, refresh]);
  return { watching, refresh };
}

/**
 * Toggles and sliders apply immediately; the readiness command has an
 * explicit Save. Header Undo restores saved values from when the pane opened.
 */
export function MessageDeliverySettings() {
  const { t } = useI18n();
  useSettingsPaneTitle(t("messageDeliveryTitle"));
  const { settings, isLoading, error, updateSettings } = useServerSettings();
  const { version } = useVersion();
  const supportsProviderSteering = serverHasCapability(
    version,
    SERVER_CAPABILITIES.providerSteeringModes.name,
  );

  const supportsReadinessCheck = serverHasCapability(
    version,
    PROJECT_QUEUE_READINESS_CHECK_CAPABILITY,
  );

  const supportsRendez = serverHasCapability(
    version,
    RENDEZ_UPLOADS_CAPABILITY,
  );
  const supportsRendezStatus = serverHasCapability(
    version,
    RENDEZ_PROJECT_STATUS_CAPABILITY,
  );
  const supportsTopicShift = serverHasCapability(
    version,
    PATIENT_TOPIC_SHIFT_CAPABILITY,
  );
  const supportsClearloop = serverHasCapability(
    version,
    SESSION_REWIND_CAPABILITY,
  );
  const {
    keepMobileKeyboardOpenAfterDelivery,
    setKeepMobileKeyboardOpenAfterDelivery,
  } = useKeepMobileKeyboardOpenAfterDelivery();
  const { backgroundSessionCreation, setBackgroundSessionCreation } =
    useBackgroundSessionCreation();
  const { questionAsidesEnabled, setQuestionAsidesEnabled } =
    useQuestionAsideSetting();
  const [attachmentQuality, setAttachmentQuality] =
    useAttachmentUploadQuality();

  // null drafts mirror the server value; non-null while the user is editing
  // or a save is in flight, cleared once the server catches up.
  const [draftJoinWindow, setDraftJoinWindow] = useState<string | null>(null);
  const [draftProjectQueueQuiet, setDraftProjectQueueQuiet] = useState<
    string | null
  >(null);
  const [draftClearloopInactivity, setDraftClearloopInactivity] = useState<
    string | null
  >(null);
  const [draftAnchors, setDraftAnchors] = useState<boolean | null>(null);
  const [draftTurnTimestamps, setDraftTurnTimestamps] =
    useState<TurnTimestampsPlacement | null>(null);
  const [draftBangCommands, setDraftBangCommands] = useState<boolean | null>(
    null,
  );
  const [draftBusyDefaultAction, setDraftBusyDefaultAction] =
    useState<BusyComposerDefaultAction | null>(null);
  const [draftSteerNow, setDraftSteerNow] = useState<boolean | null>(null);
  const [draftPatientQueue, setDraftPatientQueue] = useState<boolean | null>(
    null,
  );
  const [draftProjectQueueCtrlEnter, setDraftProjectQueueCtrlEnter] = useState<
    boolean | null
  >(null);
  const baselineRef = useRef<MessageDeliveryBaseline | null>(null);
  const [draftRendez, setDraftRendez] = useState<RendezSettingsValue | null>(
    null,
  );
  const shownRendez = draftRendez ?? settings?.rendez ?? RENDEZ_OFF;
  const { watching: rendezWatching, refresh: refreshRendezWatching } =
    useRendezWatching(supportsRendez && supportsRendezStatus);
  const { projects: knownProjects } = useProjects();
  const saveRendez = useCallback(
    (next: RendezSettingsValue) => {
      setDraftRendez(next);
      void updateSettings({ rendez: next })
        .catch(() => {
          // surfaced via the hook's error state
        })
        .finally(() => {
          setDraftRendez(null);
          // Turning a project off stops its observer.
          refreshRendezWatching();
        });
    },
    [refreshRendezWatching, updateSettings],
  );

  const serverJoinWindowSeconds = settings?.deferredJoinWindowSeconds ?? 0;
  const serverProjectQueueQuietSeconds =
    clampProjectQueueQuietSeconds(settings?.projectQueueQuietSeconds) ??
    DEFAULT_PROJECT_QUEUE_QUIET_SECONDS;
  const serverClearloopInactivitySeconds =
    clampClearloopInactivitySeconds(settings?.clearloopInactivitySeconds) ??
    DEFAULT_CLEARLOOP_INACTIVITY_SECONDS;
  const serverComposeAnchorsEnabled = settings?.composeAnchorsEnabled ?? false;
  const serverReadinessCheck = settings?.projectQueueReadinessCheck ?? null;
  const serverTurnTimestamps = settings?.turnTimestamps ?? "off";
  const serverBangCommandsEnabled =
    settings?.clientDefaults?.bangCommandsEnabled ?? false;
  const serverBusyDefaultAction =
    settings?.clientDefaults?.busyComposerDefaultAction ?? "steer";
  const serverSteerNowDefault =
    settings?.clientDefaults?.steerNowDefault ?? DEFAULT_STEER_NOW_ENABLED;
  const serverPatientQueueDefault =
    settings?.clientDefaults?.patientQueueDefault ?? false;
  const serverProjectQueueCtrlEnterEnabled =
    settings?.clientDefaults?.projectQueueCtrlEnterEnabled ??
    DEFAULT_PROJECT_QUEUE_CTRL_ENTER_ENABLED;

  useEffect(() => {
    if (settings && !baselineRef.current) {
      baselineRef.current = {
        steeringModes: { ...settings.steeringModes },
        joinWindowSeconds: settings.deferredJoinWindowSeconds ?? 0,
        projectQueueQuietSeconds:
          clampProjectQueueQuietSeconds(settings.projectQueueQuietSeconds) ??
          DEFAULT_PROJECT_QUEUE_QUIET_SECONDS,
        clearloopInactivitySeconds:
          clampClearloopInactivitySeconds(
            settings.clearloopInactivitySeconds,
          ) ?? DEFAULT_CLEARLOOP_INACTIVITY_SECONDS,
        composeAnchorsEnabled: settings.composeAnchorsEnabled ?? false,
        projectQueueReadinessCheck: settings.projectQueueReadinessCheck ?? null,
        turnTimestamps: settings.turnTimestamps ?? "off",
        bangCommandsEnabled:
          settings.clientDefaults?.bangCommandsEnabled ?? false,
        busyComposerDefaultAction:
          settings.clientDefaults?.busyComposerDefaultAction ?? "steer",
        steerNowDefault:
          settings.clientDefaults?.steerNowDefault ?? DEFAULT_STEER_NOW_ENABLED,
        patientQueueDefault:
          settings.clientDefaults?.patientQueueDefault ?? false,
        patientQueueCompactAtPercent:
          settings.clientDefaults?.patientQueueCompactAtPercent,
        topicShiftCompactAtPercent:
          settings.clientDefaults?.topicShiftCompactAtPercent,
        projectQueueCtrlEnterEnabled:
          settings.clientDefaults?.projectQueueCtrlEnterEnabled ??
          DEFAULT_PROJECT_QUEUE_CTRL_ENTER_ENABLED,
        keepMobileKeyboardOpenAfterDelivery,
        questionAsidesEnabled,
        backgroundSessionCreation,
        attachmentQuality,
        rendez: settings.rendez ?? RENDEZ_OFF,
      };
    }
  }, [
    attachmentQuality,
    keepMobileKeyboardOpenAfterDelivery,
    questionAsidesEnabled,
    backgroundSessionCreation,
    settings,
  ]);

  const shownJoinWindowText =
    draftJoinWindow ?? String(serverJoinWindowSeconds);
  const shownJoinWindowSeconds = parseJoinWindowSeconds(shownJoinWindowText);
  const shownProjectQueueQuietText =
    draftProjectQueueQuiet ?? String(serverProjectQueueQuietSeconds);
  const shownProjectQueueQuietSeconds = parseProjectQueueQuietSeconds(
    shownProjectQueueQuietText,
  );
  const shownClearloopInactivityText =
    draftClearloopInactivity ??
    formatDurationSeconds(serverClearloopInactivitySeconds);
  const shownClearloopInactivitySeconds = parseClearloopInactivityText(
    shownClearloopInactivityText,
  );
  const shownAnchors = draftAnchors ?? serverComposeAnchorsEnabled;
  const shownTurnTimestamps = draftTurnTimestamps ?? serverTurnTimestamps;
  const shownBangCommands = draftBangCommands ?? serverBangCommandsEnabled;
  const shownBusyDefaultAction =
    draftBusyDefaultAction ?? serverBusyDefaultAction;
  const shownSteerNowDefault = draftSteerNow ?? serverSteerNowDefault;
  const shownPatientQueueDefault =
    draftPatientQueue ?? serverPatientQueueDefault;
  const shownProjectQueueCtrlEnter =
    draftProjectQueueCtrlEnter ?? serverProjectQueueCtrlEnterEnabled;

  // Debounced auto-save for the join window (sliders fire continuously).
  useEffect(() => {
    if (draftJoinWindow === null) return;
    const parsed = parseJoinWindowSeconds(draftJoinWindow);
    if (parsed === serverJoinWindowSeconds) return;
    const timer = setTimeout(() => {
      void updateSettings({ deferredJoinWindowSeconds: parsed }).catch(() => {
        // surfaced via the hook's error state
      });
    }, SECONDS_SLIDER_SAVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [draftJoinWindow, serverJoinWindowSeconds, updateSettings]);

  useEffect(() => {
    if (draftProjectQueueQuiet === null) return;
    const parsed = parseProjectQueueQuietSeconds(draftProjectQueueQuiet);
    if (parsed === serverProjectQueueQuietSeconds) return;
    const timer = setTimeout(() => {
      void updateSettings({ projectQueueQuietSeconds: parsed }).catch(() => {
        // surfaced via the hook's error state
      });
    }, SECONDS_SLIDER_SAVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [draftProjectQueueQuiet, serverProjectQueueQuietSeconds, updateSettings]);

  useEffect(() => {
    if (!supportsClearloop || draftClearloopInactivity === null) return;
    const parsed = parseClearloopInactivityText(draftClearloopInactivity);
    if (parsed === null || parsed === serverClearloopInactivitySeconds) return;
    const timer = setTimeout(() => {
      void updateSettings({ clearloopInactivitySeconds: parsed }).catch(() => {
        // surfaced via the hook's error state
      });
    }, SECONDS_SLIDER_SAVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [
    draftClearloopInactivity,
    serverClearloopInactivitySeconds,
    supportsClearloop,
    updateSettings,
  ]);

  // Drop drafts once the server reflects them.
  useEffect(() => {
    if (
      draftJoinWindow !== null &&
      parseJoinWindowSeconds(draftJoinWindow) === serverJoinWindowSeconds
    ) {
      setDraftJoinWindow(null);
    }
  }, [draftJoinWindow, serverJoinWindowSeconds]);
  useEffect(() => {
    if (
      draftClearloopInactivity !== null &&
      parseClearloopInactivityText(draftClearloopInactivity) ===
        serverClearloopInactivitySeconds
    ) {
      setDraftClearloopInactivity(null);
    }
  }, [draftClearloopInactivity, serverClearloopInactivitySeconds]);
  useEffect(() => {
    if (
      draftProjectQueueQuiet !== null &&
      parseProjectQueueQuietSeconds(draftProjectQueueQuiet) ===
        serverProjectQueueQuietSeconds
    ) {
      setDraftProjectQueueQuiet(null);
    }
  }, [draftProjectQueueQuiet, serverProjectQueueQuietSeconds]);
  useEffect(() => {
    if (draftAnchors !== null && draftAnchors === serverComposeAnchorsEnabled) {
      setDraftAnchors(null);
    }
  }, [draftAnchors, serverComposeAnchorsEnabled]);
  useEffect(() => {
    if (
      draftTurnTimestamps !== null &&
      draftTurnTimestamps === serverTurnTimestamps
    ) {
      setDraftTurnTimestamps(null);
    }
  }, [draftTurnTimestamps, serverTurnTimestamps]);
  useEffect(() => {
    if (
      draftBangCommands !== null &&
      draftBangCommands === serverBangCommandsEnabled
    ) {
      setDraftBangCommands(null);
    }
  }, [draftBangCommands, serverBangCommandsEnabled]);
  useEffect(() => {
    if (
      draftBusyDefaultAction !== null &&
      draftBusyDefaultAction === serverBusyDefaultAction
    ) {
      setDraftBusyDefaultAction(null);
    }
  }, [draftBusyDefaultAction, serverBusyDefaultAction]);
  useEffect(() => {
    if (draftSteerNow !== null && draftSteerNow === serverSteerNowDefault) {
      setDraftSteerNow(null);
    }
  }, [draftSteerNow, serverSteerNowDefault]);
  useEffect(() => {
    if (
      draftPatientQueue !== null &&
      draftPatientQueue === serverPatientQueueDefault
    ) {
      setDraftPatientQueue(null);
    }
  }, [draftPatientQueue, serverPatientQueueDefault]);
  useEffect(() => {
    if (
      draftProjectQueueCtrlEnter !== null &&
      draftProjectQueueCtrlEnter === serverProjectQueueCtrlEnterEnabled
    ) {
      setDraftProjectQueueCtrlEnter(null);
    }
  }, [draftProjectQueueCtrlEnter, serverProjectQueueCtrlEnterEnabled]);

  const baseline = baselineRef.current;
  const canUndo =
    !!baseline &&
    (shownJoinWindowSeconds !== baseline.joinWindowSeconds ||
      shownProjectQueueQuietSeconds !== baseline.projectQueueQuietSeconds ||
      (supportsClearloop &&
        shownClearloopInactivitySeconds !== null &&
        shownClearloopInactivitySeconds !==
          baseline.clearloopInactivitySeconds) ||
      shownAnchors !== baseline.composeAnchorsEnabled ||
      (supportsReadinessCheck &&
        JSON.stringify(serverReadinessCheck) !==
          JSON.stringify(baseline.projectQueueReadinessCheck)) ||
      shownTurnTimestamps !== baseline.turnTimestamps ||
      shownBangCommands !== baseline.bangCommandsEnabled ||
      shownBusyDefaultAction !== baseline.busyComposerDefaultAction ||
      shownSteerNowDefault !== baseline.steerNowDefault ||
      (supportsProviderSteering &&
        !sameSteeringModes(
          settings?.steeringModes ?? {},
          baseline.steeringModes,
        )) ||
      shownPatientQueueDefault !== baseline.patientQueueDefault ||
      (supportsTopicShift &&
        (settings?.clientDefaults?.patientQueueCompactAtPercent !==
          baseline.patientQueueCompactAtPercent ||
          settings?.clientDefaults?.topicShiftCompactAtPercent !==
            baseline.topicShiftCompactAtPercent)) ||
      shownProjectQueueCtrlEnter !== baseline.projectQueueCtrlEnterEnabled ||
      keepMobileKeyboardOpenAfterDelivery !==
        baseline.keepMobileKeyboardOpenAfterDelivery ||
      questionAsidesEnabled !== baseline.questionAsidesEnabled ||
      backgroundSessionCreation !== baseline.backgroundSessionCreation ||
      attachmentQuality !== baseline.attachmentQuality ||
      (supportsRendez && !sameRendezChoices(shownRendez, baseline.rendez)));

  const undo = useCallback(async () => {
    const snapshot = baselineRef.current;
    if (!snapshot) return;
    setQuestionAsidesEnabled(snapshot.questionAsidesEnabled);
    setBackgroundSessionCreation(snapshot.backgroundSessionCreation);
    setAttachmentQuality(snapshot.attachmentQuality);
    setDraftJoinWindow(null);
    setDraftProjectQueueQuiet(null);
    setDraftClearloopInactivity(null);
    setDraftAnchors(null);
    setDraftTurnTimestamps(null);
    setDraftBangCommands(null);
    setDraftBusyDefaultAction(null);
    setDraftSteerNow(null);
    setDraftPatientQueue(null);
    setDraftProjectQueueCtrlEnter(null);
    setKeepMobileKeyboardOpenAfterDelivery(
      snapshot.keepMobileKeyboardOpenAfterDelivery,
    );
    await updateSettings({
      ...(supportsProviderSteering
        ? { steeringModes: snapshot.steeringModes }
        : {}),
      ...(supportsRendez
        ? {
            rendez: {
              ...settings?.rendez,
              enabled: snapshot.rendez.enabled,
              projects: snapshot.rendez.projects,
              delivery: snapshot.rendez.delivery ?? "auto",
            },
          }
        : {}),
      deferredJoinWindowSeconds: snapshot.joinWindowSeconds,
      ...{ projectQueueQuietSeconds: snapshot.projectQueueQuietSeconds },
      ...(supportsClearloop
        ? { clearloopInactivitySeconds: snapshot.clearloopInactivitySeconds }
        : {}),
      composeAnchorsEnabled: snapshot.composeAnchorsEnabled,
      ...(supportsReadinessCheck
        ? { projectQueueReadinessCheck: snapshot.projectQueueReadinessCheck }
        : {}),
      turnTimestamps: snapshot.turnTimestamps,
      clientDefaults: {
        ...{ bangCommandsEnabled: snapshot.bangCommandsEnabled },
        busyComposerDefaultAction: snapshot.busyComposerDefaultAction,
        steerNowDefault: snapshot.steerNowDefault,
        patientQueueDefault: snapshot.patientQueueDefault,
        ...(supportsTopicShift
          ? {
              patientQueueCompactAtPercent:
                snapshot.patientQueueCompactAtPercent,
              topicShiftCompactAtPercent: snapshot.topicShiftCompactAtPercent,
            }
          : {}),
        ...{
          projectQueueCtrlEnterEnabled: snapshot.projectQueueCtrlEnterEnabled,
        },
      },
    }).catch(() => {
      // surfaced via the hook's error state
    });
  }, [
    setAttachmentQuality,
    setKeepMobileKeyboardOpenAfterDelivery,
    setQuestionAsidesEnabled,
    setBackgroundSessionCreation,
    supportsClearloop,
    supportsReadinessCheck,
    supportsProviderSteering,
    supportsRendez,
    supportsTopicShift,
    settings?.rendez,
    updateSettings,
  ]);

  useSettingsUndo(canUndo, undo);

  if (isLoading) {
    return <SettingsSection description={t("messageDeliveryLoading")} />;
  }

  return (
    <SettingsSection description={t("messageDeliveryDescription")}>
      <div className="settings-group">
        {supportsRendez ? (
          <RendezSettings
            value={shownRendez}
            projects={knownProjects}
            watching={rendezWatching}
            saving={draftRendez !== null}
            onChange={saveRendez}
          />
        ) : (
          <SettingsItem
            label={t("rendezDefaultTitle")}
            description={t("rendezDefaultDescription")}
            descriptionLayout="full-width-on-narrow"
            keywords={["rendez", ".rendez", "rendezvous", "upload", "watch"]}
          >
            <span className="settings-hint">{t("rendezUnavailable")}</span>
          </SettingsItem>
        )}
        <SettingsItem
          label={t("attachmentQualityTitle")}
          description={t("attachmentQualityDescription")}
          descriptionLayout="full-width-on-narrow"
          keywords={[
            "SD",
            "HD",
            "image",
            "photo",
            "screenshot",
            "resize",
            "compression",
            "resolution",
            "upload",
          ]}
          valueText={
            attachmentQuality === "sd"
              ? t("attachmentQualitySd")
              : t("attachmentQualityHd")
          }
        >
          <select
            className="settings-select"
            aria-label={t("attachmentQualityTitle")}
            value={attachmentQuality}
            onChange={(event) =>
              setAttachmentQuality(
                event.target.value as AttachmentUploadQuality,
              )
            }
          >
            <option value="sd">{t("attachmentQualitySd")}</option>
            <option value="hd">{t("attachmentQualityHd")}</option>
          </select>
        </SettingsItem>
        <SettingsItem
          label={t("messageDeliveryJoinWindowTitle")}
          description={t("messageDeliveryJoinWindowDescription")}
          valueText={shownJoinWindowText}
          className="model-settings-item"
        >
          <span className="output-appearance-slider-row">
            <CommittedRangeInput
              id="message-delivery-join-window"
              min={0}
              max={JOIN_WINDOW_SLIDER_MAX_SECONDS}
              step={5}
              value={Math.min(
                shownJoinWindowSeconds,
                JOIN_WINDOW_SLIDER_MAX_SECONDS,
              )}
              aria-label={t("messageDeliveryJoinWindowTitle")}
              onCommit={(value) => setDraftJoinWindow(String(value))}
            />
            <span className="output-appearance-number-wrap">
              <input
                type="number"
                className="settings-input-small output-appearance-number"
                min={0}
                max={JOIN_WINDOW_MAX_SECONDS}
                value={shownJoinWindowText}
                onChange={(e) => setDraftJoinWindow(e.target.value)}
                aria-label={t("messageDeliveryJoinWindowTitle")}
              />
              <span className="output-appearance-unit">s</span>
            </span>
          </span>
          <span className="settings-hint">
            {shownJoinWindowSeconds === 0
              ? t("messageDeliveryJoinWindowOffHint")
              : t("messageDeliveryJoinWindowOnHint", {
                  seconds: String(shownJoinWindowSeconds),
                })}
          </span>
        </SettingsItem>

        {supportsClearloop && (
          <SettingsItem
            label={t("messageDeliveryClearloopTitle")}
            description={t("messageDeliveryClearloopDescription")}
            doc="topics/session-rewind.md#clearloop"
            valueText={
              shownClearloopInactivitySeconds === null
                ? shownClearloopInactivityText
                : formatDurationSeconds(shownClearloopInactivitySeconds)
            }
            className="model-settings-item"
          >
            <span className="output-appearance-slider-row">
              <CommittedRangeInput
                id="message-delivery-clearloop-inactivity"
                min={MIN_CLEARLOOP_INACTIVITY_SECONDS}
                max={MAX_CLEARLOOP_INACTIVITY_SECONDS}
                step={10}
                value={
                  shownClearloopInactivitySeconds ??
                  serverClearloopInactivitySeconds
                }
                aria-label={t("messageDeliveryClearloopTitle")}
                onCommit={(value) =>
                  setDraftClearloopInactivity(formatDurationSeconds(value))
                }
              />
              <span className="output-appearance-number-wrap">
                <input
                  type="text"
                  inputMode="text"
                  className="settings-input-small output-appearance-number"
                  value={shownClearloopInactivityText}
                  onChange={(e) => setDraftClearloopInactivity(e.target.value)}
                  aria-label={t("messageDeliveryClearloopTitle")}
                  aria-invalid={shownClearloopInactivitySeconds === null}
                />
              </span>
            </span>
            <span className="settings-hint">
              {shownClearloopInactivitySeconds === null
                ? t("messageDeliveryClearloopInvalid")
                : t("messageDeliveryClearloopHint", {
                    duration: formatDurationSeconds(
                      shownClearloopInactivitySeconds,
                    ),
                  })}
            </span>
          </SettingsItem>
        )}

        {
          <SettingsSection
            title={t("projectQueueTitle")}
            doc="site/src/content/docs/project-queue.md"
          >
            <SettingsItem
              label={t("messageDeliveryProjectQueueQuietTitle")}
              description={t("messageDeliveryProjectQueueQuietDescription")}
              valueText={shownProjectQueueQuietText}
              className="model-settings-item"
            >
              <span className="output-appearance-slider-row">
                <CommittedRangeInput
                  id="message-delivery-project-queue-quiet"
                  min={0}
                  max={MAX_PROJECT_QUEUE_QUIET_SECONDS}
                  step={5}
                  value={shownProjectQueueQuietSeconds}
                  aria-label={t("messageDeliveryProjectQueueQuietTitle")}
                  onCommit={(value) => setDraftProjectQueueQuiet(String(value))}
                />
                <span className="output-appearance-number-wrap">
                  <input
                    type="number"
                    className="settings-input-small output-appearance-number"
                    min={0}
                    max={MAX_PROJECT_QUEUE_QUIET_SECONDS}
                    value={shownProjectQueueQuietText}
                    onChange={(e) => setDraftProjectQueueQuiet(e.target.value)}
                    aria-label={t("messageDeliveryProjectQueueQuietTitle")}
                  />
                  <span className="output-appearance-unit">s</span>
                </span>
              </span>
              <span className="settings-hint">
                {shownProjectQueueQuietSeconds === 0
                  ? t("messageDeliveryProjectQueueQuietOffHint")
                  : t("messageDeliveryProjectQueueQuietOnHint", {
                      seconds: String(shownProjectQueueQuietSeconds),
                    })}
              </span>
            </SettingsItem>
            {supportsReadinessCheck && (
              <ProjectQueueReadinessSettings
                command={serverReadinessCheck}
                onSave={async (command) => {
                  await updateSettings({ projectQueueReadinessCheck: command });
                }}
              />
            )}
          </SettingsSection>
        }

        <SettingsItem
          as="label"
          label={t("messageDeliveryComposeAnchorsTitle")}
          description={t("messageDeliveryComposeAnchorsDescription")}
          doc="topics/compose-time-context-anchors.md#opt-in-staleness-anchors-yep_compose_anchors1"
        >
          <input
            type="checkbox"
            checked={shownAnchors}
            onChange={(e) => {
              const next = e.target.checked;
              setDraftAnchors(next);
              void updateSettings({ composeAnchorsEnabled: next }).catch(() => {
                // surfaced via the hook's error state
              });
            }}
            aria-label={t("messageDeliveryComposeAnchorsTitle")}
          />
        </SettingsItem>

        <SettingsItem
          label={t("messageDeliveryTurnTimestampsTitle")}
          description={t("messageDeliveryTurnTimestampsDescription")}
          doc="topics/compose-time-context-anchors.md#opt-in-turn-timestamps-turntimestamps--yep_turn_timestamps"
        >
          <select
            className="settings-select"
            value={shownTurnTimestamps}
            onChange={(event) => {
              const next = event.target.value as TurnTimestampsPlacement;
              if (!TURN_TIMESTAMPS_PLACEMENTS.includes(next)) return;
              setDraftTurnTimestamps(next);
              void updateSettings({ turnTimestamps: next }).catch(() => {
                // surfaced via the hook's error state
              });
            }}
            aria-label={t("messageDeliveryTurnTimestampsTitle")}
          >
            <option value="off">{t("messageDeliveryTurnTimestampsOff")}</option>
            <option value="before">
              {t("messageDeliveryTurnTimestampsBefore")}
            </option>
            <option value="after">
              {t("messageDeliveryTurnTimestampsAfter")}
            </option>
          </select>
        </SettingsItem>

        <SettingsItem
          as="label"
          label={t("sessionCreationBackgroundSettingTitle")}
          description={t("sessionCreationBackgroundSettingDescription")}
        >
          <input
            type="checkbox"
            checked={backgroundSessionCreation}
            onChange={(event) =>
              setBackgroundSessionCreation(event.target.checked)
            }
            aria-label={t("sessionCreationBackgroundSettingTitle")}
          />
        </SettingsItem>

        <SettingsItem
          as="label"
          label={t("questionAsideSettingTitle")}
          description={t("questionAsideSettingDescription")}
        >
          <input
            type="checkbox"
            checked={questionAsidesEnabled}
            onChange={(event) => setQuestionAsidesEnabled(event.target.checked)}
            aria-label={t("questionAsideSettingTitle")}
          />
        </SettingsItem>

        {
          <SettingsItem
            as="label"
            label={t("messageDeliveryBangCommandsTitle")}
            description={t("messageDeliveryBangCommandsDescription")}
          >
            <input
              type="checkbox"
              checked={shownBangCommands}
              onChange={(e) => {
                const next = e.target.checked;
                setDraftBangCommands(next);
                void updateSettings({
                  clientDefaults: { bangCommandsEnabled: next },
                }).catch(() => {
                  // surfaced via the hook's error state
                });
              }}
              aria-label={t("messageDeliveryBangCommandsTitle")}
            />
          </SettingsItem>
        }

        <SettingsItem
          as="label"
          label={t("messageDeliveryKeepMobileKeyboardOpenTitle")}
          description={t("messageDeliveryKeepMobileKeyboardOpenDescription")}
        >
          <input
            type="checkbox"
            checked={keepMobileKeyboardOpenAfterDelivery}
            onChange={(event) =>
              setKeepMobileKeyboardOpenAfterDelivery(event.target.checked)
            }
            aria-label={t("messageDeliveryKeepMobileKeyboardOpenTitle")}
          />
        </SettingsItem>

        <SettingsItem
          label={t("appearanceToolbarDefaultActionTitle")}
          description={t("appearanceToolbarDefaultActionDescription")}
          doc="site/src/content/docs/sessions-and-approvals.md#steer-queue-and-interrupt"
        >
          <select
            className="settings-select"
            value={shownBusyDefaultAction}
            onChange={(event) => {
              const next = event.target.value as BusyComposerDefaultAction;
              if (!BUSY_COMPOSER_DEFAULT_ACTIONS.includes(next)) return;
              setDraftBusyDefaultAction(next);
              void updateSettings({
                clientDefaults: { busyComposerDefaultAction: next },
              }).catch(() => {
                // surfaced via the hook's error state
              });
            }}
            aria-label={t("appearanceToolbarDefaultActionTitle")}
          >
            <option value="steer">
              {t("appearanceToolbarDefaultActionSteer")}
            </option>
            <option value="queue">
              {t("appearanceToolbarDefaultActionQueue")}
            </option>
          </select>
        </SettingsItem>

        <SettingsItem
          as="label"
          label={t("messageDeliverySteerNowDefaultTitle")}
          description={t("messageDeliverySteerNowDefaultDescription")}
          doc="topics/steer-queue-provider-differences.md#levels-of-soon-urgency-ladder-short-of-hard-interrupt"
        >
          <input
            type="checkbox"
            checked={shownSteerNowDefault}
            onChange={(e) => {
              const next = e.target.checked;
              setDraftSteerNow(next);
              void updateSettings({
                clientDefaults: { steerNowDefault: next },
              }).catch(() => {
                // surfaced via the hook's error state
              });
            }}
            aria-label={t("messageDeliverySteerNowDefaultTitle")}
          />
        </SettingsItem>

        {supportsProviderSteering && (
          <ProviderSteeringSettings
            value={settings?.steeringModes ?? {}}
            onChange={(steeringModes) => {
              void updateSettings({ steeringModes }).catch(() => {});
            }}
          />
        )}

        <SettingsItem
          as="label"
          label={t("messageDeliveryPatientQueueDefaultTitle")}
          description={t("messageDeliveryPatientQueueDefaultDescription")}
          descriptionLayout="full-width-on-narrow"
        >
          <input
            type="checkbox"
            checked={shownPatientQueueDefault}
            onChange={(e) => {
              const next = e.target.checked;
              setDraftPatientQueue(next);
              void updateSettings({
                clientDefaults: { patientQueueDefault: next },
              }).catch(() => {
                // surfaced via the hook's error state
              });
            }}
            aria-label={t("messageDeliveryPatientQueueDefaultTitle")}
          />
        </SettingsItem>

        {supportsTopicShift && (
          <>
            <PatientCompactThresholdItem
              label={t("messageDeliveryPatientQueueCompactTitle")}
              description={t("messageDeliveryPatientQueueCompactDescription")}
              storedPercent={
                settings?.clientDefaults?.patientQueueCompactAtPercent
              }
              onCommit={(percent) => {
                void updateSettings({
                  clientDefaults: { patientQueueCompactAtPercent: percent },
                }).catch(() => {
                  // surfaced via the hook's error state
                });
              }}
            />
            <PatientCompactThresholdItem
              label={t("messageDeliveryTopicShiftCompactTitle")}
              description={t("messageDeliveryTopicShiftCompactDescription")}
              storedPercent={
                settings?.clientDefaults?.topicShiftCompactAtPercent
              }
              onCommit={(percent) => {
                void updateSettings({
                  clientDefaults: { topicShiftCompactAtPercent: percent },
                }).catch(() => {
                  // surfaced via the hook's error state
                });
              }}
            />
          </>
        )}

        {
          <SettingsItem
            as="label"
            label={t("messageDeliveryProjectQueueShortcutTitle")}
            description={t("messageDeliveryProjectQueueShortcutDescription")}
          >
            <input
              type="checkbox"
              checked={shownProjectQueueCtrlEnter}
              onChange={(e) => {
                const next = e.target.checked;
                setDraftProjectQueueCtrlEnter(next);
                void updateSettings({
                  clientDefaults: { projectQueueCtrlEnterEnabled: next },
                }).catch(() => {
                  // surfaced via the hook's error state
                });
              }}
              aria-label={t("messageDeliveryProjectQueueShortcutTitle")}
            />
          </SettingsItem>
        }

        {error && <p className="settings-warning">{error}</p>}
      </div>
    </SettingsSection>
  );
}
