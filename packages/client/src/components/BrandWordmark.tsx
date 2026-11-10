import brandStyles from "./BrandWordmark.module.css";
interface BrandWordmarkProps {
  className?: string;
  variant?: "short" | "full";
}

export function BrandWordmark({
  className = "",
  variant = "short",
}: BrandWordmarkProps) {
  if (variant === "full") {
    return (
      <span
        className={`${brandStyles.brandWordmark} ${brandStyles.brandWordmarkFull} ${className}`.trim()}
        data-brand-wordmark
        data-brand-wordmark--full
      >
        <span className={brandStyles.brandWordmarkYep} data-brand-wordmark__yep>
          yep
        </span>
        <span
          className={brandStyles.brandWordmarkAnywhere}
          data-brand-wordmark__anywhere
        >
          anywhere
        </span>
      </span>
    );
  }

  return (
    <span
      className={`${brandStyles.brandWordmark} ${brandStyles.brandWordmarkShort} ${className}`.trim()}
      data-brand-wordmark
      data-brand-wordmark--short
    >
      yep
    </span>
  );
}

export function isYepAnywhereBrandName(
  value: string | null | undefined,
): boolean {
  if (!value) return false;
  const normalized = value.toLowerCase().replace(/[\s_-]+/g, "");
  return normalized === "yepanywhere";
}
