import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { toUrlProjectId, type UrlProjectId } from "@yep-anywhere/shared";
import { CONCAT_SEPARATOR, MessageQueue } from "../src/sdk/messageQueue.js";
import { getLogger } from "../src/logging/logger.js";
import type { AgentProvider } from "../src/sdk/providers/types.js";
import type {
  ProviderRetentionSnapshot,
  SDKMessage,
} from "../src/sdk/types.js";
import { SessionQueuePersistenceService } from "../src/services/SessionQueuePersistenceService.js";
import { Process } from "../src/supervisor/Process.js";
import type { ProcessEvent } from "../src/supervisor/types.js";

export { CONCAT_SEPARATOR, getLogger, MessageQueue, Process, toUrlProjectId };
export type {
  AgentProvider,
  ProcessEvent,
  ProviderRetentionSnapshot,
  SDKMessage,
  UrlProjectId,
};

export function createMockIterator(
  messages: SDKMessage[],
): AsyncIterator<SDKMessage> {
  let index = 0;
  return {
    async next() {
      if (index >= messages.length) {
        return { done: true as const, value: undefined };
      }
      return { done: false as const, value: messages[index++]! };
    },
  };
}

export function createControllableIterator(): {
  iterator: AsyncIterableIterator<SDKMessage>;
  push: (message: SDKMessage) => void;
  finish: () => void;
} {
  const queue: IteratorResult<SDKMessage>[] = [];
  let resolveNext: ((result: IteratorResult<SDKMessage>) => void) | null = null;

  const pushResult = (result: IteratorResult<SDKMessage>) => {
    if (resolveNext) {
      const resolve = resolveNext;
      resolveNext = null;
      resolve(result);
      return;
    }
    queue.push(result);
  };

  return {
    iterator: {
      [Symbol.asyncIterator]() {
        return this;
      },
      next() {
        const queued = queue.shift();
        if (queued) {
          return Promise.resolve(queued);
        }
        return new Promise<IteratorResult<SDKMessage>>((resolve) => {
          resolveNext = resolve;
        });
      },
    },
    push(message: SDKMessage) {
      pushResult({ done: false, value: message });
    },
    finish() {
      pushResult({ done: true, value: undefined });
    },
  };
}

export async function waitFor(assertion: () => void): Promise<void> {
  const timeoutAt = Date.now() + 1000;
  while (Date.now() < timeoutAt) {
    try {
      assertion();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  assertion();
}

export async function withSessionQueuePersistence<T>(
  fn: (options: {
    service: SessionQueuePersistenceService;
    projectId: UrlProjectId;
  }) => Promise<T>,
): Promise<T> {
  const testDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "process-session-queue-"),
  );
  try {
    const service = new SessionQueuePersistenceService({ dataDir: testDir });
    await service.initialize();
    return await fn({
      service,
      projectId: toUrlProjectId("/tmp/process-session-queue"),
    });
  } finally {
    await fs.rm(testDir, { recursive: true, force: true });
  }
}

export function createRecapProvider(
  generateSummary: AgentProvider["generateSummary"],
): AgentProvider {
  return {
    name: "claude",
    displayName: "Claude",
    supportsPermissionMode: true,
    supportsThinkingToggle: true,
    supportsSlashCommands: true,
    supportsSteering: false,
    supportsRecaps: true,
    isInstalled: async () => true,
    isAuthenticated: async () => true,
    getAuthStatus: async () => ({
      installed: true,
      authenticated: true,
      enabled: true,
    }),
    getAvailableModels: async () => [],
    startSession: async () => {
      throw new Error("not used");
    },
    generateSummary,
  };
}
