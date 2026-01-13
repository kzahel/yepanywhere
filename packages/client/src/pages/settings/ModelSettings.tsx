import {
  MODEL_OPTIONS,
  THINKING_LEVEL_OPTIONS,
  useModelSettings,
} from "../../hooks/useModelSettings";

export function ModelSettings() {
  const {
    model,
    setModel,
    thinkingLevel,
    setThinkingLevel,
    thinkingEnabled,
    setThinkingEnabled,
  } = useModelSettings();

  return (
    <section className="settings-section">
      <h2>Model</h2>
      <div className="settings-group">
        <div className="settings-item">
          <div className="settings-item-info">
            <strong>Model</strong>
            <p>Select which Claude model to use for new sessions.</p>
          </div>
          <div className="font-size-selector">
            {MODEL_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                className={`font-size-option ${model === opt.value ? "active" : ""}`}
                onClick={() => setModel(opt.value)}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
        <div className="settings-item">
          <div className="settings-item-info">
            <strong>Extended Thinking</strong>
            <p>
              Allow the model to "think" before responding. Toggle on to enable
              deeper reasoning.
            </p>
          </div>
          <label className="toggle-switch">
            <input
              type="checkbox"
              checked={thinkingEnabled}
              onChange={(e) => setThinkingEnabled(e.target.checked)}
            />
            <span className="toggle-slider" />
          </label>
        </div>
        <div className="settings-item">
          <div className="settings-item-info">
            <strong>Thinking Level</strong>
            <p>
              Token budget for thinking. Higher levels enable deeper reasoning
              but use more tokens.
            </p>
          </div>
          <div className="font-size-selector">
            {THINKING_LEVEL_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                className={`font-size-option ${thinkingLevel === opt.value ? "active" : ""}`}
                onClick={() => setThinkingLevel(opt.value)}
                title={opt.description}
              >
                {opt.label} ({opt.description})
              </button>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
