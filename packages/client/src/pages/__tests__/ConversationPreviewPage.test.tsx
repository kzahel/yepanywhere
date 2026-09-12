import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { decodeSnapshot } from "@yep-anywhere/shared/experimental/simple-client.generated";
import fixture from "../../../../shared/test/fixtures/simple-client/claude-conversation.json";
import { I18nProvider } from "../../i18n";
import { PreviewContent } from "../ConversationPreviewPage";

afterEach(cleanup);
it("renders the captured Claude activity and failure without interpreting markup", () => {
  const snapshot = decodeSnapshot(JSON.stringify(fixture));
  if (snapshot.view.kind !== "conversation")
    throw new Error("Expected conversation");
  render(
    <I18nProvider>
      {snapshot.view.messages.flatMap((message) =>
        message.content.map((content, index) => (
          <PreviewContent key={`${message.id}:${index}`} content={content} />
        )),
      )}
    </I18nProvider>,
  );
  expect(screen.getByText("4 tool calls · 1 failed")).toBeTruthy();
  expect(screen.getByText(/Exit code 7/)).toBeTruthy();
});
it("keeps unknown payloads opaque and renders HTML-looking prose as text", () => {
  const { container } = render(
    <I18nProvider>
      <PreviewContent
        content={{
          kind: "unknown",
          originalKind: "future",
          raw: { kind: "future", data: "SECRET_OPAQUE_DATA" },
        }}
      />
      <PreviewContent
        content={{
          kind: "text",
          format: "markdown",
          text: '<img src="x" onerror="alert(1)">',
        }}
      />
    </I18nProvider>,
  );
  expect(container.textContent).not.toContain("SECRET_OPAQUE_DATA");
  expect(container.querySelector("img")).toBeNull();
  expect(screen.getByText(/not supported in the preview/)).toBeTruthy();
});
