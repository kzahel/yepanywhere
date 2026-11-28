import { toUrlProjectId } from "@yep-anywhere/shared";
import type {
  CodexSessionContent,
  CodexSessionEntry,
  UnifiedSession,
} from "@yep-anywhere/shared";
import { assert } from "vitest";
import type { Message as ProjectionMessage } from "@yep-anywhere/shared/transcript/message";
import type { LoadedSession } from "../../src/sessions/types.js";
import type { Message } from "../../src/supervisor/types.js";

type DirectTranscriptProvider = "antigravity" | "pi";
type DirectTranscriptMessages = Extract<
  UnifiedSession,
  { provider: DirectTranscriptProvider }
>["session"]["messages"];

export function transcriptMessages(
  loaded: LoadedSession | null,
  provider: DirectTranscriptProvider,
): DirectTranscriptMessages {
  assert(loaded, `Expected a ${provider} session`);
  const data = loaded.data;
  assert(
    data.provider === provider,
    `Expected ${provider}, received ${data.provider}`,
  );
  return data.session.messages;
}

export function codexEntries(
  loaded: LoadedSession | null,
): CodexSessionContent["entries"] {
  assert(loaded, "Expected a Codex session");
  const { data } = loaded;
  assert(data.provider === "codex" || data.provider === "codex-oss");
  return data.session.entries;
}

export function projectionMessages(
  messages: readonly Message[],
): ProjectionMessage[] {
  return messages.map((row) => {
    const { message } = row;
    if (!message) return { ...row, message: undefined };
    const { role } = message;
    assert(
      role === undefined || role === "user" || role === "assistant",
      `Unexpected transcript role: ${role}`,
    );
    return { ...row, message: { ...message, role } };
  });
}

export function codexSessionFixture(
  entries: CodexSessionEntry[],
  {
    id,
    title,
    provider,
    from,
    to,
  }: {
    id: string;
    title: string;
    provider: "codex" | "codex-oss";
    from: string;
    to: string;
  },
): LoadedSession {
  return {
    summary: {
      id,
      projectId: toUrlProjectId("/test-project"),
      title,
      fullTitle: title,
      createdAt: from,
      updatedAt: to,
      messageCount: entries.length,
      ownership: { owner: "none" },
      provider,
    },
    data: { provider, session: { entries } },
    transcriptSnapshotUpdatedAt: to,
  };
}
