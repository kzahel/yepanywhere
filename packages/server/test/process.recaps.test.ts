import { describe, expect, it, vi } from "vitest";
import {
  Process,
  createControllableIterator,
  createMockIterator,
  createRecapProvider,
  waitFor,
} from "./process.test-support.js";
import type { SDKMessage, UrlProjectId } from "./process.test-support.js";
import { MessageQueue } from "../src/sdk/messageQueue.js";

describe("Process", () => {
  describe("recaps", () => {
    it("keeps simulated recaps disabled by default", async () => {
      const generateSummary = vi.fn(async () => ({ text: "summary" }));
      const process = new Process(createMockIterator([]), {
        queue: new MessageQueue(),
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
      });

      const result = await process.requestRecap(
        createRecapProvider(generateSummary),
      );

      expect(result).toMatchObject({
        supported: true,
        emitted: false,
        reason: "recaps disabled for this session",
      });
      expect(generateSummary).not.toHaveBeenCalled();
    });

    it("does not run the simulated recap generator in native mode", async () => {
      const generateSummary = vi.fn(async () => ({ text: "summary" }));
      const process = new Process(createMockIterator([]), {
        queue: new MessageQueue(),
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
        recapMode: "native",
      });
      const provider = {
        ...createRecapProvider(generateSummary),
        supportsNativeRecaps: true,
      };

      const result = await process.requestRecap(provider);

      expect(result).toMatchObject({
        supported: true,
        emitted: false,
        reason: "native recaps are provider-owned",
      });
      expect(generateSummary).not.toHaveBeenCalled();
    });

    it("uses an organic native recap before running the tailed fallback", async () => {
      const controller = createControllableIterator();
      const generateSummary = vi.fn(async () => ({
        text: "synthetic summary",
      }));
      const process = new Process(controller.iterator, {
        queue: new MessageQueue(),
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
        recapMode: "side-session",
      });
      const provider = {
        ...createRecapProvider(generateSummary),
        supportsNativeRecaps: true,
      };

      controller.push({
        type: "system",
        subtype: "init",
        session_id: "sess-1",
      });
      controller.push({ type: "assistant", message: { content: "after" } });
      controller.push({ type: "result", session_id: "sess-1" });
      await waitFor(() => expect(process.state.type).toBe("idle"));

      const request = process.requestRecap(provider, {
        sinceMs: Date.now() - 1,
      });
      controller.push({
        type: "system",
        subtype: "away_summary",
        content: "Native recap wins.",
        session_id: "sess-1",
        uuid: "native-recap-1",
      });

      await expect(request).resolves.toMatchObject({
        supported: true,
        emitted: true,
        reason: "native recap emitted",
        text: "Native recap wins.",
      });
      expect(generateSummary).not.toHaveBeenCalled();
      controller.finish();
      await process.abort();
    });

    it("summarizes only assistant turns after the away boundary", async () => {
      const controller = createControllableIterator();
      const generateSummary = vi.fn(async (request) => ({
        text:
          request.strategy === "side-session"
            ? request.recentAssistantText.join(" | ")
            : "",
      }));
      const process = new Process(controller.iterator, {
        queue: new MessageQueue(),
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
        recapsEnabled: true,
      });
      const recaps: SDKMessage[] = [];
      process.subscribe((event) => {
        if (
          event.type === "message" &&
          event.message.type === "system" &&
          event.message.subtype === "away_summary"
        ) {
          recaps.push(event.message);
        }
      });

      controller.push({
        type: "system",
        subtype: "init",
        session_id: "sess-1",
      });
      controller.push({ type: "assistant", message: { content: "before" } });
      await waitFor(() =>
        expect(process.getRecentAssistantText()).toEqual(["before"]),
      );
      const sinceMs = Date.now();
      await new Promise((resolve) => setTimeout(resolve, 5));
      controller.push({ type: "assistant", message: { content: "after" } });
      controller.push({ type: "result", session_id: "sess-1" });
      await waitFor(() => expect(process.state.type).toBe("idle"));

      const result = await process.requestRecap(
        createRecapProvider(generateSummary),
        { sinceMs },
      );

      expect(result).toMatchObject({ supported: true, emitted: true });
      // The emitted recap text is returned so the Supervisor can surface it as
      // the session's current agent line (hover card). See
      // topics/session-hovercard-recent-activity.md.
      expect(result.text).toBe("after");
      expect(generateSummary).toHaveBeenCalledWith({
        purpose: "recap",
        strategy: "side-session",
        recentAssistantText: ["after"],
        model: "cheapest",
      });
      expect(recaps.at(-1)?.content).toBe("after");
      controller.finish();
      await process.abort();
    });

    it("defers recap generation until the active turn completes", async () => {
      const controller = createControllableIterator();
      const generateSummary = vi.fn(async (request) => ({
        text:
          request.strategy === "side-session"
            ? request.recentAssistantText.join(" | ")
            : "",
      }));
      const process = new Process(controller.iterator, {
        queue: new MessageQueue(),
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
        recapsEnabled: true,
      });
      const recaps: SDKMessage[] = [];
      process.subscribe((event) => {
        if (
          event.type === "message" &&
          event.message.type === "system" &&
          event.message.subtype === "away_summary"
        ) {
          recaps.push(event.message);
        }
      });

      const sinceMs = Date.now() - 1;
      controller.push({
        type: "system",
        subtype: "init",
        session_id: "sess-1",
      });
      controller.push({ type: "assistant", message: { content: "during" } });
      await waitFor(() =>
        expect(process.getRecentAssistantText()).toEqual(["during"]),
      );

      const result = await process.requestRecap(
        createRecapProvider(generateSummary),
        { sinceMs },
      );

      expect(result).toMatchObject({
        supported: true,
        emitted: false,
        reason: "recap deferred until turn completes",
      });
      expect(generateSummary).not.toHaveBeenCalled();

      controller.push({ type: "result", session_id: "sess-1" });
      await waitFor(() =>
        expect(generateSummary).toHaveBeenCalledWith({
          purpose: "recap",
          strategy: "side-session",
          recentAssistantText: ["during"],
          model: "cheapest",
        }),
      );
      expect(recaps.at(-1)?.content).toBe("during");
      controller.finish();
      await process.abort();
    });

    it("drops a deferred recap after Stop until a fresh user turn", async () => {
      const controller = createControllableIterator();
      const generateSummary = vi.fn(async () => ({ text: "summary" }));
      const process = new Process(controller.iterator, {
        queue: new MessageQueue(),
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
        recapsEnabled: true,
      });

      controller.push({
        type: "system",
        subtype: "init",
        session_id: "sess-1",
      });
      controller.push({ type: "assistant", message: { content: "during" } });
      await waitFor(() =>
        expect(process.getRecentAssistantText()).toEqual(["during"]),
      );

      await expect(
        process.requestRecap(createRecapProvider(generateSummary)),
      ).resolves.toMatchObject({
        emitted: false,
        reason: "recap deferred until turn completes",
      });

      process.pauseRecapsUntilUserTurn();
      controller.push({ type: "result", session_id: "sess-1" });
      await waitFor(() => expect(process.state.type).toBe("idle"));

      expect(generateSummary).not.toHaveBeenCalled();
      await expect(
        process.requestRecap(createRecapProvider(generateSummary)),
      ).resolves.toMatchObject({
        emitted: false,
        reason: "recaps paused until next user turn",
      });

      process.queueMessage({
        text: "automatic project queue",
        automaticSource: "project-queue",
      });
      process.queueMessage({
        text: "automatic wake",
        automaticSource: "wake",
      });
      expect(process.isRecapPausedUntilUserTurn).toBe(true);

      process.queueMessage({
        text: "/compact",
        metadata: { hidden: true },
      });
      expect(process.isRecapPausedUntilUserTurn).toBe(true);

      process.queueMessage({
        text: "continue",
        metadata: { serverReceivedAt: new Date().toISOString() },
      });
      expect(process.isRecapPausedUntilUserTurn).toBe(false);

      controller.finish();
      await process.abort();
    });

    it("drops a recap that finishes after the session is paused", async () => {
      const controller = createControllableIterator();
      let finishSummary: (value: { text: string }) => void = () => {};
      const generateSummary = vi.fn(
        () =>
          new Promise<{ text: string }>((resolve) => {
            finishSummary = resolve;
          }),
      );
      const process = new Process(controller.iterator, {
        queue: new MessageQueue(),
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
        recapsEnabled: true,
      });
      const recaps: SDKMessage[] = [];
      process.subscribe((event) => {
        if (
          event.type === "message" &&
          event.message.type === "system" &&
          event.message.subtype === "away_summary"
        ) {
          recaps.push(event.message);
        }
      });

      controller.push({ type: "assistant", message: { content: "finished" } });
      controller.push({ type: "result", session_id: "sess-1" });
      await waitFor(() => expect(process.state.type).toBe("idle"));

      const request = process.requestRecap(
        createRecapProvider(generateSummary),
      );
      await waitFor(() => expect(generateSummary).toHaveBeenCalledTimes(1));
      process.pauseRecapsUntilUserTurn();
      finishSummary({ text: "too late" });

      await expect(request).resolves.toMatchObject({
        emitted: false,
        reason: "recaps paused until next user turn",
      });
      expect(recaps).toEqual([]);
      controller.finish();
      await process.abort();
    });

    it("refuses a retired helper target without calling a provider model", async () => {
      const controller = createControllableIterator();
      const generateSummary = vi.fn(async () => ({ text: "summary" }));
      const process = new Process(controller.iterator, {
        queue: new MessageQueue(),
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
        recapMode: "side-session",
        helperSideModel: "helper-target:retired-endpoint",
      });
      controller.push({
        type: "assistant",
        message: { content: "recent work" },
      });
      controller.push({ type: "result", session_id: "sess-1" });
      await waitFor(() => expect(process.state.type).toBe("idle"));
      try {
        await expect(
          process.requestRecap(createRecapProvider(generateSummary)),
        ).resolves.toMatchObject({
          emitted: false,
          reason:
            "Helper targets were removed; select a provider-local recap model",
        });
        expect(generateSummary).not.toHaveBeenCalled();
      } finally {
        controller.finish();
        await process.abort();
      }
    });

    it("resolves same-as-main helper model for recap generation", async () => {
      const controller = createControllableIterator();
      const generateSummary = vi.fn(async (request) => ({
        text:
          request.strategy === "side-session"
            ? request.recentAssistantText.join(" | ")
            : "",
      }));
      const process = new Process(controller.iterator, {
        queue: new MessageQueue(),
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
        recapMode: "side-session",
        helperSideModel: "same-as-main",
        model: "sonnet",
      });

      controller.push({
        type: "system",
        subtype: "init",
        session_id: "sess-1",
      });
      controller.push({ type: "assistant", message: { content: "after" } });
      controller.push({ type: "result", session_id: "sess-1" });
      await waitFor(() => expect(process.state.type).toBe("idle"));
      await process.requestRecap(createRecapProvider(generateSummary));

      expect(generateSummary).toHaveBeenCalledWith({
        purpose: "recap",
        strategy: "side-session",
        recentAssistantText: ["after"],
        model: "sonnet",
      });
      controller.finish();
      await process.abort();
    });
  });
});
