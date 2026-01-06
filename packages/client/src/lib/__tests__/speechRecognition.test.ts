import { describe, expect, it } from "vitest";
import {
  type SpeechResult,
  computeSpeechDelta,
  processSpeechResults,
} from "../speechRecognition";

describe("processSpeechResults", () => {
  it("returns empty for no results", () => {
    const result = processSpeechResults([]);
    expect(result).toEqual({ latestFinal: "", interimText: "" });
  });

  it("extracts the latest final result (mobile behavior)", () => {
    // On mobile, multiple final results accumulate - we want the last one
    const results: SpeechResult[] = [
      { isFinal: true, transcript: "the" },
      { isFinal: true, transcript: "the quick" },
      { isFinal: true, transcript: "the quick brown" },
    ];
    const result = processSpeechResults(results);
    expect(result.latestFinal).toBe("the quick brown");
    expect(result.interimText).toBe("");
  });

  it("collects interim text from non-final results", () => {
    const results: SpeechResult[] = [
      { isFinal: true, transcript: "hello" },
      { isFinal: false, transcript: " world" },
      { isFinal: false, transcript: " foo" },
    ];
    const result = processSpeechResults(results);
    expect(result.latestFinal).toBe("hello");
    expect(result.interimText).toBe(" world foo");
  });

  it("handles only interim results", () => {
    const results: SpeechResult[] = [
      { isFinal: false, transcript: "typing" },
      { isFinal: false, transcript: " in progress" },
    ];
    const result = processSpeechResults(results);
    expect(result.latestFinal).toBe("");
    expect(result.interimText).toBe("typing in progress");
  });
});

describe("computeSpeechDelta", () => {
  describe("mobile behavior (cumulative finals)", () => {
    it("returns empty for no change", () => {
      expect(computeSpeechDelta("hello", "hello")).toBe("");
    });

    it("returns empty for empty latest", () => {
      expect(computeSpeechDelta("", "hello")).toBe("");
    });

    it("extracts delta when latest starts with previous", () => {
      expect(computeSpeechDelta("the quick", "the")).toBe(" quick");
      expect(computeSpeechDelta("the quick brown", "the quick")).toBe(" brown");
    });

    it("handles first utterance (empty previous)", () => {
      expect(computeSpeechDelta("hello", "")).toBe("hello");
    });

    it("extracts multi-word delta", () => {
      expect(computeSpeechDelta("the quick brown fox", "the")).toBe(
        " quick brown fox",
      );
    });
  });

  describe("desktop behavior (separate utterances)", () => {
    it("returns full transcript for new utterance after pause", () => {
      // When user pauses and starts new utterance, it won't start with previous
      expect(computeSpeechDelta("goodbye", "hello world")).toBe("goodbye");
    });

    it("handles completely different utterances", () => {
      expect(computeSpeechDelta("new sentence", "old sentence")).toBe(
        "new sentence",
      );
    });
  });

  describe("edge cases", () => {
    it("handles whitespace-only delta", () => {
      expect(computeSpeechDelta("hello ", "hello")).toBe(" ");
    });

    it("handles punctuation", () => {
      expect(computeSpeechDelta("hello, world", "hello")).toBe(", world");
    });

    it("is case sensitive", () => {
      // "Hello" doesn't start with "hello" so treated as new utterance
      expect(computeSpeechDelta("Hello world", "hello")).toBe("Hello world");
    });
  });
});
