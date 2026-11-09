import { Badge } from "../components/ui/Badge";
import type { TranslationFn } from "../i18n";

/** Count of pending review comments anchored to a commit or file row. */
export function SourceCommentCountBadge({
  count,
  t,
}: {
  count: number;
  t: TranslationFn;
}) {
  if (count <= 0) return null;
  return (
    <Badge
      shape="count"
      size="small"
      tone="success"
      emphasis="solid"
      role="img"
      aria-label={t("sourceCommentCount", { count })}
      tooltip={t("sourceCommentCount", { count })}
    >
      {count}
    </Badge>
  );
}
