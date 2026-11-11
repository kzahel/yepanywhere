import followStyles from "./MessageFollowButton.module.css";
import { useI18n } from "../i18n";
import { Button } from "./ui/Button";

/** Follow action shared by the composer portal and the public-share overlay. */
export function MessageFollowButton({
  newOutputBelow,
  elevated,
  onClick,
}: {
  newOutputBelow: boolean;
  elevated: boolean;
  onClick: () => void;
}) {
  const { t } = useI18n();
  const label = newOutputBelow
    ? t("sessionNewOutputBelow")
    : t("sessionFollow");
  const title = newOutputBelow
    ? t("sessionNewOutputBelowTitle")
    : t("sessionFollowLatestOutput");
  return (
    <Button
      size="small"
      elevated={elevated}
      className={`${followStyles.messageFollowToggle}${newOutputBelow ? ` ${followStyles["is-new-output"]}` : ""}`}
      onClick={onClick}
      aria-label={title}
      title={title}
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M12 5v14" />
        <path d="m19 12-7 7-7-7" />
      </svg>
      <span>{label}</span>
    </Button>
  );
}
