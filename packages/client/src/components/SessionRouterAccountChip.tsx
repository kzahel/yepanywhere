import { useActingPrincipal } from "../hooks/useActingPrincipal";
import { useRouterDiscovery } from "../hooks/useRouterDiscovery";
import { useI18n } from "../i18n";
import {
  type RouterBinding,
  routedAccounts,
  routerBindingChip,
} from "./RouterPoolSelector";
import { ButtonBase } from "./ui/Button";

/** Header shortcut to the shared Account tab; it never switches accounts. */
export function SessionRouterAccountChip({
  binding,
  provider,
  canSwitch: serverCanSwitch,
  className,
  onDetails,
}: {
  binding: RouterBinding | undefined;
  provider: string | null;
  /** The server can switch, and this session could be routed. */
  canSwitch: boolean;
  className?: string;
  onDetails: () => void;
}) {
  const { t } = useI18n();
  // The switch route is owner-only; a limited user keeps the info shortcut.
  const { principal } = useActingPrincipal();
  const canSwitch = serverCanSwitch && principal.username === null;
  // A direct session offers the router only when one of its pools serves this
  // provider: a connected router with no such pool has nothing to move to.
  const discovery = useRouterDiscovery(provider, !binding && canSwitch);
  const routable = (discovery.data?.pools ?? []).some(
    (pool) =>
      pool.provider === provider &&
      routedAccounts(discovery.data, provider, pool.id).length > 0,
  );

  if (!binding && !(canSwitch && routable)) return null;
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
