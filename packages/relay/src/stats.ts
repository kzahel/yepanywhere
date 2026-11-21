import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import * as path from "node:path";
import { iterateJsonlRecords } from "@yep-anywhere/shared/jsonl";
import type { RelayTelemetryEvent } from "./telemetry.js";

interface DailyVersionStats {
  installsByVersion: Record<string, string[]>;
  clientConnectSuccesses: number;
}

interface DailyVersionStatsAccumulator {
  installsByVersion: Map<string, Set<string>>;
  clientConnectSuccesses: number;
}

interface SamplePoint {
  timestamp: string;
  waiting: number;
  pairs: number;
}

interface RelayStatsSummary {
  dailyStats: Record<string, DailyVersionStats>;
  recentSamples: SamplePoint[];
}

function createDayStats(): DailyVersionStatsAccumulator {
  return {
    installsByVersion: new Map(),
    clientConnectSuccesses: 0,
  };
}

function getDayStats(
  days: Map<string, DailyVersionStatsAccumulator>,
  day: string,
): DailyVersionStatsAccumulator {
  let dayStats = days.get(day);
  if (!dayStats) {
    dayStats = createDayStats();
    days.set(day, dayStats);
  }
  return dayStats;
}

function recordEvent(
  days: Map<string, DailyVersionStatsAccumulator>,
  recentSamples: SamplePoint[],
  event: RelayTelemetryEvent,
  recentCutoffMs: number,
): void {
  if (typeof event.timestamp !== "string") {
    return;
  }

  const dayStats = getDayStats(days, event.timestamp.slice(0, 10));

  if (event.event === "server_register") {
    const version = event.appVersion ?? "unknown";
    const installId = event.installId ?? event.username;
    let installs = dayStats.installsByVersion.get(version);
    if (!installs) {
      installs = new Set();
      dayStats.installsByVersion.set(version, installs);
    }
    installs.add(installId);
  }

  if (event.event === "client_connect_success") {
    dayStats.clientConnectSuccesses += 1;
  }

  if (event.event !== "connection_sample") {
    return;
  }

  const eventTime = new Date(event.timestamp).getTime();
  if (eventTime < recentCutoffMs) {
    return;
  }

  recentSamples.push({
    timestamp: event.timestamp,
    waiting: event.waiting,
    pairs: event.pairs,
  });
}

async function parseEventsFile(
  filePath: string,
  onEvent: (event: RelayTelemetryEvent) => void,
): Promise<void> {
  try {
    const stream = createReadStream(filePath, { encoding: "utf8" });
    for await (const { line } of iterateJsonlRecords(stream)) {
      if (!line.trim()) continue;
      try {
        onEvent(JSON.parse(line) as RelayTelemetryEvent);
      } catch {
        // Ignore malformed lines.
      }
    }
  } catch {
    // Ignore files that disappear or cannot be opened while stats are read.
  }
}

function finalizeDailyStats(
  days: Map<string, DailyVersionStatsAccumulator>,
): Record<string, DailyVersionStats> {
  return Object.fromEntries(
    Array.from(days.entries()).map(([day, stats]) => [
      day,
      {
        installsByVersion: Object.fromEntries(
          Array.from(stats.installsByVersion.entries()).map(
            ([version, installs]) => [version, [...installs]],
          ),
        ),
        clientConnectSuccesses: stats.clientConnectSuccesses,
      },
    ]),
  );
}

async function loadStats(eventsDir: string): Promise<RelayStatsSummary> {
  const days = new Map<string, DailyVersionStatsAccumulator>();
  const recentSamples: SamplePoint[] = [];
  const recentCutoffMs = Date.now() - 24 * 60 * 60 * 1000;

  let files: string[];
  try {
    files = (await readdir(eventsDir))
      .filter((file) => file.endsWith(".ndjson"))
      .sort();
  } catch {
    return { dailyStats: {}, recentSamples };
  }

  for (const file of files) {
    await parseEventsFile(path.join(eventsDir, file), (event) => {
      recordEvent(days, recentSamples, event, recentCutoffMs);
    });
  }

  recentSamples.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  return {
    dailyStats: finalizeDailyStats(days),
    recentSamples,
  };
}

function sortVersions(versions: string[]): string[] {
  return [...versions].sort((a, b) => {
    const aa = a.replace(/^v/, "").split("-")[0]?.split(".") ?? [];
    const bb = b.replace(/^v/, "").split("-")[0]?.split(".") ?? [];
    const max = Math.max(aa.length, bb.length);
    for (let i = 0; i < max; i++) {
      const diff =
        (Number.parseInt(aa[i] ?? "0", 10) || 0) -
        (Number.parseInt(bb[i] ?? "0", 10) || 0);
      if (diff !== 0) return diff;
    }
    return a.localeCompare(b);
  });
}

const VERSION_COLORS = [
  "#64748b",
  "#dc2626",
  "#ea580c",
  "#16a34a",
  "#2563eb",
  "#7c3aed",
  "#0891b2",
  "#db2777",
];

