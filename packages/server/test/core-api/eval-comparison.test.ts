import { expect, it } from "vitest";
import { compareReports } from "../../../../scripts/agent-api-eval/compare.js";

it("refuses missing, duplicate, failed and mismatched trials rather than rewarding less completed work", () => {
  const trial = {
    caseId: "identity",
    variant: "help",
    sample: 0,
    success: true,
    requests: 2,
    errors: 0,
    fetchedDocumentationBytes: 100,
    commandCount: 2,
    elapsedMs: 10,
    trace: [],
  };
  const baseline = {
    cliVersion: "same",
    plan: {
      model: "same",
      effort: "medium",
      lane: "test",
      peerRelay: false,
      peerIdentityService: false,
      cases: ["identity"],
      variants: ["help"],
      samples: 1,
    },
    results: [trial],
  };
  expect(
    compareReports(baseline, {
      ...baseline,
      results: [{ ...trial, fetchedDocumentationBytes: 50 }],
    }).passed,
  ).toBe(true);
  for (const results of [[], [trial, trial]])
    expect(() => compareReports(baseline, { ...baseline, results })).toThrow(
      "matrix",
    );
  expect(() =>
    compareReports(baseline, {
      ...baseline,
      plan: { ...baseline.plan, model: "different" },
    }),
  ).toThrow("Different model");
  const failed = compareReports(baseline, {
    ...baseline,
    results: [
      { ...trial, success: false, requests: 0, fetchedDocumentationBytes: 0 },
    ],
  });
  expect(failed.passed).toBe(false);
  expect(failed.checks.noNewTaskFailures).toBe(false);
  expect(
    compareReports(baseline, {
      ...baseline,
      results: [{ ...trial, requests: 3 }],
    }).checks.noAdditionalRequests,
  ).toBe(false);
  const two = {
    ...baseline,
    plan: { ...baseline.plan, cases: ["identity", "workflow"] },
    results: [trial, { ...trial, caseId: "workflow" }],
  };
  const offset = compareReports(two, {
    ...two,
    results: [
      { ...trial, requests: 1 },
      { ...trial, caseId: "workflow", requests: 3 },
    ],
  });
  expect(offset.checks.noAdditionalRequests).toBe(true);
  expect(offset.checks.noAdditionalRequestsPerCase).toBe(false);
  expect(offset.passed).toBe(false);
});
