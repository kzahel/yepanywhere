import { useEffect, useRef, useState } from "react";
import type { TranslationFn } from "../i18n";
import { IconButton } from "./ui/Button";
import { TextInput } from "./ui/Field";

/**
 * Compact disclosure for filtering one commit/working-tree file corpus.
 * The field spends a full banner row only while the user is using it.
 */
export function ChangesetFileFilter({
  query,
  disabled = false,
  onQueryChange,
  t,
}: {
  query: string;
  disabled?: boolean;
  onQueryChange: (query: string) => void;
  t: TranslationFn;
}) {
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const toggle = () => {
    if (open) {
      onQueryChange("");
      setOpen(false);
      return;
    }
    setOpen(true);
  };

  return (
    <span className={`changeset-file-filter ${open ? "open" : ""}`}>
      <IconButton
        size="small"
        label={t("sourceFilterFiles")}
        aria-expanded={open}
        disabled={disabled}
        onClick={toggle}
      >
        <SearchIcon />
      </IconButton>
      {open && (
        <TextInput
          ref={inputRef}
          type="search"
          size="small"
          value={query}
          placeholder={t("sourceFilterFiles")}
          aria-label={t("sourceFilterFiles")}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            if (query) onQueryChange("");
            else setOpen(false);
          }}
          onChange={(event) => onQueryChange(event.target.value)}
        />
      )}
    </span>
  );
}

function SearchIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="m15.5 15.5 5 5" />
    </svg>
  );
}
