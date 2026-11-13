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
    trace: [
      {
        method: "GET",
        path: "/v0/help",
        status: 200,
        bytes: 100,
        elapsedMs: 1,
        atMs: 0,
      },
    ],
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
      results: [
        {
          ...trial,
          fetchedDocumentationBytes: 50,
          trace: [{ ...trial.trace[0]!, bytes: 50 }],
        },
      ],
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

it("counts target documentation and full schemas from actual trace bytes rather than a stale summary", () => {
  const trial = {
    caseId: "target_contract",
    variant: "help",
    sample: 0,
    success: true,
    requests: 3,
    errors: 0,
    fetchedDocumentationBytes: 1,
    commandCount: 3,
    elapsedMs: 3,
    trace: [
      {
        method: "GET",
        path: "/v0/help",
        status: 200,
        bytes: 100,
        elapsedMs: 1,
        atMs: 0,
      },
      {
        method: "GET",
        path: "/v0/servers/target/help",
        status: 200,
        bytes: 200,
        elapsedMs: 1,
        atMs: 1,
      },
      {
        method: "GET",
        path: "/v0/servers/target/schema",
        status: 200,
        bytes: 300,
        elapsedMs: 1,
        atMs: 2,
      },
    ],
  };
  const report = {
    cliVersion: "same",
    plan: {
      model: "same",
      effort: "medium",
      lane: "test",
      peerRelay: true,
      peerIdentityService: false,
      cases: ["target_contract"],
      variants: ["help"],
      samples: 1,
    },
    results: [trial],
  };
  const result = compareReports(report, report);
  expect(result.before.fetchedDocumentationBytes).toBe(600);
  expect(result.before.fullSchemaReads).toBe(1);
});
