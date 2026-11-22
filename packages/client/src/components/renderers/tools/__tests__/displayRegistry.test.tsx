import {
  displayExpectations,
  displayOperationNames,
} from "../__fixtures__/displayExpectations";
import { displayProviders } from "../__fixtures__/displayProviders";
import { diagnosticToolNames } from "../../../../lib/validateToolResult";
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toolDefinitions, toolRegistry } from "..";
import { displayFixtures } from "../__fixtures__/displayFixtures";
import { toolDisplayContracts } from "../toolDisplayContracts";
import { toolDisplayDiagnostics } from "../displayDiagnostics";
import type { PreparedToolDisplay } from "../defineTool";
import { recordFromLegacyArgs, type DisplayRecord } from "../prepareDisplay";

const context = {
  isStreaming: false,
  theme: "dark" as const,
  toolUseId: "contract",
  projectPath: "/tmp",
};
function displayOperations(prepared: PreparedToolDisplay) {
  return [
    prepared.renderToolUse(context),
    prepared.renderToolResult(context),
    prepared.renderCollapsedPreview(context),
    prepared.renderInteractiveSummary(context),
    prepared.renderInline(context),
  ];
}
function summaries(prepared: PreparedToolDisplay) {
  return [
    prepared.getDisplayName(),
    prepared.getUseSummary(context),
    prepared.getResultSummary(context),
  ].join(" ");
}

/** Stable field-path mutations, including nested array elements. Values and
 * requiredness are deliberately not derived from display schemas. */
function mutations(value: unknown, path = "root"): Array<[string, unknown]> {
  const cases: Array<[string, unknown]> = [
    [`${path}:null`, null],
    [`${path}:scalar`, 42],
  ];
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value)) {
      const deleted = { ...value };
      Reflect.deleteProperty(deleted, key);
      cases.push(
        [`${path}.${key}:deleted`, deleted],
        [`${path}.${key}:null`, { ...value, [key]: null }],
        [
          `${path}.${key}:wrong-scalar`,
          { ...value, [key]: typeof child === "string" ? 42 : "wrong" },
        ],
      );
      if (Array.isArray(child) && child.length)
        cases.push([
          `${path}.${key}[0]:null`,
          { ...value, [key]: [null, ...child.slice(1)] },
        ]);
      if (child && typeof child === "object") {
        const nested = Array.isArray(child) ? child[0] : child;
        if (nested && typeof nested === "object") {
          for (const nestedKey of Object.keys(nested)) {
            const deleted = { ...nested };
            Reflect.deleteProperty(deleted, nestedKey);
            cases.push([
              `${path}.${key}.${nestedKey}:deleted`,
              {
                ...value,
                [key]: Array.isArray(child)
                  ? [deleted, ...child.slice(1)]
                  : deleted,
              },
            ]);
            cases.push([
              `${path}.${key}.${nestedKey}:null`,
              {
                ...value,
                [key]: Array.isArray(child)
                  ? [{ ...nested, [nestedKey]: null }, ...child.slice(1)]
                  : { ...nested, [nestedKey]: null },
              },
            ]);
          }
        }
      }
    }
  }
  return cases;
}

beforeEach(() => {
  toolDisplayDiagnostics.synchronousCatches = 0;
  toolDisplayDiagnostics.renderCatches = 0;
  vi.spyOn(console, "error");
  vi.spyOn(console, "warn");
});
afterEach(() => {
  cleanup();
  expect(toolDisplayDiagnostics).toEqual({
    synchronousCatches: 0,
    renderCatches: 0,
  });
  expect(console.error).not.toHaveBeenCalled();
  expect(console.warn).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});

it("covers exactly the production registry and every declared variant", () => {
  expect(toolDefinitions.map((d) => d.tool).sort()).toEqual(
    Object.keys(toolDisplayContracts).sort(),
  );
  expect(Object.keys(displayFixtures).sort()).toEqual(
    toolDefinitions.map((d) => d.tool).sort(),
  );
  for (const [name, contract] of Object.entries(toolDisplayContracts)) {
    const fixture = Reflect.get(displayFixtures, name);
    expect(Object.keys(fixture).sort(), name).toEqual(
      [...contract.variants].sort(),
    );
  }
});

