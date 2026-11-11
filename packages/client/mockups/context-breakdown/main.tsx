import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ContextUsageIndicator } from "../../src/components/ContextUsageIndicator";
import tokenStyles from "../../src/components/ContextUsagePopover.module.css";
import { I18nProvider } from "../../src/i18n";
import "../../src/styles/purposeGlobals";
import styles from "./Breakdown.module.css";

// Sample figures follow the user's /context screenshot (Sonnet 5, 1M window).
// Sub-rows mirror SDKContextUsage.memory_files / skills; the Conversation
// split is a proposed transcript-side estimate the SDK does not report.
const WINDOW = 1_000_000;
const BUFFER = 33_000;

interface Item {
  label: string;
  detail?: string;
  path?: boolean;
  tokens: number;
}

interface Category {
  key: string;
  label: string;
  sdkName: string;
  tokens: number;
  color: string;
  items?: Item[];
  itemsNote?: string;
}

const CATEGORIES: Category[] = [
  {
    key: "harness",
    label: "Harness prompt",
    sdkName: "System prompt",
    tokens: 4_900,
    color: "var(--text-dimmed)",
  },
  {
    key: "tools",
    label: "Tool definitions",
    sdkName: "System tools",
    tokens: 24_100,
    color: "var(--primary-color)",
  },
  {
    key: "instructions",
    label: "Instruction files",
    sdkName: "Memory files",
    tokens: 25_300,
    color: "var(--warning-color)",
    items: [
      {
        label: "~/.claude/CLAUDE.md",
        detail: "User",
        path: true,
        tokens: 24_700,
      },
      {
        label: "~/agents/CLAUDE.local.md",
        detail: "Local",
        path: true,
        tokens: 600,
      },
    ],
  },
  {
    key: "skills",
    label: "Skill index",
    sdkName: "Skills",
    tokens: 6_000,
    color: "var(--success-color)",
    items: [
      { label: "dataviz", detail: "plugin", tokens: 610 },
      { label: "code-review", detail: "built-in", tokens: 420 },
      { label: "anthropic-skills:docs", detail: "plugin", tokens: 400 },
      { label: "schedule", detail: "built-in", tokens: 250 },
      { label: "27 more", tokens: 4_320 },
    ],
  },
  {
    key: "conversation",
    label: "Conversation",
    sdkName: "Messages",
    tokens: 9_500,
    color: "var(--mock-conversation)",
    items: [
      { label: "Tool calls and results", tokens: 7_200 },
      { label: "Prose, both directions", tokens: 1_800 },
      { label: "Injected reminders", tokens: 500 },
    ],
    itemsNote: "Split estimated from the transcript",
  },
];

const USED = CATEGORIES.reduce((sum, c) => sum + c.tokens, 0);

function fmt(tokens: number): string {
  if (tokens >= 1_000_000) return `${+(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${+(tokens / 1_000).toFixed(1)}k`;
  return `${tokens}`;
}

function pct(part: number, whole: number): string {
  const p = (100 * part) / whole;
  return p < 1 ? "<1%" : `${Math.round(p)}%`;
}

function CategoryRow({
  category,
  open,
  onToggle,
}: {
  category: Category;
  open: boolean;
  onToggle: () => void;
}) {
  const expandable = !!category.items;
  const head = (
    <>
      <span
        className={styles.caret}
        data-expandable={expandable || undefined}
        data-open={open || undefined}
        aria-hidden="true"
      />
      <span
        className={styles.swatch}
        style={{ background: category.color }}
        aria-hidden="true"
      />
      <span className={styles.label} title={`SDK: ${category.sdkName}`}>
        {category.label}
      </span>
      <span className={styles.tokens}>{fmt(category.tokens)}</span>
      <span className={styles.share}>{pct(category.tokens, USED)}</span>
    </>
  );
  return (
    <li className={styles.category}>
      {expandable ? (
        <button
          type="button"
          className={styles.head}
          aria-expanded={open}
          onClick={onToggle}
        >
          {head}
        </button>
      ) : (
        <div className={styles.head}>{head}</div>
      )}
      {open && category.items && (
        <ul className={styles.items}>
          {category.items.map((item) => (
            <li className={styles.item} key={item.label}>
              <span
                className={item.path ? styles.itemPath : styles.itemLabel}
                title={item.label}
              >
                {item.label}
              </span>
              {item.detail && (
                <span className={styles.itemDetail}>{item.detail}</span>
              )}
              <span className={styles.tokens}>{fmt(item.tokens)}</span>
            </li>
          ))}
          {category.itemsNote && (
            <li className={styles.itemsNote}>≈ {category.itemsNote}</li>
          )}
        </ul>
      )}
    </li>
  );
}

