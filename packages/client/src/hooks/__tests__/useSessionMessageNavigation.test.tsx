// @vitest-environment jsdom

import type { Message } from "../../types";

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { useState } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { useSessionMessageNavigation } from "../useSessionMessageNavigation";

vi.mock("../../lib/clientSummaryStore", () => ({
  useClientSummarySourceKey: () => "host:test",
}));

interface Turn extends Message {
  uuid: string;
}

/** A message list that reports every scan the navigation decision makes. */
function countingMessages(turns: Turn[], scanned: () => void): Turn[] {
  const messages = [...turns];
  Object.defineProperty(messages, "find", {
    value(this: Turn[], predicate: (turn: Turn) => boolean) {
      scanned();
      return Array.prototype.find.call(this, predicate);
    },
  });
  return messages;
}

interface HarnessProps {
  messages: Turn[];
  loadOlder: () => Promise<void>;
  jump: (target: string, onResolved: (found: boolean) => void) => void;
  onError?: (kind: "unavailable" | "completion") => void;
}

function Harness({ messages, loadOlder, jump, onError }: HarnessProps) {
  const [repaints, repaint] = useState(0);
  useSessionMessageNavigation({
    sessionId: "session",
    target: "turn-9",
    enabled: true,
    messages,
    loading: false,
    loadingOlder: false,
    hasOlder: true,
    olderCursor: "cursor-1",
    loadOlder,
    jump,
    onError: onError ?? (() => {}),
  });
  return (
    <button type="button" onClick={() => repaint(repaints + 1)}>
      repaint
    </button>
  );
}

function renderNavigation(props: HarnessProps) {
  const { rerender, ...rest } = render(
    <MemoryRouter>
      <Harness {...props} />
    </MemoryRouter>,
  );
  return {
    ...rest,
    rerender: (next: HarnessProps) =>
      rerender(
        <MemoryRouter>
          <Harness {...next} />
        </MemoryRouter>,
      ),
  };
}

afterEach(() => {
  cleanup();
});

it("scans the loaded turns once while an older page is in flight", async () => {
  const scanned = vi.fn();
  const loadOlder = vi.fn(() => new Promise<void>(() => {}));
  renderNavigation({
    messages: countingMessages([{ uuid: "turn-1" }], scanned),
    loadOlder,
    jump: vi.fn(),
  });

  expect(scanned).toHaveBeenCalledTimes(1);
  expect(loadOlder).toHaveBeenCalledTimes(1);
  for (let repaint = 0; repaint < 3; repaint++)
    fireEvent.click(screen.getByRole("button", { name: "repaint" }));
  expect(scanned).toHaveBeenCalledTimes(1);
  expect(loadOlder).toHaveBeenCalledTimes(1);
});

it("jumps to a target an arriving page adds", async () => {
  const scanned = vi.fn();
  const loadOlder = vi.fn(() => new Promise<void>(() => {}));
  const jump = vi.fn();
  const props: HarnessProps = {
    messages: countingMessages([{ uuid: "turn-1" }], scanned),
    loadOlder,
    jump,
  };
  const { rerender } = renderNavigation(props);

  expect(jump).not.toHaveBeenCalled();
  rerender({
    ...props,
    messages: countingMessages(
      [{ uuid: "turn-1" }, { uuid: "turn-9" }],
      scanned,
    ),
  });
  expect(jump).toHaveBeenCalledWith("turn-9", expect.any(Function));
});

it("gives up once a page lands without the target", async () => {
  const scanned = vi.fn();
  let delivered!: () => void;
  const loadOlder = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        delivered = resolve;
      }),
  );
  const onError = vi.fn();
  renderNavigation({
    messages: countingMessages([{ uuid: "turn-1" }], scanned),
    loadOlder,
    jump: vi.fn(),
    onError,
  });

  expect(onError).not.toHaveBeenCalled();
  await act(async () => {
    delivered();
  });
  expect(onError).toHaveBeenCalledWith("unavailable");
});

it("resolves an original input to its grouped row without paging for a missing turn", () => {
  const jump = vi.fn();
  const loadOlder = vi.fn(async () => {});
  const onError = vi.fn();
  renderNavigation({
    messages: [
      {
        uuid: "native-group",
        type: "user",
        inputMessageIds: ["native-group", "turn-9"],
      },
    ],
    jump,
    loadOlder,
    onError,
  });
  expect(jump).toHaveBeenCalledWith("native-group", expect.any(Function));
  expect(loadOlder).not.toHaveBeenCalled();
  expect(onError).not.toHaveBeenCalled();
});
