import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ShikiHtml } from "../ShikiHtml";

const TWO_LINES =
  '<pre class="shiki"><code><span class="line">one</span>\n<span class="line">two</span></code></pre>';

describe("ShikiHtml", () => {
  it("renders its lines as layout, carrying source offsets when given the source", () => {
    const { container } = render(
      <ShikiHtml html={TWO_LINES} source={"one\ntwo"} className="surface" />,
    );

    const shell = container.firstElementChild;
    expect(shell?.hasAttribute("data-shiki-container")).toBe(true);
    expect(shell?.classList.contains("surface")).toBe(true);
    const code = container.querySelector("code");
    expect(
      Array.from(code?.childNodes ?? []).some(
        (node) => node.nodeType === Node.TEXT_NODE,
      ),
    ).toBe(false);
    const lines = container.querySelectorAll<HTMLElement>(".line");
    expect(lines[1]?.dataset.yaSourceStart).toBe("4");
    expect(lines[1]?.dataset.yaSourceEnd).toBe("7");
  });

  it("hands events inside the markup to the caller", () => {
    const onClick = vi.fn();
    const { container } = render(
      <ShikiHtml html={TWO_LINES} onClick={onClick} />,
    );

    const line = container.querySelector(".line");
    if (!line) throw new Error("line not rendered");
    fireEvent.click(line);

    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
