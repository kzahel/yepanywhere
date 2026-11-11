// @vitest-environment jsdom

import type { BangCommandTranscriptDisplayObject } from "@yep-anywhere/shared";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import { BangCommandDisplayObject } from "../BangCommandDisplayObject";
import styles from "../BangCommandDisplayObject.module.css";

const object: BangCommandTranscriptDisplayObject = {
  id: "bang-1",
  kind: "bang-command",
  createdAt: "2026-07-24T00:00:00.000Z",
  placementAfterMessageId: "",
  command: "git status",
  cwd: "/project",
  status: "done",
  exitCode: 0,
  stdoutPreview: "preview",
};

function requiredModuleClass(value: string | undefined): string {
  if (value === undefined) {
    throw new Error("Expected CSS Module class export");
  }
  return value;
}

describe("BangCommandDisplayObject", () => {
  afterEach(cleanup);

  it("automatically expands a newly noticed completed run and its stderr", async () => {
    const fetchOutput = vi.fn(async () => ({
      stdout: "complete output",
      stderr: "cannot rebase: You have unstaged changes.",
      stdoutHtml: "<p>complete output</p>",
      mode: "markdown" as const,
      responseTruncated: false,
    }));
    render(
      <I18nProvider>
        <BangCommandDisplayObject
          object={{
            ...object,
            exitCode: 1,
            stderrPreview: "cannot rebase: You have unstaged changes.",
          }}
          handlers={{ fetchOutput, shouldExpandOutput: () => true }}
        />
      </I18nProvider>,
    );
    expect(
      screen
        .getByText("cannot rebase: You have unstaged changes.")
        .closest("details")?.open,
    ).toBe(true);
    await waitFor(() => expect(fetchOutput).toHaveBeenCalledWith("bang-1"));
    await waitFor(() =>
      expect(screen.getByText("complete output")).toBeTruthy(),
    );
  });

  it("does not fetch full output until the user asks for it", async () => {
    const fetchOutput = vi.fn(async () => ({
      stdout: "full output",
      stderr: "",
      stdoutHtml: "<p>full output</p>",
      mode: "markdown" as const,
      responseTruncated: false,
    }));

    const result = render(
      <I18nProvider>
        <BangCommandDisplayObject object={object} handlers={{ fetchOutput }} />
      </I18nProvider>,
    );

    expect(fetchOutput).not.toHaveBeenCalled();
    expect(result.container.textContent).toContain("preview");

    fireEvent.click(screen.getByRole("button", { name: "Load output" }));
    await waitFor(() => expect(fetchOutput).toHaveBeenCalledWith("bang-1"));
    await waitFor(() =>
      expect(result.container.textContent).toContain("full output"),
    );
  });

  it("uses module classes for the finite status variants", () => {
    const { rerender } = render(
      <I18nProvider>
        <BangCommandDisplayObject object={object} />
      </I18nProvider>,
    );

    const rootClass = requiredModuleClass(styles.root);
    const errorClass = requiredModuleClass(styles.error);
    const killedClass = requiredModuleClass(styles.killed);
    const statuses: Array<{
      status: BangCommandTranscriptDisplayObject["status"];
      modifier?: string;
      error?: string;
    }> = [
      { status: "running" },
      { status: "done" },
      { status: "error", modifier: errorClass, error: "failed" },
      { status: "killed", modifier: killedClass, error: "interrupted" },
    ];

    for (const { status, modifier, error } of statuses) {
      rerender(
        <I18nProvider>
          <BangCommandDisplayObject object={{ ...object, status, error }} />
        </I18nProvider>,
      );
      const root = screen.getByRole("group", { name: "Local command run" });
      expect(root.classList.contains(rootClass)).toBe(true);

      if (modifier) {
        expect(root.classList.contains(modifier)).toBe(true);
      } else {
        expect(root.classList.contains(errorClass)).toBe(false);
        expect(root.classList.contains(killedClass)).toBe(false);
      }
    }

    const alert = screen.getByRole("alert");
    expect(alert.classList.contains(errorClass)).toBe(true);
  });
});
