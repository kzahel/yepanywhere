import {
  ALL_PERMISSION_MODES,
  MAX_PATIENT_QUEUE_PATIENCE_SECONDS,
  isTurnEffort,
  type PermissionMode,
  type UserMessageMetadata,
} from "@yep-anywhere/shared";

export interface CreationInputSnapshot {
  schemaVersion: 1;
  automaticSource?: "project-queue";
  /** Server receipt identity only, never taken from composer metadata. */
  nativeReceiptId?: string;
  tempId?: string;
  mode?: PermissionMode;
  metadata?: UserMessageMetadata;
}

function text(value: unknown, limit: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > limit)
    throw new Error("Invalid saved input text");
  return value;
}
function timestamp(value: unknown): string | undefined {
  const result = text(value, 40);
  if (result !== undefined && !Number.isFinite(Date.parse(result)))
    throw new Error("Invalid saved input timestamp");
  return result;
}

/** Fresh-message choices only; actor/receipt/hidden-input authority stays separate. */
export function snapshotCreationInput(
  input: CreationInputSnapshot,
): CreationInputSnapshot {
  if (input?.schemaVersion !== 1)
    throw new Error("Invalid saved input version");
  const tempId = text(input.tempId, 256 * 1024);
  const result: CreationInputSnapshot = {
    schemaVersion: 1,
    ...(tempId !== undefined ? { tempId } : {}),
  };
  if (input.automaticSource !== undefined) {
    if (input.automaticSource !== "project-queue")
      throw new Error("Invalid saved automatic input source");
    result.automaticSource = input.automaticSource;
  }
  if (input.nativeReceiptId !== undefined) {
    if (
      typeof input.nativeReceiptId !== "string" ||
      !/^[A-Za-z0-9_-]{8,128}$/.test(input.nativeReceiptId)
    )
      throw new Error("Invalid saved native receipt identity");
    result.nativeReceiptId = input.nativeReceiptId;
  }
  if (input.mode !== undefined) {
    if (!ALL_PERMISSION_MODES.includes(input.mode))
      throw new Error("Invalid saved input mode");
    result.mode = input.mode;
  }
  if (input.metadata === undefined) return result;
  const m = input.metadata;
  if (!m || typeof m !== "object" || Array.isArray(m))
    throw new Error("Invalid saved input metadata");
  const metadata: UserMessageMetadata = {};
  if (m.origin !== undefined) {
    if (
      !["user", "coordination", "rendezvous", "automation"].includes(m.origin)
    )
      throw new Error("Invalid saved input origin");
    metadata.origin = m.origin;
  }
  if (m.deliveryIntent !== undefined) {
    if (!["direct", "steer", "deferred", "patient"].includes(m.deliveryIntent))
      throw new Error("Invalid saved input intent");
    metadata.deliveryIntent = m.deliveryIntent;
  }
  if (m.turnEffort !== undefined) {
    if (!isTurnEffort(m.turnEffort))
      throw new Error("Invalid saved input effort");
    metadata.turnEffort = m.turnEffort;
  }
  for (const key of ["sourceSessionId", "sourceReviewSubmissionId"] as const) {
    const value = text(m[key], 128);
    if (value !== undefined) {
      if (!/^[\w-]{1,128}$/.test(value))
        throw new Error("Invalid saved input source id");
      metadata[key] = value;
    }
  }
  if (m.clientTimestamp !== undefined) {
    if (
      typeof m.clientTimestamp !== "number" ||
      !Number.isFinite(m.clientTimestamp)
    )
      throw new Error("Invalid saved input client time");
    metadata.clientTimestamp = m.clientTimestamp;
  }
  if (m.serverReceivedAt !== undefined)
    metadata.serverReceivedAt = timestamp(m.serverReceivedAt);
  if (m.composition !== undefined) {
    if (
      !m.composition ||
      typeof m.composition !== "object" ||
      Array.isArray(m.composition)
    )
      throw new Error("Invalid saved input composition");
    metadata.composition = {};
    for (const key of [
      "typingStartedAt",
      "typingEndedAt",
      "lastEditedAt",
      "submittedAt",
    ] as const) {
      const value = timestamp(m.composition[key]);
      if (value !== undefined) metadata.composition[key] = value;
    }
  }
  if (m.speech !== undefined) {
    if (!m.speech || typeof m.speech !== "object" || Array.isArray(m.speech))
      throw new Error("Invalid saved input speech");
    metadata.speech = {};
    if (m.speech.clientTurnId !== undefined)
      metadata.speech.clientTurnId = text(m.speech.clientTurnId, 120);
    if (m.speech.transcriptionIds !== undefined) {
      if (
        !Array.isArray(m.speech.transcriptionIds) ||
        m.speech.transcriptionIds.length > 20
      )
        throw new Error("Invalid saved input transcriptions");
      metadata.speech.transcriptionIds = m.speech.transcriptionIds.map((id) => {
        if (typeof id !== "string")
          throw new Error("Invalid saved input transcription id");
        return text(id, 120)!;
      });
    }
  }
  if (m.patienceSeconds !== undefined) {
    if (
      !Number.isInteger(m.patienceSeconds) ||
      m.patienceSeconds < 0 ||
      m.patienceSeconds > MAX_PATIENT_QUEUE_PATIENCE_SECONDS
    )
      throw new Error("Invalid saved input patience");
    metadata.patienceSeconds = m.patienceSeconds;
  }
  if (m.compactAboveContextPercent !== undefined) {
    if (
      !Number.isInteger(m.compactAboveContextPercent) ||
      m.compactAboveContextPercent < 1 ||
      m.compactAboveContextPercent > 99
    )
      throw new Error("Invalid saved input compaction");
    metadata.compactAboveContextPercent = m.compactAboveContextPercent;
  }
  if (m.patientSource !== undefined) {
    if (
      m.patientSource !== "topic-shift" &&
      m.patientSource !== "patient-default"
    )
      throw new Error("Invalid saved input patient source");
    metadata.patientSource = m.patientSource;
  }
  if (m.steerNow !== undefined) {
    if (typeof m.steerNow !== "boolean")
      throw new Error("Invalid saved input steering");
    metadata.steerNow = m.steerNow;
  }
  return { ...result, metadata };
}
