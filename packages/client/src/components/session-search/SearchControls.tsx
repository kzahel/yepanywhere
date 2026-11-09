import {
  startTransition,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useI18n } from "../../i18n";
import {
  statuses,
  type SearchField,
  type SearchStatus,
  type TimeBasis,
} from "./model";
import { Button, ButtonBase, IconButton } from "../ui/Button";
import { SegmentedControl } from "../ui/SegmentedControl";
import styles from "./SessionSearch.module.css";

export function CheckIcon({ size = 18 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m4 12 5 5L20 5" />
    </svg>
  );
}
export function SearchHeader({
  query,
  onQuery,
  fields,
  onFields,
  supported,
  supportKnown = true,
  status,
  sessionCount,
  scanning,
  acquiring,
  intersection,
  onIntersection,
}: {
  query: string;
  onQuery(value: string): void;
  fields: SearchField[];
  onFields(value: SearchField[]): void;
  supported: boolean;
  /**
   * Whether the capability read behind `supported` has resolved. While it has
   * not, `supported` is merely "not yet known", so a C-s/C-r press is held
   * rather than dropped: see the pending-field effect below.
   */
  supportKnown?: boolean;
  status?: string;
  sessionCount: number;
  scanning: boolean;
  acquiring: boolean;
  intersection?: boolean;
  onIntersection?(value: boolean): void;
}) {
  const { t } = useI18n();
  const input = useRef<HTMLInputElement>(null);
  const statusArea = useRef<HTMLDivElement>(null);
  const pendingField = useRef<SearchField | null>(null);
  const [statusOpen, setStatusOpen] = useState(false);
  useEffect(() => {
    if (!status) setStatusOpen(false);
  }, [status]);
  useEffect(() => {
    if (!statusOpen) return;
    const close = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !statusArea.current?.contains(event.target)
      )
        setStatusOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [statusOpen]);
  // Router navigation is deferred work; it must never own keyboard echo.
  const [draft, setDraft] = useState(query);
  const draftValue = useRef(query);
  const pendingQueries = useRef<string[]>([]);
  const editQuery = useCallback(
    (value: string) => {
      draftValue.current = value;
      setDraft(value);
      pendingQueries.current.push(value);
      startTransition(() => onQuery(value));
    },
    [onQuery],
  );
  useEffect(() => {
    const acknowledged = pendingQueries.current.lastIndexOf(query);
    if (acknowledged >= 0) {
      pendingQueries.current.splice(0, acknowledged + 1);
      if (pendingQueries.current.length) return;
    } else {
      // A URL change that we did not send (e.g. Back) replaces the draft.
      pendingQueries.current = [];
    }
    draftValue.current = query;
    setDraft(query);
  }, [query]);
  useEffect(() => {
    const desktop = matchMedia("(min-width: 701px)");
    const focus = () => {
      if (
        desktop.matches &&
        !document.querySelector('[role="dialog"],dialog[open]')
      )
        input.current?.focus({ preventScroll: true });
    };
    focus();
  }, []);
  useEffect(() => {
    const editable =
      'input:not([type="checkbox"]):not([type="radio"]),textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"],[role="combobox"],[role="menu"],[role="dialog"]';
    // Space presses whatever control has focus, so that key stays with the
    // control: capturing it means Tab to a field checkbox or status filter and
    // press Space toggles nothing and lands a space in the needle. Characters
    // the control ignores remain needle input, so clicking a filter and
    // continuing to type still reaches the search.
    const pressable =
      'button,summary,a[href],input[type="checkbox"],input[type="radio"],[role="button"],[role="checkbox"],[role="radio"],[role="switch"],[role="tab"],[role="menuitem"],[role="option"],[tabindex]:not([tabindex="-1"])';
    const type = (event: KeyboardEvent) => {
      const search = input.current;
      const target = event.target instanceof Element ? event.target : null;
      if (
        !search ||
        document.activeElement === search ||
        event.defaultPrevented ||
        event.isComposing ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        !matchMedia("(min-width: 701px)").matches ||
        document.querySelector('[role="dialog"],dialog[open]') ||
        target?.closest(editable) ||
        (event.key === " " && target?.closest(pressable))
      )
        return;
      const printable = [...event.key].length === 1;
      if (!printable && event.key !== "Backspace" && event.key !== "Delete")
        return;
      event.preventDefault();
      search.focus({ preventScroll: true });
      search.setSelectionRange(search.value.length, search.value.length);
      const value = draftValue.current;
      editQuery(
        printable
          ? value.length + event.key.length <= 512
            ? value + event.key
            : value
          : event.key === "Backspace"
            ? [...value].slice(0, -1).join("")
            : value,
      );
    };
    document.addEventListener("keydown", type);
    return () => document.removeEventListener("keydown", type);
  }, [editQuery]);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (
        !event.ctrlKey ||
        event.altKey ||
        event.metaKey ||
        !["s", "r"].includes(event.key.toLowerCase())
      )
        return;
      event.preventDefault();
      const field = event.key.toLowerCase() === "s" ? "assistant" : "user";
      // The capability read that decides `supported` is a fetch, so a press
      // landing in the first moments of the page would otherwise vanish: the
      // field checkboxes are still disabled and this handler had nothing to
      // apply. Hold it instead, and apply it when the answer arrives.
      if (supported) onFields([field]);
      else if (!supportKnown) pendingField.current = field;
      input.current?.focus();
    };
    document.addEventListener("keydown", keydown);
    return () => document.removeEventListener("keydown", keydown);
  }, [onFields, supported, supportKnown]);
  useEffect(() => {
    const field = pendingField.current;
    if (!field || !supportKnown) return;
    pendingField.current = null;
    // A read that resolved to "unsupported" answers the held press: there is
    // no content search to turn on, so it is discarded rather than queued.
    if (supported) onFields([field]);
  }, [onFields, supported, supportKnown]);
  return (
    <div className={styles.header}>
      <div className={styles.fields}>
        <span className={styles.searchIn}>{t("sessionSearchIn")}</span>
        {(["title", "assistant", "user"] as const).map((field) => (
          <label
            key={field}
            title={
              field !== "title" && !supported
                ? t("sessionSearchUpgrade")
                : field === "title"
                  ? t("sessionSearchTitleHelp")
                  : undefined
            }
          >
            <input
              type="checkbox"
              checked={fields.includes(field)}
              disabled={field !== "title" && !supported}
              onChange={(e) => {
                const next = e.target.checked
                  ? [...fields, field]
                  : fields.filter((f) => f !== field);
                onFields(field !== "title" && !next.length ? ["title"] : next);
              }}
            />
            {t(`sessionSearchField_${field}`)}
            {field !== "title" && (
              <kbd>{field === "assistant" ? "C-s" : "C-r"}</kbd>
            )}
          </label>
        ))}
        {onIntersection && (
          <label
            className={styles.intersection}
            title={t("sessionSearchIntersectionHelp")}
          >
            <input
              type="checkbox"
              checked={intersection}
              onChange={(event) => onIntersection(event.target.checked)}
            />
            {t("sessionSearchIntersection")}
          </label>
        )}
      </div>
      <div className={styles.needleRow}>
        <input
          ref={input}
          className={styles.search}
          type="search"
          value={draft}
          maxLength={512}
          onChange={(e) => editQuery(e.target.value)}
          placeholder={t("globalSessionsSearchPlaceholder")}
          aria-label={t("globalSessionsSearchPlaceholder")}
        />
        <div ref={statusArea} className={styles.statusArea}>
          <ButtonBase
            className={styles.searchStatus}
            disabled={!status}
            title={status}
            aria-label={status || t("sessionSearchStatus")}
            aria-expanded={statusOpen}
            data-search-scanning={scanning}
            onClick={() => setStatusOpen((open) => !open)}
          >
            <span data-search-scope>
              {t("sessionSearchScope", { count: sessionCount })}
            </span>
            <span
              className={styles.scanIndicator}
              style={{ visibility: acquiring ? "visible" : "hidden" }}
              aria-hidden="true"
            >
              …
            </span>
          </ButtonBase>
          {statusOpen && <div className={styles.statusDetails}>{status}</div>}
        </div>
      </div>
    </div>
  );
}

