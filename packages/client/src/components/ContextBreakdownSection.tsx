import type {
  ContextBreakdown,
  ContextBreakdownCategory,
  ContextBreakdownItem,
} from "@yep-anywhere/shared";
import { useState } from "react";
import type { ContextBreakdownState } from "../hooks/useContextBreakdown";
import { useI18n } from "../i18n";
import styles from "./ContextBreakdownSection.module.css";
import { formatTokens } from "./ContextUsageIndicator";
import { ButtonBase } from "./ui/Button";

/** Item rows shown before the remainder collapses into "N more". */
const VISIBLE_ITEMS = 5;

const CATEGORY_LABEL_KEYS = {
  systemPrompt: "contextBreakdown_systemPrompt",
  systemTools: "contextBreakdown_systemTools",
  mcpTools: "contextBreakdown_mcpTools",
  agents: "contextBreakdown_agents",
  memoryFiles: "contextBreakdown_memoryFiles",
  skills: "contextBreakdown_skills",
  messages: "contextBreakdown_messages",
} as const;

/** YA's reader-facing name for a row; unrecognized rows keep the provider's. */
function categoryLabel(
  t: ReturnType<typeof useI18n>["t"],
  { key, name }: ContextBreakdownCategory,
): string {
  return key in CATEGORY_LABEL_KEYS
    ? t(CATEGORY_LABEL_KEYS[key as keyof typeof CATEGORY_LABEL_KEYS])
    : name;
}

function share(part: number, whole: number): string {
  if (whole <= 0) return "";
  const percent = (100 * part) / whole;
  return percent < 1 ? "<1%" : `${Math.round(percent)}%`;
}

function ItemRows({ items }: { items: ContextBreakdownItem[] }) {
  const { t } = useI18n();
  const visible =
    items.length > VISIBLE_ITEMS + 1 ? items.slice(0, VISIBLE_ITEMS) : items;
  const rest = items.slice(visible.length);
  return (
    <>
      {visible.map((item) => (
        <li className={styles.item} key={`${item.label}\0${item.detail}`}>
          <span className={styles.itemLabel} title={item.label}>
            {item.label}
          </span>
          {item.detail && (
            <span className={styles.itemDetail}>{item.detail}</span>
          )}
          <span className={styles.tokens}>{formatTokens(item.tokens)}</span>
        </li>
      ))}
      {rest.length > 0 && (
        <li className={styles.item}>
          <span className={styles.itemLabel}>
            {t("contextBreakdownMore", { count: String(rest.length) })}
          </span>
          <span className={styles.tokens}>
            {formatTokens(rest.reduce((sum, item) => sum + item.tokens, 0))}
          </span>
        </li>
      )}
    </>
  );
}

