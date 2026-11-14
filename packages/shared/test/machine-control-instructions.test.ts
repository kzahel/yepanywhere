import { describe, expect, it } from "vitest";
import {
  findMachineControlInstructions,
  machineControlInstructions,
  splitMachineControlPrompt,
  stripMachineControlPrompt,
} from "../src/machine-control-instructions.js";

describe("Machine Control instruction provenance", () => {
  it.each([
    "'/App'\\''s CLI/machine-control'",
    "& 'C:\\App''s CLI\\machine-control.cmd'",
  ])(
    "recognizes complete current and historical templates with shell-quoted paths: %s",
    (command) => {
      const current = machineControlInstructions("0.7.2", command);
      expect(
        findMachineControlInstructions(
          `${current}<skills_instructions>native context</skills_instructions>`,
        ),
      ).toBe(current);
      const legacy = current.replace("\n[/Installed Machine Control]", "");
      const prompt = "  The actual request.\n\n---\n\nKeep these spaces.  ";
      for (const fragment of [current, legacy]) {
        expect(
          findMachineControlInstructions(
            `Other instructions\n\n${fragment}\n\nMore context`,
          ),
        ).toBe(fragment);
        const context = `Operator context\n\n${fragment}`;
        const wrapped = `[Global context]\n${context}\n\n---\n\n${prompt}`;
        expect(splitMachineControlPrompt(wrapped)).toEqual({ context, prompt });
        expect(stripMachineControlPrompt(wrapped)).toBe(prompt);
      }
    },
  );

  it("preserves incomplete templates, unknown text, quotations and missing delimiters", () => {
    const fragment = machineControlInstructions(
      "0.7.2",
      "'/owned/machine-control'",
    );
    for (const text of [
      "[Global context]\n[Installed Machine Control]\nMy own request",
      `[Global context]\n${fragment}`,
      `[Global context]\n${fragment}\n---\nTask`,
      `[Global context]\n${fragment}\n\nAdditional unknown context\n\n---\n\nTask`,
      `[Global context]\n${fragment.replace("grant no access", "grant access")}\n\n---\n\nTask`,
      `Please review this:\n\n[Global context]\n${fragment}\n\n---\n\nTask`,
    ]) {
      expect(splitMachineControlPrompt(text)).toBeNull();
      expect(stripMachineControlPrompt(text)).toBe(text);
    }
  });
});
