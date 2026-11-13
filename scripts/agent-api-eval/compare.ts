import {
  fetchedDocumentationBytes,
  isFullSchemaPath,
} from "./documentation-metrics.js";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import type { Trace } from "./cases.js";

interface Trial {
  caseId: string;
  variant: string;
  sample: number;
  success: boolean;
  requests: number;
  errors: number;
  fetchedDocumentationBytes: number;
  elapsedMs: number;
  commandCount: number;
  trace: Trace[];
}
interface Report {
  cliVersion: string;
  plan: {
    model: string;
    effort: string;
    lane: string;
    peerRelay: boolean;
    peerIdentityService: boolean;
    cases: string[];
    variants: string[];
    samples: number;
  };
  results: Trial[];
}
const key = (row: Trial) => `${row.caseId}/${row.variant}/${row.sample}`;

/** Compare complete paired task matrices; a missing/failed trial cannot improve cost. */
export function compareReports(before: Report, after: Report) {
  for (const field of [
    "model",
    "effort",
    "lane",
    "peerRelay",
    "peerIdentityService",
  ] as const)
    if (before.plan[field] !== after.plan[field])
      throw new Error(`Different ${field}; no comparable task matrix`);
  if (before.cliVersion !== after.cliVersion)
    throw new Error("Different CLI versions");
  const keys = (report: Report) => report.results.map(key).sort();
  const expected = (report: Report) =>
    report.plan.cases
      .flatMap((caseId) =>
        report.plan.variants.flatMap((variant) =>
          Array.from(
            { length: report.plan.samples },
            (_, sample) => `${caseId}/${variant}/${sample}`,
          ),
        ),
      )
      .sort();
  for (const report of [before, after])
    if (
      !report.results.length ||
      JSON.stringify(keys(report)) !== JSON.stringify(expected(report))
    )
      throw new Error("Incomplete or duplicate trial matrix");
  if (JSON.stringify(keys(before)) !== JSON.stringify(keys(after)))
    throw new Error("Different task matrices");
  const sum = (
    rows: Trial[],
    field:
      | "requests"
      | "errors"
      | "fetchedDocumentationBytes"
      | "elapsedMs"
      | "commandCount",
  ) => rows.reduce((total, row) => total + row[field], 0);
  const totals = (report: Report) => ({
    successes: report.results.filter((row) => row.success).length,
    requests: sum(report.results, "requests"),
    errors: sum(report.results, "errors"),
    fetchedDocumentationBytes: report.results.reduce(
      (sum, row) => sum + fetchedDocumentationBytes(row.trace),
      0,
    ),
    responseBytes: report.results.reduce(
      (sum, row) => sum + row.trace.reduce((n, entry) => n + entry.bytes, 0),
      0,
    ),
    requestPathBytes: report.results.reduce(
      (sum, row) =>
        sum +
        row.trace.reduce((n, entry) => n + Buffer.byteLength(entry.path), 0),
      0,
    ),
    fullSchemaReads: report.results.reduce(
      (sum, row) =>
        sum +
        row.trace.filter(
          (entry) => isFullSchemaPath(entry.path) && entry.status === 200,
        ).length,
      0,
    ),
    commandCount: sum(report.results, "commandCount"),
    elapsedMs: sum(report.results, "elapsedMs"),
  });
  const baseline = totals(before),
    candidate = totals(after);
  const cases = [...new Set(before.results.map((row) => row.caseId))].map(
    (caseId) => ({
      caseId,
      before: totals({
        ...before,
        results: before.results.filter((row) => row.caseId === caseId),
      }),
      after: totals({
        ...after,
        results: after.results.filter((row) => row.caseId === caseId),
      }),
    }),
  );
  const checks = {
    allTasksSuccessful: candidate.successes === after.results.length,
    noNewTaskFailures: before.results.every(
      (row) =>
        !row.success ||
        after.results.find((other) => key(other) === key(row))?.success,
    ),
    noAdditionalErrorsPerCase: cases.every(
      (row) => row.after.errors <= row.before.errors,
    ),
    noAdditionalRequestsPerCase: cases.every(
      (row) => row.after.requests <= row.before.requests,
    ),
    noAdditionalDocumentationBytesPerCase: cases.every(
      (row) =>
        row.after.fetchedDocumentationBytes <=
        row.before.fetchedDocumentationBytes,
    ),
    noAdditionalErrors: candidate.errors <= baseline.errors,
    noAdditionalRequests: candidate.requests <= baseline.requests,
    noAdditionalDocumentationBytes:
      candidate.fetchedDocumentationBytes <= baseline.fetchedDocumentationBytes,
  };
  return {
    passed: Object.values(checks).every(Boolean),
    checks,
    before: baseline,
    after: candidate,
    cases,
    interpretation:
      "Paired descriptive trials, not statistical latency or model-quality proof. No latency/token/cost gate. Different fixture revisions must preserve the compared tasks; new tasks are qualified separately.",
  };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [beforePath, afterPath] = process.argv.slice(2);
  if (!beforePath || !afterPath)
    throw new Error("Usage: compare.ts BEFORE/results.json AFTER/results.json");
  const result = compareReports(
    JSON.parse(await readFile(beforePath, "utf8")),
    JSON.parse(await readFile(afterPath, "utf8")),
  );
  console.log(JSON.stringify(result, null, 2));
  if (!result.passed) process.exitCode = 1;
}