function Breakdown({ initiallyOpen }: { initiallyOpen: string[] }) {
  const [open, setOpen] = useState<Set<string>>(new Set(initiallyOpen));
  const [exact, setExact] = useState(false);
  const toggle = (key: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const usedWidth = (100 * USED) / WINDOW;
  const bufferWidth = (100 * BUFFER) / WINDOW;

  return (
    <section className={styles.breakdown} aria-label="Context breakdown">
      <div className={styles.header}>
        <span className={tokenStyles.contextThresholdPopoverTitle}>
          Context window
        </span>
        <span className={styles.model}>Sonnet 5</span>
      </div>
      <div className={styles.summary}>
        <strong>{fmt(USED)}</strong> of {fmt(WINDOW)} · {pct(USED, WINDOW)} ·{" "}
        {fmt(WINDOW - USED - BUFFER)} free
      </div>
      <div
        className={styles.windowMeter}
        role="img"
        aria-label={`${fmt(USED)} used, ${fmt(BUFFER)} reserved for autocompact`}
      >
        <span
          className={styles.windowUsed}
          style={{ width: `${usedWidth}%` }}
        />
        <span
          className={styles.windowBuffer}
          style={{ width: `${bufferWidth}%` }}
        />
      </div>
      <div className={styles.compositionCaption}>What the used part holds</div>
      <div className={styles.composition} aria-hidden="true">
        {CATEGORIES.map((c) => (
          <span
            key={c.key}
            style={{ flexGrow: c.tokens, background: c.color }}
            title={`${c.label} ${fmt(c.tokens)}`}
          />
        ))}
      </div>
      <ul className={styles.categories}>
        {CATEGORIES.map((c) => (
          <CategoryRow
            key={c.key}
            category={c}
            open={open.has(c.key)}
            onToggle={() => toggle(c.key)}
          />
        ))}
      </ul>
      <div className={styles.reserve}>
        <span className={styles.hatch} aria-hidden="true" />
        Autocompact reserve {fmt(BUFFER)}
      </div>
      <div className={styles.footer}>
        <span>
          {exact ? "Exact count · just now" : "Estimated · last response"}
        </span>
        <button
          type="button"
          className={styles.exact}
          onClick={() => setExact(true)}
          disabled={exact}
        >
          {exact ? "Counted" : "Count exactly"}
        </button>
      </div>
    </section>
  );
}

function Unavailable() {
  return (
    <section className={styles.breakdown} aria-label="Context breakdown">
      <div className={styles.header}>
        <span className={tokenStyles.contextThresholdPopoverTitle}>
          Context window
        </span>
      </div>
      <div className={styles.unavailable}>
        Breakdown needs this session's Claude process running in YA. It appears
        after the next turn.
      </div>
    </section>
  );
}

function LastTurn() {
  return (
    <div className={tokenStyles.tokenUsage}>
      <div className={tokenStyles.contextThresholdPopoverTitle}>
        Last turn tokens
      </div>
      <dl className={tokenStyles.rows}>
        {[
          ["Context", "69,712"],
          ["Cache read", "68,904"],
          ["Cache write", "808"],
          ["Output", "1,215"],
        ].map(([k, v]) => (
          <div className={tokenStyles.row} key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

type View = "collapsed" | "expanded" | "unavailable";

function App() {
  const [view, setView] = useState<View>("collapsed");
  return (
    <div className={styles.page}>
      <nav className={styles.review} aria-label="Mockup state">
        <span>Mockup · context breakdown</span>
        {(["collapsed", "expanded", "unavailable"] as View[]).map((v) => (
          <button
            key={v}
            type="button"
            aria-pressed={view === v}
            onClick={() => setView(v)}
          >
            {v}
          </button>
        ))}
      </nav>
      <div className={styles.transcriptStub}>
        <p>… session transcript …</p>
      </div>
      <div className={styles.composer}>
        <div className={styles.composerInput}>Reply…</div>
        <div className={styles.toolbar}>
          <span className={styles.toolbarChip}>Sonnet 5</span>
          <span className={styles.anchor}>
            <ContextUsageIndicator
              usage={{
                inputTokens: USED,
                percentage: (100 * USED) / WINDOW,
                contextWindow: WINDOW,
              }}
            />
            <div
              className={`${tokenStyles.contextSubscriptionPopover} ${styles.popover}`}
              role="dialog"
              aria-label="Context usage"
            >
              {view === "unavailable" ? (
                <Unavailable />
              ) : (
                <Breakdown
                  key={view}
                  initiallyOpen={
                    view === "expanded" ? ["instructions", "conversation"] : []
                  }
                />
              )}
              <LastTurn />
              <button
                type="button"
                className="subscription-usage-compact-action"
              >
                Edit compact threshold…
              </button>
            </div>
          </span>
          <span className={styles.toolbarSpacer} />
          <span className={styles.toolbarChip}>Send</span>
        </div>
      </div>
    </div>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root");
createRoot(root).render(
  <I18nProvider>
    <App />
  </I18nProvider>,
);
