import { mkdir, readFile, writeFile } from "node:fs/promises";
import { cpus, platform, release } from "node:os";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import type { Message } from "../src/types";
import {
  canReuseRenderItem,
  stabilizeRenderItems,
} from "../src/lib/stableRenderItems";
import { getCachedTranscriptProjection } from "../src/lib/transcriptProjection/cache";
import { compileTranscriptProjection } from "@yep-anywhere/shared/transcript/compiler";

interface Metric {
  iterations: number;
  medianMs: number;
  minimumMs: number;
  p95Ms: number;
}

interface BenchmarkReport {
  schemaVersion: 1;
  capturedAt: string;
  corpus: {
    messageCount: number;
    renderItemCount: number;
    reusablePrefixItemCount: number;
    reusedPrefixItemCount: number;
    turns: number;
  };
  environment: {
    cpu: string;
    node: string;
    platform: string;
  };
  invariants: {
    cachePreservesArrayIdentity: boolean;
    stabilizationPreservesReusablePrefixReferences: boolean;
  };
  metrics: Record<string, Metric>;
}

interface Options {
  comparePath?: string;
  outputPath?: string;
}

const TURNS = 320;

function getCachedProjection(messages: Message[]) {
  return getCachedTranscriptProjection(
    messages,
    undefined,
    compileTranscriptProjection,
  );
}

function parseArgs(argv: string[]): Options {
  const options: Options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") continue;
    if (argument === "--out" || argument === "--compare") {
      const value = argv[index + 1];
      if (!value) throw new Error(`${argument} requires a path`);
      if (argument === "--out") options.outputPath = resolve(value);
      else options.comparePath = resolve(value);
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

function buildCorpus(): Message[] {
  const messages: Message[] = [];
  for (let turn = 0; turn < TURNS; turn += 1) {
    const timestamp = new Date(Date.UTC(2026, 0, 1, 0, 0, turn)).toISOString();
    messages.push({
      id: `user-${turn}`,
      role: "user",
      content: `Inspect deterministic fixture ${turn}`,
      timestamp,
    });
    const content: NonNullable<Message["content"]> = [
      { type: "thinking", thinking: `Plan deterministic turn ${turn}` },
      { type: "text", text: `Completed deterministic turn ${turn}.` },
    ];
    if (turn % 8 === 0) {
      content.push({
        type: "tool_use",
        id: `read-${turn}`,
        name: "Read",
        input: { file_path: `fixture-${turn}.ts` },
      });
    }
    messages.push({
      id: `assistant-${turn}`,
      role: "assistant",
      content,
      timestamp,
    });
    if (turn % 8 === 0) {
      messages.push({
        id: `result-${turn}`,
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: `read-${turn}`,
            content: `export const fixture${turn} = true;`,
          },
        ],
        toolUseResult: { filePath: `fixture-${turn}.ts`, lineCount: 1 },
        timestamp,
      });
    }
    if (turn > 0 && turn % 80 === 0) {
      messages.push({
        id: `compact-${turn}`,
        type: "system",
        subtype: "compact_boundary",
        content: "Context compacted",
        timestamp,
      });
    }
  }
  return messages;
}

function percentile(sorted: readonly number[], fraction: number): number {
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * fraction) - 1),
  );
  return sorted[index] ?? 0;
}

function measure(iterations: number, operation: () => void): Metric {
  const samples: number[] = [];
  for (let index = 0; index < iterations; index += 1) {
    const startedAt = performance.now();
    operation();
    samples.push(performance.now() - startedAt);
  }
  samples.sort((left, right) => left - right);
  return {
    iterations,
    medianMs: percentile(samples, 0.5),
    minimumMs: samples[0] ?? 0,
    p95Ms: percentile(samples, 0.95),
  };
}

function roundMetric(metric: Metric): Metric {
  return {
    ...metric,
    medianMs: Number(metric.medianMs.toFixed(4)),
    minimumMs: Number(metric.minimumMs.toFixed(4)),
    p95Ms: Number(metric.p95Ms.toFixed(4)),
  };
}

