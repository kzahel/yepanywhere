// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const {
  mockVoiceCancelProcessing,
  mockVoicePrewarm,
  mockVoiceStopAndFinalize,
  mockVoiceToggle,
  mockNavigate,
  mockSetNewSessionPrefill,
  voiceButtonState,
  voicePropsState,
} = vi.hoisted(() => ({
  mockVoiceCancelProcessing: vi.fn(),
  mockVoicePrewarm: vi.fn(),
  mockVoiceStopAndFinalize: vi.fn(() => ""),
  mockVoiceToggle: vi.fn(),
  mockNavigate: vi.fn(),
  mockSetNewSessionPrefill: vi.fn(),
  voiceButtonState: { isListening: false },
  voicePropsState: {
    current: null as null | {
      onPendingSpeechChange?: (
        kind: "starting" | "listening" | "transcribing" | "finalizing" | null,
        settlement?: "completed" | "failed",
      ) => void;
      onInterimTranscript?: (text: string) => void;
      onListeningStart?: () => void;
      onListeningStop?: () => boolean | undefined;
    },
  },
}));

const coarsePointerState = vi.hoisted(() => ({ current: false }));

vi.mock("../../lib/deviceDetection", () => ({
  hasCoarsePointer: () => coarsePointerState.current,
}));

vi.mock("react-router-dom", () => ({
  useNavigate: () => mockNavigate,
  useLocation: () => ({ pathname: "/" }),
}));

vi.mock("../../lib/newSessionPrefill", () => ({
  setNewSessionPrefill: mockSetNewSessionPrefill,
}));

vi.mock("../../hooks/useDraftPersistence", () => ({
  useDraftPersistence: () => {
    const [value, setValueInternal] = useState("");
    const valueRef = useRef("");
    const setValue = useCallback((next: string) => {
      valueRef.current = next;
      setValueInternal(next);
    }, []);
    const getDraft = useCallback(() => valueRef.current, []);
    const setDraft = setValue;
    const noop = useCallback(() => {}, []);
    const clearInput = useCallback(() => setValue(""), [setValue]);
    const controls = useMemo(
      () => ({
        getDraft,
        setDraft,
        flushDraft: noop,
        clearInput,
        clearDraft: clearInput,
        restoreFromStorage: noop,
      }),
      [getDraft, setDraft, noop, clearInput],
    );
    return [value, setValue, controls] as const;
  },
}));

vi.mock("../../hooks/useDefaultNewSessionModel", () => ({
  useDefaultNewSessionModel: () => null,
}));

vi.mock("../../hooks/useFabVisibility", () => ({
  useFabVisibility: () => ({ right: 24, bottom: 80, maxWidth: 200 }),
}));

vi.mock("../../hooks/useFloatingActionButtonEnabled", () => ({
  useFloatingActionButtonEnabled: () => ({ floatingActionButtonEnabled: true }),
}));

vi.mock("../../hooks/useRecentProject", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../hooks/useRecentProject")>()),
  setRecentProjectId: vi.fn(),
}));

vi.mock("../../hooks/useRemoteBasePath", () => ({
  useRemoteBasePath: () => "",
}));

