import { afterEach, describe, expect, it, vi } from "vitest";
import { getLogger } from "../src/logging/logger.js";
import {
  Process,
  createControllableIterator,
  waitFor,
} from "./process.test-support.js";
import type { ProcessEvent, UrlProjectId } from "./process.test-support.js";
import { MessageQueue } from "../src/sdk/messageQueue.js";

describe("Process", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("provider runtime status", () => {
    it("records Claude api_retry status in process info", async () => {
      const controller = createControllableIterator();
      const process = new Process(controller.iterator, {
        queue: new MessageQueue(),
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
      });

      controller.push({
        type: "system",
        subtype: "init",
        session_id: "sess-1",
      });
      controller.push({
        type: "system",
        subtype: "api_retry",
        session_id: "sess-1",
        error_status: 429,
        error: "rate_limit",
        retry_delay_ms: 60_000,
        attempt: 1,
        max_retries: 2_147_483_647,
      });

      await waitFor(() => {
        expect(process.getInfo().providerRuntimeStatus?.kind).toBe("retrying");
      });

      const status = process.getInfo().providerRuntimeStatus;
      expect(status).toMatchObject({
        kind: "retrying",
        provider: "claude",
        reason: "rate_limit",
        httpStatus: 429,
        retryDelayMs: 60_000,
        attempt: 1,
        maxRetries: "unbounded",
        eventCount: 1,
        source: "claude.system.api_retry",
      });
      expect(status?.startedAt).toBe(status?.lastSeenAt);
      const retryDelay =
        Date.parse(status?.retryAt ?? "") -
        Date.parse(status?.lastSeenAt ?? "");
      expect(retryDelay).toBe(60_000);

      controller.finish();
    });

    it("classifies Claude Gateway quota exhaustion as terminal rate limiting", async () => {
      vi.spyOn(getLogger(), "warn").mockImplementation(() => undefined);
      const controller = createControllableIterator();
      const process = new Process(controller.iterator, {
        queue: new MessageQueue(),
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude-gateway",
        idleTimeoutMs: 100,
      });

      controller.push({
        type: "assistant",
        session_id: "sess-1",
        error: "unknown",
        isApiErrorMessage: true,
        apiErrorStatus: 402,
        message: {
          model: "<synthetic>",
          role: "assistant",
          content: [
            {
              type: "text",
              text: 'API Error: 402 {"error":{"message":"You have exceeded your monthly quota","code":"quota_exceeded"}}',
            },
          ],
        },
      });

      await waitFor(() => {
        expect(process.getInfo().providerRuntimeStatus?.kind).toBe("terminal");
      });
      expect(process.getInfo().providerRuntimeStatus).toMatchObject({
        kind: "terminal",
        provider: "claude-gateway",
        reason: "rate_limit",
        message: expect.stringContaining("exceeded your monthly quota"),
        source: "claude.assistant.api_error",
      });

      controller.finish();
    });

    it("detects Claude Gateway quota exhaustion from compact command stderr", async () => {
      const controller = createControllableIterator();
      const process = new Process(controller.iterator, {
        queue: new MessageQueue(),
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude-gateway",
        idleTimeoutMs: 100,
      });

      controller.push({
        type: "system",
        subtype: "local_command",
        session_id: "sess-1",
        content:
          '<local-command-stderr>Error during compaction: API Error: 402 {"error":{"message":"You have exceeded your monthly quota","code":"quota_exceeded"}}</local-command-stderr>',
      });

      await waitFor(() => {
        expect(process.getInfo().providerRuntimeStatus?.kind).toBe("terminal");
      });
      expect(process.getInfo().providerRuntimeStatus).toMatchObject({
        kind: "terminal",
        provider: "claude-gateway",
        reason: "rate_limit",
        message: "You have exceeded your monthly quota",
        source: "claude.system.local_command.compaction",
      });

      controller.finish();
    });

    it("emits provider runtime status changes", async () => {
      const controller = createControllableIterator();
      const process = new Process(controller.iterator, {
        queue: new MessageQueue(),
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
      });
      const events: ProcessEvent[] = [];
      process.subscribe((event) => {
        events.push(event);
      });

      controller.push({
        type: "system",
        subtype: "api_retry",
        session_id: "sess-1",
        error_status: 429,
        error: "rate_limit",
      });

      await waitFor(() => {
        expect(
          events.some(
            (event) =>
              event.type === "provider-runtime-status-change" &&
              event.status?.kind === "retrying",
          ),
        ).toBe(true);
      });

      controller.push({
        type: "assistant",
        message: { role: "assistant", content: "Recovered" },
      });

      await waitFor(() => {
        expect(
          events.some(
            (event) =>
              event.type === "provider-runtime-status-change" &&
              event.status === null,
          ),
        ).toBe(true);
      });

      controller.finish();
    });

    it("updates Claude api_retry status without resetting the incident start", async () => {
      const controller = createControllableIterator();
      const process = new Process(controller.iterator, {
        queue: new MessageQueue(),
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
      });

      controller.push({
        type: "system",
        subtype: "init",
        session_id: "sess-1",
      });
      controller.push({
        type: "system",
        subtype: "api_retry",
        session_id: "sess-1",
        error_status: 429,
        error: "rate_limit",
        retry_delay_ms: 60_000,
        attempt: 1,
        max_retries: 2_147_483_647,
      });

      await waitFor(() => {
        expect(process.getInfo().providerRuntimeStatus?.eventCount).toBe(1);
      });
      const firstStartedAt = process.getInfo().providerRuntimeStatus?.startedAt;

      controller.push({
        type: "system",
        subtype: "api_retry",
        session_id: "sess-1",
        error_status: 529,
        error: "overloaded",
        retry_delay_ms: 30_000,
        attempt: 2,
        max_retries: 3,
      });

      await waitFor(() => {
        expect(process.getInfo().providerRuntimeStatus?.eventCount).toBe(2);
      });

      expect(process.getInfo().providerRuntimeStatus).toMatchObject({
        kind: "retrying",
        provider: "claude",
        reason: "overloaded",
        httpStatus: 529,
        retryDelayMs: 30_000,
        attempt: 2,
        maxRetries: 3,
        startedAt: firstStartedAt,
        eventCount: 2,
      });

      controller.finish();
    });

    it("ignores Claude-shaped api_retry messages for non-Claude providers", async () => {
      const controller = createControllableIterator();
      const process = new Process(controller.iterator, {
        queue: new MessageQueue(),
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "codex",
        idleTimeoutMs: 100,
      });

      controller.push({
        type: "system",
        subtype: "api_retry",
        session_id: "sess-1",
        error_status: 429,
        error: "rate_limit",
        retry_delay_ms: 60_000,
      });

      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(process.getInfo().providerRuntimeStatus).toBe(null);

      controller.finish();
    });

    it("records terminal Codex errors until the next user turn", async () => {
      const controller = createControllableIterator();
      const process = new Process(controller.iterator, {
        queue: new MessageQueue(),
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "codex",
        idleTimeoutMs: 100,
      });

      controller.push({
        type: "error",
        uuid: "codex-error-turn-1",
        session_id: "sess-1",
        error: "Selected model is at capacity. Please try a different model.",
        codexErrorInfo: "serverOverloaded",
        codexWillRetry: false,
        codexTurnId: "turn-1",
      });

      await waitFor(() => {
        expect(process.getInfo().providerRuntimeStatus?.kind).toBe("terminal");
      });
      expect(process.getInfo().providerRuntimeStatus).toMatchObject({
        kind: "terminal",
        provider: "codex",
        reason: "overloaded",
        message: "Selected model is at capacity. Please try a different model.",
        turnId: "turn-1",
        source: "codex.error",
      });

      controller.push({ type: "result", session_id: "sess-1" });
      await waitFor(() => {
        expect(process.state.type).toBe("idle");
      });
      expect(process.getInfo().providerRuntimeStatus?.kind).toBe("terminal");

      controller.push({
        type: "user",
        uuid: "user-2",
        session_id: "sess-1",
        message: { role: "user", content: "Try again" },
      });
      await waitFor(() => {
        expect(process.getInfo().providerRuntimeStatus).toBe(null);
      });

      controller.finish();
    });

    it("normalizes Codex policyCapacityUnavailable to the overloaded reason", async () => {
      const controller = createControllableIterator();
      const process = new Process(controller.iterator, {
        queue: new MessageQueue(),
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "codex",
        idleTimeoutMs: 100,
      });

      controller.push({
        type: "error",
        uuid: "codex-error-turn-1",
        session_id: "sess-1",
        error:
          "Policy-restricted capacity is unavailable. Please try again later.",
        codexErrorInfo: "policyCapacityUnavailable",
        codexWillRetry: false,
        codexTurnId: "turn-1",
      });

      await waitFor(() => {
        expect(process.getInfo().providerRuntimeStatus).toMatchObject({
          kind: "terminal",
          reason: "overloaded",
        });
      });
      controller.finish();
    });

    it.each(["rateLimitExceeded", "flexUnavailable"])(
      "normalizes Codex %s to the rate_limit reason",
      async (codexErrorInfo) => {
        const controller = createControllableIterator();
        const process = new Process(controller.iterator, {
          queue: new MessageQueue(),
          projectPath: "/test",
          projectId: "proj-1" as UrlProjectId,
          sessionId: "sess-1",
          provider: "codex",
          idleTimeoutMs: 100,
        });

        controller.push({
          type: "error",
          uuid: "codex-error-turn-1",
          session_id: "sess-1",
          error: "Rate limit exceeded.",
          codexErrorInfo,
          codexWillRetry: false,
          codexTurnId: "turn-1",
        });

        await waitFor(() => {
          expect(process.getInfo().providerRuntimeStatus?.kind).toBe(
            "terminal",
          );
        });
        expect(process.getInfo().providerRuntimeStatus).toMatchObject({
          kind: "terminal",
          provider: "codex",
          reason: "rate_limit",
          message: "Rate limit exceeded.",
          turnId: "turn-1",
        });

        controller.finish();
      },
    );

    it("records automatic Codex retries until provider progress resumes", async () => {
      const controller = createControllableIterator();
      const process = new Process(controller.iterator, {
        queue: new MessageQueue(),
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "codex",
        idleTimeoutMs: 100,
      });

      controller.push({
        type: "error",
        uuid: "codex-error-turn-1",
        session_id: "sess-1",
        error: "Reconnecting... 2/5",
        codexErrorInfo: {
          responseStreamDisconnected: { httpStatusCode: 502 },
        },
        codexAdditionalDetails: "stream disconnected before completion",
        codexWillRetry: true,
        codexTurnId: "turn-1",
        codexRetryDelayMs: 45_000,
        codexRetryAttempt: 2,
        codexRetryMaxRetries: 16,
      });

      await waitFor(() => {
        expect(process.getInfo().providerRuntimeStatus?.kind).toBe("retrying");
      });
      expect(process.getInfo().providerRuntimeStatus).toMatchObject({
        kind: "retrying",
        provider: "codex",
        reason: "network",
        httpStatus: 502,
        message: "Reconnecting... 2/5",
        details: "stream disconnected before completion",
        turnId: "turn-1",
        retryDelayMs: 45_000,
        attempt: 2,
        maxRetries: 16,
        eventCount: 1,
        source: "codex.error",
      });
      const retryStatus = process.getInfo().providerRuntimeStatus;
      expect(
        Date.parse(
          retryStatus?.kind === "retrying" ? (retryStatus.retryAt ?? "") : "",
        ) -
          Date.parse(
            retryStatus?.kind === "retrying" ? retryStatus.lastSeenAt : "",
          ),
      ).toBe(45_000);

      controller.push({
        type: "assistant",
        uuid: "assistant-1",
        session_id: "sess-1",
        message: { role: "assistant", content: "Recovered" },
      });
      await waitFor(() => {
        expect(process.getInfo().providerRuntimeStatus).toBe(null);
      });

      controller.finish();
    });

    it("distinguishes Codex app-server process exits from failed turns", async () => {
      const controller = createControllableIterator();
      const process = new Process(controller.iterator, {
        queue: new MessageQueue(),
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "codex",
        idleTimeoutMs: 100,
      });

      controller.push({
        type: "error",
        uuid: "codex-error-process-exit",
        session_id: "sess-1",
        error: "Codex app-server exited (code=1, signal=null)",
        codexWillRetry: false,
        codexErrorScope: "app_server_process",
      });

      await waitFor(() => {
        expect(process.getInfo().providerRuntimeStatus?.kind).toBe("terminal");
      });
      expect(process.getInfo().providerRuntimeStatus).toMatchObject({
        kind: "terminal",
        provider: "codex",
        reason: "server_error",
        message: "Codex app-server exited (code=1, signal=null)",
        scope: "provider_process",
        source: "codex.app_server_process",
      });

      controller.finish();
    });

    it("restores a retained terminal status into a reactivated process", async () => {
      const controller = createControllableIterator();
      const process = new Process(controller.iterator, {
        queue: new MessageQueue(),
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "codex",
        idleTimeoutMs: 100,
        initialProviderRuntimeStatus: {
          kind: "terminal",
          provider: "codex",
          reason: "overloaded",
          message: "Selected model is at capacity.",
          occurredAt: "2026-07-10T18:14:32.213Z",
          source: "codex.error",
          turnId: "turn-1",
        },
      });

      expect(process.getInfo().providerRuntimeStatus).toMatchObject({
        kind: "terminal",
        reason: "overloaded",
        turnId: "turn-1",
      });

      controller.finish();
    });

    it("clears retry status when assistant progress resumes", async () => {
      const controller = createControllableIterator();
      const process = new Process(controller.iterator, {
        queue: new MessageQueue(),
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
      });

      controller.push({
        type: "system",
        subtype: "api_retry",
        session_id: "sess-1",
        error_status: 429,
        error: "rate_limit",
      });

      await waitFor(() => {
        expect(process.getInfo().providerRuntimeStatus?.kind).toBe("retrying");
      });

      controller.push({
        type: "assistant",
        message: { role: "assistant", content: "Recovered" },
      });

      await waitFor(() => {
        expect(process.getInfo().providerRuntimeStatus).toBe(null);
      });

      controller.finish();
    });

    it("clears retry status when the turn ends", async () => {
      const controller = createControllableIterator();
      const process = new Process(controller.iterator, {
        queue: new MessageQueue(),
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
      });

      controller.push({
        type: "system",
        subtype: "api_retry",
        session_id: "sess-1",
        error_status: 429,
        error: "rate_limit",
      });

      await waitFor(() => {
        expect(process.getInfo().providerRuntimeStatus?.kind).toBe("retrying");
      });

      controller.push({ type: "result", session_id: "sess-1" });

      await waitFor(() => {
        expect(process.state.type).toBe("idle");
      });
      expect(process.getInfo().providerRuntimeStatus).toBe(null);

      controller.finish();
    });

    it("interrupts a retrying turn before changing models", async () => {
      const controller = createControllableIterator();
      let retryInterrupted = false;
      const setModelFn = vi.fn(async () => {
        if (!retryInterrupted) {
          throw new Error("retry must be interrupted before model control");
        }
      });
      const interruptFn = vi.fn(async () => {
        retryInterrupted = true;
        return true;
      });
      const process = new Process(controller.iterator, {
        queue: new MessageQueue(),
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
        setModelFn,
        interruptFn,
      });

      controller.push({
        type: "system",
        subtype: "api_retry",
        session_id: "sess-1",
        error_status: 429,
        error: "rate_limit",
        retry_delay_ms: 60_000,
      });

      await waitFor(() => {
        expect(process.getInfo().providerRuntimeStatus?.kind).toBe("retrying");
      });

      await expect(process.setModel("opus")).resolves.toBe(true);

      expect(setModelFn).toHaveBeenCalledWith("opus");
      expect(interruptFn).toHaveBeenCalledTimes(1);
      expect(interruptFn.mock.invocationCallOrder[0]).toBeLessThan(
        setModelFn.mock.invocationCallOrder[0] ?? 0,
      );
      expect(process.getInfo().providerRuntimeStatus).toBe(null);
      expect(process.resolvedModel).toBe("opus");

      controller.finish();
    });

    it("does not change models when a retry cannot be interrupted", async () => {
      const controller = createControllableIterator();
      const setModelFn = vi.fn(async () => {});
      const interruptFn = vi.fn(async () => false);
      const process = new Process(controller.iterator, {
        queue: new MessageQueue(),
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
        setModelFn,
        interruptFn,
      });

      controller.push({
        type: "system",
        subtype: "api_retry",
        session_id: "sess-1",
        error_status: 429,
        error: "rate_limit",
      });

      await waitFor(() => {
        expect(process.getInfo().providerRuntimeStatus?.kind).toBe("retrying");
      });

      await expect(process.setModel("opus")).rejects.toThrow(
        "Provider retry could not be interrupted before changing models",
      );

      expect(setModelFn).not.toHaveBeenCalled();
      expect(process.getInfo().providerRuntimeStatus?.kind).toBe("retrying");
      expect(process.resolvedModel).toBeUndefined();

      controller.finish();
    });

    it("does not interrupt an ordinary active turn when changing models", async () => {
      const controller = createControllableIterator();
      const setModelFn = vi.fn(async () => {});
      const interruptFn = vi.fn(async () => true);
      const process = new Process(controller.iterator, {
        queue: new MessageQueue(),
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
        setModelFn,
        interruptFn,
      });

      await expect(process.setModel("opus")).resolves.toBe(true);

      expect(setModelFn).toHaveBeenCalledWith("opus");
      expect(interruptFn).not.toHaveBeenCalled();

      controller.finish();
    });

    it("clears retry status when aborted", async () => {
      const controller = createControllableIterator();
      const process = new Process(controller.iterator, {
        queue: new MessageQueue(),
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
      });

      controller.push({
        type: "system",
        subtype: "api_retry",
        session_id: "sess-1",
        error_status: 429,
        error: "rate_limit",
      });

      await waitFor(() => {
        expect(process.getInfo().providerRuntimeStatus?.kind).toBe("retrying");
      });

      const abortPromise = process.abort();
      expect(process.getInfo().providerRuntimeStatus).toBe(null);
      controller.finish();
      await abortPromise;
    });
  });
});
