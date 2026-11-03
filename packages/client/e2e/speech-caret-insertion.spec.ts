import { join } from "node:path";
import type { Page } from "@playwright/test";
import { e2ePaths, expect, test } from "./fixtures.js";

const mockProjectPath = join(e2ePaths.tempDir, "mockproject");
const projectId = Buffer.from(mockProjectPath).toString("base64url");
const speechSessionIds = {
  moveInterim: "speech-caret-001",
  laterFinal: "speech-caret-002",
  sendInterim: "speech-caret-003",
  stopInterim: "speech-caret-004",
} as const;

interface FakeSpeechResultInput {
  transcript: string;
  isFinal: boolean;
}

async function dismissOnboardingIfVisible(page: Page) {
  const dialog = page.getByText("Welcome to yepanywhere");
  await page.waitForTimeout(250);
  if (!(await dialog.isVisible().catch(() => false))) return;
  await page.getByRole("button", { name: "Skip all" }).click({ force: true });
  await expect(dialog).not.toBeVisible();
}

async function openBrowserSpeechComposer(
  page: Page,
  baseURL: string,
  sessionId: string,
  initialText = "",
) {
  await page.addInitScript(() => {
    localStorage.setItem("yep-anywhere-voice-input-enabled", "true");
    localStorage.setItem("yep-anywhere-speech-method", "browser-native");

    class FakeSpeechRecognition extends EventTarget {
      continuous = false;
      interimResults = false;
      unspokenPunctuation = false;
      lang = "";
      maxAlternatives = 1;
      onstart: ((event: Event) => void) | null = null;
      onend: ((event: Event) => void) | null = null;
      onaudiostart: ((event: Event) => void) | null = null;
      onaudioend: ((event: Event) => void) | null = null;
      onsoundstart: ((event: Event) => void) | null = null;
      onsoundend: ((event: Event) => void) | null = null;
      onspeechstart: ((event: Event) => void) | null = null;
      onspeechend: ((event: Event) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      onresult: ((event: Event) => void) | null = null;

      constructor() {
        super();
        (
          window as unknown as {
            __yaFakeSpeechRecognition?: FakeSpeechRecognition;
          }
        ).__yaFakeSpeechRecognition = this;
      }

      start() {
        queueMicrotask(() => {
          this.onstart?.call(this, new Event("start"));
          this.onaudiostart?.call(this, new Event("audiostart"));
        });
      }

      stop() {
        queueMicrotask(() => {
          const finalText = (
            window as unknown as { finalSpeechOnStop?: string }
          ).finalSpeechOnStop;
          if (finalText)
            this.emit([{ transcript: finalText, isFinal: true }], 0);
          this.onend?.call(this, new Event("end"));
        });
      }

      abort() {}

      emit(entries: FakeSpeechResultInput[], resultIndex: number) {
        const mapped = entries.map(({ transcript, isFinal }) => {
          const alternative = { transcript, confidence: 1 };
          return {
            isFinal,
            length: 1,
            0: alternative,
            item: () => alternative,
          };
        });
        const results = {
          ...mapped,
          length: mapped.length,
          item: (index: number) => mapped[index],
        };
        this.onresult?.call(this, { resultIndex, results } as unknown as Event);
      }
    }

    Object.defineProperty(window, "SpeechRecognition", {
      configurable: true,
      value: FakeSpeechRecognition,
    });
    Object.defineProperty(window, "webkitSpeechRecognition", {
      configurable: true,
      value: FakeSpeechRecognition,
    });
  });

  await page.goto(`${baseURL}/projects/${projectId}/sessions/${sessionId}`);
  await dismissOnboardingIfVisible(page);
  const textarea = page.locator("[data-composer-input]");
  await expect(textarea).toBeVisible();
  if (initialText) {
    await textarea.fill(initialText);
    await textarea.evaluate((element) => {
      const input = element as HTMLTextAreaElement;
      input.setSelectionRange(input.value.length, input.value.length);
    });
  }
  await page.getByRole("button", { name: "Start voice input" }).click();
  await expect(
    page.getByRole("button", { name: "Stop voice input" }),
  ).toHaveAttribute("data-speech-method", "browser-native");
  return textarea;
}

async function emitSpeechResults(
  page: Page,
  entries: FakeSpeechResultInput[],
  resultIndex = 0,
) {
  await page.evaluate(
    ({ nextEntries, nextResultIndex }) => {
      (
        window as unknown as {
          __yaFakeSpeechRecognition: {
            emit(entries: FakeSpeechResultInput[], resultIndex: number): void;
          };
        }
      ).__yaFakeSpeechRecognition.emit(nextEntries, nextResultIndex);
    },
    { nextEntries: entries, nextResultIndex: resultIndex },
  );
}

test("moves only the next fragment when the caret changes mid-interim", async ({
  page,
  baseURL,
}) => {
  const textarea = await openBrowserSpeechComposer(
    page,
    baseURL,
    speechSessionIds.moveInterim,
    "existing text",
  );

  await emitSpeechResults(page, [
    { transcript: "spoken first", isFinal: false },
  ]);
  await expect(page.locator(".speech-interim-inline")).toHaveText(
    "spoken first",
  );

  await textarea.click({ position: { x: 12, y: 10 } });
  await expect(textarea).toHaveJSProperty("selectionStart", 0);
  await expect(textarea).toHaveValue("existing text");

  await emitSpeechResults(page, [
    { transcript: "spoken first still speaking", isFinal: false },
  ]);
  await expect(textarea).toHaveValue("existing text");
  await expect(page.locator(".speech-interim-inline")).toHaveText(
    "spoken first still speaking",
  );

  await emitSpeechResults(page, [
    { transcript: "spoken first still speaking", isFinal: true },
    { transcript: "resumed speech", isFinal: false },
  ]);
  await expect(textarea).toHaveValue(
    "existing text spoken first still speaking",
  );
  await expect(page.locator(".speech-interim-inline")).toHaveText(
    "resumed speech",
  );

  await emitSpeechResults(
    page,
    [
      { transcript: "spoken first still speaking", isFinal: true },
      { transcript: "resumed speech", isFinal: true },
    ],
    1,
  );
  await expect(textarea).toHaveValue(
    "resumed speech existing text spoken first still speaking",
  );
});

test("moves a later final-only browser result to the live caret", async ({
  page,
  baseURL,
}) => {
  const textarea = await openBrowserSpeechComposer(
    page,
    baseURL,
    speechSessionIds.laterFinal,
  );

  await emitSpeechResults(page, [
    { transcript: "spoken first", isFinal: true },
  ]);
  await expect(textarea).toHaveValue("spoken first");

  await textarea.click({ position: { x: 12, y: 10 } });
  await expect(textarea).toHaveJSProperty("selectionStart", 0);

  await emitSpeechResults(
    page,
    [
      { transcript: "spoken first", isFinal: true },
      { transcript: "resumed speech", isFinal: true },
    ],
    1,
  );
  await expect(textarea).toHaveValue("resumed speech spoken first");
});

test("sends the final ASR wording with its prefix when Send is pressed", async ({
  page,
  baseURL,
}) => {
  // Observe the speech finalization/send boundary directly. Native provider
  // resume is covered separately; this fixture's hostname store is imported
  // history, not a provider launch store.
  let submitted: { message: string } | undefined;
  await page.route("**/api/projects/*/sessions/*/resume", (route) => {
    expect(route.request().method()).toBe("POST");
    submitted = route.request().postDataJSON();
    return route.fulfill({
      json: { processId: "speech-send-fixture", permissionMode: "default" },
    });
  });
  const textarea = await openBrowserSpeechComposer(
    page,
    baseURL,
    speechSessionIds.sendInterim,
    "alpha omega",
  );

  await textarea.click({ position: { x: 12, y: 10 } });
  await expect(textarea).toHaveJSProperty("selectionStart", 0);

  await emitSpeechResults(page, [
    { transcript: "provisional words", isFinal: false },
  ]);
  await expect(page.locator(".speech-interim-inline")).toHaveText(
    "provisional words",
  );

  await page.evaluate(() => {
    Object.assign(window, { finalSpeechOnStop: "final wording" });
  });
  await page.getByRole("button", { name: /^Send/ }).click();

  await expect
    .poll(() => submitted?.message)
    .toBe("🎤 final wording alpha omega");
  await expect(textarea).toHaveValue("");
});

test("commits the interim text visible when Stop is pressed", async ({
  page,
  baseURL,
}) => {
  const textarea = await openBrowserSpeechComposer(
    page,
    baseURL,
    speechSessionIds.stopInterim,
    "alpha omega",
  );

  await textarea.click({ position: { x: 12, y: 10 } });
  await expect(textarea).toHaveJSProperty("selectionStart", 0);
  await emitSpeechResults(page, [
    { transcript: "provisional words", isFinal: false },
  ]);
  await expect(page.locator(".speech-interim-inline")).toHaveText(
    "provisional words",
  );

  await page.getByRole("button", { name: "Stop voice input" }).click();

  await expect(textarea).toHaveValue("provisional words alpha omega");
  await expect(page.locator(".speech-interim-inline")).toHaveCount(0);
});
