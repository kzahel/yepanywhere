import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { e2ePaths, expect, test } from "./fixtures.js";

const mockProjectPath = join(e2ePaths.tempDir, "mockproject");
const projectId = Buffer.from(mockProjectPath).toString("base64url");
const speechSessionIds = {
  moveInterim: "speech-caret-001",
  laterFinal: "speech-caret-002",
  sendInterim: "speech-caret-003",
  stopInterim: "speech-caret-004",
  typingInterim: "speech-caret-005",
} as const;
test.use({ draftSessionIds: [speechSessionIds.typingInterim] });
const sessionPath = (sessionId: string) =>
  `/projects/${projectId}/sessions/${sessionId}`;

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

async function installFakeSpeechRecognition(page: Page) {
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
}

async function openBrowserSpeechComposer(
  page: Page,
  baseURL: string,
  path: string,
  initialText = "",
) {
  await installFakeSpeechRecognition(page);
  await page.goto(`${baseURL}${path}`);
  await dismissOnboardingIfVisible(page);
  const textarea = page.locator("[data-composer-input]");
  await expect(textarea).toBeVisible();
  await startSpeechWithDraft(page, textarea, initialText);
  return textarea;
}

// Opens the floating new-session composer, which shows on wide non-session
// pages once enabled.
async function openFloatingSpeechComposer(
  page: Page,
  baseURL: string,
  initialText: string,
) {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.addInitScript(() => {
    localStorage.setItem("yep-anywhere-floating-action-button-enabled", "true");
  });
  await installFakeSpeechRecognition(page);
  await page.goto(`${baseURL}/projects`);
  await dismissOnboardingIfVisible(page);
  // Project cards carry their own "New session" buttons; use the floating one.
  await page.locator(".fab-button").click();
  const textarea = page.locator(".fab-textarea");
  await expect(textarea).toBeVisible();
  await startSpeechWithDraft(page, textarea, initialText);
  return textarea;
}

