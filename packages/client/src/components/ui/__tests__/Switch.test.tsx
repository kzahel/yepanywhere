// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { Switch } from "../Switch";

afterEach(cleanup);

function Controlled({ label }: { label?: string }) {
  const [checked, setChecked] = useState(false);
  return (
    <Switch
      label={label}
      aria-label={label ? undefined : "Live output"}
      checked={checked}
      onCheckedChange={setChecked}
    />
  );
}

describe("Switch", () => {
  it("is a named switch that reports its state", () => {
    render(<Controlled />);
    const control = screen.getByRole("switch", { name: "Live output" });
    expect(control).toHaveProperty("checked", false);
    fireEvent.click(control);
    expect(screen.getByRole("switch", { checked: true })).toBe(control);
  });

  it("toggles from its visible label", () => {
    render(<Controlled label="Notifications" />);
    fireEvent.click(screen.getByText("Notifications"));
    expect(
      screen.getByRole("switch", { name: "Notifications", checked: true }),
    ).toBeTruthy();
  });
});
