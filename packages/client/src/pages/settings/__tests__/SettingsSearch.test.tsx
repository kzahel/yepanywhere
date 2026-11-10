// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { lazy, useEffect, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsItem } from "../SettingsItem";
import { SettingsSearchBar } from "../SettingsSearchBar";
import {
  HideInSettingsSearch,
  SettingsJumpTargetProvider,
  type SettingsSearchScope,
  SettingsSearchScopeProvider,
} from "../SettingsSearchContext";
import { SettingsSearchResults } from "../SettingsSearchResults";
import { SettingsSection } from "../SettingsSection";

vi.mock("../../../i18n", () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}));

function makeScope(
  overrides: Partial<SettingsSearchScope> = {},
): SettingsSearchScope {
  return {
    query: "",
    matchValues: false,
    sectionMatched: false,
    categoryLabel: "Appearance",
    jumpToItem: vi.fn(),
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
});

describe("SettingsSearchBar credential boundary", () => {
  it("keeps search outside a mounted settings credential form", () => {
    render(
      <>
        <SettingsSearchBar
          query=""
          onQueryChange={vi.fn()}
          matchValues={false}
          onMatchValuesChange={vi.fn()}
        />
        <input
          type="password"
          aria-label="Browser xAI STT Key"
          autoComplete="new-password"
        />
      </>,
    );

    const search = screen.getByRole("searchbox") as HTMLInputElement;
    const credential = screen.getByLabelText(
      "Browser xAI STT Key",
    ) as HTMLInputElement;

    expect(search.form).not.toBeNull();
    expect(search.form).not.toBe(credential.form);
    expect(search.autocomplete).toBe("off");
    expect(search.name).toBe("settings-search");
  });
});

