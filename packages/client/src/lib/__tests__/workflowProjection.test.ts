import { describe, expect, it } from "vitest";
import type { Message } from "../../types";
import { compileTranscriptProjection } from "@yep-anywhere/shared/transcript/compiler";
import {
  assistant,
  asCodeMode,
  call,
  result,
  publishSchema,
  simulatedInline,
  simulatedNestedTool,
  simulatedPublish,
} from "../../../test-fixtures/workflow";
import { buildSessionDetailRenderItems } from "../sessionDetail/renderItems";
import { readWorkflowSchema } from "@yep-anywhere/shared/transcript/workflowTags";
import { AcliToolOutput, type AcliOutputProjection } from "../acliToolOutput";

describe("workflow tag projection", () => {
  it.each(["json", "lines"])(
    "composes %s commentary before matching, with stream and caller isolation",
    async (format) => {
      const banner = `# acli-capabilities: commentary${format === "lines" ? "-lines" : ""}/1\n`;
      const note = (text: string) =>
        format === "lines"
          ? `# _acli.commentary: ${text}\n`
          : `${JSON.stringify({ _acli: { commentary: [{ text }] } })}\n`;
      const stdout =
        banner +
        "[build] first\n" +
        note(
          "[report] [Report](./report.md)\n[workflow][end] id=x status=completed",
        ) +
        "following data\n[build] last\n";
      const stderr =
        '# acli-capabilities: commentary-lines/1\n# _acli.commentary: @@visualization-schema/1 ["error"]\n# _acli.commentary: [error] Independent.\n';
      const messages = [
        assistant(
          "start",
          '@@visualization-schema/1 ["parent","build","report"]\n[parent] Start.',
        ),
        call("tool"),
        assistant("advance", "[build] Caller advanced."),
        { ...result("tool", stdout), toolUseResult: { stdout, stderr } },
        assistant("after", "[report] Caller retained its schema."),
      ];
      const items = compileTranscriptProjection(messages, {
        workflowTags: true,
      });
      const tool = items.find((item) => item.id === "tool")!;
      expect(tool.workflow?.toolContext?.initial?.path).toBe("[parent]");
      expect(
        tool.workflow?.markers
          .filter((marker) => marker.kind === "stage")
          .map((marker) => marker.path),
      ).toEqual([
        "[parent][build]",
        "[parent][report]",
        "[parent][build]",
        "[parent][error]",
      ]);
      expect(items.at(-1)?.workflow?.markers[0]?.path).toBe("[report]");
      expect(tool).toMatchObject({ toolResult: { content: stdout } });
      expect(
        compileTranscriptProjection(JSON.parse(JSON.stringify(messages)), {
          workflowTags: true,
        }),
      ).toEqual(items);
      const outputs: AcliOutputProjection[] = [];
      const engine = new AcliToolOutput(
        async (texts) => texts,
        (next) => outputs.push(next),
        undefined,
        true,
        tool.workflow?.toolContext,
      );
      for (let end = 1; end <= stdout.length; end++) {
        engine.appendSnapshot(stdout.slice(0, end), false, stderr);
        await new Promise<void>((resolve) => queueMicrotask(resolve));
      }
      engine.appendSnapshot(stdout, true, stderr);
      await new Promise<void>((resolve) => queueMicrotask(resolve));
      const output = outputs.at(-1)!;
      expect(output.stdout).not.toContain("_acli");
      expect(output.workflow?.outputText).not.toContain("_acli");
      expect(
        output.commentary.flatMap(
          (item) => item.workflow?.markers.map((marker) => marker.path) ?? [],
        ),
      ).toContain("[parent][report]");
      for (const marker of output.workflow?.markers ?? [])
        expect(
          output.workflow?.outputText?.slice(marker.start, marker.end),
        ).toBe(marker.prefix);
      expect(
        output.workflow?.markers.some(
          (marker) =>
            marker.path === "[parent][report]" && marker.prefix === "",
        ),
      ).toBe(true);
      expect(
        output.commentary.find((item) => item.text.includes("Independent"))
          ?.getContext,
      ).toBeNull();
    },
  );

  it("activates from decoded commentary without interpreting arbitrary JSON strings", () => {
    const note = (text: string) =>
      `${JSON.stringify({ _acli: { commentary: [{ text }] } })}\n`;
    const source =
      "# acli: 1 +commentary\n" +
      note('@@visualization-schema/1 ["build"]') +
      note("[build] Note.") +
      JSON.stringify({ example: "[build] Data string." }) +
      "\n";
    const messages = [
      call("tool"),
      result("tool", source),
      assistant("after", "[build] Subsequent activity."),
    ];
    for (const input of [messages, asCodeMode(messages, "command")]) {
      const items = compileTranscriptProjection(input, { workflowTags: true });
      expect(items[0]?.workflow?.markers.map((marker) => marker.kind)).toEqual([
        "activation",
        "stage",
      ]);
      expect(items.at(-1)?.workflow?.markers[0]?.kind).toBe("stage");
    }
    expect(
      compileTranscriptProjection(messages).every((item) => !item.workflow),
    ).toBe(true);
  });

  it("recomputes workflow ranges against retained raw records after render failure", async () => {
    const source =
      "# acli: 1 +commentary\n" +
      JSON.stringify({
        _acli: { commentary: [{ text: "[build] Unrendered." }] },
      }) +
      "\n[build] Raw progress.\n";
    const tool = compileTranscriptProjection(
      [
        assistant("activate", '@@visualization-schema/1 ["build"]'),
        call("tool"),
        result("tool", source),
      ],
      { workflowTags: true },
    ).find((item) => item.id === "tool")!;
    const outputs: AcliOutputProjection[] = [];
    new AcliToolOutput(
      async () => {
        throw new Error("Offline");
      },
      (next) => outputs.push(next),
      undefined,
      true,
      tool.workflow?.toolContext,
    ).appendSnapshot(source, true);
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    const output = outputs.at(-1)!;
    expect(output.failed).toBe(true);
    expect(output.commentary).toEqual([]);
    expect(output.workflow?.outputText).toBe(output.stdout);
    expect(output.workflow?.markers).toHaveLength(1);
    expect(
      output.workflow?.outputText?.slice(output.workflow.markers[0]!.start),
    ).toBe("[build] Raw progress.\n");
  });

  it("keeps JSON arrays opaque and tool lifecycle prefixes subordinate", () => {
    const schema = { ...publishSchema, toolOutput: { containsTags: true } };
    const source =
      "# acli: 1 +commentary\n[1]\n" +
      JSON.stringify({
        _acli: { commentary: [{ text: "[workflow][end] id=x status=failed" }] },
      }) +
      "\n";
    const items = compileTranscriptProjection(
      [
        assistant(
          "activate",
          "@@visualization-schema/1 /schema.json\n[workflow][start] id=x schema=ya-publish/1\n[publish] Begin.",
        ),
        call("tool"),
        result("tool", source),
        assistant("end", "[workflow][end] id=x status=completed Done."),
      ],
      {
        workflowTags: true,
        workflowSchemaFiles: { "/schema.json": JSON.stringify(schema) },
      },
    );
    expect(items.find((item) => item.id === "tool")?.workflow?.markers).toEqual(
      [
        expect.objectContaining({
          kind: "stage",
          path: "[publish][workflow][end]",
        }),
      ],
    );
    expect(items.at(-1)?.workflow?.markers[0]?.kind).toBe("end");
  });

  it("keeps each commentary document's fences independent of ordinary output", () => {
    const source =
      '# acli-capabilities: commentary-lines/1\n```text\n# _acli.commentary: @@visualization-schema/1 ["child"]\n@@visualization-schema/1 ["wrong"]\n```\n[child] Still child.\n# _acli.commentary: ```text\n# _acli.commentary: @@visualization-schema/1 ["after"]\n[after] New document.\n';
    const items = compileTranscriptProjection(
      [call("tool"), result("tool", source)],
      { workflowTags: true },
    );
    expect(items[0]?.workflow?.markers.map((marker) => marker.prefix)).toEqual([
      '@@visualization-schema/1 ["child"]',
      "[child]",
      '@@visualization-schema/1 ["after"]',
      "[after]",
    ]);
  });

  it("isolates code-mode commentary activations and partial records", () => {
    const declared =
      "# acli: 1 +commentary\n" +
      JSON.stringify({
        _acli: {
          commentary: [
            { text: '@@visualization-schema/1 ["child"]' },
            { text: "[child] First leaf." },
          ],
        },
      }) +
      "\n";
    const source = JSON.stringify([
      { type: "text", text: declared },
      {
        type: "text",
        text: "# acli-capabilities: commentary-lines/1\n# _acli.commentary: [child] Ordinary sibling.\n",
      },
    ]);
    const items = compileTranscriptProjection(
      [
        assistant(
          "activate",
          '@@visualization-schema/1 ["parent"]\n[parent] Start.',
        ),
        call("tool", "Exec"),
        result("tool", source),
      ],
      { workflowTags: true },
    );
    expect(
      items.at(-1)?.workflow?.markers.map((marker) => marker.kind),
    ).toEqual(["activation", "stage"]);
    const partial = compileTranscriptProjection(
      [
        call("pending"),
        { ...result("pending", declared.slice(0, -3)), _isStreaming: true },
      ],
      { workflowTags: true },
    );
    expect(partial.at(-1)?.workflow?.markers).toEqual([]);
  });

  it.each(["text", "command", "settled"] as const)(
    "resolves file announcements from code-mode %s envelopes",
    (format) => {
      const reference = "/schema.json#ya-publish/1";
      const messages = asCodeMode(simulatedPublish(reference), format);
      const raw = JSON.stringify(messages);
      const unresolved = buildSessionDetailRenderItems({
        messages,
        workflowTagsEnabled: true,
      });
      expect(
        unresolved.find((item) => item.id === "schema")?.workflow?.markers,
      ).toEqual([
        expect.objectContaining({ kind: "unresolved", schemaRef: reference }),
      ]);
      const items = buildSessionDetailRenderItems({
        messages,
        workflowTagsEnabled: true,
        workflowSchemaFiles: { [reference]: JSON.stringify(publishSchema) },
      });
      expect(
        items.find((item) => item.id === "publish-client-0")?.workflow
          ?.markers[0]?.path,
      ).toBe("[publish][client]");
      expect(items.at(-1)?.workflow?.markers[0]?.kind).toBe("end");
      expect(JSON.stringify(messages)).toBe(raw);
    },
  );

  it.each(["text", "command", "settled"] as const)(
    "keeps nested inline activation inside code-mode %s envelopes",
    (format) => {
      const messages = asCodeMode(
        simulatedNestedTool("self-announced"),
        format,
      );
      const items = buildSessionDetailRenderItems({
        messages,
        workflowTagsEnabled: true,
      });
      const script = items.find((item) => item.id === "nested-script");
      expect(script?.workflow?.markers.map((marker) => marker.kind)).toEqual([
        "activation",
        "stage",
        "stage",
      ]);
      expect(script?.workflow?.markers[1]?.path).toBe(
        "[publish][client][build][types]",
      );
      expect(script?.workflow?.outputText).toContain(
        "\n@@visualization-schema/1",
      );
      expect(items.at(-1)?.workflow?.markers[0]?.kind).toBe("end");
      expect(
        buildSessionDetailRenderItems({ messages }).every(
          (item) => !item.workflow,
        ),
      ).toBe(true);
    },
  );

  it("keeps fences and nested activations within their decoded result part", () => {
    const output = JSON.stringify(
      [
        "```text\nAn unfinished example fence.",
        '@@visualization-schema/1 ["child"]\n[child] Local stage.',
        "[child] Ordinary sibling output.\n[parent] Inherited stage.",
      ].map((text) => ({ type: "input_text", text })),
    );
    const messages = [
      assistant(
        "start",
        '@@visualization-schema/1 ["parent"]\n[parent] Start.',
      ),
      call("parts", "Exec"),
      result("parts", output),
      assistant("after", "[parent] Continue."),
    ];
    const items = compileTranscriptProjection(messages, { workflowTags: true });
    const tool = items.find((item) => item.id === "parts");
    expect(tool?.workflow?.markers.map((marker) => marker.kind)).toEqual([
      "activation",
      "stage",
      "stage",
    ]);
    expect(tool?.workflow?.markers.map((marker) => marker.path)).toEqual([
      undefined,
      "[parent][child]",
      "[parent][parent]",
    ]);
    for (const marker of tool?.workflow?.markers ?? []) {
      expect(tool?.workflow?.outputText?.slice(marker.start, marker.end)).toBe(
        marker.prefix,
      );
    }
    expect(items.at(-1)?.workflow?.markers[0]?.path).toBe("[parent]");
    expect(tool).toMatchObject({ toolResult: { content: output } });
    expect(
      tool?.workflow?.visibleRanges
        ?.map(({ start, end }) => tool.workflow?.outputText?.slice(start, end))
        .join(""),
    ).toContain("Local stage.\n[child] Ordinary sibling output.");
  });

  it("retains the calling stage when code-mode output contains only status", () => {
    const items = compileTranscriptProjection(
      [
        assistant(
          "start",
          '@@visualization-schema/1 ["parent"]\n[parent] Start.',
        ),
        call("status", "Exec"),
        result(
          "status",
          JSON.stringify([
            {
              type: "input_text",
              text: "Script completed\nWall time 0 seconds\nOutput:\n",
            },
          ]),
        ),
      ],
      { workflowTags: true },
    );
    expect(items.at(-1)?.workflow?.parent?.path).toBe("[parent]");
    expect(items.at(-1)?.workflow?.markers).toEqual([]);
  });

  it("does not borrow a sibling result's embedded declaration", () => {
    const reference = "/separate.json#ya-publish/1";
    const items = compileTranscriptProjection(
      [
        call("parts", "Exec"),
        result(
          "parts",
          JSON.stringify([
            {
              type: "input_text",
              text: `@@visualization-schema/1 ${reference}`,
            },
            {
              type: "input_text",
              text: `\`\`\`json\n${JSON.stringify(publishSchema)}\n\`\`\``,
            },
          ]),
        ),
        assistant("start", "[workflow][start] id=x schema=ya-publish/1"),
      ],
      { workflowTags: true },
    );
    expect(items[0]?.workflow?.markers).toEqual([
      expect.objectContaining({ kind: "unresolved", schemaRef: reference }),
    ]);
    expect(items.at(-1)?.workflow).toBeUndefined();
  });

  it("does not activate JSON data or fenced examples inside command stdout", () => {
    const messages = asCodeMode(
      [
        call("data"),
        result(
          "data",
          JSON.stringify({
            example: '@@visualization-schema/1 ["build"]\n[build] Data.',
          }),
        ),
        call("quote"),
        result("quote", '```text\n@@visualization-schema/1 ["build"]\n```'),
        assistant("after", "[build] No workflow was activated."),
      ],
      "command",
    );
    const items = buildSessionDetailRenderItems({
      messages,
      workflowTagsEnabled: true,
    });
    expect(items.every((item) => !item.workflow)).toBe(true);
  });

  it.each(["inherited", "self-announced", "matching-lines"] as const)(
    "nests %s script tags without replacing the outer workflow",
    (mode) => {
      const messages = simulatedNestedTool(mode);
      const compile = (input: Message[]) =>
        buildSessionDetailRenderItems({
          messages: input,
          workflowTagsEnabled: true,
        });
      const items = compile(messages);
      const script = items.find((item) => item.id === "nested-script");
      const stages = script?.workflow?.markers.filter(
        (marker) => marker.kind === "stage",
      );
      expect(stages?.map((marker) => marker.path)).toEqual([
        "[publish][client][build][types]",
        "[publish][client][copy]",
      ]);
      expect(stages?.[0]?.title).toBe(
        mode === "inherited"
          ? "Publish YA › Publish the hosted client › Build the remote client › Check client types"
          : "Publish YA › Publish the hosted client › build › types",
      );
      expect(
        items.find((item) => item.id === "after-script")?.workflow?.parent
          ?.path,
      ).toBe("[publish][source]");
      expect(items.at(-1)?.workflow?.markers[0]?.kind).toBe("end");
      expect(compile(JSON.parse(JSON.stringify(messages)))).toEqual(items);
      if (script?.type !== "tool_call") throw new Error("Missing script row");
      const text = script.toolResult?.content ?? "";
      const visible = script.workflow?.visibleRanges
        ?.map(({ start, end }) => text.slice(start, end))
        .join("");
      expect(visible).toContain("Diagnostic after activation.");
      if (mode === "matching-lines") {
        expect(visible).not.toContain("Before the script declaration.");
        expect(visible).not.toContain("Before activation.");
        expect(text).toContain("Before activation.");
      } else if (mode === "self-announced") {
        expect(visible).toContain("Before activation.");
      }
    },
  );

  it("activates a schema from a native Read's unnumbered structured content", () => {
    const body = `@@visualization-schema/1 ~/schema.md#ya-publish/1\n\`\`\`json\n${JSON.stringify(publishSchema)}\n\`\`\``;
    const readResult = {
      ...result(
        "read",
        body
          .split("\n")
          .map((line, index) => `${index + 1}→${line}`)
          .join("\n"),
      ),
      toolUseResult: {
        type: "text",
        file: { filePath: "/schema.md", content: body, numLines: 4 },
      },
    };
    const items = compileTranscriptProjection(
      [
        call("read", "Read"),
        readResult,
        assistant(
          "start",
          "[workflow][start] id=read schema=ya-publish/1\n[publish][client] Ready.",
        ),
      ],
      { workflowTags: true },
    );
    expect(
      items.at(-1)?.workflow?.markers.map((marker) => marker.kind),
    ).toEqual(["start", "stage"]);
  });

  it("treats inline lifecycle-shaped tags as display data and waits for complete streamed lines", () => {
    const activation = assistant(
      "activation",
      '@@visualization-schema/1 [["workflow","end"],"build"]',
    );
    const partial = {
      ...assistant("stream", "[workflow][end] Ordinary stage.\n[build]"),
      _isStreaming: true,
    };
    const items = compileTranscriptProjection([activation, partial], {
      workflowTags: true,
    });
    expect(items[1]?.workflow?.markers.map((marker) => marker.kind)).toEqual([
      "stage",
    ]);
    const complete = compileTranscriptProjection(
      [activation, { ...partial, _isStreaming: false }],
      { workflowTags: true },
    );
    expect(complete[1]?.workflow?.markers.map((marker) => marker.kind)).toEqual(
      ["stage", "stage"],
    );
  });

  it("allows inline activation in a tool result without reclassifying earlier output", () => {
    const messages = [
      call("tool"),
      result(
        "tool",
        '[build] Before.\n@@visualization-schema/1 ["build"]\n[build] Inside.',
      ),
      assistant("after", "[build] Subsequent commentary."),
    ];
    const items = compileTranscriptProjection(messages, { workflowTags: true });
    expect(items[0]?.workflow?.markers.map((marker) => marker.kind)).toEqual([
      "activation",
      "stage",
    ]);
    expect(items[1]?.workflow?.markers[0]?.kind).toBe("stage");
  });
  it("opts into inline boundaries without changing transcript rows or text", () => {
    const messages: Message[] = [
      { id: "user", role: "user", content: "Run the harmless checks" },
      {
        id: "answer",
        role: "assistant",
        content:
          '@@visualization-schema/1 ["build",["check","types"]]\n[build] Prepare.\n[build][other] Ordinary text.\n[check][types] Check.\n[build] Retry.',
      },
    ];
    const ordinary = compileTranscriptProjection(messages);
    const tagged = compileTranscriptProjection(messages, {
      workflowTags: true,
    });
    expect(tagged.map(({ id, type }) => ({ id, type }))).toEqual(
      ordinary.map(({ id, type }) => ({ id, type })),
    );
    expect(ordinary.every((item) => !item.workflow)).toBe(true);
    expect(tagged[1]?.workflow?.markers.map((marker) => marker.prefix)).toEqual(
      [
        '@@visualization-schema/1 ["build",["check","types"]]',
        "[build]",
        "[check][types]",
        "[build]",
      ],
    );
    expect(tagged[1]).toMatchObject({ text: messages[1]?.content });
  });

  it("displays the publish schema and keeps opaque tool output under its parent", () => {
    const items = buildSessionDetailRenderItems({
      messages: simulatedPublish(),
      workflowTagsEnabled: true,
    });
    const client = items.find((item) => item.id === "publish-client-0");
    expect(client?.workflow?.markers).toEqual([
      expect.objectContaining({
        prefix: "[publish][client]",
        title: "Publish YA › Publish the hosted client",
        kind: "stage",
      }),
    ]);
    const pages = items.find((item) => item.id === "pages");
    expect(pages?.workflow).toEqual({
      outputBoundaries: [0],
      parent: {
        path: "[publish][client]",
        title: "Publish YA › Publish the hosted client",
      },
      markers: [],
    });
    expect(
      items
        .flatMap((item) => item.workflow?.markers ?? [])
        .filter((marker) => marker.kind === "end"),
    ).toHaveLength(1);
    expect(pages).toMatchObject({
      toolResult: { content: expect.stringContaining("nothing deployed") },
    });
  });

  it("keeps concurrent inline tool output beneath its launch stage, including after reload", () => {
    const messages = simulatedInline();
    const compile = (input: Message[]) =>
      buildSessionDetailRenderItems({
        messages: input,
        workflowTagsEnabled: true,
      });
    const items = compile(messages);
    const tool = items.find((item) => item.id === "inline-tool");
    expect(tool?.workflow?.markers.map((marker) => marker.path)).toEqual([
      "[build][check][types]",
      "[build][report]",
    ]);
    expect(compile(JSON.parse(JSON.stringify(messages)))).toEqual(items);
    const partial = compile(messages.slice(0, 5));
    expect(
      partial.find((item) => item.id === "inline-tool")?.workflow?.parent,
    ).toEqual(tool?.workflow?.parent);
    expect(compile(messages)).toEqual(items);
  });

  it("requires raw publish markers instead of inline-code examples", () => {
    const reference = "~/skills/publish/workflow.json#ya-publish/1";
    const lines = [
      `@@visualization-schema/1 ${reference}`,
      "[workflow][start] id=publish-example schema=ya-publish/1",
      "[publish][prepare] Inspect the work.",
      "[workflow][end] id=publish-example status=completed Prepared only.",
    ];
    const options = {
      workflowTags: true,
      workflowSchemaFiles: { [reference]: JSON.stringify(publishSchema) },
    };
    const quoted = lines.map((line) => `\`${line}\``).join("\n\n");
    const literal = compileTranscriptProjection(
      [assistant("quoted", quoted)],
      options,
    );
    expect(literal[0]?.workflow).toBeUndefined();
    const raw = compileTranscriptProjection(
      [assistant("raw", lines.join("\n\n"))],
      options,
    );
    expect(raw[0]?.workflow?.markers.map((marker) => marker.kind)).toEqual([
      "activation",
      "start",
      "stage",
      "end",
    ]);
  });

  it("ignores quoted examples, undeclared gates, malformed updates and later turns", () => {
    const messages = [
      assistant(
        "examples",
        '```text\n@@visualization-schema/1 ["A"]\n```\n> @@visualization-schema/1 ["A"]\n[A] Before activation.',
      ),
      assistant(
        "activate",
        '@@visualization-schema/1 ["A"]\n[A] Recognized.\n[no-attrib] Ordinary gate.\n```\n[A] Example.\n```\n> [A] Quote.\n@@visualization-schema/1 [invalid]\n[A] Still recognized.',
      ),
      { id: "next-turn", role: "user", content: "Next request" } as Message,
      assistant("after", "[A] Outside the span."),
    ];
    const items = compileTranscriptProjection(messages, { workflowTags: true });
    expect(items[0]?.workflow).toBeUndefined();
    expect(items[1]?.workflow?.markers.map((marker) => marker.kind)).toEqual([
      "activation",
      "stage",
      "unresolved",
      "stage",
    ]);
    expect(items[3]?.workflow).toBeUndefined();
  });

  it("does not infer completion or activate arbitrary JSON and unresolved paths", () => {
    const items = compileTranscriptProjection(
      [
        assistant("json", JSON.stringify(publishSchema)),
        assistant(
          "path",
          "@@visualization-schema/1 ~/missing.json\n[workflow][start] id=x schema=ya-publish/1\n[publish][client] Not activated.",
        ),
      ],
      { workflowTags: true },
    );
    expect(items[0]?.workflow).toBeUndefined();
    expect(items[1]?.workflow?.markers.map((marker) => marker.kind)).toEqual([
      "unresolved",
    ]);
  });

  it.each([
    {
      containsTags: true,
      expected: ["[build]", "[build][extra]", "[INFO]", "[workflow][end]"],
    },
    {
      containsTags: true,
      whitelist: ["[build]"],
      expected: ["[build]", "[build][extra]", "[INFO]", "[workflow][end]"],
    },
    {
      containsTags: true,
      whitelist: [],
      expected: ["[build]", "[build][extra]", "[INFO]", "[workflow][end]"],
    },
    {
      containsTags: true,
      closed: true,
      whitelist: ["[build]"],
      expected: ["[build]"],
    },
    { containsTags: true, closed: true, whitelist: [], expected: [] },
    { containsTags: true, closed: true, expected: [] },
    { containsTags: false, expected: [] },
  ])(
    "honors tool policy $containsTags / $whitelist",
    ({ expected, ...toolOutput }) => {
      const schema = { ...publishSchema, toolOutput };
      const messages = [
        call("schema"),
        result(
          "schema",
          `@@visualization-schema/1 /schema.md#ya-publish/1\n\`\`\`json\n${JSON.stringify(schema)}\n\`\`\``,
        ),
        assistant(
          "start",
          "[workflow][start] id=x schema=ya-publish/1\n[publish][verify] Check.",
        ),
        call("check"),
        result(
          "check",
          "[build] One.\n[build][extra] Two.\n```\n[INFO] Three.\n[workflow][end] id=x status=failed\n```",
        ),
        assistant("end", "[workflow][end] id=x status=completed Finished."),
      ];
      const items = compileTranscriptProjection(messages, {
        workflowTags: true,
      });
      expect(
        items
          .find((item) => item.id === "check")
          ?.workflow?.markers.map((marker) => marker.prefix) ?? [],
      ).toEqual(expected);
      expect(items.at(-1)?.workflow?.markers[0]?.kind).toBe("end");
      if (expected.length) {
        expect(
          items.find((item) => item.id === "check")?.workflow?.markers[0]
            ?.title,
        ).toBe("Publish YA › Verify the source change › build");
      }
    },
  );

  it("keeps closed descendants and additive extras relative to each captured stage", () => {
    const schema = {
      type: "tagged-stages/1",
      id: "closed/1",
      key: "work",
      title: "Work",
      toolOutput: { containsTags: true, closed: true, whitelist: ["[INFO]"] },
      stages: [
        {
          key: "client",
          children: [
            { key: "build", children: [{ key: "types" }] },
            { key: "copy" },
            { key: "open", toolOutput: { containsTags: true } },
            { key: "off", toolOutput: { closed: true, whitelist: ["[INFO]"] } },
          ],
        },
      ],
    };
    const messages = [
      assistant(
        "activate",
        "@@visualization-schema/1 /closed.json\n[workflow][start] id=c schema=closed/1\n[work][client] Start.",
      ),
      call("client"),
      assistant("build", "[work][client][build] Nested."),
      call("build"),
      assistant("copy", "[work][client][copy] Advance."),
      result(
        "client",
        "[build] Parent.\n[build][types] Child.\n[build][other] Unknown.\n[INFO] Extra.\n[copy] Copy.",
      ),
      result(
        "build",
        "[types] Child.\n[build][types] Wrong base.\n[copy] Sibling.\n[INFO] Extra.",
      ),
      assistant("open", "[work][client][open] Replacement."),
      call("open"),
      result("open", "[unknown] Open."),
      assistant("off", "[work][client][off] Disabled."),
      call("off"),
      result("off", "[INFO] Ordinary."),
    ];
    const compile = (input: Message[]) =>
      buildSessionDetailRenderItems({
        messages: input,
        workflowTagsEnabled: true,
        workflowSchemaFiles: { "/closed.json": JSON.stringify(schema) },
      });
    const items = compile(messages);
    const paths = (id: string) =>
      items
        .find((item) => item.id === id)
        ?.workflow?.markers.map((marker) => marker.path);
    expect(paths("client")).toEqual([
      "[work][client][build]",
      "[work][client][build][types]",
      "[work][client][INFO]",
      "[work][client][copy]",
    ]);
    expect(paths("build")).toEqual([
      "[work][client][build][types]",
      "[work][client][build][INFO]",
    ]);
    expect(paths("open")).toEqual(["[work][client][open][unknown]"]);
    expect(paths("off")).toEqual([]);
    expect(compile(JSON.parse(JSON.stringify(messages)))).toEqual(items);
    expect(items.find((item) => item.id === "client")).toMatchObject({
      toolResult: {
        content: expect.stringContaining("[build][other] Unknown."),
      },
    });
  });

  it("normalizes presentation defaults without inheriting or reordering them", () => {
    const schema = {
      ...publishSchema,
      presentation: { collect: true, order: -1 },
      stages: [
        { key: "A" },
        { key: "B", presentation: { collect: false, order: 0 } },
      ],
    };
    const parsed = readWorkflowSchema(JSON.stringify(schema), "/schema.json");
    expect(parsed?.stages.get("[publish]")?.presentation).toEqual({
      collect: true,
      order: -1,
    });
    expect(parsed?.stages.get("[publish][A]")?.presentation).toEqual({
      collect: false,
      order: 0,
    });
    expect(parsed?.stages.get("[publish][B]")?.presentation).toEqual({
      collect: false,
      order: 0,
    });
    expect([...parsed!.stages.keys()]).toEqual([
      "[publish]",
      "[publish][A]",
      "[publish][B]",
    ]);
  });

  it.each([
    { toolOutput: { containsTags: true, closed: "true" } },
    { presentation: { collect: "true" } },
    { presentation: { order: null } },
    { presentation: { order: "0" } },
    { stages: [{ key: "A", presentation: { collect: 1 } }] },
  ])(
    "rejects malformed optional fields in $toolOutput / $presentation / $stages",
    (fields) => {
      expect(
        readWorkflowSchema(
          JSON.stringify({ ...publishSchema, ...fields }),
          "/schema.json",
        ),
      ).toBeUndefined();
    },
  );

  it("stabilizes unchanged rows but invalidates an inherited workflow label", () => {
    const messages = simulatedInline();
    const first = buildSessionDetailRenderItems({
      messages,
      workflowTagsEnabled: true,
    });
    const again = buildSessionDetailRenderItems({
      messages: [...messages],
      workflowTagsEnabled: true,
      previousRenderItems: first,
    });
    expect(again.every((item, i) => item === first[i])).toBe(true);
    const off = buildSessionDetailRenderItems({
      messages,
      previousRenderItems: first,
    });
    expect(off.every((item) => !item.workflow)).toBe(true);
  });
});
