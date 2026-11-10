import { AssistantTurnImageGallery } from "../../src/components/TurnImageGallery";
import { TextBlock } from "../../src/components/blocks/TextBlock";
import { ProviderChildSessionControl } from "../../src/components/ProviderChildSessionControl";
import { SessionViewerProvider } from "../../src/components/SessionManagedViewer";
import { useState } from "react";
import { ToolApprovalPanel } from "../../src/components/ToolApprovalPanel";
import { QuestionAnswerPanel } from "../../src/components/QuestionAnswerPanel";
import { ProjectCodeNameEditor } from "../../src/components/ProjectCodeNameEditor";
import { SourceShortcutHelp } from "../../src/components/SourceShortcutHelp";
import { FilePathCopyButton } from "../../src/components/FilePathLink";
import { AsyncQuestionsButton } from "../../src/components/AsyncQuestionsButton";
import { ToolCallRow } from "../../src/components/blocks/ToolCallRow";
import { Button, IconButton } from "../../src/components/ui/Button";
import { SelectableCard } from "../../src/components/ui/SelectableCard";
import { Spinner } from "../../src/components/ui/Spinner";
import { ReviewCommentsPanel } from "../../src/pages/ReviewCommentsPanel";
import SpeechVocabularyChart from "../../src/pages/settings/SpeechVocabularyChart";
import { useI18n } from "../../src/i18n";
import { SettingsCategoryItem } from "../../src/pages/settings/SettingsCategoryItem";
import queueStyles from "../../src/components/NewSessionProjectQueue.module.css";
import sideStyles from "../../src/extension/sidepanel/SidePanel.module.css";
import childStyles from "../../src/components/ProviderChildSessionControl.module.css";
import previewStyles from "../../src/pages/ConversationPreviewPage.module.css";
import submissionStyles from "../../src/pages/ReviewSubmissionsPanel.module.css";