function RangeField({
  value,
  onChange,
  label,
  placeholder,
}: {
  value: string;
  onChange(value: string): void;
  label: string;
  placeholder: string;
}) {
  const { t } = useI18n();
  const [reservation, setReservation] = useState(3);
  return (
    <span className={styles.ageField}>
      <span aria-hidden="true">
        {(value || placeholder).padEnd(reservation, "0")}
      </span>
      <input
        aria-label={label}
        title={t("sessionSearchAgeHelp")}
        placeholder={placeholder}
        value={value}
        maxLength={20}
        onChange={(e) => {
          const value = e.target.value;
          if (value.length >= reservation)
            setReservation(Math.ceil((value.length + 1) / 2) * 2);
          onChange(value);
        }}
      />
    </span>
  );
}

export function SearchFilters({
  basis,
  onBasis,
  young,
  old,
  onYoung,
  onOld,
  limit,
  onLimit,
  showLimit,
  children,
}: {
  basis: TimeBasis;
  onBasis(value: TimeBasis): void;
  young: string;
  old: string;
  onYoung(value: string): void;
  onOld(value: string): void;
  limit: string;
  onLimit(value: string): void;
  showLimit: boolean;
  children: ReactNode;
}) {
  const { t } = useI18n();
  return (
    <div className={styles.filterRow}>
      <div className={styles.range}>
        <SegmentedControl
          size="small"
          aria-label={t("sessionSearchTimeBasis")}
          options={(["activity", "turns", "created"] as const).map((value) => ({
            value,
            label: t(`sessionSearchTime_${value}`),
            tooltip: t(`sessionSearchTimeHelp_${value}`),
          }))}
          value={basis}
          onChange={onBasis}
        />
        <div className={styles.age}>
          <RangeField
            label={t("sessionSearchFrom")}
            placeholder="0d"
            value={young}
            onChange={onYoung}
          />
          <span>–</span>
          <RangeField
            label={t("sessionSearchTo")}
            placeholder="∞d"
            value={old}
            onChange={onOld}
          />
        </div>
        <div className={styles.quickAge}>
          {[1, 7, 30].map((days) => (
            <Button
              key={days}
              size="small"
              title={t("sessionSearchRecentHelp", { days })}
              onClick={() => {
                onBasis("activity");
                onYoung("");
                onOld(`${days}d`);
              }}
            >
              {days}d
            </Button>
          ))}
          <Button
            size="small"
            onClick={() => {
              onYoung("");
              onOld("");
            }}
          >
            {t("sessionSearchAnyAge")}
          </Button>
        </div>
      </div>
      <div className={styles.filters}>
        {children}
        {showLimit && (
          <label className={styles.limit} title={t("sessionSearchLimitHelp")}>
            {t("sessionSearchLimit")}
            <input
              inputMode="numeric"
              placeholder="∞"
              value={limit}
              onChange={(e) => onLimit(e.target.value)}
              aria-label={t("sessionSearchLimit")}
            />
          </label>
        )}
      </div>
    </div>
  );
}

