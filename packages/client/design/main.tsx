/*
 * Design playground entry, served only by the Vite dev server at
 * /design.html. No production build lists design.html as an input, and
 * production modules may not import this directory or any *.specimen.tsx
 * (enforced by biome.json). See topics/ui-design.md.
 */
import { createRoot } from "react-dom/client";
import { TooltipLayer } from "../src/components/ui/TooltipLayer";
import { I18nProvider } from "../src/i18n";
import "../src/styles/index.css";
import { DesignApp } from "./DesignApp";

const root = document.getElementById("root");
if (!root) throw new Error("design.html has no #root");

createRoot(root).render(
  <I18nProvider>
    <TooltipLayer />
    <DesignApp />
  </I18nProvider>,
);
