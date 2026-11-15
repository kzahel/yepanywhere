// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../api/client";
import type {
  GetSessionResult,
  SourceApiClient,
} from "../../lib/sourceRuntime";
import type { Message } from "../../types";
import {
  buildBtwAsideFollowupPrompt,
  buildBtwAsideInitialPrompt,
  getBtwRequestFromMessages,
  getBtwTranscriptTurns,
  messageContentToBtwLiveText,
  providerSupportsBtwAsideFork,
  truncateBtwPreview,
  useBtwAsides,
} from "../useBtwAsides";

describe("useBtwAsides helpers", () => {
  it("keeps provider fork support explicit", () => {
    expect(providerSupportsBtwAsideFork("claude")).toBe(true);
    expect(providerSupportsBtwAsideFork("codex")).toBe(true);
    expect(providerSupportsBtwAsideFork("codex-oss")).toBe(true);
    expect(providerSupportsBtwAsideFork("opencode")).toBe(false);
    expect(providerSupportsBtwAsideFork(undefined)).toBe(false);
  });

  it("builds parseable initial and follow-up side prompts", () => {
    const initial = buildBtwAsideInitialPrompt("Check the route split");
    const followup = buildBtwAsideFollowupPrompt("Check the focused test");

    expect(initial).toContain("[YA /btw aside]");
    expect(initial).toContain("[Side request]\nCheck the route split");
    expect(followup).toContain("[YA /btw aside]");
    expect(followup).toContain("[Side request]\nCheck the focused test");
    expect(
      getBtwRequestFromMessages([{ type: "user", content: initial }]),
    ).toBe("Check the route split");
    expect(
      getBtwRequestFromMessages([{ type: "user", content: followup }]),
    ).toBe("Check the focused test");
  });

  it("derives aside transcript turns from prompt-marked messages", () => {
    const messages: Message[] = [
      { id: "parent", type: "assistant", content: "Parent setup" },
      {
        uuid: "user-1",
        type: "user",
        content: buildBtwAsideInitialPrompt("Inspect the sidebar"),
      },
      {
        uuid: "assistant-1",
        type: "assistant",
        content: [
          { type: "text", text: "Found the state owner." },
          { type: "tool_use", name: "Read", input: { file_path: "a.ts" } },
        ],
      },
      {
        uuid: "user-2",
        type: "user",
        content: buildBtwAsideFollowupPrompt("Check the tests"),
      },
      {
        uuid: "assistant-2",
        type: "assistant",
        message: { role: "assistant", content: "Tests look focused." },
      },
    ];

    expect(getBtwTranscriptTurns(messages, 0)).toEqual([
      {
        id: "user-1-user",
        role: "user",
        text: "Inspect the sidebar",
      },
      {
        id: "assistant-1-assistant",
        role: "assistant",
        text: "Found the state owner.\nUsing Read: a.ts",
      },
      {
        id: "user-2-user",
        role: "user",
        text: "Check the tests",
      },
      {
        id: "assistant-2-assistant",
        role: "assistant",
        text: "Tests look focused.",
      },
    ]);
  });

  it("formats live text previews for non-text assistant blocks", () => {
    expect(
      messageContentToBtwLiveText([
        { type: "thinking", thinking: "Thinking about a route split" },
        { type: "tool_use", name: "Grep", input: { query: "btw" } },
      ]),
    ).toBe("Thinking: Thinking about a route split\nUsing Grep: btw");
  });

  it("retains a migrated question and answer before /btw follow-ups", () => {
    const messages: Message[] = [
      { id: "parent", type: "assistant", content: "Inherited parent answer" },
      {
        id: "question",
        type: "user",
        content: "[YA question aside test-id]\nInstructions\n[Question]\nWhy?",
      },
      { id: "answer", type: "assistant", content: "The original answer" },
    ];
    expect(getBtwRequestFromMessages(messages)).toBe("Why?");
    messages.push(
      {
        id: "followup",
        type: "user",
        content: buildBtwAsideFollowupPrompt("What next?"),
      },
      { id: "next-answer", type: "assistant", content: "The next step" },
    );
    expect(getBtwTranscriptTurns(messages, Number.MAX_SAFE_INTEGER)).toEqual([
      { id: "question-user", role: "user", text: "Why?" },
      {
        id: "answer-assistant",
        role: "assistant",
        text: "The original answer",
      },
      { id: "followup-user", role: "user", text: "What next?" },
      { id: "next-answer-assistant", role: "assistant", text: "The next step" },
    ]);
  });

  it("hides native-fork history until the aside prompt arrives", () => {
    const messages: Message[] = [
      { id: "inherited", type: "assistant", content: "An old parent answer" },
    ];
    const inheritedPrefixBound = Number.MAX_SAFE_INTEGER;
    expect(getBtwTranscriptTurns(messages, inheritedPrefixBound)).toEqual([]);
    messages.push(
      {
        id: "question",
        type: "user",
        content: buildBtwAsideInitialPrompt("Why?"),
      },
      { id: "answer", type: "assistant", content: "The aside answer" },
    );
    expect(getBtwTranscriptTurns(messages, inheritedPrefixBound)).toEqual([
      { id: "question-user", role: "user", text: "Why?" },
      { id: "answer-assistant", role: "assistant", text: "The aside answer" },
    ]);
  });

  it("normalizes and truncates preview text", () => {
    expect(truncateBtwPreview("  one\n\n two\tthree  ")).toBe("one two three");
    expect(truncateBtwPreview("x".repeat(710))).toHaveLength(700);
  });
});

