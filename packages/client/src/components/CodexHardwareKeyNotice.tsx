import type { ProviderRuntimeStatus } from "@yep-anywhere/shared";
import { Link } from "react-router-dom";
import { useCanAdministerHost } from "../hooks/useActingPrincipal";
import { useI18n } from "../i18n";
import { Banner } from "./ui/Banner";
import { buttonClassName } from "./ui/Button";

export function needsCodexHardwareKey(status: ProviderRuntimeStatus): boolean {
  return (
    status?.kind === "terminal" &&
    status.provider === "codex" &&
    /re-authenticate with your hardware key/i.test(status.message)
  );
}

export function CodexHardwareKeyNotice({
  basePath,
  className,
  routed,
}: {
  basePath: string;
  className?: string;
  routed: boolean;
}) {
  const { t } = useI18n();
  const canAdminister = useCanAdministerHost();
  const path = routed
    ? "/settings/providers"
    : "/provider-sign-in/codex?hardwareKey=1";
  return (
    <Banner
      className={className}
      tone="warning"
      role="alert"
      title={t("codexHardwareKeyActionNeeded")}
      actions={
        canAdminister && (
          <Link
            className={buttonClassName({ variant: "attention-outline" })}
            to={`${basePath}${path}`}
          >
            {t(
              routed
                ? "codexHardwareKeyRouterAction"
                : "codexHardwareKeyAction",
            )}
          </Link>
        )
      }
    >
      {t(
        !canAdminister
          ? "codexHardwareKeyAskOwner"
          : routed
            ? "codexHardwareKeyRouterHint"
            : "codexHardwareKeyHint",
      )}
    </Banner>
  );
}
