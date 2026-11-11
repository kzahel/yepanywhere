/*
 * Separate design playground entry at /design.html in dev and hosted builds.
 * App modules may not import this directory or any *.specimen.tsx
 * (enforced by biome.json). See topics/ui-design.md.
 */
import { createRoot } from "react-dom/client";
import { TooltipLayer } from "../src/components/ui/TooltipLayer";
import { I18nProvider } from "../src/i18n";
import "../src/styles/purposeGlobals";
import { DesignApp } from "./DesignApp";

const root = document.getElementById("root");
if (!root) throw new Error("design.html has no #root");

createRoot(root).render(
  <I18nProvider>
    <TooltipLayer />
    <DesignApp />
  </I18nProvider>,
);