function StatusIcon({ status }: { status: SearchStatus }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill={status === "starred" ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {status === "archived" || status === "unarchived" ? (
        <>
          <rect x="3" y="4" width="18" height="4" rx="1" />
          <path d="M5 8v12h14V8M10 12h4" />
          {status === "unarchived" && <path d="m3 21 18-18" />}
        </>
      ) : status === "starred" || status === "unstarred" ? (
        <path d="m12 2 3 6 7 1-5 5 1 7-6-3-6 3 1-7-5-5 7-1Z" />
      ) : (
        <>
          <rect x="3" y="5" width="18" height="14" rx="2" />
          <path d="m3 7 9 6 9-6" />
          {status === "read" && <path d="m8 16 3 3 6-6" />}
        </>
      )}
    </svg>
  );
}

function SelectAllIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="9 11 12 14 22 4" />
      <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
    </svg>
  );
}

function SelectionCancel({ size = 20 }: { size?: number }) {
  return (
    <svg
      className={styles.selectionCancelIcon}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.8"
      aria-hidden="true"
    >
      <path d="m5 5 14 14M19 5 5 19" />
    </svg>
  );
}

export function SearchHelp() {
  const { t } = useI18n();
  return (
    <p className={styles.help}>
      <span role="img" aria-label={t("sessionSearchHelpCount")}>
        <CheckIcon size={14} />
      </span>{" "}
      {t("sessionSearchHelp")}{" "}
      <span role="img" aria-label={t("sessionSearchHelpCancel")}>
        <SelectionCancel size={14} />
      </span>
      {t("sessionSearchHelpClear")}
    </p>
  );
}

