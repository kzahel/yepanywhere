// @vitest-environment jsdom

import {
  EMPTY_USAGE_TOTALS,
  type UsageReport,
  type UsageTokenBucket,
  type UsageTotals,
} from "@yep-anywhere/shared";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { I18nProvider } from "../../../i18n";
import { UserUsageTable, formatTokenCount, formatUsd } from "../UserUsageTable";

/** Contract: topics/limited-users.md § Delivery v1 — Usage. */

const DAY_MS = 24 * 60 * 60 * 1000;
/** The superuser's row label and its breakdown table captions. */
const OWNER = "superuser";
const OWNER_BY_MODEL = `${OWNER} by model`;
const OWNER_BY_PROJECT = `${OWNER} by project`;

function bucket(overrides: Partial<UsageTokenBucket>): UsageTokenBucket {
  return {
    name: "opus",
    tokens: {
      freshInputTokens: 1000,
      cachedInputTokens: 9000,
      cacheWriteTokens: 0,
      outputTokens: 2000,
    },
    equivalentOutputTokens: 2400,
    costUsd: 0.06,
    ...overrides,
  };
}

function totals(overrides: Partial<UsageTotals> = {}): UsageTotals {
  return {
    ...EMPTY_USAGE_TOTALS,
    sessions: 8,
    turns: 141,
    words: 4913,
    activeMs: 4 * 60 * 60 * 1000 + 25 * 60 * 1000,
    tokens: {
      freshInputTokens: 1000,
      cachedInputTokens: 9000,
      cacheWriteTokens: 0,
      outputTokens: 2000,
    },
    byModel: [bucket({})],
    byProject: [bucket({ name: "yepanywhere", equivalentOutputTokens: null })],
    ...overrides,
  };
}

function report(overrides: Partial<UsageReport> = {}): UsageReport {
  const now = new Date("2026-09-21T12:00:00").getTime();
  return {
    now,
    since: now - 13 * DAY_MS,
    users: [{ username: null, total: totals(), lastWeek: totals() }],
    ...overrides,
  };
}

function renderTable(value: UsageReport) {
  return render(
    <I18nProvider>
      <UserUsageTable report={value} />
    </I18nProvider>,
  );
}

afterEach(cleanup);

/** The data cells of one row, found by table caption and row header. */
function rowCells(caption: string, rowHeader: string): string[] {
  const table = screen
    .getAllByRole("table")
    .find(
      (candidate) =>
        candidate.querySelector("caption")?.textContent === caption,
    );
  if (!table) throw new Error(`no table captioned ${caption}`);
  const row = [...table.querySelectorAll("tbody tr")].find(
    (candidate) => candidate.querySelector("th")?.textContent === rowHeader,
  );
  if (!row) throw new Error(`no row ${rowHeader} in ${caption}`);
  return [...row.querySelectorAll("td")].map((cell) => cell.textContent ?? "");
}

describe("UserUsageTable", () => {
  it("names the calendar days the ledger spans in the all-recorded window", () => {
    renderTable(report());
    expect(
      screen.getByRole("radio", { name: "All recorded (14 days)" }),
    ).toBeTruthy();
  });

  it("says 7 days rather than 'last week', which reads as a calendar week", () => {
    renderTable(report());
    expect(
      screen.getByRole("radio", { name: "Over last 7 days" }),
    ).toBeTruthy();
    expect(screen.queryByText("Last week")).toBeNull();
  });

  it("puts each total in its own column, one row per user", () => {
    renderTable(report());
    expect(rowCells("All recorded (14 days)", OWNER)).toEqual([
      "4h 25m",
      "8",
      "141",
      "4,913",
      "12.0k",
    ]);
  });

  it("switches every table to the chosen window", () => {
    const lastWeek = totals({ sessions: 2, turns: 30 });
    renderTable(
      report({
        users: [{ username: null, total: totals(), lastWeek }],
      }),
    );
    fireEvent.click(screen.getByRole("radio", { name: "Over last 7 days" }));
    expect(rowCells("Over last 7 days", OWNER).slice(1, 3)).toEqual([
      "2",
      "30",
    ]);
  });

  it("shows a model's output-token equivalent and dollars in columns", () => {
    renderTable(report());
    expect(rowCells(OWNER_BY_MODEL, "opus")).toEqual([
      "2,400",
      "$0.06",
      "12.0k",
    ]);
  });

  it("shows a served model id without the vendor name", () => {
    const served = totals({
      byModel: [bucket({ name: "claude-opus-5-5" })],
    });
    renderTable(
      report({ users: [{ username: null, total: served, lastWeek: served }] }),
    );
    expect(rowCells(OWNER_BY_MODEL, "opus-5-5")[0]).toBe("2,400");
  });

  it("marks a figure the report does not have instead of omitting it", () => {
    renderTable(report());
    expect(rowCells(OWNER_BY_PROJECT, "yepanywhere")).toEqual([
      "—",
      "$0.06",
      "12.0k",
    ]);
  });

  it("shows raw volume for a bucket with neither figure", () => {
    const unpriced = totals({
      byModel: [
        bucket({
          name: "qwen-local",
          equivalentOutputTokens: null,
          costUsd: null,
        }),
      ],
      byProject: [],
    });
    renderTable(
      report({
        users: [{ username: null, total: unpriced, lastWeek: unpriced }],
      }),
    );
    expect(rowCells(OWNER_BY_MODEL, "qwen-local")).toEqual(["—", "—", "12.0k"]);
  });

  it("omits every token line when nothing was charged", () => {
    const noTokens = totals({
      tokens: EMPTY_USAGE_TOTALS.tokens,
      byModel: [],
      byProject: [],
    });
    renderTable(
      report({
        users: [{ username: null, total: noTokens, lastWeek: noTokens }],
      }),
    );
    expect(screen.queryByText(/by model/)).toBeNull();
    expect(screen.queryByText(/by project/)).toBeNull();
    expect(rowCells("All recorded (14 days)", OWNER)[4]).toBe("—");
  });

  it("says nothing is recorded rather than reporting an empty span", () => {
    renderTable(report({ since: null, users: [] }));
    expect(screen.getByText(/Nothing recorded yet/)).toBeTruthy();
  });
});

describe("formatTokenCount", () => {
  it("is exact below ten thousand and abbreviated above", () => {
    expect(formatTokenCount(0)).toBe("0");
    expect(formatTokenCount(9999)).toBe("9,999");
    expect(formatTokenCount(12_345)).toBe("12.3k");
    expect(formatTokenCount(2_500_000)).toBe("2.5M");
  });
});

describe("formatUsd", () => {
  it("keeps two cheap sessions distinguishable and rounds large ones", () => {
    expect(formatUsd(0.004)).toBe("<$0.01");
    expect(formatUsd(0.06)).toBe("$0.06");
    expect(formatUsd(9.5)).toBe("$9.50");
    expect(formatUsd(1234.5)).toBe("$1235");
  });

  it("shows an exact zero as zero, not as under a cent", () => {
    expect(formatUsd(0)).toBe("$0.00");
  });
});
