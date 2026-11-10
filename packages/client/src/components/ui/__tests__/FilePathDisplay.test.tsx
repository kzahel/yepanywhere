import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FilePathDisplay } from "../FilePathDisplay";

describe("FilePathDisplay", () => {
  it("keeps the separator between directory and filename spans", () => {
    render(<FilePathDisplay displayPath="src/main.rs" />);

    const path = screen.getByTitle("src/main.rs");
    expect(path.textContent).toBe("src/main.rs");
    expect(
      path.querySelector("[data-file-path-display-dir]")?.textContent,
    ).toBe("src/");
    expect(path.querySelector(".file-path-display-name")?.textContent).toBe(
      "main.rs",
    );
  });
});