export function SearchSelection({
  count,
  shown,
  allShownSelected,
  filters,
  onToggle,
  onSelectShown,
  onClear,
  onlySelected,
  onOnlySelected,
  onManage,
  pending,
  helpInline,
  onHelpInline,
}: {
  count: number;
  shown: number;
  allShownSelected: boolean;
  filters: SearchStatus[];
  onToggle(status: SearchStatus): void;
  onSelectShown(): void;
  onClear(): void;
  onlySelected: boolean;
  onOnlySelected(value: boolean): void;
  onManage(): void;
  pending: boolean;
  helpInline: boolean;
  onHelpInline(value: boolean): void;
}) {
  const { t } = useI18n();
  const help = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const slot = help.current;
    const row = slot?.parentElement;
    const text = slot?.firstElementChild;
    if (!slot || !row || !text) return;
    let reported: boolean | undefined;
    const measure = () => {
      const preceding = slot.previousElementSibling;
      if (!(preceding instanceof HTMLElement)) return;
      const left = preceding.offsetLeft + preceding.offsetWidth + 12;
      slot.style.left = `${left}px`;
      slot.style.top = `${preceding.offsetTop + preceding.offsetHeight / 2}px`;
      const inline = row.clientWidth - left >= text.scrollWidth;
      if (inline !== reported) {
        reported = inline;
        onHelpInline(inline);
      }
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(row);
    for (const child of row.children)
      if (child !== slot) observer.observe(child);
    observer.observe(text);
    const children = new MutationObserver(measure);
    children.observe(row, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    return () => {
      observer.disconnect();
      children.disconnect();
    };
  }, [onHelpInline]);
  return (
    <div className={styles.scope}>
      <div className={styles.selectionInfo}>
        <ButtonBase
          className={styles.selectionCount}
          title={t("sessionSearchSelectionHelp", { count })}
          onClick={onManage}
        >
          <CheckIcon />
          {count}
        </ButtonBase>
        <Button
          size="small"
          onClick={onSelectShown}
          disabled={!shown || allShownSelected || pending}
          title={t("sessionSearchSelectShownTitle", { count: shown })}
        >
          <SelectAllIcon />
          <span>{t("sessionSearchSelectShown", { count: shown })}</span>
        </Button>
        <Button
          variant="ghost"
          size="small"
          aria-pressed={onlySelected}
          onClick={() => onOnlySelected(!onlySelected)}
          title={t("sessionSearchOnlySelectedTitle")}
        >
          {t("sessionSearchOnlySelected")}
        </Button>
        {count > 0 && (
          <IconButton
            size="small"
            label={t("sessionSearchClear", { count })}
            onClick={onClear}
            disabled={pending}
          >
            <SelectionCancel />
          </IconButton>
        )}
      </div>
      <div className={styles.statusFilters}>
        <span>{t("sessionSearchFilter")}</span>
        {statuses.map((status) => (
          <IconButton
            key={status}
            size="small"
            aria-pressed={filters.includes(status)}
            label={t("sessionSearchStatusFilter", {
              status: t(`sessionSearchStatus_${status}`),
            })}
            onClick={() => onToggle(status)}
          >
            <StatusIcon status={status} />
          </IconButton>
        ))}
      </div>
      <div
        ref={help}
        className={styles.helpSlot}
        style={{ visibility: helpInline ? "visible" : "hidden" }}
        aria-hidden={!helpInline}
      >
        <SearchHelp />
      </div>
    </div>
  );
}
