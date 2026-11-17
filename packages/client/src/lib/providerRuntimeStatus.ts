import type { useI18n } from "../i18n";
import { getProvider } from "../providers/registry";
import type { InboxProviderRuntimeStatus } from "../api/inbox";
import type { ProviderRuntimeStatus } from "../types";
import { parseTimestampMs } from "./messageAge";

type Translate = ReturnType<typeof useI18n>["t"];

export type ProviderRuntimeTone = "warn" | "danger";

export interface ProviderRuntimeDisplay {
  label: string;
  summary: string;
  retryAtMs: number | null;
  tone: ProviderRuntimeTone;
  title: string;
}

export function getProviderRuntimeReasonLabel(
  status: Pick<Exclude<ProviderRuntimeStatus, null>, "reason">,
  t: Translate,
): string {
  switch (status.reason) {
    case "rate_limit":
      return t("providerRuntimeReasonRateLimit");
    case "overloaded":
      return t("providerRuntimeReasonOverloaded");
    case "server_error":
      return t("providerRuntimeReasonServerError");
    case "network":
      return t("providerRuntimeReasonNetwork");
    case "unknown":
      return t("providerRuntimeReasonUnknown");
  }
}

function formatRetryClockTime(timestampMs: number): string {
  return new Date(timestampMs).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Accepts a full status or the inbox row summary, which omits diagnostics. */
export function describeProviderRuntimeStatus(
  status: ProviderRuntimeStatus | InboxProviderRuntimeStatus,
  t: Translate,
): ProviderRuntimeDisplay | null {
  if (!status) {
    return null;
  }

  const provider = getProvider(status.provider).displayName;
  const reason = getProviderRuntimeReasonLabel(status, t);
  const label =
    status.kind === "terminal"
      ? t("toolbarProviderRuntimeStopped", { provider })
      : status.reason === "rate_limit"
        ? t("toolbarProviderRuntimeRateLimited", { provider })
        : t("toolbarProviderRuntimeRetrying", { provider });
  const retryAtMs =
    status.kind === "retrying" ? parseTimestampMs(status.retryAt) : null;
  const summary =
    status.kind === "terminal"
      ? t("toolbarProviderRuntimeStoppedReason", { label, reason })
      : retryAtMs !== null
        ? t("toolbarProviderRuntimeRetryAt", {
            label,
            time: formatRetryClockTime(retryAtMs),
          })
        : label;
  const title = [
    summary,
    status.kind === "terminal"
      ? status.scope === "provider_process"
        ? t("providerRuntimeProcessTerminalTitle")
        : t("providerRuntimeTerminalTitle")
      : t("providerRuntimeRetryingTitle"),
    t("providerRuntimeReasonTitle", {
      reason,
    }),
    status.message ?? null,
    "details" in status ? (status.details ?? null) : null,
    status.kind === "retrying" && status.httpStatus !== undefined
      ? t("providerRuntimeHttpStatusTitle", { status: status.httpStatus })
      : null,
    status.kind === "retrying" && "lastSeenAt" in status
      ? t("providerRuntimeLastSeenTitle", { time: status.lastSeenAt })
      : null,
    status.kind === "terminal"
      ? t("providerRuntimeOccurredTitle", { time: status.occurredAt })
      : null,
    status.source
      ? t("providerRuntimeSourceTitle", { source: status.source })
      : null,
  ]
    .filter(Boolean)
    .join("\n");

  return {
    label,
    summary,
    retryAtMs,
    tone: status.kind === "terminal" ? "danger" : "warn",
    title,
  };
}
