import { SessionToolbarPreviewView } from "../../src/components/SessionToolbarPreview";
import {
  DEFAULT_SESSION_TOOLBAR_PRESENCE,
  DEFAULT_SESSION_TOOLBAR_PRIORITY,
  SESSION_TOOLBAR_CONTROL_KEYS,
  type SessionToolbarVisibility,
} from "../../src/hooks/useSessionToolbarPresence";
import { DEFAULT_WAVEFORM_BUTTON_BACKGROUND_OPACITY_PERCENT } from "../../src/hooks/useWaveformButtonBackgroundOpacity";
import type { SpecimenMeta } from "../specimen";

export default {
  title: "Scenes/Composer",
  component: SessionToolbarPreviewView,
  parameters: {
    layer: "scene",
    width: "fill",
    description:
      "The Settings toolbar preview with fixed standard and all-controls-enabled configurations, without speech capture. Inert references: no messages, menus or saved-setting changes. Narrow layouts show overflow through More.",
  },
} satisfies SpecimenMeta;

const standard = Object.fromEntries(
  SESSION_TOOLBAR_CONTROL_KEYS.map((key) => [
    key,
    DEFAULT_SESSION_TOOLBAR_PRESENCE[key] !== "hidden" &&
      DEFAULT_SESSION_TOOLBAR_PRESENCE[key] !== "off",
  ]),
) as SessionToolbarVisibility;
const all = Object.fromEntries(
  SESSION_TOOLBAR_CONTROL_KEYS.map((key) => [key, key !== "composerRecall"]),
) as SessionToolbarVisibility;
const nowMs = Date.UTC(2026, 0, 1, 12);

function Toolbar({ visibility }: { visibility: SessionToolbarVisibility }) {
  return (
    <SessionToolbarPreviewView
      fitToContainer
      visibility={visibility}
      priority={DEFAULT_SESSION_TOOLBAR_PRIORITY}
      waveformButtonBackgroundOpacityPercent={
        DEFAULT_WAVEFORM_BUTTON_BACKGROUND_OPACITY_PERCENT
      }
      nowMs={nowMs}
    />
  );
}

export function Standard() {
  return <Toolbar visibility={standard} />;
}
Standard.storyName = "Standard toolbar";

export function AllControls() {
  return <Toolbar visibility={all} />;
}
AllControls.storyName = "All controls enabled";
