// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createClientSlashCommand } from "../../lib/slashCommands";
import { SlashCommandButton } from "../SlashCommandButton";

vi.mock("../../i18n", () => ({
  useI18n: () => ({
    t: (key: string) =>
      (
        ({
          slashCommandsLabel: "Commands and skills",
          slashCommandsShow: "Show commands and skills",
        }) satisfies Record<string, string>
      )[key] ?? key,
  }),
}));

describe("SlashCommandButton", () => {
  afterEach(() => {
    cleanup();
  });

  it("shows documented slash command words with bold shortcuts", () => {
    render(
      <SlashCommandButton
        commands={["fast", "run", "goal", "compact", "model"].map(
          createClientSlashCommand,
        )}
        onSelectCommand={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByLabelText("Show commands and skills"));

    expect(screen.getByRole("menuitem", { name: "/model" }).textContent).toBe(
      "/model",
    );
    expect(
      screen.getByRole("menuitem", { name: "/fast turn" }).textContent,
    ).toBe("/fast turn");
    expect(
      screen.getByRole("menuitem", { name: "/run exactly" }).textContent,
    ).toContain("/run exactly");
    expect(
      screen.getByRole("menuitem", { name: "/run exactly" }).textContent,
    ).toContain("Direct local shell: !!cmd");
    expect(screen.getByRole("menuitem", { name: "/goal" }).textContent).toBe(
      "/goal",
    );
    expect(screen.getByRole("menuitem", { name: "/compact" }).textContent).toBe(
      "/compact",
    );

    const shortcuts = Array.from(
      document.querySelectorAll("[data-slash-command-shortcut]"),
    ).map((node) => node.textContent);
    expect(shortcuts).toEqual(["/f", "/r", "/m"]);
  });

  it("selects the full command word, not the shortcut", () => {
    const onSelectCommand = vi.fn();
    render(
      <SlashCommandButton
        commands={[createClientSlashCommand("fast")]}
        onSelectCommand={onSelectCommand}
      />,
    );

    fireEvent.click(screen.getByLabelText("Show commands and skills"));
    fireEvent.click(screen.getByRole("menuitem", { name: "/fast turn" }));

    expect(onSelectCommand).toHaveBeenCalledWith(
      createClientSlashCommand("fast"),
    );
  });

  it("shows and selects the provider-canonical skill token", () => {
    const skill = {
      name: "doubt",
      description: "Verify a conclusion independently",
      argumentHint: "[claim]",
      invocation: { kind: "skill" as const, prefix: "$" as const },
    };
    const onSelectCommand = vi.fn();
    render(
      <SlashCommandButton
        commands={[skill]}
        onSelectCommand={onSelectCommand}
      />,
    );

    fireEvent.click(screen.getByLabelText("Show commands and skills"));
    const row = screen.getByRole("menuitem", { name: "$doubt" });
    expect(row.textContent).toContain("$doubt");
    expect(row.textContent).toContain("Verify a conclusion independently");
    expect(row.textContent).toContain("[claim]");
    fireEvent.click(row);
    expect(onSelectCommand).toHaveBeenCalledWith(skill);
  });

  it("shows one native entry for a same-name native/skill collision", () => {
    render(
      <SlashCommandButton
        commands={[
          {
            name: "goal",
            description: "Invoke the goal skill",
            invocation: {
              kind: "skill",
              prefix: "$",
              inventoryState: "current",
            },
          },
          {
            name: "goal",
            description: "Set a native goal",
            invocation: { kind: "native", prefix: "/" },
          },
        ]}
        onSelectCommand={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByLabelText("Show commands and skills"));
    expect(screen.getAllByRole("menuitem")).toHaveLength(1);
    expect(screen.getByRole("menuitem", { name: "/goal" })).toBeTruthy();
  });
});
