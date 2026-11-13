import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  AsyncQuestionsButton,
  type AsyncQuestionsMenuState,
} from "../AsyncQuestionsButton";
import { I18nProvider } from "../../i18n";

/** A question past the count stage but short of the retired stage. */
const quietInventory: AsyncQuestionsMenuState = {
  questions: [
    {
      id: "q1",
      messageId: "m1",
      renderId: "m1",
      index: 0,
      title: "Which relay should the hosted client default to?",
      options: [],
      age: 5,
    },
  ],
  records: {},
  reminderTurns: 3,
  menuOpen: false,
  setMenuOpen: () => {},
  open: () => {},
  update: () => {},
};

const renderButton = (props: Parameters<typeof AsyncQuestionsButton>[0]) =>
  render(
    <I18nProvider>
      <AsyncQuestionsButton {...props} />
    </I18nProvider>,
  );

describe("AsyncQuestionsButton", () => {
  it("keeps the quiet control to its icon where space is tightest", () => {
    renderButton({ compact: "late", inventory: quietInventory });
    const button = screen.getByRole("button", { name: "Questions" });
    expect(button.textContent).toBe("");
  });

  it("shows a question's age and stops counting it once it is days old", () => {
    const question = quietInventory.questions[0]!;
    const asked = (askedAtMs: number): AsyncQuestionsMenuState => ({
      ...quietInventory,
      questions: [{ ...question, age: 0, askedAtMs }],
    });
    const hour = 60 * 60 * 1000;
    const { unmount } = renderButton({
      compact: "none",
      inventory: asked(Date.now() - 2 * hour),
    });
    fireEvent.click(screen.getByRole("button", { name: "1 question" }));
    expect(
      screen.getByRole("button", { name: question.title }).textContent,
    ).toContain("2h");
    unmount();
    // No turn has followed it, as in a session left idle, yet it no longer
    // asks for attention.
    renderButton({
      compact: "none",
      inventory: asked(Date.now() - 4 * 24 * hour),
    });
    expect(screen.queryByRole("button", { name: /question/i })).toBeNull();
  });

  it("still spells out the control when the row has room", () => {
    renderButton({ compact: "none", inventory: quietInventory });
    expect(
      screen.getByRole("button", { name: "Questions" }).textContent,
    ).toContain("Questions");
  });
});
