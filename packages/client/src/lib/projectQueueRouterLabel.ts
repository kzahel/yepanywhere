import type { ProjectQueueTarget } from "@yep-anywhere/shared";
import type { MessageKey } from "../i18n";

type Translate = (
  key: MessageKey,
  vars?: Record<string, string | number>,
) => string;

/**
 * What a queued new session will run on when it names a router pool or
 * account; null for Direct. The pin is allocated when the item dispatches.
 */
export function projectQueueRouterLabel(
  target: ProjectQueueTarget,
  t: Translate,
): { label: string; title: string } | null {
  if (target.type !== "new-session") return null;
  if (target.routerPoolId)
    return {
      label: t("projectQueueRouterPool"),
      title: t("projectQueueRouterPoolTitle", { pool: target.routerPoolId }),
    };
  if (target.routerAccountId)
    return {
      label: t("projectQueueRouterAccount"),
      title: t("projectQueueRouterAccountTitle", {
        account: target.routerAccountId,
      }),
    };
  return null;
}
