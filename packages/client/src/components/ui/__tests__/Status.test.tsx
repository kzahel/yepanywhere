// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Banner } from "../Banner";
import { Spinner } from "../Spinner";
import { TabPanel, Tabs } from "../Tabs";

afterEach(cleanup);

const TABS = [
  { value: "a", label: "Alpha" },
  { value: "b", label: "Beta", disabled: true },
  { value: "c", label: "Gamma", count: 3 },
] as const;

function Strip({
  activation,
  onChange,
}: {
  activation?: "automatic" | "manual";
  onChange?: (value: string) => void;
}) {
  const [tab, setTab] = useState<string>("a");
  return (
    <>
      <Tabs
        id="t"
        aria-label="Views"
        activation={activation}
        tabs={TABS}
        value={tab}
        onChange={(value) => {
          onChange?.(value);
          setTab(value);
        }}
      />
      <TabPanel tabsId="t" value={tab}>
        Pane {tab}
      </TabPanel>
    </>
  );
}

describe("Tabs", () => {
  it("is one tab stop and links the selected tab to its panel", () => {
    render(<Strip />);
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((tab) => tab.tabIndex)).toEqual([0, -1, -1]);
    const panel = screen.getByRole("tabpanel", { name: "Alpha" });
    expect(tabs[0]?.getAttribute("aria-controls")).toBe(panel.id);
    expect(screen.getByRole("tab", { name: "Gamma 3" })).toBeTruthy();
  });

  it("selects with arrows, skipping disabled tabs and wrapping", () => {
    render(<Strip />);
    const alpha = screen.getByRole("tab", { name: "Alpha" });
    alpha.focus();
    fireEvent.keyDown(alpha, { key: "ArrowRight" });
    const gamma = screen.getByRole("tab", { name: /Gamma/ });
    expect(gamma.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(gamma);
    fireEvent.keyDown(gamma, { key: "ArrowRight" });
    expect(alpha.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(alpha, { key: "End" });
    expect(gamma.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tabpanel").textContent).toBe("Pane c");
  });

  it("moves focus only under manual activation", () => {
    const onChange = vi.fn();
    render(<Strip activation="manual" onChange={onChange} />);
    const alpha = screen.getByRole("tab", { name: "Alpha" });
    alpha.focus();
    fireEvent.keyDown(alpha, { key: "ArrowLeft" });
    const gamma = screen.getByRole("tab", { name: /Gamma/ });
    expect(document.activeElement).toBe(gamma);
    expect(gamma.tabIndex).toBe(0);
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(gamma);
    expect(onChange).toHaveBeenCalledWith("c");
  });
});

describe("Banner and Spinner", () => {
  it("announces errors as alerts and dismisses", () => {
    const onDismiss = vi.fn();
    render(
      <>
        <Banner tone="error" dismissLabel="Dismiss" onDismiss={onDismiss}>
          Failed
        </Banner>
        <Banner tone="info">Note</Banner>
        <Banner tone="warning" role="none">
          Quiet
        </Banner>
      </>,
    );
    expect(screen.getByRole("alert").textContent).toContain("Failed");
    expect(screen.getByRole("status").textContent).toBe("Note");
    expect(screen.queryAllByRole("status")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("is a named status only when labelled", () => {
    const { container } = render(
      <>
        <Spinner />
        <Spinner label="Loading files" />
      </>,
    );
    expect(screen.getByRole("status", { name: "Loading files" })).toBeTruthy();
    expect(container.querySelectorAll('[aria-hidden="true"]')).toHaveLength(1);
  });
});