vi.mock("../../i18n", () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

vi.mock("../VoiceInputButton", () => ({
  VoiceInputButton: forwardRef((props: Record<string, unknown>, ref) => {
    voicePropsState.current = props as typeof voicePropsState.current;
    useImperativeHandle(
      ref,
      () => ({
        stopAndFinalize: mockVoiceStopAndFinalize,
        toggle: mockVoiceToggle,
        cancelProcessing: mockVoiceCancelProcessing,
        prewarm: mockVoicePrewarm,
        beginInsertionBoundary: vi.fn(),
        isListening: voiceButtonState.isListening,
        isAvailable: true,
      }),
      [],
    );
    return <button type="button">voice</button>;
  }),
}));

import { FloatingActionButton } from "../FloatingActionButton";

afterEach(() => {
  cleanup();
  mockVoiceCancelProcessing.mockReset();
  mockVoicePrewarm.mockReset();
  mockVoiceStopAndFinalize.mockReset();
  mockVoiceStopAndFinalize.mockReturnValue("");
  mockVoiceToggle.mockReset();
  mockNavigate.mockReset();
  mockSetNewSessionPrefill.mockReset();
  voiceButtonState.isListening = false;
  voicePropsState.current = null;
  coarsePointerState.current = false;
});

describe("FloatingActionButton speech", () => {
  // Plan 178: the shared speech hooks must not change the identity of a
  // voice button callback that is stable today. The others change with the
  // draft, through the composer's submit callback.
  it("keeps the voice button's stable callbacks across a typed character", async () => {
    render(<FloatingActionButton />);
    fireEvent.click(screen.getByLabelText("fabNewSession"));
    const textarea = await screen.findByPlaceholderText(/./);
    const beforeProps = voicePropsState.current;
    const before = { ...beforeProps } as Record<string, unknown>;
    fireEvent.change(textarea, { target: { value: "a" } });
    const after = voicePropsState.current as Record<string, unknown> | null;
    // The voice button rendered again, and a callback that follows the draft
    // changed, so the identity checks below are not comparing stale props.
    expect(after).not.toBe(beforeProps);
    expect(after?.onTranscript).not.toBe(before.onTranscript);
    for (const key of [
      "getTranscriptionContext",
      "onInterimTranscript",
      "onListeningStart",
    ]) {
      expect(after?.[key], key).toBeTypeOf("function");
      expect(after?.[key], key).toBe(before[key]);
    }
  });

  it("prewarms voice resources after expanding the quick composer", async () => {
    render(<FloatingActionButton />);

    expect(mockVoicePrewarm).not.toHaveBeenCalled();

    fireEvent.click(screen.getByLabelText("fabNewSession"));
    await waitFor(() => expect(mockVoicePrewarm).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByLabelText("fabClose"));
    fireEvent.click(screen.getByLabelText("fabNewSession"));
    await waitFor(() => expect(mockVoicePrewarm).toHaveBeenCalledTimes(2));
  });

  it("keeps mic focus through coarse-pointer speech transitions", async () => {
    coarsePointerState.current = true;
    render(<FloatingActionButton />);
    fireEvent.click(screen.getByLabelText("fabNewSession"));
    const textarea = await screen.findByPlaceholderText("fabPlaceholder");
    const voice = screen.getByRole("button", { name: "voice" });

    act(() => voice.focus());
    act(() => voicePropsState.current?.onListeningStart?.());
    expect(document.activeElement).toBe(voice);

    act(() => voicePropsState.current?.onListeningStop?.());
    expect(document.activeElement).toBe(voice);
    expect(document.activeElement).not.toBe(textarea);
  });

  it("returns keyboard mic focus to the fine-pointer composer", async () => {
    render(<FloatingActionButton />);
    fireEvent.click(screen.getByLabelText("fabNewSession"));
    const textarea = await screen.findByPlaceholderText("fabPlaceholder");
    const voice = screen.getByRole("button", { name: "voice" });

    act(() => voice.focus());
    act(() => voicePropsState.current?.onListeningStart?.());
    expect(document.activeElement).toBe(textarea);

    act(() => voice.focus());
    act(() => voicePropsState.current?.onListeningStop?.());
    expect(document.activeElement).toBe(textarea);
  });

  it("keeps the real quick-composer textarea editable while transcribing", async () => {
    render(<FloatingActionButton />);

    // Expand the quick-compose panel.
    fireEvent.click(screen.getByLabelText("fabNewSession"));
    const textarea = (await screen.findByPlaceholderText(
      "fabPlaceholder",
    )) as HTMLTextAreaElement;

    act(() => {
      screen.getByRole("button", { name: "voice" }).focus();
      voicePropsState.current?.onListeningStop?.();
      voicePropsState.current?.onPendingSpeechChange?.("transcribing");
    });
    await waitFor(() => {
      expect(document.querySelector(".speech-draft-mirror")).toBeNull();
    });
    expect(
      document.querySelector(".speech-draft-field")?.classList,
    ).not.toContain("has-interim");
    expect(document.activeElement).toBe(textarea);

    expect(textarea.disabled).toBe(false);
    fireEvent.change(textarea, {
      target: { value: "typed while transcribing" },
    });
    expect(textarea.value).toBe("typed while transcribing");

    fireEvent.keyDown(textarea, { key: "Escape" });
    expect(mockVoiceCancelProcessing).toHaveBeenCalledTimes(1);
    expect(textarea.value).toBe("typed while transcribing");
  });

  it("commits the visible interim when the quick-composer mic stops", async () => {
    render(<FloatingActionButton />);
    fireEvent.click(screen.getByLabelText("fabNewSession"));
    const textarea = (await screen.findByPlaceholderText(
      "fabPlaceholder",
    )) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "alpha omega" } });
    textarea.setSelectionRange("alpha".length, "alpha".length);

    act(() => {
      voicePropsState.current?.onListeningStart?.();
      voicePropsState.current?.onInterimTranscript?.("visible words");
    });
    let committed = false;
    act(() => {
      committed = voicePropsState.current?.onListeningStop?.() === true;
    });

    await waitFor(() => {
      expect(textarea.value).toBe("alpha visible words omega");
    });
    expect(committed).toBe(true);
  });

  it("keeps Listening out of the draft and places the caret after provisional speech", async () => {
    render(<FloatingActionButton />);

    fireEvent.click(screen.getByLabelText("fabNewSession"));
    await screen.findByPlaceholderText("fabPlaceholder");

    act(() => {
      voicePropsState.current?.onPendingSpeechChange?.("listening");
    });
    await waitFor(() =>
      expect(document.querySelector(".speech-draft-mirror")).toBeNull(),
    );

    act(() => {
      voicePropsState.current?.onInterimTranscript?.("live words");
    });
    const interim = await waitFor(() => {
      const el = document.querySelector(".speech-interim-inline");
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    expect(interim.nextElementSibling?.classList).toContain(
      "speech-interim-caret",
    );
  });

  it("submits the visible interim snapshot after capture settles", async () => {
    voiceButtonState.isListening = true;
    render(<FloatingActionButton />);

    fireEvent.click(screen.getByLabelText("fabNewSession"));
    const textarea = (await screen.findByPlaceholderText(
      "fabPlaceholder",
    )) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "alpha omega" } });
    textarea.setSelectionRange("alpha".length, "alpha".length);
    act(() => {
      voicePropsState.current?.onListeningStart?.();
      voicePropsState.current?.onPendingSpeechChange?.("listening");
      voicePropsState.current?.onInterimTranscript?.("provisional words");
    });

    fireEvent.click(screen.getByLabelText("fabGoToNewSession"));
    expect(mockVoiceStopAndFinalize).toHaveBeenCalledOnce();
    expect(mockSetNewSessionPrefill).not.toHaveBeenCalled();

    act(() => {
      voiceButtonState.isListening = false;
      voicePropsState.current?.onPendingSpeechChange?.(null, "completed");
    });
    expect(mockSetNewSessionPrefill).toHaveBeenCalledWith(
      expect.any(String),
      "alpha provisional words omega",
    );
    expect(mockNavigate).toHaveBeenCalledWith("/new-session");
  });
});
