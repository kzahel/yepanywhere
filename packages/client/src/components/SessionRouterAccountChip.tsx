import { useEffect, useState } from "react";
import { api } from "../api/client";
import { useActingPrincipal } from "../hooks/useActingPrincipal";
import { useI18n } from "../i18n";
import { type RouterBinding, routerBindingChip } from "./RouterPoolSelector";
import { ButtonBase } from "./ui/Button";

/** Header shortcut to the shared Account tab; it never switches accounts. */
export function SessionRouterAccountChip({
  binding,
  canSwitch: serverCanSwitch,
  className,
  onDetails,
}: {
  binding: RouterBinding | undefined;
  /** The server can switch, and this session could be routed. */
  canSwitch: boolean;
  className?: string;
  onDetails: () => void;
}) {
  const { t } = useI18n();
  // The switch route is owner-only; a limited user keeps the info shortcut.
  const { principal } = useActingPrincipal();
  const canSwitch = serverCanSwitch && principal.username === null;
  const [routerConnected, setRouterConnected] = useState(false);

  // A direct session shows the chip only while a router is connected.
  useEffect(() => {
    if (binding || !canSwitch) return;
    let live = true;
    api
      .routerStatus()
      .then((status) => {
        if (live) setRouterConnected(status.state === "connected");
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [binding, canSwitch]);

  if (!binding && !(canSwitch && routerConnected)) return null;
  const chip = binding
    ? routerBindingChip(t, binding, "routerChipTooltipOpen")
    : { label: t("routerSwitchDirect"), tooltip: t("routerSwitchDirectTitle") };

  return (
    <ButtonBase
      className={className}
      title={chip.tooltip}
      aria-label={chip.tooltip}
      onClick={onDetails}
    >
      {chip.label}
    </ButtonBase>
  );
}