describe("SettingsItem under search scope", () => {
  it("renders nothing when the query does not match", () => {
    render(
      <SettingsSearchScopeProvider value={makeScope({ query: "webhook" })}>
        <SettingsItem label="Theme" description="Color scheme">
          <input aria-label="Theme" />
        </SettingsItem>
      </SettingsSearchScopeProvider>,
    );
    expect(screen.queryByLabelText("Theme")).toBeNull();
  });

  it("renders operable with highlighted label on a match", () => {
    render(
      <SettingsSearchScopeProvider value={makeScope({ query: "theme" })}>
        <SettingsItem label="Theme" description="Color scheme">
          <input aria-label="Theme" />
        </SettingsItem>
      </SettingsSearchScopeProvider>,
    );
    expect(screen.getByLabelText("Theme")).toBeTruthy();
    const mark = document.querySelector("mark");
    expect(mark?.textContent).toBe("Theme");
  });

  it("offers a jump link labeled category › section", () => {
    const jumpToItem = vi.fn();
    render(
      <SettingsSearchScopeProvider
        value={makeScope({ query: "theme", jumpToItem })}
      >
        <SettingsSection title="Display">
          <SettingsItem label="Theme">
            <input aria-label="Theme" />
          </SettingsItem>
        </SettingsSection>
      </SettingsSearchScopeProvider>,
    );
    const origin = screen.getByText("Appearance › Display ›");
    fireEvent.click(origin);
    expect(jumpToItem).toHaveBeenCalledWith("theme");
  });

  it("matches valueText only when matchValues is on", () => {
    const { rerender } = render(
      <SettingsSearchScopeProvider value={makeScope({ query: "dark" })}>
        <SettingsItem label="Theme" valueText="Dark">
          <input aria-label="Theme" />
        </SettingsItem>
      </SettingsSearchScopeProvider>,
    );
    expect(screen.queryByLabelText("Theme")).toBeNull();

    rerender(
      <SettingsSearchScopeProvider
        value={makeScope({ query: "dark", matchValues: true })}
      >
        <SettingsItem label="Theme" valueText="Dark">
          <input aria-label="Theme" />
        </SettingsItem>
      </SettingsSearchScopeProvider>,
    );
    expect(screen.getByLabelText("Theme")).toBeTruthy();
  });

  it("jumps from row text but preserves controls and selected text", () => {
    const jumpToItem = vi.fn();
    render(
      <SettingsSearchScopeProvider
        value={makeScope({ query: "theme", jumpToItem })}
      >
        <SettingsItem label="Theme" description="Color scheme">
          <label>
            Dark mode <input type="checkbox" />
          </label>
          <button type="button">Save</button>
        </SettingsItem>
      </SettingsSearchScopeProvider>,
    );
    fireEvent.click(screen.getByText("Color scheme"));
    expect(jumpToItem).toHaveBeenCalledTimes(1);
    expect(jumpToItem).toHaveBeenLastCalledWith("theme");
    fireEvent.click(screen.getByText("Dark mode"));
    expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(
      true,
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(jumpToItem).toHaveBeenCalledTimes(1);

    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(screen.getByText("Color scheme"));
    selection?.addRange(range);
    try {
      fireEvent.click(screen.getByText("Color scheme"));
      expect(jumpToItem).toHaveBeenCalledTimes(1);
    } finally {
      selection?.removeAllRanges();
    }
  });

  it("keeps label rows as controls and caller-owned clicks authoritative", () => {
    const jumpToItem = vi.fn();
    render(
      <SettingsSearchScopeProvider
        value={makeScope({ query: "theme", jumpToItem })}
      >
        <SettingsItem as="label" label="Theme toggle">
          <input type="checkbox" />
        </SettingsItem>
        <SettingsItem
          label="Theme custom"
          containerProps={{ onClick: (event) => event.preventDefault() }}
        />
      </SettingsSearchScopeProvider>,
    );
    fireEvent.click(screen.getByText("toggle", { exact: false }));
    expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(
      true,
    );
    fireEvent.click(screen.getByText("custom", { exact: false }));
    expect(jumpToItem).not.toHaveBeenCalled();
  });

  it("matches keywords that are never rendered", () => {
    render(
      <SettingsSearchScopeProvider value={makeScope({ query: "color" })}>
        <SettingsItem label="Theme" keywords={["color scheme"]}>
          <input aria-label="Theme" />
        </SettingsItem>
      </SettingsSearchScopeProvider>,
    );
    expect(screen.getByLabelText("Theme")).toBeTruthy();
  });

  it("searches custom row layouts without changing their content", () => {
    render(
      <SettingsSearchScopeProvider value={makeScope({ query: "typography" })}>
        <SettingsItem
          label="Typography"
          layout="custom"
          baseClassName="custom-settings-panel"
        >
          <input aria-label="Prose font" />
        </SettingsItem>
      </SettingsSearchScopeProvider>,
    );

    expect(screen.getByLabelText("Prose font")).toBeTruthy();
    expect(document.querySelector(".custom-settings-panel")).toBeTruthy();
    expect(screen.getByText("Appearance ›")).toBeTruthy();
  });

  it("reveals matched-row controls intentionally hidden from search alone", () => {
    render(
      <SettingsSearchScopeProvider value={makeScope({ query: "helper" })}>
        <SettingsItem label="Helper target">
          <HideInSettingsSearch>
            <input aria-label="Helper target URL" />
          </HideInSettingsSearch>
        </SettingsItem>
      </SettingsSearchScopeProvider>,
    );

    expect(screen.getByLabelText("Helper target URL")).toBeTruthy();
  });

  it("matches multi-word product names on Session Defaults-style rows", () => {
    render(
      <SettingsSearchScopeProvider
        value={makeScope({ query: "compact context early" })}
      >
        <SettingsItem
          id="session-default-compact-early"
          label="Compact context early"
          description="Optionally ask for compaction once this model's live context passes the chosen share of its full window."
          keywords={["early compact", "autocompact", "/compact"]}
        >
          <input
            type="range"
            aria-label="Compact context early"
            min={0}
            max={99}
          />
        </SettingsItem>
        <SettingsItem label="Unrelated recap">
          <input aria-label="Unrelated recap" />
        </SettingsItem>
      </SettingsSearchScopeProvider>,
    );
    expect(screen.getByLabelText("Compact context early")).toBeTruthy();
    expect(screen.queryByLabelText("Unrelated recap")).toBeNull();
  });

  it("omits searchable={false} clones from search even when they would match", () => {
    render(
      <SettingsSearchScopeProvider
        value={makeScope({ query: "compact context early" })}
      >
        <SettingsItem
          id="primary"
          label="Compact context early"
          description="Primary home"
        >
          <input aria-label="Compact context early primary" type="range" />
        </SettingsItem>
        <SettingsItem
          id="clone"
          searchable={false}
          label="Compact context early"
          description="Clone next to Claude"
        >
          <input aria-label="Compact context early clone" type="range" />
        </SettingsItem>
      </SettingsSearchScopeProvider>,
    );
    expect(screen.getByLabelText("Compact context early primary")).toBeTruthy();
    expect(screen.queryByLabelText("Compact context early clone")).toBeNull();
  });
});

describe("SettingsSection under search scope", () => {
  it("a section title match reveals all child rows", () => {
    render(
      <SettingsSearchScopeProvider value={makeScope({ query: "display" })}>
        <SettingsSection title="Display">
          <SettingsItem label="Theme">
            <input aria-label="Theme" />
          </SettingsItem>
          <SettingsItem label="Tab Size">
            <input aria-label="Tab Size" />
          </SettingsItem>
        </SettingsSection>
      </SettingsSearchScopeProvider>,
    );
    expect(screen.getByLabelText("Theme")).toBeTruthy();
    expect(screen.getByLabelText("Tab Size")).toBeTruthy();
    expect(
      document.querySelector("[data-settings-section-match]"),
    ).toBeTruthy();
  });
});

describe("SettingsItem jump target (normal mode)", () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
  });

  it("scrolls to, flashes, and consumes a matching jump target", () => {
    const consume = vi.fn();
    render(
      <SettingsJumpTargetProvider value={{ target: "theme", consume }}>
        <SettingsItem label="Theme">
          <input aria-label="Theme" />
        </SettingsItem>
      </SettingsJumpTargetProvider>,
    );
    expect(consume).toHaveBeenCalled();
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
    expect(document.querySelector("[data-settings-jump-flash]")).toBeTruthy();
  });

  it("ignores a jump target for another row", () => {
    const consume = vi.fn();
    render(
      <SettingsJumpTargetProvider value={{ target: "other", consume }}>
        <SettingsItem label="Theme">
          <input aria-label="Theme" />
        </SettingsItem>
      </SettingsJumpTargetProvider>,
    );
    expect(consume).not.toHaveBeenCalled();
    expect(document.querySelector("[data-settings-jump-flash]")).toBeNull();
  });
});

