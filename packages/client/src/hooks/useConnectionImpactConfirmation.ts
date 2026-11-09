import { SERVER_CAPABILITIES, serverHasCapability } from "@yep-anywhere/shared";
import { useCallback } from "react";
import {
  type ConnectionImpactReason,
  type ConnectionImpactScope,
  runConfirmingConnectionImpact,
} from "../api/connectionImpact";
import { confirmDialog } from "../components/ui/ConfirmDialog";
import { useI18n } from "../i18n";
import { useVersion } from "./useVersion";

type Translate = ReturnType<typeof useI18n>["t"];

function describeReason(t: Translate, reason: ConnectionImpactReason): string {
  switch (reason.kind) {
    case "listener-closed":
      return t("connectionImpactListenerClosed", { listener: reason.listener });
    case "host-not-allowed":
      return t("connectionImpactHostNotAllowed", { host: reason.host });
    case "remote-session-ended":
      return t("connectionImpactRemoteSessionEnded");
    case "remote-access-off":
      return t("connectionImpactRemoteAccessOff");
    case "relay-disconnected":
      return t("connectionImpactRelayDisconnected");
  }
}

export function describeConnectionImpact(
  t: Translate,
  reasons: ConnectionImpactReason[],
): string {
  return [
    t("connectionImpactConfirmIntro"),
    ...reasons.map((reason) => `• ${describeReason(t, reason)}`),
    t("connectionImpactConfirmQuestion"),
  ].join("\n");
}

export interface ConnectionImpactRunOptions {
  /**
   * Whether this action can disconnect a client at all. Servers without the
   * capability apply such actions without asking, so the client asks first.
   */
  mayDisconnect: boolean;
  /** Shared by the requests of one user action, so it asks once. */
  scope?: ConnectionImpactScope;
}

/**
 * Run settings writes that a `connection-safe-settings` server may refuse as
 * disconnecting this client, asking the user before repeating them
 * (topics/connection-safe-settings.md).
 */
export function useConnectionImpactConfirmation() {
  const { t } = useI18n();
  const { version } = useVersion();
  const serverConfirms = serverHasCapability(
    version,
    SERVER_CAPABILITIES.connectionSafeSettings,
  );
  return useCallback(
    <T>(
      send: (confirmed: boolean) => Promise<T>,
      { mayDisconnect, scope }: ConnectionImpactRunOptions,
    ): Promise<T> => {
      const ask = (message: string) =>
        confirmDialog({
          title: t("connectionImpactConfirmTitle"),
          message,
          confirmLabel: t("connectionImpactConfirmAction"),
          tone: "danger",
        });
      return runConfirmingConnectionImpact(
        send,
        {
          serverConfirms,
          legacyQuestion: mayDisconnect
            ? t("connectionImpactLegacyConfirm")
            : null,
          confirmLegacy: ask,
          confirmReasons: (reasons) =>
            ask(describeConnectionImpact(t, reasons)),
        },
        scope,
      );
    },
    [serverConfirms, t],
  );
}
