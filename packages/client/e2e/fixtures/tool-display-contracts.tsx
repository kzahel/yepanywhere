import { useState } from "react";
import { createRoot } from "react-dom/client";
import { displayProviders } from "../../src/components/renderers/tools/__fixtures__/displayProviders";
import { ToolCallRow } from "../../src/components/blocks/ToolCallRow";
import { TaskNestedContent } from "../../src/components/renderers/tools/TaskNestedContent";
import { toolDisplayDiagnostics } from "../../src/components/renderers/tools/displayDiagnostics";
import { toolRegistry } from "../../src/components/renderers/tools";
import "../../src/styles/purposeGlobals";
function Fixture() {
  const [corrected, setCorrected] = useState(false);
  const [complete, setComplete] = useState(false);
  return (
    <main style={{ maxWidth: 760, margin: "20px auto", padding: "0 16px" }}>
      <h2>Tool display contracts</h2>
      <ToolCallRow
        id="valid"
        toolName="Write"
        toolInput={{
          file_path: "/tmp/contract.ts",
          content: "export const checked = true;",
          _highlightedContentHtml:
            '<pre><code><span class="line">export const checked = true;</span></code></pre>',
        }}
        toolResult={{ content: "File written", isError: false }}
        status="complete"
      />
      <section aria-label="Recoverable Write">
        <ToolCallRow
          id="recovery"
          toolName="Write"
          toolInput={
            corrected
              ? { file_path: "/tmp/recovered.ts", content: "Recovered content" }
              : { content: "validation-test" }
          }
          toolResult={{
            content: corrected
              ? "File written"
              : "InputValidationError: The required parameter file_path is missing",
            isError: !corrected,
          }}
          status={corrected ? "complete" : "error"}
        />
        <button type="button" onClick={() => setCorrected(true)}>
          Correct record
        </button>
      </section>
      <ToolCallRow
        id="partial"
        toolName="Read"
        toolInput={{ file_path: "/tmp/notes.txt" }}
        toolResult={{
          content: "Plain text remains readable without file metadata.",
          isError: false,
        }}
        status="complete"
      />
      <section aria-label="Pending call">
        <ToolCallRow
          id="pending"
          toolName="Bash"
          toolInput={{ command: "printf contract" }}
          toolResult={
            complete
              ? { content: "contract output", isError: false }
              : undefined
          }
          status={complete ? "complete" : "pending"}
        />
        <button type="button" onClick={() => setComplete(true)}>
          Complete pending call
        </button>
      </section>
      <details open>
        <summary>Subagent tools</summary>
        <TaskNestedContent
          isStreaming={false}
          messages={[
            {
              id: "child-use",
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: "child-write",
                  name: "Write",
                  input: { content: "nested validation-test" },
                },
              ],
            },
            {
              id: "child-result",
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: "child-write",
                  content: "Missing file_path in subagent Write",
                  is_error: true,
                },
              ],
            },
          ]}
        />
      </details>
      <output data-testid="catches">
        {toolDisplayDiagnostics.synchronousCatches +
          toolDisplayDiagnostics.renderCatches}
      </output>
    </main>
  );
}
function ReviewFixture() {
  const context = { isStreaming: false, theme: "dark" as const };
  const search = toolRegistry.prepare("WebSearch", {
    input: { query: "display contracts" },
    status: "complete",
    result: {
      query: "display contracts",
      durationSeconds: 0.5,
      results: [
        "Provider commentary",
        {
          content: [
            {
              title: "Contract reference",
              url: "https://example.com/contracts",
            },
          ],
        },
      ],
    },
  });
  const pdf = toolRegistry.prepare("Read", {
    input: undefined,
    status: "complete",
    result: {
      type: "pdf",
      file: {
        filePath: "/tmp/reference.pdf",
        base64: "JVBERi0=",
        originalSize: 1024,
      },
    },
  });
  const edit = toolRegistry.prepare("Edit", {
    input: {
      file_path: "/tmp/checked.ts",
      old_string: "unchecked",
      new_string: "checked",
      _structuredPatch: [
        {
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 1,
          lines: ["-unchecked", "+checked"],
        },
      ],
    },
    result: "User rejected tool use",
    status: "error",
  });
  const plan = toolRegistry.prepare("ExitPlanMode", {
    input: undefined,
    status: "complete",
    result: {
      plan: "Preserve provider output and verify each display operation.",
    },
  });
  return (
    <main style={{ maxWidth: 760, margin: "20px auto", padding: "0 16px" }}>
      <h2>Tool display regression controls</h2>
      <h3>Search with provider commentary</h3>
      {search.renderToolResult(context)}
      <h3>PDF without original input</h3>
      {pdf.renderToolResult(context)}
      <h3>Declined edit with proposed diff</h3>
      {edit.renderToolResult(context)}
      <h3>Standalone plan</h3>
      {plan.renderToolResult(context)}
      <output data-testid="catches">
        {toolDisplayDiagnostics.synchronousCatches +
          toolDisplayDiagnostics.renderCatches}
      </output>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(
  displayProviders(
    new URLSearchParams(location.search).has("review") ? (
      <ReviewFixture />
    ) : (
      <Fixture />
    ),
  ),
);
