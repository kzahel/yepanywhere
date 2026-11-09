// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Checkbox, Radio } from "../Checkbox";
import { Field, Select, Textarea, TextInput } from "../Field";

afterEach(cleanup);

function describedBy(element: HTMLElement) {
  return (element.getAttribute("aria-describedby") ?? "")
    .split(" ")
    .filter(Boolean)
    .map((id) => document.getElementById(id)?.textContent ?? `#${id}`);
}

describe("Field", () => {
  it("names the control and links its hint and error", () => {
    const { rerender } = render(
      <Field label="Endpoint" hint="Where the gateway listens." required>
        <TextInput defaultValue="" />
      </Field>,
    );
    const input = screen.getByRole("textbox", {
      name: /Endpoint/,
    }) as HTMLInputElement;
    expect(input.required).toBe(true);
    expect(describedBy(input)).toEqual(["Where the gateway listens."]);
    expect(input.hasAttribute("aria-invalid")).toBe(false);

    rerender(
      <Field
        label="Endpoint"
        hint="Where the gateway listens."
        error="Not a URL."
        required
      >
        <TextInput defaultValue="" aria-describedby="extra" />
      </Field>,
    );
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(describedBy(input)).toEqual([
      "#extra",
      "Where the gateway listens.",
      "Not a URL.",
    ]);
  });

  it("keeps a caller id and names selects and textareas", () => {
    render(
      <>
        <Field label="Provider" id="provider">
          <Select defaultValue="b">
            <option value="a">A</option>
            <option value="b">B</option>
          </Select>
        </Field>
        <Field label="Notes">
          <Textarea />
        </Field>
      </>,
    );
    expect(screen.getByRole("combobox", { name: "Provider" }).id).toBe(
      "provider",
    );
    expect(screen.getByRole("textbox", { name: "Notes" }).tagName).toBe(
      "TEXTAREA",
    );
  });

  it("puts a unit after the box and the layout class on the wrapper", () => {
    const { container } = render(
      <TextInput
        aria-label="Height"
        type="number"
        unit="px"
        className="layout"
        defaultValue={4}
      />,
    );
    const input = screen.getByRole("spinbutton", { name: "Height" });
    const wrapper = container.firstElementChild as HTMLElement;
    expect(input.classList.contains("layout")).toBe(false);
    expect(wrapper.classList.contains("layout")).toBe(true);
    expect(wrapper.textContent).toBe("px");
  });
});

describe("Checkbox and Radio", () => {
  it("toggles from its label and describes itself", () => {
    const onCheckedChange = vi.fn();
    render(
      <Checkbox
        label="Archived"
        description="Older than a month."
        checked={false}
        onCheckedChange={onCheckedChange}
      />,
    );
    const box = screen.getByRole("checkbox", { name: "Archived" });
    expect(describedBy(box)).toEqual(["Older than a month."]);
    fireEvent.click(screen.getByText("Archived"));
    expect(onCheckedChange).toHaveBeenCalledWith(true, expect.anything());
  });

  it("shows a mixed state and keeps a caller ref", () => {
    const ref = { current: null as HTMLInputElement | null };
    render(
      <Checkbox
        aria-label="All"
        indeterminate
        checked={false}
        onCheckedChange={() => {}}
        ref={ref}
      />,
    );
    expect(ref.current?.indeterminate).toBe(true);
    expect(screen.getByRole("checkbox", { name: "All" })).toBe(ref.current);
  });

  it("groups radios by name", () => {
    const onCheckedChange = vi.fn();
    render(
      <>
        <Radio name="pick" label="One" checked onCheckedChange={() => {}} />
        <Radio
          name="pick"
          label="Two"
          checked={false}
          onCheckedChange={onCheckedChange}
        />
      </>,
    );
    fireEvent.click(screen.getByRole("radio", { name: "Two" }));
    expect(onCheckedChange).toHaveBeenCalledWith(true, expect.anything());
  });
});