function compileChangedTail(messages: Message[]): Message[] {
  const next = messages.slice();
  const last = next.at(-1);
  if (!last || !Array.isArray(last.content)) {
    throw new Error("Benchmark corpus must end in an assistant block array");
  }
  next[next.length - 1] = {
    ...last,
    content: last.content.map((block) =>
      block.type === "text"
        ? { ...block, text: `${block.text ?? ""} changed` }
        : block,
    ),
  };
  return next;
}

function buildReport(): BenchmarkReport {
  const messages = buildCorpus();
  for (let index = 0; index < 15; index += 1) {
    compileTranscriptProjection(messages.slice());
  }

  const cachedItems = getCachedProjection(messages);
  const cachePreservesArrayIdentity =
    getCachedProjection(messages) === cachedItems;

  const changedItems = compileTranscriptProjection(
    compileChangedTail(messages),
  );
  const stabilized = stabilizeRenderItems(cachedItems, changedItems);
  const reusablePrefixIndexes = cachedItems
    .slice(0, -1)
    .flatMap((item, index) =>
      changedItems[index] && canReuseRenderItem(item, changedItems[index])
        ? [index]
        : [],
    );
  const reusedPrefixItemCount = reusablePrefixIndexes.filter(
    (index) => stabilized[index] === cachedItems[index],
  ).length;

  const metrics = {
    coldSemanticCompile: roundMetric(
      measure(75, () => {
        compileTranscriptProjection(messages.slice());
      }),
    ),
    sameArrayCacheHit: roundMetric(
      measure(2_000, () => {
        getCachedProjection(messages);
      }),
    ),
    changedTailStabilization: roundMetric(
      measure(150, () => {
        stabilizeRenderItems(cachedItems, changedItems);
      }),
    ),
  };

  return {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    corpus: {
      messageCount: messages.length,
      renderItemCount: cachedItems.length,
      reusablePrefixItemCount: reusablePrefixIndexes.length,
      reusedPrefixItemCount,
      turns: TURNS,
    },
    environment: {
      cpu: cpus()[0]?.model ?? "unknown",
      node: process.version,
      platform: `${platform()} ${release()}`,
    },
    invariants: {
      cachePreservesArrayIdentity,
      stabilizationPreservesReusablePrefixReferences:
        reusedPrefixItemCount === reusablePrefixIndexes.length,
    },
    metrics,
  };
}

function comparisonFailures(
  baseline: BenchmarkReport,
  current: BenchmarkReport,
): string[] {
  const failures: string[] = [];
  if (JSON.stringify(baseline.corpus) !== JSON.stringify(current.corpus)) {
    failures.push("benchmark corpus shape changed");
  }
  for (const [name, metric] of Object.entries(current.metrics)) {
    const prior = baseline.metrics[name];
    if (!prior) {
      failures.push(`${name}: missing from baseline`);
      continue;
    }
    const allowance = Math.max(prior.medianMs * 0.1, 2);
    if (metric.medianMs > prior.medianMs + allowance) {
      failures.push(
        `${name}: median ${metric.medianMs}ms exceeds ${prior.medianMs}ms + ${allowance.toFixed(4)}ms`,
      );
    }
  }
  return failures;
}

async function readReport(path: string): Promise<BenchmarkReport> {
  return JSON.parse(await readFile(path, "utf8")) as BenchmarkReport;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const report = buildReport();
  if (!Object.values(report.invariants).every(Boolean)) {
    throw new Error(
      `Benchmark invariant failed: ${JSON.stringify(report.invariants)}`,
    );
  }

  if (options.outputPath) {
    await mkdir(dirname(options.outputPath), { recursive: true });
    await writeFile(options.outputPath, `${JSON.stringify(report, null, 2)}\n`);
  }

  const failures = options.comparePath
    ? comparisonFailures(await readReport(options.comparePath), report)
    : [];
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (failures.length > 0) {
    throw new Error(
      `Performance comparison failed:\n- ${failures.join("\n- ")}`,
    );
  }
}

await main();
