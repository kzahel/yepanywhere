import { createRoot } from "react-dom/client";
import { ToolCallRow } from "../../src/components/blocks/ToolCallRow";
import { displayProviders } from "../../src/components/renderers/tools/__fixtures__/displayProviders";
import "../../src/styles/purposeGlobals";

const output =
  "timeout waiting for master-release-hostpaths-20260915 to reach not-running; current status=running";
createRoot(document.getElementById("root")!).render(
  displayProviders(
    <main style={{ maxWidth: 1000, margin: "24px auto", padding: "0 24px" }}>
      <h2>Command waits</h2>
      <section aria-label="Command">
        <ToolCallRow
          id="command"
          toolName="Bash"
          toolInput={{
            command:
              "agentctl wait master-release-hostpaths-20260915 --timeout 60",
          }}
          toolResult={{
            content: "permission denied while inspecting the release",
            structured: {
              stdout: "permission denied while inspecting the release",
              exitCode: 1,
            },
            isError: true,
          }}
          status="error"
        />
      </section>
      <section aria-label="Simple poll">
        <ToolCallRow
          id="poll"
          toolName="WriteStdin"
          toolInput={{ session_id: 42, chars: "" }}
          toolResult={{
            content: output,
            structured: { stdout: output, exitCode: 1 },
            isError: true,
          }}
          status="error"
        />
      </section>
      <section aria-label="Long failure">
        <ToolCallRow
          id="long"
          toolName="WriteStdin"
          toolInput={{ session_id: 43, chars: "" }}
          toolResult={{
            content: "first diagnostic\nsecond diagnostic\nthird diagnostic",
            isError: true,
          }}
          status="error"
        />
      </section>
    </main>,
  ),
);