function CategoryRow({
  category,
  usedTokens,
}: {
  category: ContextBreakdownCategory;
  usedTokens: number;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const label = categoryLabel(t, category);
  const parts = category.messageParts;
  const expandable = !!category.items || !!parts;
  const head = (
    <>
      <span
        className={styles.caret}
        data-open={expandable ? open : undefined}
        aria-hidden="true"
      />
      <span
        className={styles.swatch}
        data-key={category.key}
        aria-hidden="true"
      />
      <span className={styles.label} title={category.name}>
        {label}
      </span>
      <span className={styles.tokens}>{formatTokens(category.tokens)}</span>
      <span className={styles.share}>{share(category.tokens, usedTokens)}</span>
    </>
  );
  return (
    <li>
      {expandable ? (
        <ButtonBase
          className={styles.head}
          aria-expanded={open}
          onClick={() => setOpen((current) => !current)}
        >
          {head}
        </ButtonBase>
      ) : (
        <div className={styles.head}>{head}</div>
      )}
      {open && (
        <ul className={styles.items}>
          {category.items && <ItemRows items={category.items} />}
          {parts && (
            <>
              <ItemRows
                items={[
                  {
                    label: t("contextBreakdownToolCalls"),
                    tokens: parts.toolCallTokens,
                  },
                  {
                    label: t("contextBreakdownToolResults"),
                    tokens: parts.toolResultTokens,
                  },
                  {
                    label: t("contextBreakdownAssistantText"),
                    tokens: parts.assistantTextTokens,
                  },
                  {
                    label: t("contextBreakdownUserText"),
                    tokens: parts.userTextTokens,
                  },
                ]}
              />
              <li className={styles.note}>{t("contextBreakdownPartsNote")}</li>
            </>
          )}
        </ul>
      )}
    </li>
  );
}

function Breakdown({ breakdown }: { breakdown: ContextBreakdown }) {
  const { t } = useI18n();
  const used = breakdown.categories.filter(({ kind }) => kind === "used");
  const usedTokens = used.reduce((sum, { tokens }) => sum + tokens, 0);
  const deferred = breakdown.categories.filter(
    ({ kind }) => kind === "deferred",
  );
  const reserve = breakdown.categories.find(({ kind }) => kind === "buffer");
  const free = breakdown.categories.find(({ kind }) => kind === "free");
  const percentOf = (tokens: number) =>
    breakdown.maxTokens > 0
      ? Math.min(100, (100 * tokens) / breakdown.maxTokens)
      : 0;

  return (
    <div className={styles.breakdown}>
      <div className="context-threshold-popover-title">
        {t("contextBreakdownTitle")}
      </div>
      <div className={styles.summary}>
        {t("contextBreakdownSummary", {
          used: formatTokens(breakdown.totalTokens),
          max: formatTokens(breakdown.maxTokens),
          percent: String(Math.round(percentOf(breakdown.totalTokens))),
        })}
        {free &&
          ` · ${t("contextBreakdownFree", { tokens: formatTokens(free.tokens) })}`}
      </div>
      <div
        className={styles.windowMeter}
        role="img"
        aria-label={t("contextBreakdownMeterAria", {
          used: formatTokens(breakdown.totalTokens),
          max: formatTokens(breakdown.maxTokens),
        })}
      >
        <span
          className={styles.windowUsed}
          style={{ width: `${percentOf(breakdown.totalTokens)}%` }}
        />
        {reserve && (
          <span
            className={styles.windowReserve}
            style={{ width: `${percentOf(reserve.tokens)}%` }}
          />
        )}
        {breakdown.autoCompactAtTokens !== undefined && (
          <span
            className={styles.compactMark}
            style={{ left: `${percentOf(breakdown.autoCompactAtTokens)}%` }}
          />
        )}
      </div>
      <div className={styles.caption}>{t("contextBreakdownComposition")}</div>
      <div className={styles.composition} aria-hidden="true">
        {used.map((category) => (
          <span
            key={category.name}
            data-key={category.key}
            style={{ flexGrow: category.tokens }}
          />
        ))}
      </div>
      <ul className={styles.categories}>
        {used.map((category) => (
          <CategoryRow
            key={category.name}
            category={category}
            usedTokens={usedTokens}
          />
        ))}
      </ul>
      {deferred.map((category) => (
        <div className={styles.aside} key={category.name}>
          {t("contextBreakdownDeferred", {
            label: categoryLabel(t, category),
            tokens: formatTokens(category.tokens),
          })}
        </div>
      ))}
      {reserve && (
        <div className={styles.aside}>
          {t("contextBreakdownReserve", {
            tokens: formatTokens(reserve.tokens),
          })}
        </div>
      )}
      {!reserve && breakdown.autoCompactAtTokens !== undefined && (
        <div className={styles.aside}>
          {t("contextBreakdownAutoCompact", {
            tokens: formatTokens(breakdown.autoCompactAtTokens),
          })}
        </div>
      )}
    </div>
  );
}

/**
 * The context-window section of the usage popover: what fills the window, by
 * category, from the live provider. Renders nothing when the provider has no
 * breakdown to give.
 */
export function ContextBreakdownSection({
  state,
}: {
  state: ContextBreakdownState;
}) {
  const { t } = useI18n();
  switch (state.status) {
    case "absent":
      return null;
    case "loading":
      return (
        <div className={styles.breakdown}>
          <div className="context-threshold-popover-title">
            {t("contextBreakdownTitle")}
          </div>
          <div className={styles.aside}>{t("contextBreakdownLoading")}</div>
        </div>
      );
    case "error":
      return (
        <div className={styles.breakdown}>
          <div className="context-threshold-popover-title">
            {t("contextBreakdownTitle")}
          </div>
          <div className={styles.aside}>
            {t("contextBreakdownError", { message: state.message })}
          </div>
        </div>
      );
    case "loaded":
      return <Breakdown breakdown={state.breakdown} />;
  }
}
