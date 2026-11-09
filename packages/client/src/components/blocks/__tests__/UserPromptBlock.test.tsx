import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionMetadataProvider } from "../../../contexts/SessionMetadataContext";
import { I18nProvider } from "../../../i18n";
import { useRemoteImage } from "../../../hooks/useRemoteImage";
import type { ContentBlock } from "../../../types";
import { UserPromptBlock } from "../UserPromptBlock";

vi.mock("../../../hooks/useRemoteImage", () => ({
  useRemoteImage: vi.fn(() => ({ url: null, loading: false, error: null })),
}));

describe("UserPromptBlock", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
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
    expect(screen.getByText(/pasted-image-1\.png/)).toBeDefined();
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

    expect(
      screen.getByRole("img", { name: /pasted-image-1\.png/i }),
    ).toBeDefined();
  });

  it("uses file_path name for Codex input_image attachments", async () => {
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

    // Let the chip's attachment-cache load settle (it rejects in jsdom)
    // before the test ends, so its setState lands inside act.
    await waitFor(() => expect(screen.queryByText("Loading...")).toBeNull());

    expect(screen.getByText(/Annotated image:/)).toBeDefined();
    expect(screen.queryByText("<image>")).toBeNull();
    expect(screen.getByText(/annotated-shot\.jpg/)).toBeDefined();
  });

  it("shows Windows opened-file metadata by filename", () => {
    const path = "C:\\Users\\user\\Documents\\code\\playbox\\src\\app.ts";
    const content = `<ide_opened_file>The user opened the file ${path} in the IDE.</ide_opened_file>Question`;

    render(
      <I18nProvider>
        <UserPromptBlock content={content} />
      </I18nProvider>,
    );

    expect(screen.getByText("app.ts")).toBeDefined();
    expect(screen.queryByText(path)).toBeNull();
  });

  it("orders actions and starts with containment-safe one-column packing", () => {
    render(
      <I18nProvider>
        <UserPromptBlock
          content={"Please handle this long user turn. ".repeat(5)}
          onCorrect={vi.fn()}
          onForkBefore={vi.fn()}
          onForkAfter={vi.fn()}
          onForkAfterSummary={vi.fn()}
          onTrimBefore={vi.fn()}
        />
      </I18nProvider>,
    );

    const container = screen
      .getByText(/Please handle this long user turn/)
      .closest<HTMLElement>(".user-prompt-container");
    expect(
      container?.style.getPropertyValue("--user-prompt-action-count"),
    ).toBe("4");
    expect(
      container?.style.getPropertyValue("--user-prompt-action-columns"),
    ).toBe("1");
    expect(container?.style.getPropertyValue("--user-prompt-action-rows")).toBe(
      "4",
    );

    const actionLabels = Array.from(
      container?.querySelectorAll(".user-prompt-actions button") ?? [],
    ).map((button) => button.getAttribute("aria-label"));
    expect(actionLabels).toEqual([
      "Copy message text",
      "Edit latest message",
      "Fork from this turn",
      "Show starting here",
    ]);
  });

  it("offers after but not before for a first-turn fork menu", () => {
    const onForkAfter = vi.fn();
    render(
      <I18nProvider>
        <UserPromptBlock
          content="First request"
          onForkAfter={onForkAfter}
          onForkAfterSummary={vi.fn()}
        />
      </I18nProvider>,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Fork from this turn" }),
    );
    expect(
      screen.queryByRole("menuitem", { name: "Before this turn" }),
    ).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: "After this turn" }));
    expect(onForkAfter).toHaveBeenCalledTimes(1);
  });

  it("keeps plain forks when fork with summary is unavailable", () => {
    // Routed sessions refuse fork with summary but still fork transcripts.
    const onForkBefore = vi.fn();
    render(
      <I18nProvider>
        <UserPromptBlock
          content="Routed request"
          onForkBefore={onForkBefore}
          onForkAfter={vi.fn()}
        />
      </I18nProvider>,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Fork from this turn" }),
    );
    expect(
      screen.getByRole("menuitem", { name: "After this turn" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("menuitem", { name: "After with summary…" }),
    ).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: "Before this turn" }));
    expect(onForkBefore).toHaveBeenCalledTimes(1);
  });

  it("renders a disabled fork action with server update guidance", () => {
    render(
      <I18nProvider>
        <UserPromptBlock
          content="Modern Codex request"
          forkUnavailableMessage="Update this YA server for Codex forks."
        />
      </I18nProvider>,
    );

    const fork = screen.getByRole("button", { name: "Fork from this turn" });
    expect((fork as HTMLButtonElement).disabled).toBe(false);
    expect(fork.getAttribute("title")).toBe(
      "Update this YA server for Codex forks.",
    );
    fireEvent.click(fork);
    expect(
      screen
        .getByRole("menuitem", {
          name: "Update this YA server for Codex forks.",
        })
        .getAttribute("aria-disabled") === "true",
    ).toBe(true);
  });

  it("keeps before available while disabling active after actions", () => {
    render(
      <I18nProvider>
        <UserPromptBlock
          content="Active later request"
          onForkBefore={vi.fn()}
          onForkAfter={vi.fn()}
          onForkAfterSummary={vi.fn()}
          forkAfterDisabled
        />
      </I18nProvider>,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Fork from this turn" }),
    );
    expect(
      screen
        .getByRole("menuitem", {
          name: "Before this turn",
        })
        .getAttribute("aria-disabled") === "true",
    ).toBe(false);
    expect(
      screen
        .getByRole("menuitem", {
          name: "After this turn",
        })
        .getAttribute("aria-disabled") === "true",
    ).toBe(true);
    expect(
      screen
        .getByRole("menuitem", {
          name: "After with summary…",
        })
        .getAttribute("aria-disabled") === "true",
    ).toBe(true);
  });

  it("marks an unconfirmed send with a margin tag whose tap explains it", () => {
    render(
      <I18nProvider>
        <UserPromptBlock content="hello there" deliveryState="sent" />
      </I18nProvider>,
    );

    const bubble = screen
      .getByText("hello there")
      .closest(".message-user-prompt");
    expect(bubble?.classList.contains("user-prompt-unconfirmed")).toBe(true);

    const marker = screen.getByRole("button", {
      name: /waiting for the session to record it/i,
    });
    expect(marker.textContent).toBe("sent");
    expect(marker.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("status")).toBeNull();

    fireEvent.click(marker);
    expect(marker.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("status").textContent).toMatch(
      /isn't recorded in the session yet/,
    );

    fireEvent.click(marker);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("renders a confirmed send as the plain bubble with no marker", () => {
    render(
      <I18nProvider>
        <UserPromptBlock content="hello there" deliveryState="confirmed" />
      </I18nProvider>,
    );

    const bubble = screen
      .getByText("hello there")
      .closest(".message-user-prompt");
    expect(bubble?.classList.contains("user-prompt-unconfirmed")).toBe(false);
    expect(screen.queryByText("sent")).toBeNull();
  });

  it("does not fetch uploaded image previews until opened", async () => {
    const remotePath =
      "/api/projects/proj/sessions/session/upload/123e4567-e89b-12d3-a456-426614174000_photo.jpg";
    const content: ContentBlock[] = [
      {
        type: "text",
        text: "Attached image:\n<image>",
      },
      {
        type: "input_image",
        file_path:
          "/home/graehl/.yep-anywhere/uploads/proj/session/123e4567-e89b-12d3-a456-426614174000_photo.jpg",
      },
    ];

    render(
      <I18nProvider>
        <UserPromptBlock content={content} />
      </I18nProvider>,
    );

    await waitFor(() => {
      expect(useRemoteImage).toHaveBeenCalledWith(remotePath, false, undefined);
    });
    expect(useRemoteImage).not.toHaveBeenCalledWith(
      remotePath,
      true,
      undefined,
    );

    fireEvent.click(screen.getByRole("button", { name: /photo\.jpg/i }));

    await waitFor(() => {
      expect(useRemoteImage).toHaveBeenCalledWith(remotePath, true, undefined);
    });
  });

  it.each([
    [
      "app-data",
      "/home/user/.yep-anywhere/projects/0123456789abcdef0123456789abcdef/attachments/session-a/123e4567-e89b-12d3-a456-426614174000_photo.jpg",
    ],
    [
      "project-local",
      "/workspace/project/.yep/attachments/session-a/123e4567-e89b-12d3-a456-426614174000_photo.jpg",
    ],
  ])(
    "routes a persisted %s attachment by its physical session directory",
    async (_storageMode, filePath) => {
      // The viewed logical session id differs from the path's directory
      // (provisional first-turn id, fork source id); the URL must carry the
      // physical directory so the server's exact lookup hits.
      const remotePath =
        "/api/projects/project-a/sessions/session-a/upload/123e4567-e89b-12d3-a456-426614174000_photo.jpg";
      const content = `Attached image\n\nUser uploaded files:\n- [photo.jpg](<${filePath}>) (6 kb, image/jpeg, 277x100)`;

      render(
        <SessionMetadataProvider
          projectId="project-a"
          projectPath="/workspace/project"
          sessionId="logical-session-b"
        >
          <I18nProvider>
            <UserPromptBlock content={content} />
          </I18nProvider>
        </SessionMetadataProvider>,
      );

      await waitFor(() => {
        expect(useRemoteImage).toHaveBeenCalledWith(
          remotePath,
          false,
          undefined,
        );
      });

      fireEvent.click(screen.getByRole("button", { name: /photo\.jpg/i }));

      await waitFor(() => {
        expect(useRemoteImage).toHaveBeenCalledWith(
          remotePath,
          true,
          undefined,
        );
      });
    },
  );
});
