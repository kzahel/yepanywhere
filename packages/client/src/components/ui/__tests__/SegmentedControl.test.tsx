// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SegmentedControl, type SegmentedOption } from "../SegmentedControl";

afterEach(cleanup);

const OPTIONS: SegmentedOption<string>[] = [
  { value: "small", label: "Small" },
  { value: "medium", label: "Medium", disabled: true },
  { value: "large", label: "Large" },
  { value: "huge", label: "Huge" },
];

function Controlled({ initial }: { initial: string | null }) {
  const [value, setValue] = useState(initial);
  return (
    <SegmentedControl
      aria-label="Font size"
      options={OPTIONS}
      value={value}
      onChange={setValue}
    />
  );
}

const radio = (name: string) => screen.getByRole("radio", { name });

describe("SegmentedControl", () => {
  it("is a named radio group with one tab stop on the selection", () => {
    render(<Controlled initial="large" />);
    expect(screen.getByRole("radiogroup", { name: "Font size" })).toBeTruthy();
    expect(radio("Large").getAttribute("aria-checked")).toBe("true");
    expect(radio("Small").getAttribute("aria-checked")).toBe("false");
    expect(
      screen
        .getAllByRole("radio")
        .filter((element) => element.tabIndex === 0)
        .map((element) => element.textContent),
    ).toEqual(["Large"]);
  });

  it("puts the tab stop on the first enabled option when nothing is selected", () => {
    render(<Controlled initial={null} />);
    expect(radio("Small").tabIndex).toBe(0);
    expect(radio("Large").tabIndex).toBe(-1);
  });

  it("selects on click", () => {
    const onChange = vi.fn();
    render(
      <SegmentedControl
        aria-label="Font size"
        options={OPTIONS}
        value="small"
        onChange={onChange}
      />,
    );
    fireEvent.click(radio("Huge"));
    expect(onChange).toHaveBeenCalledWith("huge");
    fireEvent.click(radio("Small"));
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("moves focus and selection with arrows, Home and End, skipping disabled options", () => {
    render(<Controlled initial="small" />);
    radio("Small").focus();
    fireEvent.keyDown(radio("Small"), { key: "ArrowRight" });
    expect(radio("Large").getAttribute("aria-checked")).toBe("true");
    expect(document.activeElement).toBe(radio("Large"));
    fireEvent.keyDown(radio("Large"), { key: "ArrowLeft" });
    expect(document.activeElement).toBe(radio("Small"));
    fireEvent.keyDown(radio("Small"), { key: "ArrowUp" });
    expect(document.activeElement).toBe(radio("Huge"));
    fireEvent.keyDown(radio("Huge"), { key: "Home" });
    expect(document.activeElement).toBe(radio("Small"));
    fireEvent.keyDown(radio("Small"), { key: "End" });
    expect(radio("Huge").getAttribute("aria-checked")).toBe("true");
  });

  it("accepts numeric values", () => {
    const onChange = vi.fn();
    render(
      <SegmentedControl
        aria-label="Tab size"
        options={[
          { value: 2, label: "2" },
          { value: 4, label: "4" },
        ]}
        value={2}
        onChange={onChange}
      />,
    );
    fireEvent.click(radio("4"));
    expect(onChange).toHaveBeenCalledWith(4);
  });
});
