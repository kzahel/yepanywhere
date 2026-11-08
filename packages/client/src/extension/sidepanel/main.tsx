/**
 * Side panel entry for the Chrome extension (docs/tactical/151 step 9): a
 * lightweight page, not the full app, that shows sessions for the current tab.
 */

import { createRoot } from "react-dom/client";
import { TooltipLayer } from "../../components/ui/TooltipLayer";
import { initializeTheme } from "../../hooks/useTheme";
import { I18nProvider } from "../../i18n";
import "../../styles/index.css";
import { SidePanel } from "./SidePanel";

initializeTheme();

const root = document.getElementById("root");
if (!root) throw new Error("Root element not found");
createRoot(root).render(
  <I18nProvider>
    <TooltipLayer />
    <SidePanel />
  </I18nProvider>,
);
