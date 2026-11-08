import { Link } from "react-router-dom";
import type { TranslationFn } from "../i18n";
import { CopyButton } from "./CopyButton";
import { buttonClassName, IconButton } from "./ui/Button";

/** Compact path-copy and provenance actions shared by source diff headers. */
export function SourceFileHeaderActions({
  path,
  lastEditorSessionHref,
  lastEditorSessionLabel,
  onBlameFile,
  blameTitle,
  blameActive = false,
  t,
}: {
  path: string;
  lastEditorSessionHref?: string;
  lastEditorSessionLabel?: string;
  onBlameFile?: (path: string) => void;
  blameTitle?: string;
  blameActive?: boolean;
  t: TranslationFn;
}) {
  return (
    <>
      <CopyButton value={path} title={t("sourceCopyPath")} icon="path" />
      {lastEditorSessionHref && (
        <Link
          to={lastEditorSessionHref}
          className={buttonClassName({
            variant: "ghost",
            size: "small",
            icon: true,
          })}
          title={lastEditorSessionLabel ?? t("sourceOpenLastEditorSession")}
          aria-label={
            lastEditorSessionLabel ?? t("sourceOpenLastEditorSession")
          }
        >
          <SessionLinkIcon />
        </Link>
      )}
      {onBlameFile && (
        <IconButton
          size="small"
          label={blameTitle ?? t("sourceBlameAtHead")}
          aria-pressed={blameActive}
          onClick={() => onBlameFile(path)}
        >
          <BlameIcon />
        </IconButton>
      )}
    </>
  );
}

function SessionLinkIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M5 17l-2 3v-4.5A7 7 0 0 1 2 12V8a6 6 0 0 1 6-6h5" />
      <path d="M14 5h7v7" />
      <path d="M21 5l-9 9" />
    </svg>
  );
}

function BlameIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 12a9 9 0 1 0 3-6.7" />
      <path d="M3 4v5h5" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}
