import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  nativeDisplayCases,
  runNativeDisplayCase,
} from "../../server/test/utils/native-tool-display-corpus";
import { toolRegistry } from "../src/components/renderers/tools";
import { displayProviders } from "../src/components/renderers/tools/__fixtures__/displayProviders";
import { toolDisplayDiagnostics } from "../src/components/renderers/tools/displayDiagnostics";
import {
  runNativeDisplayLifecycle,
  runNativeDisplayOwnership,
} from "../../server/test/utils/native-tool-display-lifecycle";
// This provider corpus has no Git backend; provenance is exercised separately.
vi.mock("../src/hooks/useFileVersionControl", () => ({
  useFileVersionControl: () => ({
    cumulativeFile: null,
    worktreeFile: null,
    loading: false,
    relativePath: null,
  }),
}));
const context = {
  isStreaming: false,
  theme: "dark" as const,
  projectPath: "/tmp",
};
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
it("mounts native rejected-to-corrected prefixes without hiding the successful neighbor", async () => {
  const mounted = render(displayProviders(null));
  for (const prefix of [1, 2, 3, 4]) {
    const pair = await runNativeDisplayLifecycle(prefix);
    for (const side of [pair.live, pair.durable]) {
      const nodes = side.renderItems
        .filter((item) => item.type === "tool_call")
        .map((item) => {
          const prepared = toolRegistry.prepare(item.toolName, {
            input: item.toolInput,
            result: item.toolResult?.structured ?? item.toolResult?.content,
            status: item.status,
            isError: item.toolResult?.isError,
          });
          return (
            <div key={item.id} data-call={item.id}>
              {item.toolResult
                ? prepared.renderToolResult(context)
                : prepared.renderToolUse(context)}
            </div>
          );
        });
      mounted.rerender(displayProviders(nodes));
      expect(
        mounted.container.querySelectorAll('[data-tool-display="raw"]'),
      ).toHaveLength(1);
      expect(mounted.container.textContent).toContain(
        prefix === 1 ? "retained rejected body" : "Missing file_path",
      );
      if (prefix === 3)
        expect(mounted.container.textContent).toContain("recovered.ts");
      if (prefix === 4)
        expect(mounted.container.textContent).toContain("File written");
    }
  }
});

it("mounts both independently read child calls while retaining their parent launch mapping", async () => {
  const pair = await runNativeDisplayOwnership();
  expect(pair.mappings).toContainEqual(
    expect.objectContaining({
      toolUseId: pair.parentId,
      agentId: "review-child",
    }),
  );
  for (const side of [pair.live, pair.durable]) {
    const nodes = side.renderItems
      .filter((item) => item.type === "tool_call")
      .map((item) =>
        toolRegistry
          .prepare(item.toolName, {
            input: item.toolInput,
            result: item.toolResult?.structured ?? item.toolResult?.content,
            status: item.status,
            isError: item.toolResult?.isError,
          })
          .renderToolResult(context),
      );
    const mounted = render(
      displayProviders(
        nodes.map((node, index) => <div key={index}>{node}</div>),
      ),
    );
    expect(mounted.container.textContent).toContain("Missing file_path");
    expect(mounted.container.textContent).toContain("File written");
    expect(
      mounted.container.querySelectorAll('[data-tool-display="raw"]'),
    ).toHaveLength(1);
    mounted.unmount();
  }
});
for (const fixture of nativeDisplayCases)
  it(`mounts ${fixture.provider === "gemini" ? "historical" : "native live and durable"} ${fixture.id}`, async () => {
    const pair = await runNativeDisplayCase(fixture);
    const outputs = pair.live ? [pair.live, pair.durable] : [pair.durable];
    for (const output of outputs) {
      const call = output.renderItems.find((item) => item.type === "tool_call");
      if (call?.type !== "tool_call")
        throw new Error("Missing native tool call");
      const prepared = toolRegistry.prepare(call.toolName, {
        input: call.toolInput,
        result: call.toolResult?.structured ?? call.toolResult?.content,
        status: call.status,
        isError: call.toolResult?.isError,
      });
      if (fixture.expectedOperation) {
        expect(prepared.kind).toBe(fixture.expectedKind);
        const mounted = render(
          displayProviders(prepared[fixture.expectedOperation](context)),
        );
        expect(mounted.container.textContent).toContain(fixture.text);
        expect(
          mounted.container.querySelector('[data-tool-display="raw"]'),
        ).toBeNull();
        mounted.unmount();
        continue;
      }
      let visible = [
        prepared.getDisplayName(),
        prepared.getUseSummary(context),
        prepared.getResultSummary(context),
      ].join(" ");
      for (const node of [
        prepared.renderToolUse(context),
        prepared.renderToolResult(context),
        prepared.renderCollapsedPreview(context),
        prepared.renderInline(context),
        prepared.renderInteractiveSummary(context),
      ]) {
        const mounted = render(displayProviders(node));
        expect(
          !!mounted.container.querySelector('[data-tool-display="raw"]'),
        ).toBe(!!fixture.isError);
        visible += mounted.container.textContent;
        mounted.unmount();
      }
      expect(visible).toContain(fixture.text);
    }
  });
