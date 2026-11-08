/**
 * Example-file ("specimen") format for the design playground.
 *
 * A specimen module is a Storybook-compatible subset of Component Story
 * Format: the default export names the title, and every other exported
 * function is one state. Nothing else of Storybook is supported: no args,
 * decorators, loaders or play functions. Playground-specific settings live
 * in `parameters`, which Storybook passes through untouched.
 *
 *     export default { title: "Controls/Switch", component: Switch,
 *       parameters: { layer: "control" } } satisfies SpecimenMeta;
 *     export const Off = () => <Switch checked={false} … />;
 */
import type { ComponentType } from "react";

/** Lower layers never depend on higher ones; see topics/ui-design.md. */
export const DESIGN_LAYERS = [
  "token",
  "control",
  "pattern",
  "scene",
  "census",
] as const;
export type DesignLayer = (typeof DESIGN_LAYERS)[number];

export const DESIGN_THEMES = ["verydark", "dark", "light"] as const;
export type DesignTheme = (typeof DESIGN_THEMES)[number];

export interface SpecimenParameters {
  layer: DesignLayer;
  /** One sentence shown above the states. */
  description?: string;
  /**
   * Content width in the grid and isolated views. `content` (default) shrinks
   * to the state; `fill` gives it the whole column, for wide pages such as
   * census tables.
   */
  width?: "content" | "fill";
}

export interface SpecimenMeta {
  /** Slash-separated, as in Storybook: "Controls/Switch". */
  title: string;
  component?: unknown;
  parameters: SpecimenParameters;
}

export type SpecimenState = ComponentType & { storyName?: string };

export interface LoadedState {
  id: string;
  exportName: string;
  name: string;
  render: SpecimenState;
}

export interface LoadedSpecimen {
  id: string;
  title: string;
  file: string;
  parameters: SpecimenParameters;
  states: LoadedState[];
}

/** Storybook's id rule: lower-case words joined by hyphens. */
export function toId(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

/** "GlobalClasses" → "Global Classes", as Storybook names an unnamed state. */
export function stateName(exportName: string): string {
  return exportName
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .trim();
}

export function stateId(specimenId: string, exportName: string): string {
  return `${specimenId}--${toId(exportName)}`;
}
