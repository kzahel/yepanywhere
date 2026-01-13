import {
  FONT_SIZES,
  getFontSizeLabel,
  useFontSize,
} from "../../hooks/useFontSize";
import { useFunPhrases } from "../../hooks/useFunPhrases";
import { useStreamingEnabled } from "../../hooks/useStreamingEnabled";
import { THEMES, getThemeLabel, useTheme } from "../../hooks/useTheme";

export function AppearanceSettings() {
  const { fontSize, setFontSize } = useFontSize();
  const { theme, setTheme } = useTheme();
  const { streamingEnabled, setStreamingEnabled } = useStreamingEnabled();
  const { funPhrasesEnabled, setFunPhrasesEnabled } = useFunPhrases();

  return (
    <section className="settings-section">
      <h2>Appearance</h2>
      <div className="settings-group">
        <div className="settings-item">
          <div className="settings-item-info">
            <strong>Theme</strong>
            <p>Choose your preferred color scheme.</p>
          </div>
          <div className="font-size-selector">
            {THEMES.map((t) => (
              <button
                key={t}
                type="button"
                className={`font-size-option ${theme === t ? "active" : ""}`}
                onClick={() => setTheme(t)}
              >
                {getThemeLabel(t)}
              </button>
            ))}
          </div>
        </div>
        <div className="settings-item">
          <div className="settings-item-info">
            <strong>Font Size</strong>
            <p>Adjust the text size throughout the application.</p>
          </div>
          <div className="font-size-selector">
            {FONT_SIZES.map((size) => (
              <button
                key={size}
                type="button"
                className={`font-size-option ${fontSize === size ? "active" : ""}`}
                onClick={() => setFontSize(size)}
              >
                {getFontSizeLabel(size)}
              </button>
            ))}
          </div>
        </div>
        <div className="settings-item">
          <div className="settings-item-info">
            <strong>Response Streaming</strong>
            <p>
              Show responses as they are generated, token by token. Disable for
              better performance on slower devices.
            </p>
          </div>
          <label className="toggle-switch">
            <input
              type="checkbox"
              checked={streamingEnabled}
              onChange={(e) => setStreamingEnabled(e.target.checked)}
            />
            <span className="toggle-slider" />
          </label>
        </div>
        <div className="settings-item">
          <div className="settings-item-info">
            <strong>Fun Phrases</strong>
            <p>
              Show playful status messages while waiting for responses. Disable
              to show only "Thinking..."
            </p>
          </div>
          <label className="toggle-switch">
            <input
              type="checkbox"
              checked={funPhrasesEnabled}
              onChange={(e) => setFunPhrasesEnabled(e.target.checked)}
            />
            <span className="toggle-slider" />
          </label>
        </div>
      </div>
    </section>
  );
}
