import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { I18nProvider } from "../../../i18n";
import type { ContentBlock } from "../../../types";
import { UserPromptBlock } from "../UserPromptBlock";

describe("UserPromptBlock", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders Codex input_image blocks as uploaded file metadata", () => {
    const content: ContentBlock[] = [
      {
        type: "text",
        text: "Please review this screenshot.\n<image>\nThanks.",
      },
      {
        type: "input_image",
        image_url: "data:image/png;base64,AAAA",
      },
    ];

    render(
      <I18nProvider>
        <UserPromptBlock content={content} />
      </I18nProvider>,
    );

    expect(screen.getByText(/Please review this screenshot\./)).toBeDefined();
    expect(screen.getByText(/Thanks\./)).toBeDefined();
    expect(screen.queryByText("<image>")).toBeNull();
    expect(
      screen.getByRole("button", { name: /pasted-image-1\.png/i }),
    ).toBeDefined();
    expect(screen.queryByText(/pasted-image-1\.png/)).toBeNull();
    expect(screen.queryByText(/data:image\/png;base64/i)).toBeNull();
  });

  it("opens preview modal for Codex inline input_image attachments", () => {
    const content: ContentBlock[] = [
      {
        type: "text",
        text: "Please review this screenshot.\n<image>\nThanks.",
      },
      {
        type: "input_image",
        image_url: "data:image/png;base64,AAAA",
      },
    ];

    render(
      <I18nProvider>
        <UserPromptBlock content={content} />
      </I18nProvider>,
    );

    const attachmentButton = screen.getByRole("button", {
      name: /pasted-image-1\.png/i,
    });
    fireEvent.click(attachmentButton);

    expect(screen.getByText("pasted-image-1.png (3 B)")).toBeDefined();
    expect(
      screen.getByRole("dialog").querySelector('img[alt="pasted-image-1.png"]'),
    ).not.toBeNull();
  });

  it("uses file_path name for Codex input_image attachments", () => {
    const content: ContentBlock[] = [
      {
        type: "text",
        text: "Annotated image:\n<image>",
      },
      {
        type: "input_image",
        file_path: "/tmp/codex-images/annotated-shot.jpg",
      },
    ];

    render(
      <I18nProvider>
        <UserPromptBlock content={content} />
      </I18nProvider>,
    );

    expect(screen.getByText(/Annotated image:/)).toBeDefined();
    expect(screen.queryByText("<image>")).toBeNull();
    expect(screen.getByText(/annotated-shot\.jpg/)).toBeDefined();
  });

  it("keeps attachment-only prompts in the user prompt container", () => {
    const content: ContentBlock[] = [
      {
        type: "input_image",
        image_url: "data:image/png;base64,AAAA",
      },
    ];

    const { container } = render(
      <I18nProvider>
        <UserPromptBlock content={content} />
      </I18nProvider>,
    );

    expect(container.querySelector(".user-prompt-container")).not.toBeNull();
    expect(container.querySelector(".uploaded-file-image")).not.toBeNull();
  });
});
