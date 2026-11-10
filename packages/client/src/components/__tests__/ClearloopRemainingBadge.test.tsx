import type { SessionClearloopBadge } from "@yep-anywhere/shared";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import { ClearloopRemainingBadge } from "../ClearloopRemainingBadge";

const badge: SessionClearloopBadge = {
  remaining: 2,
  total: 3,
  completed: 1,
  cutTurnIndex: 4,
  prompt: "keep going",
  windowSeconds: 60,
};

function renderBadge(overrides: Partial<SessionClearloopBadge> = {}) {
  const controls = {
    onCancel: vi.fn(),
    onSetPatient: vi.fn(),
    onStartNow: vi.fn(),
  };
  render(
    <I18nProvider>
      <ClearloopRemainingBadge
        badge={{ ...badge, ...overrides }}
        controls={controls}
      />
    </I18nProvider>,
  );
  return {
    controls,
    target: screen.getByRole("button", { name: /clearloop/i }),
  };
}

afterEach(cleanup);

describe("ClearloopRemainingBadge", () => {
  it("cancels on a plain click", () => {
    const { controls, target } = renderBadge();
    fireEvent.click(target);
    expect(controls.onCancel).toHaveBeenCalledTimes(1);
  });

  it("offers stop, the patience toggle, and start now on right-click", () => {
    const { controls, target } = renderBadge();
    fireEvent.contextMenu(target);

    const items = screen
      .getAllByRole("menuitem")
      .map((item) => item.textContent);
    expect(items).toEqual([
      "Stop the loop",
      "Patient: also wait for the project",
      "Start the next iteration now",
    ]);

    fireEvent.click(screen.getByRole("menuitem", { name: /^Patient/ }));
    expect(controls.onSetPatient).toHaveBeenCalledWith(true);
  });

  it("names the patient wait and offers the reverse toggle", () => {
    const { controls, target } = renderBadge({ patient: true });
    expect(target.getAttribute("aria-label")).toContain(
      "waiting for the project",
    );

    fireEvent.contextMenu(target);
    fireEvent.click(screen.getByRole("menuitem", { name: /^Impatient/ }));
    expect(controls.onSetPatient).toHaveBeenCalledWith(false);
  });

  it("starts the next iteration now from the menu", () => {
    const { controls, target } = renderBadge();
    fireEvent.contextMenu(target);
    fireEvent.click(screen.getByRole("menuitem", { name: /Start the next/ }));
    expect(controls.onStartNow).toHaveBeenCalledTimes(1);
  });

  it("stays a passive label without controls", () => {
    render(
      <I18nProvider>
        <ClearloopRemainingBadge badge={badge} />
      </I18nProvider>,
    );
    expect(screen.queryByRole("button")).toBeNull();
    expect(
      screen.getByRole("img", { name: /clearloop 2\/3 left/ }),
    ).toBeTruthy();
  });
});
