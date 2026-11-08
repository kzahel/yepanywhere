// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import { SessionMenu, type SessionMenuProps } from "../SessionMenu";
import styles from "../SessionMenu.module.css";

afterEach(() => {
  cleanup();
});

function renderMenu(props: Partial<SessionMenuProps> = {}) {
  return render(
    <I18nProvider>
      <SessionMenu
        sessionId="session-1"
        projectId="project-1"
        isStarred={false}
        isArchived={false}
        onToggleStar={vi.fn()}
        onToggleArchive={vi.fn()}
        onRename={vi.fn()}
        {...props}
      />
    </I18nProvider>,
  );
}

describe("SessionMenu CSS module contracts", () => {
  it("keeps the caller and global hooks alongside module classes", () => {
    const { container } = renderMenu({
      className: "session-list-item__menu",
      overlayTrigger: true,
    });
    const wrapper = container.firstElementChild as HTMLElement;
    const trigger = screen.getByRole("button", { name: "Session options" });

    expect(wrapper.classList.contains(styles.wrapper ?? "")).toBe(true);
    expect(wrapper.classList.contains(styles.overlayTrigger ?? "")).toBe(true);
    expect(wrapper.classList.contains("session-menu-wrapper")).toBe(true);
    expect(wrapper.classList.contains("session-list-item__menu")).toBe(true);
    expect(wrapper.classList.contains("is-open")).toBe(false);
    expect(trigger.classList.contains("session-menu-trigger")).toBe(true);

    fireEvent.click(trigger);

    expect(wrapper.classList.contains("is-open")).toBe(true);
    const dropdown = screen.getByRole("button", { name: "Star" })
      .parentElement as HTMLElement;
    expect(dropdown.classList.contains(styles.dropdown ?? "")).toBe(true);
    expect(dropdown.classList.contains("session-menu-dropdown")).toBe(false);
  });

  it("styles the terminate variant in a fixed-position portal", () => {
    const { container } = renderMenu({
      processId: "process-1",
      onTerminate: vi.fn(),
      useFixedPositioning: true,
    });
    const trigger = screen.getByRole("button", { name: "Session options" });

    fireEvent.click(trigger);

    const terminateButton = screen.getByRole("button", { name: "Terminate" });
    const dropdown = terminateButton.parentElement as HTMLElement;
    expect(container.contains(dropdown)).toBe(false);
    expect(document.body.contains(dropdown)).toBe(true);
    expect(dropdown.classList.contains(styles.dropdown ?? "")).toBe(true);
    expect(dropdown.style.position).toBe("fixed");
    expect(
      terminateButton.classList.contains(styles.terminateButton ?? ""),
    ).toBe(true);
    expect(terminateButton.classList.contains("terminate-button")).toBe(false);
  });

  it("exposes direct Clone with pending and disabled states", async () => {
    const onClone = vi.fn(async () => undefined);
    const { rerender } = renderMenu({ onClone });
    fireEvent.click(screen.getByRole("button", { name: "Session options" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Clone" }));
    });
    expect(onClone).toHaveBeenCalledTimes(1);

    rerender(
      <I18nProvider>
        <SessionMenu
          sessionId="session-1"
          projectId="project-1"
          isStarred={false}
          isArchived={false}
          onToggleStar={vi.fn()}
          onToggleArchive={vi.fn()}
          onRename={vi.fn()}
          onClone={onClone}
          cloneDisabled
        />
      </I18nProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Session options" }));
    expect(
      (screen.getByRole("button", { name: "Clone" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("keeps incompatible Clone visible with update guidance", () => {
    renderMenu({
      cloneUnavailableMessage: "Update the server to use Codex Clone.",
    });
    fireEvent.click(screen.getByRole("button", { name: "Session options" }));

    const clone = screen.getByRole("button", {
      name: "Clone (server update required)",
    });
    expect((clone as HTMLButtonElement).disabled).toBe(true);
    expect(clone.getAttribute("title")).toBe(
      "Update the server to use Codex Clone.",
    );
  });

  it("opens project settings from the session menu", () => {
    const onConfigureProjectSettings = vi.fn();
    renderMenu({ onConfigureProjectSettings });

    fireEvent.click(screen.getByRole("button", { name: "Session options" }));
    fireEvent.click(screen.getByRole("button", { name: "Project settings" }));

    expect(onConfigureProjectSettings).toHaveBeenCalledOnce();
  });

  it("explains unavailable compaction before a user can request it", () => {
    const onCompact = vi.fn();
    renderMenu({ onCompact, compactDisabled: true });
    fireEvent.click(screen.getByRole("button", { name: "Session options" }));

    const compact = screen.getByRole("button", {
      name: "Compact (turn active)",
    });
    expect((compact as HTMLButtonElement).disabled).toBe(true);
    expect(compact.title).toBe(
      "Unavailable until this turn finishes, including tool waits.",
    );
    fireEvent.click(compact);
    expect(onCompact).not.toHaveBeenCalled();
  });

  it("copies the session id and confirms it in place", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    renderMenu({ sessionId: "abc-123" });
    fireEvent.click(screen.getByRole("button", { name: "Session options" }));

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy session id" }));
    });

    expect(writeText).toHaveBeenCalledWith("abc-123");
    expect(
      screen.getByRole("button", { name: "Copied session id" }),
    ).toBeTruthy();
  });

  describe("closing after a copied session id", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    function openMenu() {
      fireEvent.click(screen.getByRole("button", { name: "Session options" }));
    }

    function menuIsOpen() {
      return (
        screen
          .getByRole("button", { name: "Session options" })
          .getAttribute("aria-expanded") === "true"
      );
    }

    it("closes the menu a second after confirming the copy", async () => {
      vi.useFakeTimers();
      Object.defineProperty(navigator, "clipboard", {
        value: { writeText: vi.fn().mockResolvedValue(undefined) },
        configurable: true,
      });
      renderMenu();
      openMenu();
      await act(async () => {
        fireEvent.click(
          screen.getByRole("button", { name: "Copy session id" }),
        );
      });

      act(() => vi.advanceTimersByTime(1000));

      expect(menuIsOpen()).toBe(false);
    });

    it("leaves a menu reopened before that second alone", async () => {
      vi.useFakeTimers();
      Object.defineProperty(navigator, "clipboard", {
        value: { writeText: vi.fn().mockResolvedValue(undefined) },
        configurable: true,
      });
      renderMenu();
      openMenu();
      await act(async () => {
        fireEvent.click(
          screen.getByRole("button", { name: "Copy session id" }),
        );
      });
      fireEvent.mouseDown(document.body);
      openMenu();

      act(() => vi.advanceTimersByTime(1000));

      expect(menuIsOpen()).toBe(true);
      expect(
        screen.getByRole("button", { name: "Copy session id" }),
      ).toBeTruthy();
    });

    it("ignores a copy that finishes after its menu closed", async () => {
      vi.useFakeTimers();
      let finishCopy: () => void = () => {};
      Object.defineProperty(navigator, "clipboard", {
        value: {
          writeText: vi.fn(
            () =>
              new Promise<void>((resolve) => {
                finishCopy = resolve;
              }),
          ),
        },
        configurable: true,
      });
      renderMenu();
      openMenu();
      fireEvent.click(screen.getByRole("button", { name: "Copy session id" }));
      fireEvent.mouseDown(document.body);
      await act(async () => finishCopy());
      openMenu();

      act(() => vi.advanceTimersByTime(1000));

      expect(menuIsOpen()).toBe(true);
      expect(
        screen.getByRole("button", { name: "Copy session id" }),
      ).toBeTruthy();
    });
  });

  it("says so when the clipboard refuses the session id", async () => {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
      configurable: true,
    });
    renderMenu();
    fireEvent.click(screen.getByRole("button", { name: "Session options" }));

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy session id" }));
    });

    expect(
      screen.getByRole("button", { name: "Clipboard blocked — copy failed" }),
    ).toBeTruthy();
  });
});

