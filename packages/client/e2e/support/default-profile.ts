import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { InstallService } from "../../../server/src/services/InstallService.js";
import { defaultProfilePaths } from "./profile-paths.js";

const __dirname = join(dirname(fileURLToPath(import.meta.url)), "..");

export async function seedDefaultProfile(directory: string) {
  const paths = defaultProfilePaths(directory);
  const {
    tempDir: E2E_TEMP_DIR,
    testDir: E2E_TEST_DIR,
    claudeSessionsDir: E2E_CLAUDE_SESSIONS_DIR,
    codexSessionsDir: E2E_CODEX_SESSIONS_DIR,
    geminiSessionsDir: E2E_GEMINI_SESSIONS_DIR,
    dataDir: E2E_DATA_DIR,
    portFile: PORT_FILE,
    maintenancePortFile: MAINTENANCE_PORT_FILE,
    pidFile: PID_FILE,
    remoteClientPortFile: REMOTE_CLIENT_PORT_FILE,
    remoteClientPidFile: REMOTE_CLIENT_PID_FILE,
    remotePreviewPortFile: REMOTE_PREVIEW_PORT_FILE,
    remotePreviewPidFile: REMOTE_PREVIEW_PID_FILE,
    relayPortFile: RELAY_PORT_FILE,
    relayPidFile: RELAY_PID_FILE,
  } = paths;
  // Create isolated test directories
  console.log(`[E2E] Creating isolated test directories at ${E2E_TEST_DIR}`);
  mkdirSync(E2E_CLAUDE_SESSIONS_DIR, { recursive: true });
  mkdirSync(E2E_CODEX_SESSIONS_DIR, { recursive: true });
  mkdirSync(E2E_GEMINI_SESSIONS_DIR, { recursive: true });
  mkdirSync(E2E_DATA_DIR, { recursive: true });
  // This fixture models an installation with saved sessions from these
  // providers. Retained collections only discover successfully used stores;
  // creating transcript files alone intentionally does not enroll a provider.
  const installService = new InstallService({ dataDir: E2E_DATA_DIR });
  await installService.initialize();
  await installService.recordSuccessfulProviders(["claude", "codex", "gemini"]);
  writeFileSync(
    join(E2E_DATA_DIR, "server-settings.json"),
    JSON.stringify(
      {
        version: 1,
        settings: {
          codexUpdatePolicy: "off",
        },
      },
      null,
      2,
    ),
  );

  // Write paths file for tests to import
  const pathsFile = join(E2E_TEMP_DIR, "paths.json");
  writeFileSync(
    pathsFile,
    JSON.stringify({
      tempDir: E2E_TEMP_DIR,
      testDir: E2E_TEST_DIR,
      claudeSessionsDir: E2E_CLAUDE_SESSIONS_DIR,
      codexSessionsDir: E2E_CODEX_SESSIONS_DIR,
      geminiSessionsDir: E2E_GEMINI_SESSIONS_DIR,
      dataDir: E2E_DATA_DIR,
      portFile: PORT_FILE,
      maintenancePortFile: MAINTENANCE_PORT_FILE,
      pidFile: PID_FILE,
      remoteClientPortFile: REMOTE_CLIENT_PORT_FILE,
      remoteClientPidFile: REMOTE_CLIENT_PID_FILE,
      remotePreviewPortFile: REMOTE_PREVIEW_PORT_FILE,
      remotePreviewPidFile: REMOTE_PREVIEW_PID_FILE,
      relayPortFile: RELAY_PORT_FILE,
      relayPidFile: RELAY_PID_FILE,
    }),
  );

  // Create mock project data for tests that expect a session to exist
  const mockProjectPath = join(E2E_TEMP_DIR, "mockproject");
  mkdirSync(mockProjectPath, { recursive: true });
  writeFileSync(
    join(mockProjectPath, "GLOSSARY.md"),
    [
      "# Glossary",
      "",
      "| term | definition | references |",
      "| --- | --- | --- |",
      "| Viewer context | The active session's project context for a viewed file. | |",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(mockProjectPath, "turn-target.md"),
    "# User-turn link target\n",
  );
  const encodedPath = mockProjectPath.replace(/\//g, "-");
  const mockSessionDir = join(E2E_CLAUDE_SESSIONS_DIR, hostname(), encodedPath);
  mkdirSync(mockSessionDir, { recursive: true });
  const sessionFile = join(mockSessionDir, "mock-session-001.jsonl");
  const mockMessages = [
    {
      type: "user",
      cwd: mockProjectPath,
      message: { role: "user", content: "Previous message" },
      timestamp: new Date().toISOString(),
      uuid: "1",
    },
  ];
  writeFileSync(
    sessionFile,
    mockMessages.map((m) => JSON.stringify(m)).join("\n"),
  );
  console.log(`[E2E] Created mock session at ${sessionFile}`);

  const scrollMemorySessionFile = join(
    mockSessionDir,
    "scroll-memory-001.jsonl",
  );
  const scrollMemoryResponse = Array.from(
    { length: 180 },
    (_, index) => `Scroll memory response paragraph ${index + 1}.`,
  ).join("\n\n");
  writeFileSync(
    scrollMemorySessionFile,
    [
      {
        type: "user",
        cwd: mockProjectPath,
        message: { role: "user", content: "Scroll memory fixture" },
        timestamp: "2026-01-01T00:00:00.000Z",
        uuid: "scroll-memory-user-1",
      },
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: scrollMemoryResponse }],
        },
        timestamp: "2026-01-01T00:00:01.000Z",
        uuid: "scroll-memory-assistant-1",
        parentUuid: "scroll-memory-user-1",
      },
    ]
      .map((message) => JSON.stringify(message))
      .join("\n"),
  );
  console.log(
    `[E2E] Created scroll memory session at ${scrollMemorySessionFile}`,
  );

  // A mermaid fence and an ordinary highlighted fence, so one fixture covers
  // both the per-language renderer and the language label.
  const mermaidDiagram = [
    "```mermaid",
    "sequenceDiagram",
    "  participant Phone",
    "  participant Server",
    "  participant Claude",
    "  Phone->>Server: send prompt",
    "  Server->>Claude: start turn",
    "  Claude-->>Server: stream tokens",
    "  Server-->>Phone: rendered augments",
    "```",
  ].join("\n");
  const codeFenceMarkdown = [
    "Supervising a turn moves through three hops.",
    "",
    mermaidDiagram,
    "",
    "The server owns the process, so a disconnect does not stop it:",
    "",
    "```typescript",
    "export function streamTurn(prompt: string): AsyncIterable<Augment> {",
    "  return supervisor.start(prompt);",
    "}",
    "```",
  ].join("\n");
  const codeFenceSessionFile = join(
    mockSessionDir,
    "code-fence-mermaid-001.jsonl",
  );
  writeFileSync(
    codeFenceSessionFile,
    [
      {
        type: "user",
        cwd: mockProjectPath,
        message: { role: "user", content: "Diagram how a turn reaches Claude" },
        timestamp: "2026-01-05T00:00:00.000Z",
        uuid: "code-fence-user-1",
      },
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: codeFenceMarkdown }],
        },
        timestamp: "2026-01-05T00:00:01.000Z",
        uuid: "code-fence-assistant-1",
        parentUuid: "code-fence-user-1",
      },
    ]
      .map((message) => JSON.stringify(message))
      .join("\n"),
  );
  writeFileSync(
    join(mockProjectPath, "diagram-notes.md"),
    ["# Turn flow", "", mermaidDiagram, ""].join("\n"),
  );
  console.log(`[E2E] Created code fence session at ${codeFenceSessionFile}`);

  const providerChildSessionId = "provider-child-layout-001";
  writeFileSync(
    join(mockSessionDir, `${providerChildSessionId}.jsonl`),
    mockMessages.map((message) => JSON.stringify(message)).join("\n"),
  );
  const providerChildDir = join(
    mockSessionDir,
    providerChildSessionId,
    "subagents",
  );
  mkdirSync(providerChildDir, { recursive: true });
  writeFileSync(
    join(providerChildDir, "agent-layout-child.jsonl"),
    [
      {
        type: "user",
        uuid: "provider-child-user-1",
        agentId: "layout-child",
        isSidechain: true,
        sessionId: providerChildSessionId,
        message: { content: "Inspect the provider child layout." },
      },
      {
        type: "assistant",
        uuid: "provider-child-assistant-1",
        parentUuid: "provider-child-user-1",
        agentId: "layout-child",
        isSidechain: true,
        message: {
          content: [
            {
              type: "text",
              text: "The compact title layout keeps the transcript visible.",
            },
          ],
        },
      },
      {
        type: "result",
        uuid: "provider-child-result-1",
        parentUuid: "provider-child-assistant-1",
      },
    ]
      .map((message) => JSON.stringify(message))
      .join("\n"),
  );
  writeFileSync(
    join(providerChildDir, "agent-layout-child.meta.json"),
    JSON.stringify({
      agentType: "Explore",
      description: "Inspect the provider child layout",
      spawnDepth: 1,
    }),
  );
  console.log("[E2E] Created provider child layout session");

  for (const speechSessionId of [
    "speech-caret-001",
    "speech-caret-002",
    "speech-caret-003",
    "speech-caret-004",
    "speech-caret-006",
  ]) {
    writeFileSync(
      join(mockSessionDir, `${speechSessionId}.jsonl`),
      mockMessages.map((message) => JSON.stringify(message)).join("\n"),
    );
  }
  console.log("[E2E] Created isolated speech composer sessions");

  // A project no other test touches, so a check that needs the whole project
  // idle is not falsified by sessions earlier tests left active in
  // mockproject.
  const idleProjectPath = join(E2E_TEMP_DIR, "idle-queue-project");
  mkdirSync(idleProjectPath, { recursive: true });
  const idleSessionDir = join(
    E2E_CLAUDE_SESSIONS_DIR,
    hostname(),
    idleProjectPath.replace(/\//g, "-"),
  );
  mkdirSync(idleSessionDir, { recursive: true });
  writeFileSync(
    join(idleSessionDir, "idle-queue-session-001.jsonl"),
    mockMessages
      .map((message) => JSON.stringify({ ...message, cwd: idleProjectPath }))
      .join("\n"),
  );
  console.log("[E2E] Created idle Project Queue project");

  // Deterministic transcript specimen for semantic-boundary browser gates.
  // Keep it separate from mock-session-001 so transport/navigation tests that
  // expect the historical one-row fixture retain their exact input.
  const transcriptSpecimenFile = join(
    mockSessionDir,
    "transcript-specimen-001.jsonl",
  );
  const transcriptSpecimenMessages = [
    {
      type: "user",
      cwd: mockProjectPath,
      message: { role: "user", content: "Inspect the browser specimen" },
      timestamp: "2026-01-01T00:00:00.000Z",
      uuid: "specimen-user-1",
    },
    {
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "I should inspect the fixture." },
          { type: "text", text: "I’ll read the file." },
          {
            type: "tool_use",
            id: "specimen-tool-1",
            name: "Read",
            input: { file_path: "fixture.ts" },
          },
        ],
      },
      timestamp: "2026-01-01T00:00:01.000Z",
      uuid: "specimen-assistant-1",
      parentUuid: "specimen-user-1",
    },
    {
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "specimen-tool-1",
            content: "export const fixture = true;",
          },
        ],
      },
      toolUseResult: { filePath: "fixture.ts", lineCount: 1 },
      timestamp: "2026-01-01T00:00:02.000Z",
      uuid: "specimen-result-1",
      parentUuid: "specimen-assistant-1",
    },
    {
      type: "system",
      subtype: "tool_output",
      content: "new message from the release channel",
      codexToolName: "notifications",
      codexToolNamespace: "slack",
      timestamp: "2026-01-01T00:00:03.000Z",
      uuid: "specimen-tool-output-1",
      parentUuid: "specimen-result-1",
    },
    {
      type: "system",
      subtype: "compact_boundary",
      content: "Context compacted",
      timestamp: "2026-01-01T00:00:04.000Z",
      uuid: "specimen-compact-1",
      parentUuid: "specimen-tool-output-1",
    },
    {
      type: "assistant",
      message: { role: "assistant", content: "The specimen is ready." },
      timestamp: "2026-01-01T00:00:05.000Z",
      uuid: "specimen-assistant-2",
      parentUuid: "specimen-compact-1",
    },
  ];
  writeFileSync(
    transcriptSpecimenFile,
    transcriptSpecimenMessages
      .map((message) => JSON.stringify(message))
      .join("\n"),
  );
  console.log(`[E2E] Created transcript specimen at ${transcriptSpecimenFile}`);

  // Grouped image reads whose results carry metadata and a path but no bytes:
  // the shape YA stores once it materializes tool-result media. The strip in the
  // explored group re-reads these files, so they must exist in the project.
  const exploredImageNames = ["diagram.png", "badge.png"];
  const exploredImageSources = [
    join(__dirname, "..", "public", "icon-192.png"),
    join(__dirname, "..", "public", "icon-512.png"),
  ];
  for (const [index, name] of exploredImageNames.entries()) {
    const source = exploredImageSources[index];
    if (source) copyFileSync(source, join(mockProjectPath, name));
  }
  const exploredImageMessages = [
    {
      type: "user",
      cwd: mockProjectPath,
      message: { role: "user", content: "Look at the two screenshots" },
      timestamp: "2026-01-01T00:00:00.000Z",
      uuid: "explored-images-user-1",
    },
    {
      type: "assistant",
      message: {
        role: "assistant",
        content: exploredImageNames.map((name, index) => ({
          type: "tool_use",
          id: `explored-image-${index}`,
          name: "Read",
          input: { file_path: join(mockProjectPath, name) },
        })),
      },
      timestamp: "2026-01-01T00:00:01.000Z",
      uuid: "explored-images-assistant-1",
      parentUuid: "explored-images-user-1",
    },
    ...exploredImageNames.map((name, index) => ({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: `explored-image-${index}`,
            content: `Read image ${name}`,
          },
        ],
      },
      toolUseResult: {
        type: "image",
        file: {
          type: "image/png",
          originalSize: 4096,
          dimensions: {
            originalWidth: 192,
            originalHeight: 192,
            displayWidth: 192,
            displayHeight: 192,
          },
        },
      },
      timestamp: `2026-01-01T00:00:0${2 + index}.000Z`,
      uuid: `explored-images-result-${index}`,
      parentUuid: "explored-images-assistant-1",
    })),
    {
      type: "assistant",
      message: { role: "assistant", content: "Both screenshots look right." },
      timestamp: "2026-01-01T00:00:05.000Z",
      uuid: "explored-images-assistant-2",
      parentUuid: "explored-images-result-1",
    },
  ];
  writeFileSync(
    join(mockSessionDir, "explored-images-001.jsonl"),
    exploredImageMessages.map((message) => JSON.stringify(message)).join("\n"),
  );
  console.log("[E2E] Created explored image-read session");

  const historySearchSessionFile = join(
    mockSessionDir,
    "history-search-001.jsonl",
  );
  const historySearchMessages = [
    {
      type: "user",
      cwd: mockProjectPath,
      message: {
        role: "user",
        content: "The archived horizon needle is in the oldest page.",
      },
      timestamp: "2026-01-02T00:00:00.000Z",
      uuid: "history-user-0",
    },
    {
      type: "assistant",
      message: { role: "assistant", content: "Archived answer 0." },
      timestamp: "2026-01-02T00:00:01.000Z",
      uuid: "history-assistant-0",
      parentUuid: "history-user-0",
    },
    ...Array.from({ length: 9 }, (_, index) => {
      const number = index + 1;
      return [
        {
          type: "system",
          subtype: "compact_boundary",
          content: `History search compaction ${number}`,
          compactMetadata: { trigger: "auto", preTokens: number * 1000 },
          timestamp: `2026-01-02T00:00:${String(number * 3 - 1).padStart(2, "0")}.000Z`,
          uuid: `history-compact-${number}`,
          parentUuid: null,
          logicalParentUuid: `history-assistant-${index}`,
        },
        {
          type: "user",
          message: {
            role: "user",
            content:
              number === 9
                ? "The recent horizon needle remains in the loaded tail."
                : `History search filler turn ${number}.`,
          },
          timestamp: `2026-01-02T00:00:${String(number * 3).padStart(2, "0")}.000Z`,
          uuid: `history-user-${number}`,
          parentUuid: `history-compact-${number}`,
        },
        {
          type: "assistant",
          message: {
            role: "assistant",
            content: `History search answer ${number}.`,
          },
          timestamp: `2026-01-02T00:00:${String(number * 3 + 1).padStart(2, "0")}.000Z`,
          uuid: `history-assistant-${number}`,
          parentUuid: `history-user-${number}`,
        },
      ];
    }).flat(),
  ];
  writeFileSync(
    historySearchSessionFile,
    historySearchMessages.map((message) => JSON.stringify(message)).join("\n"),
  );
  console.log(
    `[E2E] Created history-search session at ${historySearchSessionFile}`,
  );

  const userTurnPresentationFile = join(
    mockSessionDir,
    "user-turn-presentation-001.jsonl",
  );
  const userTurnPresentationMessages = [
    {
      type: "user",
      cwd: mockProjectPath,
      message: {
        role: "user",
        content:
          "Viewer context: inspect turn-target.md, then summarize the visible result and keep this deliberately long source sentence on one rendered desktop line.",
      },
      timestamp: "2026-01-03T00:00:00.000Z",
      uuid: "user-turn-presentation-1",
    },
    {
      type: "assistant",
      message: {
        role: "assistant",
        content: "The short-width-dependent turn is complete.",
      },
      timestamp: "2026-01-03T00:00:01.000Z",
      uuid: "user-turn-presentation-assistant-1",
      parentUuid: "user-turn-presentation-1",
    },
    {
      type: "user",
      message: {
        role: "user",
        content: [
          "This turn is deliberately tall.",
          "Its visible lines contain the action rail.",
          "Line three keeps the bubble tall.",
          "Line four keeps the bubble tall.",
          "Line five keeps the bubble tall.",
          "Line six keeps the bubble tall.",
          "Line seven keeps the bubble tall.",
          "Line eight keeps the bubble tall.",
        ].join("\n"),
      },
      timestamp: "2026-01-03T00:00:02.000Z",
      uuid: "user-turn-presentation-2",
      parentUuid: "user-turn-presentation-assistant-1",
    },
    {
      type: "assistant",
      message: {
        role: "assistant",
        content: "The explicitly tall turn is complete.",
      },
      timestamp: "2026-01-03T00:00:03.000Z",
      uuid: "user-turn-presentation-assistant-2",
      parentUuid: "user-turn-presentation-2",
    },
  ];
  writeFileSync(
    userTurnPresentationFile,
    userTurnPresentationMessages
      .map((message) => JSON.stringify(message))
      .join("\n"),
  );
  console.log(
    `[E2E] Created user-turn presentation fixture at ${userTurnPresentationFile}`,
  );

  const pageKeyPaginationFile = join(
    mockSessionDir,
    "page-key-pagination-001.jsonl",
  );
  const pageKeyPaginationMessages = Array.from({ length: 30 }, (_, index) => ({
    type: "user",
    ...(index === 0 ? { cwd: mockProjectPath } : {}),
    message: {
      role: "user",
      content:
        index === 0
          ? "Oldest keyboard request"
          : index === 10
            ? "Intermediate keyboard request"
            : index === 29
              ? "Current keyboard request"
              : `Keyboard request ${index + 1}`,
    },
    timestamp: `2026-01-02T00:00:${String(index).padStart(2, "0")}.000Z`,
    uuid: `page-key-user-${index + 1}`,
    ...(index > 0 ? { parentUuid: `page-key-user-${index}` } : {}),
  }));
  writeFileSync(
    pageKeyPaginationFile,
    pageKeyPaginationMessages
      .map((message) => JSON.stringify(message))
      .join("\n"),
  );
  console.log(
    `[E2E] Created page-key pagination fixture at ${pageKeyPaginationFile}`,
  );

  // Two long multi-turn sessions in one project, so direct session switching
  // exercises the parked-layer swap with a transcript longer than its
  // retained tail.
  const switchStartMs = Date.now() - 60 * 60 * 1000;
  for (const label of ["a", "b"] as const) {
    const switchSessionId = `switch-scroll-${label}`;
    const switchMessages = Array.from({ length: 90 }, (_, turn) => {
      const timestamp = (offsetMs: number) =>
        new Date(switchStartMs + turn * 10_000 + offsetMs).toISOString();
      return [
        {
          type: "user",
          ...(turn === 0 ? { cwd: mockProjectPath } : {}),
          message: {
            role: "user",
            content: `Switch ${label} request ${turn + 1}`,
          },
          timestamp: timestamp(0),
          uuid: `switch-${label}-user-${turn + 1}`,
          ...(turn > 0
            ? { parentUuid: `switch-${label}-assistant-${turn}` }
            : {}),
        },
        {
          type: "assistant",
          message: {
            role: "assistant",
            content: [
              {
                type: "text",
                text: `Switch ${label} reply ${turn + 1}.\n\nSecond paragraph of reply ${turn + 1}.`,
              },
            ],
          },
          timestamp: timestamp(1_000),
          uuid: `switch-${label}-assistant-${turn + 1}`,
          parentUuid: `switch-${label}-user-${turn + 1}`,
        },
      ];
    }).flat();
    writeFileSync(
      join(mockSessionDir, `${switchSessionId}.jsonl`),
      switchMessages.map((message) => JSON.stringify(message)).join("\n"),
    );
  }

  // Create the file-browser fixture before the server starts so its initial
  // project snapshot sees it even when no installed provider activates a
  // filesystem watcher (as on a clean CI runner).
  const fileBrowserProjectPath = join(E2E_TEMP_DIR, "file-browser-project");
  mkdirSync(join(fileBrowserProjectPath, "src"), { recursive: true });
  writeFileSync(
    join(fileBrowserProjectPath, "test.txt"),
    "Hello from test file!",
  );
  writeFileSync(
    join(fileBrowserProjectPath, "README.md"),
    [
      "# Test Project",
      "",
      "This is a **test** markdown file.",
      "",
      "Viewer context remains available while reviewing this file.",
      "",
      "## Scroll clearance specimen",
      "",
      ...Array.from(
        { length: 60 },
        (_, index) => `Scrollable paragraph ${index + 1}.`,
      ),
      "",
      "End of file viewer clearance specimen.",
    ].join("\n"),
  );
  writeFileSync(
    join(fileBrowserProjectPath, "embedded-html.md"),
    [
      "# Runtime comparison",
      "",
      "<table>",
      "  <thead>",
      '    <tr><th rowspan="2">Runtime</th><th colspan="2">Latency</th></tr>',
      "    <tr><th>Cold</th><th>Warm</th></tr>",
      "  </thead>",
      "  <tbody>",
      '    <tr><th rowspan="2">Desktop</th><td>120 ms</td><td>45 ms</td></tr>',
      '    <tr><td colspan="2">Stable after reload</td></tr>',
      '    <tr><td rowspan="2">Phone</td><td>150 ms</td><td>55 ms</td></tr>',
      '    <tr><td colspan="2">Fits the narrow viewer</td></tr>',
      "  </tbody>",
      "</table>",
    ].join("\n"),
  );
  writeFileSync(
    join(fileBrowserProjectPath, "src", "index.ts"),
    [
      'export const alpha = "first highlighted line";',
      'export const beta = "second highlighted line";',
      `export const wrapped = "wrapped-selection-start ${"0123456789 ".repeat(24)}wrapped-selection-end";`,
      'export const repeated = "same marker";',
      'export const repeatedAgain = "same marker";',
      "console.log(alpha, beta, wrapped, repeated, repeatedAgain);",
    ].join("\n"),
  );
  writeFileSync(join(fileBrowserProjectPath, "data.json"), '{"key": "value"}');
  writeFileSync(
    join(fileBrowserProjectPath, "hostile.html"),
    '<script>fetch("/api/processes", { headers: { "X-Yep-Anywhere": "true" } }).then(() => { document.title = "EXECUTED"; })</script>',
  );
  writeFileSync(
    join(fileBrowserProjectPath, "hostile.svg"),
    '<svg xmlns="http://www.w3.org/2000/svg" onload="fetch(\'/api/processes\', { headers: { \'X-Yep-Anywhere\': \'true\' } })"><rect width="10" height="10"/></svg>',
  );
  const fileBrowserSessionDir = join(
    E2E_CLAUDE_SESSIONS_DIR,
    hostname(),
    fileBrowserProjectPath.replace(/[/\\:]/g, "-"),
  );
  mkdirSync(fileBrowserSessionDir, { recursive: true });
  writeFileSync(
    join(fileBrowserSessionDir, "e2e-file-test.jsonl"),
    JSON.stringify({
      type: "user",
      cwd: fileBrowserProjectPath,
      message: { role: "user", content: "test" },
    }),
  );
  console.log(
    `[E2E] Created file-browser fixture at ${fileBrowserProjectPath}`,
  );

  // A dedicated clean Git project keeps Source Control browser tests isolated
  // from fixtures that other specs intentionally mutate.
  const sourceControlProjectPath = join(E2E_TEMP_DIR, "source-control-project");
  mkdirSync(sourceControlProjectPath, { recursive: true });
  writeFileSync(
    join(sourceControlProjectPath, "README.md"),
    [
      "# Source Control browser fixture",
      "prefix/that/is/intentionally/long/enough/to/be/truncated/while/searching/ZebraNeedle/and/a/long/trailing/suffix/for/the/source/control/result",
      "",
    ].join("\n"),
  );
  execFileSync("git", ["init", "--initial-branch=main"], {
    cwd: sourceControlProjectPath,
    stdio: "ignore",
  });
  execFileSync("git", ["add", "README.md"], {
    cwd: sourceControlProjectPath,
    stdio: "ignore",
  });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=YA E2E",
      "-c",
      "user.email=ya-e2e@example.invalid",
      "commit",
      "-m",
      "Seed source control fixture",
    ],
    {
      cwd: sourceControlProjectPath,
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: "2026-01-03T00:00:00Z",
        GIT_COMMITTER_DATE: "2026-01-03T00:00:00Z",
      },
      stdio: "ignore",
    },
  );
  const sourceControlSessionDir = join(
    E2E_CLAUDE_SESSIONS_DIR,
    hostname(),
    sourceControlProjectPath.replace(/[/\\:]/g, "-"),
  );
  mkdirSync(sourceControlSessionDir, { recursive: true });
  writeFileSync(
    join(sourceControlSessionDir, "source-control-clean-001.jsonl"),
    JSON.stringify({
      type: "user",
      cwd: sourceControlProjectPath,
      message: { role: "user", content: "Inspect the clean repository" },
      timestamp: "2026-01-03T00:00:01.000Z",
      uuid: "source-control-user-1",
    }),
  );
  console.log(
    `[E2E] Created clean Source Control fixture at ${sourceControlProjectPath}`,
  );

  // This project must exist before the server assembles its project inventory.
  // The spec dirties the committed file after global setup.
  const sourceControlToolbarProjectPath = join(
    E2E_TEMP_DIR,
    "source-control-toolbar-project",
  );
  const sourceControlToolbarFileName =
    "claude-gateway-process-start-and-output-collector-with-an-intentionally-long-layout-name-that-wraps-at-medium-width.ts";
  const sourceControlToolbarRelativePath = `src/${sourceControlToolbarFileName}`;
  mkdirSync(join(sourceControlToolbarProjectPath, "src"), { recursive: true });
  writeFileSync(
    join(sourceControlToolbarProjectPath, sourceControlToolbarRelativePath),
    "export const toolbarLayoutFixture = false;\n",
  );
  execFileSync("git", ["init", "--initial-branch=main"], {
    cwd: sourceControlToolbarProjectPath,
    stdio: "ignore",
  });
  execFileSync("git", ["add", sourceControlToolbarRelativePath], {
    cwd: sourceControlToolbarProjectPath,
    stdio: "ignore",
  });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=YA E2E",
      "-c",
      "user.email=ya-e2e@example.invalid",
      "commit",
      "-m",
      "Seed toolbar layout fixture",
    ],
    { cwd: sourceControlToolbarProjectPath, stdio: "ignore" },
  );
  const sourceControlToolbarSessionDir = join(
    E2E_CLAUDE_SESSIONS_DIR,
    hostname(),
    sourceControlToolbarProjectPath.replace(/[/\\:]/g, "-"),
  );
  mkdirSync(sourceControlToolbarSessionDir, { recursive: true });
  writeFileSync(
    join(sourceControlToolbarSessionDir, "source-control-toolbar-001.jsonl"),
    JSON.stringify({
      type: "user",
      cwd: sourceControlToolbarProjectPath,
      message: { role: "user", content: "Inspect the diff toolbar layout" },
      timestamp: "2026-01-03T00:00:02.000Z",
      uuid: "source-control-toolbar-user-1",
    }),
  );
  console.log(
    `[E2E] Created Source Control toolbar fixture at ${sourceControlToolbarProjectPath}`,
  );

  // A separate dirty Quarto project exercises the rendered-document path
  // without changing the clean-landing fixture above.
  const sourceControlQmdProjectPath = join(
    E2E_TEMP_DIR,
    "source-control-qmd-project",
  );
  mkdirSync(join(sourceControlQmdProjectPath, "sections"), { recursive: true });
  writeFileSync(
    join(sourceControlQmdProjectPath, "sections", "_introduction.qmd"),
    "Included introduction.\n",
  );
  writeFileSync(
    join(sourceControlQmdProjectPath, "report.qmd"),
    [
      "---",
      "title: Initial report",
      "---",
      "",
      "# Initial Quarto report",
      "",
      "{{< include sections/_introduction.qmd >}}",
      "",
    ].join("\n"),
  );
  execFileSync("git", ["init", "--initial-branch=main"], {
    cwd: sourceControlQmdProjectPath,
    stdio: "ignore",
  });
  execFileSync("git", ["add", "report.qmd", "sections/_introduction.qmd"], {
    cwd: sourceControlQmdProjectPath,
    stdio: "ignore",
  });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=YA E2E",
      "-c",
      "user.email=ya-e2e@example.invalid",
      "commit",
      "-m",
      "Seed Quarto source control fixture",
    ],
    {
      cwd: sourceControlQmdProjectPath,
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: "2026-01-04T00:00:00Z",
        GIT_COMMITTER_DATE: "2026-01-04T00:00:00Z",
      },
      stdio: "ignore",
    },
  );
  writeFileSync(
    join(sourceControlQmdProjectPath, "report.qmd"),
    [
      "---",
      "title: Updated report",
      "---",
      "",
      "# Updated Quarto report",
      "",
      "{{< include sections/_introduction.qmd >}}",
      "",
    ].join("\n"),
  );
  const sourceControlQmdSessionDir = join(
    E2E_CLAUDE_SESSIONS_DIR,
    hostname(),
    sourceControlQmdProjectPath.replace(/[/\\:]/g, "-"),
  );
  mkdirSync(sourceControlQmdSessionDir, { recursive: true });
  // A ranged Read of the dirty file exercises in-session diff shortcuts.
  const sourceControlQmdReportPath = join(
    sourceControlQmdProjectPath,
    "report.qmd",
  );
  writeFileSync(
    join(sourceControlQmdSessionDir, "source-control-qmd-001.jsonl"),
    [
      {
        type: "user",
        cwd: sourceControlQmdProjectPath,
        message: { role: "user", content: "Inspect the Quarto report" },
        timestamp: "2026-01-04T00:00:01.000Z",
        uuid: "source-control-qmd-user-1",
      },
      {
        type: "assistant",
        uuid: "source-control-qmd-read-use",
        parentUuid: "source-control-qmd-user-1",
        timestamp: "2026-01-04T00:00:02.000Z",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "source-control-qmd-read",
              name: "Read",
              input: {
                file_path: sourceControlQmdReportPath,
                offset: 2,
                limit: 2,
              },
            },
          ],
        },
      },
      {
        type: "user",
        uuid: "source-control-qmd-read-result",
        parentUuid: "source-control-qmd-read-use",
        timestamp: "2026-01-04T00:00:03.000Z",
        toolUseResult: {
          type: "text",
          file: {
            filePath: sourceControlQmdReportPath,
            content: "title: Updated report\n---",
            startLine: 2,
            numLines: 2,
            totalLines: 8,
          },
        },
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "source-control-qmd-read",
              content: "2→title: Updated report\n3→---",
            },
          ],
        },
      },
    ]
      .map((message) => JSON.stringify(message))
      .join("\n"),
  );
  console.log(
    `[E2E] Created Quarto Source Control fixture at ${sourceControlQmdProjectPath}`,
  );

  const absoluteViewerSessionFile = join(
    mockSessionDir,
    "file-viewer-absolute-001.jsonl",
  );
  const externalReadmePath = join(fileBrowserProjectPath, "README.md");
  writeFileSync(
    absoluteViewerSessionFile,
    [
      {
        type: "user",
        cwd: mockProjectPath,
        message: { role: "user", content: "Open the external reference" },
        timestamp: "2026-01-02T00:00:00.000Z",
        uuid: "viewer-user-1",
      },
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: `Review ${externalReadmePath} and quote the relevant passage.`,
        },
        timestamp: "2026-01-02T00:00:01.000Z",
        uuid: "viewer-assistant-1",
        parentUuid: "viewer-user-1",
      },
    ]
      .map((message) => JSON.stringify(message))
      .join("\n"),
  );
  console.log(
    `[E2E] Created absolute-path viewer session at ${absoluteViewerSessionFile}`,
  );

  // An HTML report inside the project, linked from a session, for the right
  // pane's interactive preview: play, then minimize, must leave a chip.
  writeFileSync(
    join(mockProjectPath, "report.html"),
    '<!doctype html><html><body><h1>Play report</h1><p id="status" role="status">ready</p></body></html>',
  );
  const playReportSessionFile = join(mockSessionDir, "play-report-001.jsonl");
  writeFileSync(
    playReportSessionFile,
    [
      {
        type: "user",
        cwd: mockProjectPath,
        message: { role: "user", content: "Open the report" },
        timestamp: "2026-01-02T00:00:00.000Z",
        uuid: "play-user-1",
      },
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: "The build wrote report.html for review.",
        },
        timestamp: "2026-01-02T00:00:01.000Z",
        uuid: "play-assistant-1",
        parentUuid: "play-user-1",
      },
    ]
      .map((message) => JSON.stringify(message))
      .join("\n"),
  );
  console.log(`[E2E] Created play report session at ${playReportSessionFile}`);

  // Enough turns that the transcript renders through its row window, so a
  // selection test exercises rows mounting and unmounting around it.
  // Each turn carries many assistant messages so the loaded tail alone
  // exceeds the window's activation weight.
  const windowedSelectionParts = 12;
  const windowedSelectionMessages = Array.from({ length: 30 }, (_, turn) => {
    const at = (step: number) =>
      new Date(Date.UTC(2026, 0, 3, 0, turn, step)).toISOString();
    return [
      {
        type: "user",
        ...(turn === 0 ? { cwd: mockProjectPath } : {}),
        message: {
          role: "user",
          content: `Windowed selection request ${turn}`,
        },
        timestamp: at(0),
        uuid: `windowed-selection-user-${turn}`,
        ...(turn > 0
          ? {
              parentUuid: `windowed-selection-assistant-${turn - 1}-${windowedSelectionParts - 1}`,
            }
          : {}),
      },
      ...Array.from({ length: windowedSelectionParts }, (_, part) => ({
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "text",
              text: `Windowed reply ${turn} part ${part} carries enough prose to wrap across the transcript column.`,
            },
          ],
        },
        timestamp: at(part + 1),
        uuid: `windowed-selection-assistant-${turn}-${part}`,
        parentUuid:
          part === 0
            ? `windowed-selection-user-${turn}`
            : `windowed-selection-assistant-${turn}-${part - 1}`,
      })),
    ];
  }).flat();
  writeFileSync(
    join(mockSessionDir, "windowed-selection-001.jsonl"),
    windowedSelectionMessages
      .map((message) => JSON.stringify(message))
      .join("\n"),
  );

  const sourceSelectionSessionFile = join(
    mockSessionDir,
    "source-selection-001.jsonl",
  );
  const externalSourcePath = join(fileBrowserProjectPath, "src", "index.ts");
  writeFileSync(
    sourceSelectionSessionFile,
    [
      {
        type: "user",
        cwd: mockProjectPath,
        message: { role: "user", content: "Review the formatted source" },
        timestamp: "2026-01-02T00:01:00.000Z",
        uuid: "source-selection-user-1",
      },
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: `Review ${externalSourcePath} and quote the exact source range.`,
        },
        timestamp: "2026-01-02T00:01:01.000Z",
        uuid: "source-selection-assistant-1",
        parentUuid: "source-selection-user-1",
      },
    ]
      .map((message) => JSON.stringify(message))
      .join("\n"),
  );

  const activitySelectionSessionFile = join(
    mockSessionDir,
    "activity-selection-001.jsonl",
  );
  const activityOutput = [
    "selection anchor near top",
    "backward drag anchor near bottom",
    ...Array.from(
      { length: 70 },
      (_, index) => `activity output line ${index + 3}`,
    ),
  ].join("\n");
  writeFileSync(
    activitySelectionSessionFile,
    [
      {
        type: "user",
        cwd: mockProjectPath,
        message: { role: "user", content: "Inspect the long activity output" },
        timestamp: "2026-01-02T00:02:00.000Z",
        uuid: "activity-selection-user-1",
      },
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "activity-selection-bash-1",
              name: "Bash",
              input: {
                command: "generate-selection-output",
                description: "Selection placement specimen",
              },
            },
          ],
        },
        timestamp: "2026-01-02T00:02:01.000Z",
        uuid: "activity-selection-assistant-1",
        parentUuid: "activity-selection-user-1",
      },
      {
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "activity-selection-bash-1",
              content: activityOutput,
            },
          ],
        },
        toolUseResult: {
          stdout: activityOutput,
          stderr: "",
          interrupted: false,
          isImage: false,
          exitCode: 0,
        },
        timestamp: "2026-01-02T00:02:02.000Z",
        uuid: "activity-selection-result-1",
        parentUuid: "activity-selection-assistant-1",
      },
    ]
      .map((message) => JSON.stringify(message))
      .join("\n"),
  );

  return paths;
}
