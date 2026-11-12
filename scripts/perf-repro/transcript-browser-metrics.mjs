export function distribution(values) {
  if (!values.length || values.some((n) => !Number.isFinite(n) || n < 0))
    throw new Error("Missing/invalid samples");
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p) =>
    sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)];
  return {
    count: sorted.length,
    median: at(0.5),
    p95: at(0.95),
    max: sorted.at(-1),
  };
}
export function summarizeTranscriptProbe(
  raw,
  calibration,
  expectedAppends,
  expectedText,
) {
  const cadence = distribution(calibration).median;
  if (cadence < 4 || cadence > 40)
    throw new Error(`Unusable frame calibration: ${cadence}`);
  const frames = distribution(raw.frames);
  const keys = expectedText.length
    ? distribution(raw.keys.map((k) => k.latencyMs ?? Number.NaN))
    : null;
  const prefixesCorrect =
    raw.keys.length === expectedText.length &&
    raw.keys.every(
      (k, i) =>
        k.expected === expectedText.slice(0, i + 1) &&
        k.value === k.expected &&
        k.valueAtFrame === k.expected,
    ) &&
    raw.inputValue === expectedText;
  const delivered = raw.markers.filter((m) => Number.isFinite(m.domLatencyMs));
  const complete =
    raw.markers.length === expectedAppends &&
    delivered.length === expectedAppends &&
    raw.pending === 0;
  const unknownRequests = raw.snapshot.unexpected;
  return {
    cadenceMs: cadence,
    frames,
    keys,
    prefixesCorrect,
    complete,
    unknownRequests,
    appendLatencyMs: delivered.length
      ? distribution(delivered.map((m) => m.domLatencyMs))
      : null,
    appendLatenessMs: raw.markers.length
      ? distribution(raw.markers.map((m) => m.latenessMs))
      : null,
    missedFrameOpportunities: raw.frames.reduce(
      (n, gap) => n + Math.max(0, Math.round(gap / cadence) - 1),
      0,
    ),
    gapsOverTwoFrames: raw.frames.filter((gap) => gap > cadence * 2.5).length,
    gapsOver60HzBudget: raw.frames.filter((gap) => gap > 1000 / 60 + 0.5)
      .length,
    gapsOver33Ms: raw.frames.filter((gap) => gap > 1000 / 30 + 0.5).length,
    longTasks: raw.longTasks.length,
    longestTaskMs: Math.max(0, ...raw.longTasks.map((t) => t.ms)),
    mountedRows: raw.mountedRows,
    loadedMessages: raw.snapshot.loadedMessages,
    responsiveInput: keys ? prefixesCorrect && keys.max <= 100 : null,
    valid: complete && prefixesCorrect && unknownRequests.length === 0,
  };
}