describe("SessionMenu sidebar categories", () => {
  it("files under an existing or newly typed category, or none", () => {
    const onSetSidebarCategory = vi.fn();
    renderMenu({
      sidebarCategory: "Paper",
      sidebarCategoryNames: ["Paper", "PII program"],
      onSetSidebarCategory,
    });
    const open = () => {
      fireEvent.click(screen.getByRole("button", { name: "Session options" }));
      fireEvent.click(screen.getByRole("button", { name: "Move to category" }));
    };

    // The choices stay folded until asked for.
    fireEvent.click(screen.getByRole("button", { name: "Session options" }));
    expect(screen.queryByRole("button", { name: /PII program/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Move to category" }));
    fireEvent.click(screen.getByRole("button", { name: /PII program/ }));
    expect(onSetSidebarCategory).toHaveBeenLastCalledWith("PII program");

    // Choosing the current category again takes the session out of it.
    open();
    fireEvent.click(screen.getByRole("button", { name: /Paper/ }));
    expect(onSetSidebarCategory).toHaveBeenLastCalledWith(null);

    open();
    fireEvent.click(screen.getByRole("button", { name: "New category…" }));
    const input = screen.getByRole("textbox", { name: "New category…" });
    let typed = "";
    for (const key of "  Grant  work") {
      typed += key;
      fireEvent.change(input, { target: { value: typed } });
      expect((input as HTMLInputElement).value).toBe(typed);
    }
    fireEvent.submit(input);
    expect(onSetSidebarCategory).toHaveBeenLastCalledWith("Grant work");

    open();
    fireEvent.click(
      screen.getByRole("button", { name: "Remove from category" }),
    );
    expect(onSetSidebarCategory).toHaveBeenLastCalledWith(null);
  });

  it("offers no category entry when the caller cannot store one", () => {
    renderMenu();
    fireEvent.click(screen.getByRole("button", { name: "Session options" }));
    expect(
      screen.queryByRole("button", { name: "Move to category" }),
    ).toBeNull();
  });
});
