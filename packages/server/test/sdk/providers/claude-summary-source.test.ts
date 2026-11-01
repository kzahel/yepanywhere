import assert from "node:assert/strict";
import { expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { symlink } from "node:fs/promises";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  realpath,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ClaudeProvider,
  resolveClaudeSdkNativeExecutable,
} from "../../../src/sdk/providers/claude.js";
import {
  nativeSessionRef,
  parseNativeSessionId,
  toUrlProjectId,
} from "@yep-anywhere/shared";
const pinnedExecutable = resolveClaudeSdkNativeExecutable();
const nativeTest = pinnedExecutable ? it : it.skip;
nativeTest.each(["alias", "conventional", "relative-home"] as const)(
  "runs the pinned native Claude helper against its exact %s with a duplicate id in the working project",
  { timeout: 10000 },
  async (layout) => {
    for (const key of Object.keys(process.env))
      if (/^(ANTHROPIC_|CLAUDE_|AGENT_|YEP_PROVIDER_HOST_)/.test(key))
        vi.stubEnv(key, undefined);
    const root = await realpath(
        await mkdtemp(join(tmpdir(), "ya-native-claude-helper-")),
      ),
      physicalOriginal = join(root, "physical", "original"),
      original =
        layout === "relative-home"
          ? join(root, "original-link")
          : join(root, "original"),
      working = join(root, "working"),
      config =
        layout === "relative-home"
          ? join(root, "physical", "account")
          : join(root, "claude");
    if (layout === "relative-home") {
      await mkdir(physicalOriginal, { recursive: true });
      await symlink(physicalOriginal, original, "junction");
    }
    const nativeId = parseNativeSessionId(
      "019a0000-aaaa-7aaa-8aaa-aaaaaaaaaaaa",
    );
    const scope = (cwd: string) =>
      join(
        config,
        "projects",
        (layout === "relative-home" && cwd === original
          ? physicalOriginal
          : cwd
        ).replace(/[^A-Za-z0-9]/g, "-"),
      );
    const selected =
        layout !== "conventional"
          ? join(config, "projects", "selected-alias")
          : scope(original),
      other = scope(working);
    await Promise.all(
      [original, working, selected, other].map((p) =>
        mkdir(p, { recursive: true }),
      ),
    );
    const seed = (cwd: string, text: string) =>
      [
        {
          type: "user",
          uuid: "11111111-1111-4111-8111-111111111111",
          parentUuid: null,
          isSidechain: false,
          sessionId: nativeId,
          cwd,
          timestamp: "2026-11-01T00:00:00Z",
          message: { role: "user", content: text },
        },
        {
          type: "assistant",
          uuid: "22222222-2222-4222-8222-222222222222",
          parentUuid: "11111111-1111-4111-8111-111111111111",
          isSidechain: false,
          sessionId: nativeId,
          cwd,
          timestamp: "2026-11-01T00:00:01Z",
          message: {
            id: "msg_owned_seed",
            type: "message",
            role: "assistant",
            model: "claude-sonnet-4-6",
            content: [{ type: "text", text: "Owned seed answer" }],
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: { input_tokens: 10, output_tokens: 3 },
          },
        },
      ]
        .map((x) => JSON.stringify(x))
        .join("\n") + "\n";
    const selectedPath = join(selected, nativeId + ".jsonl"),
      otherPath = join(other, nativeId + ".jsonl");
    await writeFile(
      selectedPath,
      seed(original, "SELECTED_ORIGINAL_NATIVE_HISTORY"),
    );
    const otherBytes = seed(working, "FOREIGN_WORKING_NATIVE_HISTORY");
    await writeFile(otherPath, otherBytes);
    const bodies: any[] = [];
    const requests: string[] = [];
    const server = createServer(async (req, res) => {
      requests.push(req.url ?? "");
      let raw = "";
      for await (const chunk of req) raw += chunk;
      let body: any;
      try {
        body = JSON.parse(raw);
      } catch {}
      if (req.url?.includes("/messages/count_tokens")) {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ input_tokens: 100 }));
        return;
      }
      if (req.url?.includes("/messages")) {
        bodies.push(body);
        res.setHeader("content-type", "text/event-stream");
        res.setHeader("cache-control", "no-cache");
        const event = (type: string, data: any) =>
          res.write(
            `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`,
          );
        event("message_start", {
          message: {
            id: "msg_owned_response",
            type: "message",
            role: "assistant",
            content: [],
            model: "claude-sonnet-4-6",
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 100, output_tokens: 0 },
          },
        });
        event("content_block_start", {
          index: 0,
          content_block: { type: "text", text: "" },
        });
        event("content_block_delta", {
          index: 0,
          delta: { type: "text_delta", text: "Owned native title" },
        });
        event("content_block_stop", { index: 0 });
        event("message_delta", {
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { output_tokens: 3 },
        });
        event("message_stop", {});
        res.end();
        return;
      }
      res.setHeader("content-type", "application/json");
      res.end("{}");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const address = server.address();
    if (!address || typeof address === "string")
      throw Error("missing local listener");
    const environment = {
      CLAUDE_CONFIG_DIR: layout === "relative-home" ? "../account" : config,
      ANTHROPIC_API_KEY: "owned-fixture-key",
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_TELEMETRY: "1",
      DISABLE_ERROR_REPORTING: "1",
      CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
      CLAUDE_CODE_EXECUTABLE: pinnedExecutable!,
    };
    for (const [key, value] of Object.entries(environment))
      vi.stubEnv(key, value);
    const controller = new AbortController(),
      deadline = setTimeout(() => controller.abort(), 7500);
    try {
      const provider = new ClaudeProvider();
      if (layout === "relative-home") {
        const lexicalScope = join(
          root,
          "account",
          "projects",
          "selected-alias",
        );
        await mkdir(lexicalScope, { recursive: true });
        const lexicalFile = join(lexicalScope, nativeId + ".jsonl"),
          lexicalBytes = seed(original, "LEXICAL_WRONG_ACCOUNT_HISTORY");
        await writeFile(lexicalFile, lexicalBytes);
        const actualBytes = await readFile(selectedPath, "utf8"),
          before = bodies.length;
        await expect(
          provider.generateSummary({
            purpose: "session-retitle",
            strategy: "fork",
            generatorSessionId: nativeId,
            nativeSource: {
              native: nativeSessionRef("claude", lexicalScope, nativeId),
              filePath: lexicalFile,
              projectId: toUrlProjectId(original),
            },
            cwd: working,
            model: "sonnet",
          }),
        ).rejects.toThrow("scoped resume is not qualified");
        assert.equal(bodies.length, before);
        assert.equal(await readFile(lexicalFile, "utf8"), lexicalBytes);
        assert.equal(await readFile(selectedPath, "utf8"), actualBytes);
      }
      const result = await provider.generateSummary({
        purpose: "session-retitle",
        strategy: "fork",
        generatorSessionId: nativeId,
        nativeSource: {
          native: nativeSessionRef("claude", selected, nativeId),
          filePath: selectedPath,
          projectId: toUrlProjectId(original),
        },
        cwd: working,
        model: "sonnet",
        signal: controller.signal,
      });
      assert.equal(result.text, "Owned native title");
      const sourceBodies = JSON.stringify(bodies);
      assert.ok(
        sourceBodies.includes("SELECTED_ORIGINAL_NATIVE_HISTORY"),
        "actual native CLI must resume original source",
      );
      assert.ok(
        !sourceBodies.includes("FOREIGN_WORKING_NATIVE_HISTORY"),
        "must not resume working cwd duplicate",
      );
      assert.equal(await readFile(otherPath, "utf8"), otherBytes);
      const unselectable = join(config, "projects", "selected.alias");
      await mkdir(unselectable);
      const unselectableFile = join(unselectable, nativeId + ".jsonl");
      const unselectableBytes = seed(original, "UNSELECTABLE_CAPTURED_SOURCE");
      await writeFile(unselectableFile, unselectableBytes);
      const conventional = scope(original),
        conventionalFile = join(conventional, nativeId + ".jsonl");
      if (conventional !== selected) {
        await mkdir(conventional, { recursive: true });
        await writeFile(
          conventionalFile,
          seed(original, "COMPETING_ORIGINAL_DEFAULT_SOURCE"),
        );
      }
      const conventionalBytes = await readFile(conventionalFile, "utf8");
      const beforeUnsupported = bodies.length;
      await expect(
        provider.generateSummary({
          purpose: "session-retitle",
          strategy: "fork",
          generatorSessionId: nativeId,
          nativeSource: {
            native: nativeSessionRef("claude", unselectable, nativeId),
            filePath: unselectableFile,
            projectId: toUrlProjectId(original),
          },
          cwd: working,
          model: "sonnet",
        }),
      ).rejects.toThrow("cannot be addressed");
      assert.equal(bodies.length, beforeUnsupported);
      assert.equal(await readFile(unselectableFile, "utf8"), unselectableBytes);
      assert.equal(await readFile(conventionalFile, "utf8"), conventionalBytes);
      const before = bodies.length;
      const foreign = join(root, "foreign-native-root");
      await mkdir(foreign);
      await writeFile(
        join(foreign, nativeId + ".jsonl"),
        seed(original, "foreign source"),
      );
      await expect(
        provider.generateSummary({
          purpose: "session-retitle",
          strategy: "fork",
          generatorSessionId: nativeId,
          nativeSource: {
            native: nativeSessionRef("claude", foreign, nativeId),
            filePath: join(foreign, nativeId + ".jsonl"),
            projectId: toUrlProjectId(original),
          },
          cwd: working,
          model: "sonnet",
        }),
      ).rejects.toThrow("scoped resume is not qualified");
      assert.equal(bodies.length, before);
    } catch (e) {
      console.error("owned local request paths", JSON.stringify(requests));
      throw e;
    } finally {
      clearTimeout(deadline);
      controller.abort();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      await rm(root, { recursive: true, force: true });
      vi.unstubAllEnvs();
    }
  },
);
