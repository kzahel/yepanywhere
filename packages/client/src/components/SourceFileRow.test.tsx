// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { UI_KEYS } from "../lib/storageKeys";
import {
  SourceFilePath,
  SourceFileRowButton,
  SourceFileStatusBadge,
  SourceReviewStateBadges,
} from "./SourceFileRow";

const t = (key: string) => key;

describe("SourceFileRow", () => {
  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it("puts the full native tooltip on the actual row target", () => {
    localStorage.setItem(UI_KEYS.tooltipMode, "native");
    render(
      <SourceFileRowButton path="src/a/very-long-file-name.ts">
        <SourceFilePath>src/a/very-long-file-name.ts</SourceFilePath>
      </SourceFileRowButton>,
    );

    const row = screen.getByRole("button");
    expect(row.getAttribute("title")).toBe("src/a/very-long-file-name.ts");
    expect(row.getAttribute("data-tooltip")).toBeNull();
  });

  it("puts the full themed tooltip on the actual row target", () => {
    localStorage.setItem(UI_KEYS.tooltipMode, "themed");
    render(
      <SourceFileRowButton path="src/a/very-long-file-name.ts">
        <SourceFilePath>src/a/very-long-file-name.ts</SourceFilePath>
      </SourceFileRowButton>,
    );

    const row = screen.getByRole("button");
    expect(row.getAttribute("data-tooltip")).toBe(
      "src/a/very-long-file-name.ts",
    );
    expect(row.getAttribute("title")).toBeNull();
  });

  it("highlights a case-insensitive path match while preserving full identity", () => {
    render(
      <SourceFilePath query="BOOTSTRAP">
        runs/aim/pii-handout-fresh7/bootstrap-v2.json
      </SourceFilePath>,
    );

    const path = document.querySelector(
      '[data-source-path="runs/aim/pii-handout-fresh7/bootstrap-v2.json"]',
    );
    if (!path) throw new Error("Highlighted source path is missing");
    expect(path.querySelector("mark")?.textContent).toBe("bootstrap");
    expect(path.textContent).toBe(
      "runs/aim/pii-handout-fresh7/bootstrap-v2.json",
    );
  });

  it("expands a compact git status code", () => {
    render(<SourceFileStatusBadge status="M" t={t} />);

    const badge = screen.getByRole("img", {
      name: "M — sourceFileStatusModified",
    });
    expect(badge.textContent).toBe("M");
    expect(badge.getAttribute("data-tooltip")).toBe(
      "M — sourceFileStatusModified",
    );
  });

  it("keeps review state and source change as separate badges", () => {
    render(
      <SourceReviewStateBadges
        states={[
          {
            siteId: "open-site",
            path: "src/a.ts",
            state: "open",
            changeStatus: "changed",
          },
          {
            siteId: "addressed-site",
            path: "src/a.ts",
            state: "addressed",
            changeStatus: "unchanged",
          },
        ]}
        t={t}
      />,
    );

    expect(screen.getByText("sourceReviewStateOpen 1")).toBeTruthy();
    expect(screen.getByText("sourceReviewSourceChanged 1")).toBeTruthy();
    expect(screen.queryByText("sourceReviewStateAddressed 1")).toBeNull();
    expect(screen.queryByText("sourceReviewSourceUnchanged 1")).toBeNull();
  });

  it("shows an unchanged site as addressed when an outcome exists", () => {
    render(
      <SourceReviewStateBadges
        states={[
          {
            siteId: "addressed-site",
            path: "src/a.ts",
            state: "addressed",
            changeStatus: "unchanged",
          },
        ]}
        t={t}
      />,
    );

    expect(screen.getByText("sourceReviewStateAddressed 1")).toBeTruthy();
    expect(screen.getByText("sourceReviewSourceUnchanged 1")).toBeTruthy();
  });
});
