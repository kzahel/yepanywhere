import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { ToolCallRow } from "../../src/components/blocks/ToolCallRow";
import { SessionViewerProvider } from "../../src/components/SessionManagedViewer";
import { SchemaValidationProvider } from "../../src/contexts/SchemaValidationContext";
import { SessionMetadataProvider } from "../../src/contexts/SessionMetadataContext";
import { ToastProvider } from "../../src/contexts/ToastContext";
import { useVersion } from "../../src/hooks/useVersion";
import { I18nProvider } from "../../src/i18n";
import { compileTranscriptProjection } from "@yep-anywhere/shared/transcript/compiler";
import { projectConversationView } from "../../src/lib/sessionDetail/conversationView";
import "../../src/styles/index.css";

function Fixture() {
  useVersion();
  const [data, setData] = useState<{
    projectId: string;
    stdout: string;
    stderr: string;
    toolName?: string;
    command?: string;
    workflowActivation?: string;
  }>();
  useEffect(() => {
    void fetch(`/api/fixture${window.location.search}`)
      .then((response) => response.json())
      .then(setData);
  }, []);
  if (!data) return null;
  const workflow =
    data.workflowActivation &&
    new URLSearchParams(window.location.search).get("workflow") !== "off"
      ? compileTranscriptProjection(
          [
            {
              id: "activate",
              role: "assistant",
              content: data.workflowActivation,
            },
            {
              id: "call",
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: "report",
                  name: data.toolName ?? "Bash",
                  input: {},
                },
              ],
            },
            {
              id: "result",
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: "report",
                  content: data.stdout,
                },
              ],
              toolUseResult:
                data.toolName === "Exec"
                  ? undefined
                  : { stdout: data.stdout, stderr: data.stderr },
            },
          ],
          { workflowTags: true },
        ).find((item) => item.id === "report")?.workflow
      : undefined;
  const visible = projectConversationView(
    [
      {
        type: "tool_call",
        id: "report",
        toolName: data.toolName ?? "Bash",
        toolInput: {},
        toolResult: {
          content: data.stdout,
          isError: false,
          structured: data.toolName === "Exec" ? undefined : data,
        },
        workflow,
        status: "complete",
        sourceMessages: [],
      },
    ],
    { active: false, nowMs: 0 },
  ).some((item) => item.type === "tool_call");
  return (
    <SessionMetadataProvider
      projectId={data.projectId}
      projectPath={null}
      sessionId="commentary-fixture"
    >
      <SessionViewerProvider sessionId="commentary-fixture">
        <main style={{ maxWidth: 740, margin: "24px auto", padding: "0 24px" }}>
          <div className="assistant-turn">
            {(new URLSearchParams(window.location.search).get(
              "conversation",
            ) !== "1" ||
              visible) && (
              <ToolCallRow
                id="report"
                toolName={data.toolName ?? "Bash"}
                toolInput={
                  data.toolName === "Exec"
                    ? {
                        calls: [
                          {
                            toolName: "exec_command",
                            input: {
                              cmd: "pnpm -s artifact:capture index.html --json",
                            },
                          },
                        ],
                        source:
                          "text(await tools.exec_command({cmd: 'pnpm -s artifact:capture index.html --json'}))",
                      }
                    : { command: data.command ?? "report --jsonl" }
                }
                status="complete"
                workflow={workflow}
                toolResult={{
                  content: data.stdout,
                  isError: false,
                  structured:
                    data.toolName === "Exec"
                      ? undefined
                      : { ...data, interrupted: false, isImage: false },
                }}
              />
            )}
          </div>
        </main>
      </SessionViewerProvider>
    </SessionMetadataProvider>
  );
}

createRoot(document.getElementById("root")!).render(
  <I18nProvider>
    <MemoryRouter>
      <ToastProvider>
        <SchemaValidationProvider>
          <Fixture />
        </SchemaValidationProvider>
      </ToastProvider>
    </MemoryRouter>
  </I18nProvider>,
);