describe("SettingsSearchResults", () => {
  function ToyPane() {
    const [checked, setChecked] = useState(false);
    return (
      <SettingsSection title="General">
        <SettingsItem label="Streaming" description="Live token updates">
          <input
            type="checkbox"
            aria-label="Streaming"
            checked={checked}
            onChange={(event) => setChecked(event.target.checked)}
          />
        </SettingsItem>
      </SettingsSection>
    );
  }

  const categories = [
    { id: "toy", label: "Toy", description: "Toy pane" },
    { id: "other", label: "Other", description: "Second pane" },
  ];
  const components = { toy: ToyPane, other: () => null };

  it("yields between cold pane mounts, retains controls and cancels acquisition on exit", () => {
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrame = 0;
    const request = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((callback) => {
        const id = ++nextFrame;
        frames.set(id, callback);
        return id;
      });
    const cancel = vi
      .spyOn(window, "cancelAnimationFrame")
      .mockImplementation((id) => {
        frames.delete(id);
      });
    try {
      const { container, rerender, unmount } = render(
        <SettingsSearchResults
          categories={[
            ...categories,
            { id: "last", label: "Last", description: "Last pane" },
          ]}
          components={{ ...components, last: ToyPane }}
          query="streaming"
          matchValues={false}
          onJumpToItem={vi.fn()}
          onOpenCategory={vi.fn()}
        />,
      );
      const control = screen.getByLabelText("Streaming") as HTMLInputElement;
      fireEvent.click(control);
      expect(container.querySelectorAll("[data-settings-pane]")).toHaveLength(
        1,
      );
      expect(container.querySelector("[aria-busy=true]")).toBeTruthy();
      act(() => {
        const [id, callback] = frames.entries().next().value!;
        frames.delete(id);
        callback(16);
      });
      expect(container.querySelectorAll("[data-settings-pane]")).toHaveLength(
        2,
      );
      expect(screen.getByLabelText("Streaming")).toBe(control);
      expect(control.checked).toBe(true);
      // A later, still-unacquired category may contain a match. Do not claim
      // no results while the corpus is incomplete, even after a query edit.
      rerender(
        <SettingsSearchResults
          categories={[
            ...categories,
            { id: "last", label: "Last", description: "Last pane" },
          ]}
          components={{ ...components, last: ToyPane }}
          query="missing"
          matchValues={false}
          onJumpToItem={vi.fn()}
          onOpenCategory={vi.fn()}
        />,
      );
      expect(screen.queryByText("settingsSearchNoResults")).toBeNull();
      expect(frames.size).toBe(1);
      unmount();
      expect(frames.size).toBe(0);
    } finally {
      request.mockRestore();
      cancel.mockRestore();
    }
  });

  it("lists matching categories and keeps matched rows operable", () => {
    const onJumpToItem = vi.fn();
    render(
      <SettingsSearchResults
        categories={categories}
        components={components}
        query="streaming"
        matchValues={false}
        onJumpToItem={onJumpToItem}
        onOpenCategory={vi.fn()}
      />,
    );
    const toggle = screen.getByLabelText("Streaming") as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    fireEvent.click(toggle);
    expect(toggle.checked).toBe(true);

    fireEvent.click(screen.getByText("Toy › General ›"));
    expect(onJumpToItem).toHaveBeenCalledWith("toy", "streaming");
  });

  it("shows category matches for category-label queries", () => {
    render(
      <SettingsSearchResults
        categories={categories}
        components={components}
        query="other"
        matchValues={false}
        onJumpToItem={vi.fn()}
        onOpenCategory={vi.fn()}
      />,
    );
    expect(screen.getByText("settingsSearchCategoriesHeading")).toBeTruthy();
    expect(screen.getByText("Second pane")).toBeTruthy();
  });

  it("reports no results when nothing matches", async () => {
    render(
      <SettingsSearchResults
        categories={categories}
        components={components}
        query="zzzz"
        matchValues={false}
        onJumpToItem={vi.fn()}
        onOpenCategory={vi.fn()}
      />,
    );
    expect(await screen.findByText("settingsSearchNoResults")).toBeTruthy();
  });

  it("recounts rows loaded asynchronously by a pane", async () => {
    function AsyncPane() {
      const [loaded, setLoaded] = useState(false);
      useEffect(() => setLoaded(true), []);
      return loaded ? (
        <SettingsItem label="Late setting">
          <input aria-label="Late setting" />
        </SettingsItem>
      ) : null;
    }

    render(
      <SettingsSearchResults
        categories={[{ id: "async", label: "Async", description: "Pane" }]}
        components={{ async: AsyncPane }}
        query="late"
        matchValues={false}
        onJumpToItem={vi.fn()}
        onOpenCategory={vi.fn()}
      />,
    );

    expect(await screen.findByLabelText("Late setting")).toBeTruthy();
    await waitFor(() =>
      expect(screen.queryByText("settingsSearchNoResults")).toBeNull(),
    );
  });

  it("keeps results operable while another pane loads and finds its rows later", async () => {
    let resolvePane!: (module: { default: typeof ToyPane }) => void;
    const pending = new Promise<{ default: typeof ToyPane }>((resolve) => {
      resolvePane = resolve;
    });
    const delayed = lazy(() => pending);
    const props = {
      categories,
      components: { toy: ToyPane, other: delayed },
      query: "streaming",
      matchValues: false,
      onJumpToItem: vi.fn(),
      onOpenCategory: vi.fn(),
    };
    const { rerender } = render(<SettingsSearchResults {...props} />);
    fireEvent.click(screen.getByLabelText("Streaming"));
    expect(
      (screen.getByLabelText("Streaming") as HTMLInputElement).checked,
    ).toBe(true);
    expect((await screen.findByRole("status")).textContent).toBe(
      "Other: loading",
    );

    rerender(<SettingsSearchResults {...props} query="missing" />);
    expect(screen.queryByText("settingsSearchNoResults")).toBeNull();
    await act(async () => {
      resolvePane({ default: ToyPane });
      await pending;
    });
    await waitFor(() =>
      expect(screen.getByText("settingsSearchNoResults")).toBeTruthy(),
    );
    rerender(<SettingsSearchResults {...props} />);
    expect(screen.getAllByLabelText("Streaming")).toHaveLength(2);
    fireEvent.click(screen.getByText("Other › General ›"));
    expect(props.onJumpToItem).toHaveBeenCalledWith("other", "streaming");
  });
});
