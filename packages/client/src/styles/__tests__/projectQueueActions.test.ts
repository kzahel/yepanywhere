// @vitest-environment node

import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import { readClientStyles } from "./read-client-styles";

const deliveryGlyphStylesheetUrl = new URL(
  "../../components/DeliveryGlyph.module.css",
  import.meta.url,
);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getRuleDeclarations(css: string, selector: string): string {
  const match = new RegExp(
    `(?:^|\\n)${escapeRegExp(selector)}\\s*\\{([^}]*)\\}`,
  ).exec(css);
  expect(
    match,
    `${selector} should have a dedicated style rule.`,
  ).not.toBeNull();
  return match?.[1] ?? "";
}

function getHexCustomProperty(css: string, property: string): string {
  const rootDeclarations = [...css.matchAll(/:root\s*\{([^}]*)\}/g)]
    .map((match) => match[1])
    .join("\n");
  const match = new RegExp(
    `${escapeRegExp(property)}:\\s*(#[0-9a-fA-F]{6})\\s*;`,
  ).exec(rootDeclarations);
  expect(match, `${property} should be a six-digit hex color.`).not.toBeNull();
  return match?.[1] ?? "#000000";
}

function relativeLuminance(hex: string): number {
  const channels = hex
    .slice(1)
    .match(/.{2}/g)
    ?.map((channel) => Number.parseInt(channel, 16) / 255);
  const [red = 0, green = 0, blue = 0] = channels ?? [];
  const linearize = (channel: number) =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;

  return (
    0.2126 * linearize(red) +
    0.7152 * linearize(green) +
    0.0722 * linearize(blue)
  );
}

describe("Project Queue action CSS contract", () => {
  it("makes the new-session action darker than the current-session action", async () => {
    const css = await readClientStyles(
      "tokens",
      "../components/ComposerActions.module",
    );
    const currentSessionColor = getHexCustomProperty(
      css,
      "--project-queue-action-bg",
    );
    const newSessionColor = getHexCustomProperty(
      css,
      "--project-queue-new-session-action-bg",
    );
    const variantDeclarations = getRuleDeclarations(
      css,
      ".projectQueueNewSessionButton",
    );
    const keyboardDeclarations = getRuleDeclarations(
      css,
      ".messageInputKeyboardAction.projectQueueMode",
    );
    const toolbarDeclarations = getRuleDeclarations(
      css,
      ".sendButton.projectQueueButton",
    );

    expect(relativeLuminance(newSessionColor)).toBeLessThan(
      relativeLuminance(currentSessionColor),
    );
    expect(variantDeclarations).toMatch(
      /--project-queue-button-bg:\s*var\(--project-queue-new-session-action-bg\)\s*;/,
    );
    for (const declarations of [toolbarDeclarations, keyboardDeclarations]) {
      expect(declarations).toMatch(
        /background:\s*var\(\s*--project-queue-button-bg,\s*var\(--project-queue-action-bg\)\s*\)\s*;/,
      );
    }
  });

  it("optically centers text arrows in a shared glyph envelope", async () => {
    const css = await readFile(deliveryGlyphStylesheetUrl, "utf8");
    const declarations = getRuleDeclarations(css, ".glyph");

    expect(declarations).toMatch(/height:\s*1em\s*;/);
    expect(declarations).toMatch(/padding-block-start:\s*4px\s*;/);
    expect(declarations).toMatch(/line-height:\s*1\s*;/);
  });
});
