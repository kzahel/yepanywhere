// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import { SearchHeader, SearchSelection } from "./SearchControls";

const onQuery = vi.fn();
const onFields = vi.fn();

beforeEach(() => {
  onQuery.mockReset();
  onFields.mockReset();
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      matches: true,
      addEventListener() {},
      removeEventListener() {},
    })),
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderControls() {
  render(
    <I18nProvider>
      <SearchHeader
        query=""
        onQuery={onQuery}
        fields={["title"]}
        onFields={onFields}
        supported
        sessionCount={2}
        scanning={false}
        acquiring={false}
      />
      <SearchSelection
        count={0}
        shown={0}
        allShownSelected={false}
        filters={[]}
        onToggle={() => {}}
        onSelectShown={() => {}}
        onClear={() => {}}
        onlySelected={false}
        onOnlySelected={() => {}}
        onManage={() => {}}
        pending={false}
        helpInline
        onHelpInline={() => {}}
      />
    </I18nProvider>,
  );
  const needle = screen.getByRole("searchbox");
  needle.blur();
  return needle as HTMLInputElement;
}

function renderHeader(supported: boolean, supportKnown: boolean) {
  const view = render(
    <I18nProvider>
      <SearchHeader
        query=""
        onQuery={onQuery}
        fields={["title"]}
        onFields={onFields}
        supported={supported}
        supportKnown={supportKnown}
        sessionCount={2}
        scanning={false}
        acquiring={false}
      />
    </I18nProvider>,
  );
  return (nextSupported: boolean, nextSupportKnown: boolean) =>
    view.rerender(
      <I18nProvider>
        <SearchHeader
          query=""
          onQuery={onQuery}
          fields={["title"]}
          onFields={onFields}
          supported={nextSupported}
          supportKnown={nextSupportKnown}
          sessionCount={2}
          scanning={false}
          acquiring={false}
        />
      </I18nProvider>,
    );
}

it("applies a field shortcut pressed before the capability read resolves", () => {
  const rerender = renderHeader(false, false);
  fireEvent.keyDown(document, { key: "r", ctrlKey: true });
  expect(onFields).not.toHaveBeenCalled();
  rerender(true, true);
  expect(onFields).toHaveBeenCalledWith(["user"]);
});

it("discards a held field shortcut once the read reports no support", () => {
  const rerender = renderHeader(false, false);
  fireEvent.keyDown(document, { key: "s", ctrlKey: true });
  rerender(false, true);
  expect(onFields).not.toHaveBeenCalled();
  // The answer consumed the press: later support does not replay it.
  rerender(true, true);
  expect(onFields).not.toHaveBeenCalled();
});

it("leaves Space to a focused control instead of typing it into the needle", () => {
  const needle = renderControls();
  for (const control of [
    screen.getByRole("checkbox", { name: "Title" }),
    screen.getByRole("button", { name: "Filter: Starred" }),
  ]) {
    control.focus();
    // dispatchEvent reports false once preventDefault ran, which is what stops
    // the browser from pressing the control.
    expect(fireEvent.keyDown(control, { key: " " })).toBe(true);
    expect(document.activeElement).toBe(control);
    expect(needle.value).toBe("");
    expect(onQuery).not.toHaveBeenCalled();
  }
});

it("still types a character over a focused control, which ignores it", () => {
  const needle = renderControls();
  const filter = screen.getByRole("button", { name: "Filter: Starred" });
  filter.focus();
  fireEvent.keyDown(filter, { key: "x" });
  expect(needle.value).toBe("x");
  expect(document.activeElement).toBe(needle);
  expect(onQuery).toHaveBeenCalledWith("x");
});

it("types a space into the needle when no control holds focus", () => {
  const needle = renderControls();
  fireEvent.keyDown(document.body, { key: " " });
  expect(needle.value).toBe(" ");
  expect(document.activeElement).toBe(needle);
});
