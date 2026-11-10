import { Badge } from "./Badge";

interface HiddenContentBadgeProps {
  count: number;
  className?: string;
  tooltip: string;
}

/** Compact cue and shared tail reveal for a preview that omits content. */
export function HiddenContentBadge({
  count,
  className,
  tooltip,
  ...attributes
}: HiddenContentBadgeProps) {
  return (
    <Badge
      {...attributes}
      shape="count"
      size="small"
      tooltip={tooltip}
      className={className}
    >
      +{count}
    </Badge>
  );
}
