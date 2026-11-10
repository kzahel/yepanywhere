import { render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

const subscribeDraftStorage = vi.fn((_key: string, _listener: () => void) =>
  vi.fn(),
);
vi.mock("../draftSyncStorage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../draftSyncStorage")>()),
  subscribeDraftStorage,
}));

const { useQuestionRecords } = await import("../asyncQuestionRecords");

afterEach(() => subscribeDraftStorage.mockClear());

function Records({ id, tick }: { id: string; tick: number }) {
  useQuestionRecords(id);
  return <span>{tick}</span>;
}

it("keeps one draft subscription across re-renders of the same session", () => {
  // Each wildcard subscription refreshes the whole synced draft index, so a
  // session page that re-renders on every transcript append must not
  // resubscribe.
  const view = render(<Records id="yep-async-questions:local:a" tick={0} />);
  for (let tick = 1; tick <= 5; tick++)
    view.rerender(<Records id="yep-async-questions:local:a" tick={tick} />);
  expect(subscribeDraftStorage).toHaveBeenCalledTimes(1);
  view.rerender(<Records id="yep-async-questions:local:b" tick={6} />);
  expect(subscribeDraftStorage).toHaveBeenCalledTimes(2);
  expect(subscribeDraftStorage.mock.calls.map(([key]) => key)).toEqual([
    "yep-async-questions:local:a:*",
    "yep-async-questions:local:b:*",
  ]);
  view.unmount();
});