const longName = `${"a-long-file-name-without-breaks".repeat(5)}.png`;
const galleryHtml = `<p>Images <span class="local-media-link-group"><a class="local-media-link" data-media-type="image" data-ya-path="/tmp/a.png">A</a></span> <span class="local-media-link-group"><a class="local-media-link" data-media-type="image" data-ya-path="/tmp/b.png">B</a></span> after.</p>`;
const galleryItems = [
  {
    id: "gallery-prose",
    type: "text" as const,
    text: "Prose with images",
    augmentHtml: galleryHtml,
    sourceMessages: [],
    sourceBlockIndex: 0,
  },
];
const request = {
  id: "approval",
  sessionId: "controls",
  type: "tool-approval" as const,
  prompt: "Run command?",
  toolName: "Bash",
  toolInput: { command: "pwd" },
  timestamp: "2026-11-10T00:00:00Z",
};
const noop = () => {};
const done = async () => {};
export function Corrections() {
  const [collapsed, setCollapsed] = useState(true);
  const [clicked, setClicked] = useState("");
  const [current, setCurrent] = useState(0);
  const { t } = useI18n();
  return (
    <div data-site="corrections">
      <h2>Panel placement and text flow</h2>
      <div data-case="approval" style={{ marginTop: 24, minHeight: 60 }}>
        <ToolApprovalPanel
          request={request}
          sessionId="controls"
          collapsed={collapsed}
          onCollapsedChange={setCollapsed}
          onApprove={done}
          onDeny={done}
        />
      </div>
      <div data-case="questions" style={{ marginTop: 32 }}>
        <QuestionAnswerPanel
          request={{
            ...request,
            type: "question",
            toolInput: {
              questions: [
                {
                  header: "Choice",
                  question: "Which option?",
                  options: [
                    { label: "One", description: "First" },
                    { label: "Two", description: "Second" },
                  ],
                  multiSelect: false,
                },
              ],
            },
          }}
          sessionId="controls-questions"
          onSubmit={done}
          onDeny={done}
        />
      </div>
      <div data-case="code-name">
        <ProjectCodeNameEditor
          project={{
            id: "p",
            path: "/tmp",
            name: "Project",
            codeName: "anextraordinarilylongprojectname",
            sessionCount: 0,
            activeOwnedCount: 0,
            activeExternalCount: 0,
            lastActivity: null,
          }}
          onUpdateCodeName={done}
          error={null}
          onErrorChange={noop}
          errorId="code-error"
        />
      </div>
      <ReviewCommentsPanel
        projectId="p"
        pending={[
          {
            id: "comment",
            anchor: {
              path: longName,
              revision: { kind: "sha", sha: "1234567890abcdef" },
              side: "new",
              oldLine: null,
              newLine: 123,
              snippet: "line",
            },
            text: "Long path wrapping witness",
            status: "pending",
            createdAt: "2026-11-10T00:00:00Z",
          },
        ]}
        onOpenFile={noop}
        onSubmit={noop}
        t={t}
      />
      <div data-case="files">
        <ToolCallRow
          id="long-image"
          toolName="ViewImage"
          toolInput={{ path: `/tmp/${longName}` }}
          status="complete"
        />
        <ToolCallRow
          id="long-pdf"
          toolName="Read"
          toolInput={{ file_path: `/tmp/${longName}.pdf` }}
          toolResult={{
            content: "PDF",
            structured: {
              type: "pdf",
              file: {
                filePath: `/tmp/${longName}.pdf`,
                base64: "JVBERg==",
                originalSize: 3,
              },
            },
          }}
          status="complete"
        />
        <ToolCallRow
          id="long-pty"
          toolName="WriteStdin"
          toolInput={{
            session_id: "read-pty",
            linked_tool_name: "Read",
            linked_file_path: `/tmp/${longName}`,
          }}
          toolResult={{ content: "first line\nsecond line" }}
          status="complete"
        />
        <ToolCallRow
          id="long-edit"
          toolName="Edit"
          toolInput={{
            file_path: `/tmp/${longName}`,
            old_string: "before",
            new_string: "after",
          }}
          toolResult={{ content: "Updated" }}
          status="complete"
        />
      </div>
      <div data-case="inline">
        <p>
          Prose before{" "}
          <Button variant="outline" size="inline">
            Gallery
          </Button>{" "}
          prose after.
        </p>
        <p>Prose before plain label prose after.</p>
        <span className="file-path">
          /tmp/source.ts <FilePathCopyButton filePath="/tmp/source.ts" />
        </span>
      </div>
      <div data-case="gallery-prose">
        <AssistantTurnImageGallery items={galleryItems}>
          <TextBlock
            text="Prose with images"
            augmentHtml={galleryHtml}
            renderItemId="gallery-prose"
          />
        </AssistantTurnImageGallery>
      </div>
      <div data-case="help" style={{ position: "relative", height: 40 }}>
        <SourceShortcutHelp t={t} />
      </div>
      <div data-case="provider-trigger">
        <SessionViewerProvider sessionId="controls">
          <ProviderChildSessionControl
            projectId="p"
            sessionId="controls"
            basePath=""
            childrenFromSession={[
              {
                id: "child-1",
                parentSessionId: "controls",
                title: "Inspect tree",
                updatedAt: "2026-11-10T00:00:00Z",
              },
              {
                id: "child-2",
                parentSessionId: "controls",
                title: "Review changes",
                updatedAt: "2026-11-10T00:00:00Z",
              },
            ]}
          />
        </SessionViewerProvider>
      </div>
      <div data-case="touch-targets">
        <AsyncQuestionsButton
          inventory={{
            questions: [
              {
                id: "q",
                messageId: "m",
                renderId: "r",
                index: 0,
                title: "Which option?",
                options: ["One", "Two"],
                age: 1,
              },
            ],
            records: {},
            reminderTurns: 3,
            open: noop,
            update: noop,
            menuOpen: false,
            setMenuOpen: noop,
          }}
        />
        <SpeechVocabularyChart
          status={{
            generation: 1,
            enabled: true,
            biasing: true,
            hours: 1,
            sessionMultiplier: 1,
            sessionShare: 0.5,
            totals: { words: 100, user: 100, assistant: 0 },
            words: [
              { word: "known", user: 20, assistant: 0 },
              { word: "unknownword", user: 10, assistant: 0 },
            ],
            scan: { state: "idle", sessions: 1, messages: 1 },
            integration: "grok-via-ya",
          }}
        />
      </div>
      <h2>Card navigation, density and connecting state</h2>
      <div data-case="current-rows">
        {[
          childStyles.selectorItem,
          previewStyles.session,
          submissionStyles.submissionButton,
        ].map((cls, index) => (
          <SelectableCard
            key={cls}
            size="compact"
            className={cls}
            aria-current={current === index ? "true" : undefined}
            onClick={() => setCurrent(index)}
          >
            Navigation row {index + 1}
          </SelectableCard>
        ))}
        <SettingsCategoryItem
          category={{
            id: "about",
            label: "About",
            description: "Settings navigation",
          }}
          isActive
          onClick={noop}
        />
      </div>
      <SelectableCard variant="accent" className={queueStyles.itemButton}>
        Project queue action
      </SelectableCard>
      <SelectableCard size="compact" className={sideStyles.row}>
        SidePanel row
      </SelectableCard>
      <SelectableCard>Relay option</SelectableCard>
      <SelectableCard variant="quiet">Direct option</SelectableCard>
      <SelectableCard disabled aria-busy="true" data-case="connecting">
        <span>Connecting host</span>
        <Spinner size="small" />
      </SelectableCard>
      <div
        className="tool-row-header"
        data-case="dense-taps"
        style={{ display: "flex", gap: 4, marginTop: 24 }}
      >
        {["A", "B", "C"].map((name) => (
          <IconButton
            key={name}
            label={`Dense ${name}`}
            size="dense"
            onClick={() => setClicked(name)}
          >
            {name}
          </IconButton>
        ))}
        <output>{clicked}</output>
      </div>
    </div>
  );
}