for (const [tool, variants] of Object.entries(displayFixtures)) {
  for (const [variant, fixture] of Object.entries(variants)) {
    describe(`${tool}/${variant}`, () => {
      const record: DisplayRecord = {
        input: fixture.input,
        result: fixture.result,
        status: "complete",
      };
      it("mounts every declared rich operation with independent semantic content", () => {
        expect(fixture.provenance.length).toBeGreaterThan(20);
        const prepared = toolRegistry.prepare(tool, record);
        expect(prepared.kind).toBe(
          variant === "plain-text" ? "partial" : "rich",
        );
        summaries(prepared);
        const expectations = Reflect.get(
          Reflect.get(displayExpectations, tool),
          variant,
        );
        for (const [operation, node] of displayOperations(prepared).entries()) {
          const mounted = render(
            displayProviders(<div data-testid="tool-operation">{node}</div>),
          );
          const output = mounted.getByTestId("tool-operation");
          expect(
            output.querySelector('[data-tool-display="raw"]'),
            `${tool}/${variant}/${operation}`,
          ).toBeNull();
          const expected = expectations[operation];
          const label = `${tool}/${variant}/${displayOperationNames[operation]}`;
          if (expected === null) expect(output.innerHTML, label).toBe("");
          else expect(output.textContent, label).toContain(expected);
          mounted.unmount();
        }
      });
      it("preserves lifecycle status and retries corrected records", () => {
        for (const status of [
          "pending",
          "aborted",
          "incomplete",
          "error",
          "complete",
        ] as const) {
          const current = {
            ...record,
            status,
            ...(status === "pending" ||
            status === "aborted" ||
            status === "incomplete"
              ? { result: undefined }
              : {}),
          };
          const prepared = toolRegistry.prepare(tool, current);
          expect(prepared.status).toBe(status);
          expect(prepared.isError).toBe(status === "error");
          const mounted = render(
            displayProviders(
              prepared.renderInline(context) ?? prepared.renderToolUse(context),
            ),
          );
          const corrected = toolRegistry.prepare(tool, record);
          mounted.rerender(displayProviders(corrected.renderToolUse(context)));
          expect(
            mounted.container.querySelector('[data-tool-display="raw"]'),
          ).toBeNull();
          mounted.unmount();
        }
      });
      it("declares standalone result support", () => {
        const prepared = toolRegistry.prepare(tool, {
          ...record,
          input: undefined,
        });
        const metadata = toolDefinitions.find((d) => d.tool === tool);
        const supportsStandalone = metadata?.standaloneResult;
        expect(prepared.kind).toBe(
          supportsStandalone
            ? variant === "plain-text"
              ? "partial"
              : "rich"
            : "raw",
        );
        const mounted = render(
          displayProviders(prepared.renderToolResult(context)),
        );
        expect(
          !!mounted.container.querySelector('[data-tool-display="raw"]'),
        ).toBe(!supportsStandalone);
        if (supportsStandalone) {
          const standalone: Record<string, string> = {
            "Write/file": "contract content",
            "Read/image": "image",
            "TaskCreate/event": "Task created",
            "TaskUpdate/event": "Task updated",
          };
          const expected =
            standalone[`${tool}/${variant}`] ??
            Reflect.get(Reflect.get(displayExpectations, tool), variant)[1];
          expect(expected).not.toBeNull();
          expect(mounted.container.textContent).toContain(expected);
        }
      });
      for (const field of ["input", "result"] as const) {
        for (const [mutation, value] of mutations(record[field], field)) {
          it(`contains ${mutation} and keeps the original record inspectable`, () => {
            const damaged = { ...record, [field]: value };
            const prepared = toolRegistry.prepare(tool, damaged);
            summaries(prepared);
            for (const node of displayOperations(prepared)) {
              const mounted = render(displayProviders(node));
              if (prepared.kind === "raw") {
                expect(
                  mounted.container.querySelector('[data-tool-display="raw"]'),
                ).not.toBeNull();
                expect(mounted.container.textContent).toContain(
                  JSON.stringify(damaged.input, null, 2),
                );
                expect(mounted.container.textContent).toContain(
                  typeof damaged.result === "string"
                    ? damaged.result
                    : JSON.stringify(damaged.result, null, 2),
                );
              }
              mounted.unmount();
            }
          });
        }
      }
    });
  }
}

it("reads a call still running out of positional dispatch arguments", () => {
  expect(
    recordFromLegacyArgs({ file_path: "notes.md" }, undefined, false),
  ).toEqual({
    input: { file_path: "notes.md" },
    result: undefined,
    isError: false,
    status: "pending",
  });
  expect(recordFromLegacyArgs(undefined, "output", false).status).toBe(
    "complete",
  );
  expect(recordFromLegacyArgs(undefined, undefined, true).status).toBe("error");
  expect(
    recordFromLegacyArgs(undefined, undefined, false, "complete").status,
  ).toBe("complete");
});

it("accounts for diagnostic schemas separately from display eligibility", () => {
  const omitted = [
    "ExitPlanMode",
    "Exec",
    "Web",
    "UpdatePlan",
    "ViewImage",
    "Skill",
    "SendMessage",
    "spawn_agent",
    "TaskCreate",
    "TaskUpdate",
    "WriteStdin",
    "create_goal",
    "get_goal",
    "update_goal",
  ];
  expect([...diagnosticToolNames, ...omitted].sort()).toEqual(
    toolDefinitions.map((d) => d.tool).sort(),
  );
});