async function startSpeechWithDraft(
  page: Page,
  textarea: Locator,
  initialText: string,
) {
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
    sessionPath(speechSessionIds.moveInterim),
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
    sessionPath(speechSessionIds.laterFinal),
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
    sessionPath(speechSessionIds.sendInterim),
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
    sessionPath(speechSessionIds.stopInterim),
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

/**
 * Seeds a short Claude session the in-session box can open, and returns a
 * function that appends an assistant row and waits until the page shows it.
 */
function seedTypingSession(page: Page) {
  const directory = join(
    e2ePaths.claudeSessionsDir,
    hostname(),
    mockProjectPath.replace(/[/\\]/g, "-"),
  );
  mkdirSync(directory, { recursive: true });
  const sessionId = speechSessionIds.typingInterim;
  const start = Date.parse("2026-11-01T00:00:00.000Z");
  const row = (
    uuid: string,
    parentUuid: string | null,
    index: number,
    message: object,
    type: string,
  ) =>
    JSON.stringify({
      type,
      uuid,
      parentUuid,
      cwd: mockProjectPath,
      sessionId,
      timestamp: new Date(start + index * 1000).toISOString(),
      message,
    });
  const sessionFile = join(directory, `${sessionId}.jsonl`);
  writeFileSync(
    sessionFile,
    [
      row(
        "typing-user-0",
        null,
        0,
        { role: "user", content: "Dictation typing fixture" },
        "user",
      ),
      row(
        "typing-assistant-0",
        "typing-user-0",
        1,
        { role: "assistant", content: [{ type: "text", text: "Reply 0" }] },
        "assistant",
      ),
    ].join("\n"),
  );
  let parentUuid = "typing-assistant-0";
  let updates = 0;
  return async () => {
    updates += 1;
    const uuid = `typing-concurrent-${updates}`;
    const text = `Concurrent reply ${updates}`;
    appendFileSync(
      sessionFile,
      `\n${row(uuid, parentUuid, updates + 1, { role: "assistant", content: [{ type: "text", text }] }, "assistant")}`,
    );
    parentUuid = uuid;
    await expect(page.getByText(text, { exact: true })).toBeVisible();
  };
}

// The in-session, new-session and floating composers share their dictation
// code (docs/tactical/178-shared-composer-dictation.md). After 20 finals
// have landed in the open speech target (each a chunk every keystroke maps
// through the edit) and with an interim showing, the caret moves to the
// start of a long draft and the user types there while the recognizer
// revises the interim and, in a session, the transcript updates. Each key
// must show within 100 ms. Where the in-flight fragment then lands differs
// today (the plan's D10 and F4): the in-session and floating composers keep
// it at its first target, the new-session box moves it to the caret. The
// check pins each until the maintainer decides.
for (const box of ["in-session", "new-session", "floating"] as const) {
  test(`shows each key typed during dictation within 100 ms (${box})`, async ({
    page,
    baseURL,
  }) => {
    const updateTranscript =
      box === "in-session" ? seedTypingSession(page) : async () => {};
    const longDraft = Array.from(
      { length: 120 },
      (_, index) => `Line ${index} of a long dictated prompt draft.`,
    ).join("\n");
    const textarea =
      box === "floating"
        ? await openFloatingSpeechComposer(page, baseURL, longDraft)
        : await openBrowserSpeechComposer(
            page,
            baseURL,
            box === "in-session"
              ? sessionPath(speechSessionIds.typingInterim)
              : `/new-session?projectId=${projectId}`,
            longDraft,
          );
    if (box === "in-session") {
      await expect(page.getByText("Reply 0", { exact: true })).toBeVisible();
    }
    const finals = Array.from({ length: 20 }, (_, index) => ({
      transcript: `chunk ${index}`,
      isFinal: true,
    }));
    let dictated = longDraft;
    for (let index = 0; index < finals.length; index += 1) {
      await emitSpeechResults(page, finals.slice(0, index + 1), index);
      dictated += ` ${finals[index]?.transcript}`;
      await expect(textarea).toHaveValue(dictated);
    }
    const emitInterim = (transcript: string, isFinal = false) =>
      emitSpeechResults(
        page,
        [...finals, { transcript, isFinal }],
        finals.length,
      );
    await emitInterim("spoken words");
    await expect(page.locator(".speech-interim-inline")).toHaveText(
      "spoken words",
    );

    if (box === "floating") {
      // The floating panel's textarea grows past the viewport with this
      // draft, so move the caret by keyboard; its key-up and select both
      // count as manual moves there, as a click does.
      await textarea.press(
        process.platform === "darwin" ? "Meta+ArrowUp" : "Control+Home",
      );
    } else {
      await textarea.evaluate((element) => {
        element.scrollTop = 0;
      });
      await textarea.click({ position: { x: 12, y: 10 } });
    }
    await expect(textarea).toHaveJSProperty("selectionStart", 0);
    await textarea.evaluate((element) => {
      const field = element as HTMLTextAreaElement & {
        acks: { value: string; latency: number }[];
      };
      field.acks = [];
      field.addEventListener("keydown", (event) =>
        requestAnimationFrame(() =>
          requestAnimationFrame(() =>
            field.acks.push({
              value: field.value,
              latency: performance.now() - event.timeStamp,
            }),
          ),
        ),
      );
    });
    // Waits out the two frames a pending acknowledgement takes.
    const acksOf = () =>
      textarea.evaluate(async (element) => {
        await new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        );
        return (
          element as HTMLTextAreaElement & {
            acks: { value: string; latency: number }[];
          }
        ).acks;
      });

    const keys = "Typed first. ";
    for (const [index, character] of [...keys].entries()) {
      if (index % 4 === 2) {
        await emitInterim(`spoken words ${index}`);
        await expect(page.locator(".speech-interim-inline")).toHaveText(
          `spoken words ${index}`,
        );
      }
      if (index === Math.floor(keys.length / 2)) await updateTranscript();
      await page.keyboard.type(character);
      await expect.poll(async () => (await acksOf()).length).toBe(index + 1);
    }
    const acks = await acksOf();
    expect(acks.map((ack) => ack.value)).toEqual(
      [...keys].map((_, index) => keys.slice(0, index + 1) + dictated),
    );
    expect(Math.max(...acks.map((ack) => ack.latency))).toBeLessThan(100);

    await emitInterim("spoken words final", true);
    await expect(textarea).toHaveValue(
      box === "new-session"
        ? `${keys}spoken words final ${dictated}`
        : `${keys}${dictated} spoken words final`,
    );
  });
}