function buildStatsHtml(eventsDir: string, summary: RelayStatsSummary): string {
  const { dailyStats, recentSamples } = summary;
  const dates = Object.keys(dailyStats).sort();
  const versionSet = new Set<string>();
  for (const dayStats of Object.values(dailyStats)) {
    for (const version of Object.keys(dayStats.installsByVersion)) {
      versionSet.add(version);
    }
  }
  const versions = sortVersions([...versionSet]);
  const versionDatasets = versions.map((version, index) => ({
    label: version,
    data: dates.map(
      (date) => dailyStats[date]?.installsByVersion[version]?.length ?? 0,
    ),
    borderColor: VERSION_COLORS[index % VERSION_COLORS.length],
    backgroundColor: `${VERSION_COLORS[index % VERSION_COLORS.length]}22`,
    borderWidth: 2,
    tension: 0.25,
    pointRadius: 2,
    fill: false,
  }));

  const totalUniqueInstalls = dates.map((date) => {
    const installs = new Set<string>();
    for (const ids of Object.values(
      dailyStats[date]?.installsByVersion ?? {},
    )) {
      for (const id of ids) installs.add(id);
    }
    return installs.size;
  });
  versionDatasets.push({
    label: "All versions",
    data: totalUniqueInstalls,
    borderColor: "#111827",
    backgroundColor: "#11182710",
    borderWidth: 2.5,
    tension: 0.25,
    pointRadius: 2,
    fill: false,
  });

  const sampleLabels = recentSamples.map((sample) =>
    sample.timestamp.slice(11, 16),
  );
  const waitingData = recentSamples.map((sample) => sample.waiting);
  const pairsData = recentSamples.map((sample) => sample.pairs);

  const connectSuccesses7d = dates
    .slice(-7)
    .reduce(
      (sum, date) => sum + (dailyStats[date]?.clientConnectSuccesses ?? 0),
      0,
    );
  const generatedAt = new Date().toISOString().slice(0, 16).replace("T", " ");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Yep Relay Stats</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>
<style>
body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  max-width: 1200px;
  margin: 32px auto;
  padding: 0 20px 40px;
  background: #f8fafc;
  color: #0f172a;
}
h1 { font-size: 22px; margin-bottom: 6px; }
.subtitle { color: #475569; margin-bottom: 20px; }
.grid {
  display: grid;
  gap: 20px;
}
.card {
  background: white;
  border: 1px solid #e2e8f0;
  border-radius: 12px;
  padding: 18px;
}
.chart-wrap {
  position: relative;
  min-height: 320px;
}
.meta {
  display: flex;
  flex-wrap: wrap;
  gap: 12px 24px;
  margin-top: 14px;
  color: #64748b;
  font-size: 13px;
}
.empty {
  color: #64748b;
  font-style: italic;
}
</style>
</head>
<body>
<h1>Yep Relay Stats</h1>
<div class="subtitle">Daily rolled telemetry from <code>${eventsDir}</code></div>
<div class="grid">
  <section class="card">
    <h2>Remote-active installs by version</h2>
    ${
      dates.length === 0
        ? '<p class="empty">No telemetry data yet.</p>'
        : '<div class="chart-wrap"><canvas id="versionsChart"></canvas></div>'
    }
    <div class="meta">
      <span>Days: ${dates.length}</span>
      <span>Versions seen: ${versions.length}</span>
      <span>Client connects, trailing 7d: ${connectSuccesses7d}</span>
    </div>
  </section>
  <section class="card">
    <h2>Relay traffic, last 24 hours</h2>
    ${
      recentSamples.length === 0
        ? '<p class="empty">No connection samples yet.</p>'
        : '<div class="chart-wrap"><canvas id="trafficChart"></canvas></div>'
    }
    <div class="meta">
      <span>Samples: ${recentSamples.length}</span>
      <span>Generated ${generatedAt} UTC</span>
    </div>
  </section>
</div>
<script>
const commonOptions = {
  responsive: true,
  maintainAspectRatio: false,
  interaction: { mode: 'index', intersect: false },
  plugins: {
    legend: { position: 'bottom', labels: { usePointStyle: true, padding: 12 } }
  },
  scales: {
    x: { grid: { display: false } },
    y: { beginAtZero: true }
  }
};
${
  dates.length === 0
    ? ""
    : `new Chart(document.getElementById('versionsChart'), {
  type: 'line',
  data: { labels: ${JSON.stringify(dates)}, datasets: ${JSON.stringify(versionDatasets)} },
  options: commonOptions
});`
}
${
  recentSamples.length === 0
    ? ""
    : `new Chart(document.getElementById('trafficChart'), {
  type: 'line',
  data: {
    labels: ${JSON.stringify(sampleLabels)},
    datasets: [
      {
        label: 'waiting',
        data: ${JSON.stringify(waitingData)},
        borderColor: '#2563eb',
        backgroundColor: '#2563eb22',
        borderWidth: 2,
        tension: 0.2,
        pointRadius: 1,
        fill: false
      },
      {
        label: 'pairs',
        data: ${JSON.stringify(pairsData)},
        borderColor: '#16a34a',
        backgroundColor: '#16a34a22',
        borderWidth: 2,
        tension: 0.2,
        pointRadius: 1,
        fill: false
      }
    ]
  },
  options: commonOptions
});`
}
</script>
</body>
</html>`;
}

export async function generateRelayStatsHtml(
  eventsDir: string,
): Promise<string> {
  const summary = await loadStats(eventsDir);
  return buildStatsHtml(eventsDir, summary);
}