describe("/btw aside poll ownership", () => {
  const POLL_MS = 1500;
  let replies: Array<(owner: "self" | "none") => void>;
  let getSession: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    replies = [];
    vi.spyOn(api, "cloneSession").mockResolvedValue({
      sessionId: "aside-session",
      messageCount: 0,
      clonedFrom: "parent",
      provider: "claude",
    });
    vi.spyOn(api, "resumeSession").mockResolvedValue({
      processId: "aside-process",
      permissionMode: "default",
      modeVersion: 1,
      serverTimestamp: 0,
    });
    vi.spyOn(api, "interruptProcess").mockResolvedValue({
      interrupted: true,
      supported: true,
    });
    getSession = vi.fn(
      () =>
        new Promise<GetSessionResult>((resolve) => {
          replies.push((owner) =>
            resolve({
              session: { id: "aside-session" },
              ownership:
                owner === "none"
                  ? { owner: "none" }
                  : { owner: "self", processId: "aside-process" },
              messages: [{ type: "assistant", content: `answer ${owner}` }],
            } as unknown as GetSessionResult),
          );
        }),
    );
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  async function startPolledAside() {
    const sourceApi = { getSession } as unknown as SourceApiClient;
    const hook = renderHook(
      ({ sessionId }: { sessionId: string }) =>
        useBtwAsides({
          basePath: "",
          projectId: "project",
          sessionId,
          actualSessionId: sessionId,
          locationSearch: "",
          sourceApi,
          effectiveProvider: "claude",
          isWideScreen: true,
          permissionMode: "default",
          liveModel: undefined,
          sessionModel: undefined,
          sessionExecutor: undefined,
          parentSessionId: null,
          showToast: vi.fn(),
          onNavigateToParentAside: vi.fn(),
        }),
      { initialProps: { sessionId: "parent" } },
    );
    await act(async () => {
      hook.result.current.startBtwAside("Check the route split");
    });
    await act(() => vi.advanceTimersByTimeAsync(POLL_MS));
    expect(getSession).toHaveBeenCalledTimes(1);
    return hook;
  }

  async function reply(owner: "self" | "none") {
    await act(async () => {
      replies.shift()?.(owner);
    });
  }

  async function expectNoFurtherPolls(calls: number) {
    await act(() => vi.advanceTimersByTimeAsync(POLL_MS * 10));
    expect(getSession).toHaveBeenCalledTimes(calls);
  }

  it("stops when the hook unmounts, even with a request in flight", async () => {
    const hook = await startPolledAside();
    hook.unmount();
    await reply("self");
    await expectNoFurtherPolls(1);
  });

  it("stops when the session changes", async () => {
    const hook = await startPolledAside();
    await reply("self");
    expect(hook.result.current.stickyBtwAsides[0]?.status).toBe("running");
    hook.rerender({ sessionId: "other" });
    await expectNoFurtherPolls(1);
  });

  it("stops when the aside is stopped and drops the late reply", async () => {
    const hook = await startPolledAside();
    const asideId = hook.result.current.stickyBtwAsides[0]?.id ?? "";
    await act(() => hook.result.current.handleStopBtwAside(asideId));
    await reply("none");
    const aside = hook.result.current.historyBtwAsides[0];
    expect(aside?.status).toBe("stopped");
    expect(aside?.preview).toBeUndefined();
    await expectNoFurtherPolls(1);
  });

  it("stops when the asides are reset", async () => {
    const hook = await startPolledAside();
    await reply("self");
    act(() => hook.result.current.resetBtwAsides());
    await expectNoFurtherPolls(1);
  });
});
