/**
 * Summarizes a brain-log record too large to hold, in one forward pass with
 * fixed memory: its top-level keys and their JSON types, its short scalar
 * fields, the first characters of its text fields and its tool calls' names.
 * The log window shows such a record as a placeholder built from this
 * summary (topics/antigravity-native-storage.md#serving-cold-history--plan-195-step-4).
 */

export type JsonKind = "string" | "number" | "array" | "object" | "literal";

export interface OversizedRecordSummary {
  /** Top-level keys in order, with their value's JSON kind. */
  keys: Array<[string, JsonKind]>;
  /** Top-level string and number values, the strings cut to their start. */
  values: Map<string, string | number>;
  /** Top-level strings longer than what was kept. */
  cut: Set<string>;
  /** `tool_calls` elements: name, whether `args` is an object, key count. */
  calls: Array<{ name?: string; argsObject: boolean; keys: number }>;
  /** Why the bytes are not one JSON object, if they are not. */
  malformed?: string;
}

/** Characters of each top-level string kept, enough for every wrapper. */
const KEEP_BYTES = 8 * 1024;
const KEY_BYTES = 256;
const strict = () => new TextDecoder("utf-8", { fatal: true });

/** A JSON string body cut anywhere, decoded up to its last whole character. */
function decodeCut(raw: Buffer): string {
  let end = raw.length;
  // Drop a character cut short.
  let lead = end - 1;
  while (lead >= 0 && end - lead < 4 && (raw[lead]! & 0xc0) === 0x80) lead--;
  if (lead >= 0 && raw[lead]! >= 0xc0) {
    const width = raw[lead]! >= 0xf0 ? 4 : raw[lead]! >= 0xe0 ? 3 : 2;
    if (end - lead < width) end = lead;
  }
  // Then any escape cut short.
  for (let trim = 0; trim <= 6 && trim <= end; trim++) {
    try {
      return JSON.parse(`"${raw.subarray(0, end - trim).toString("utf8")}"`);
    } catch {
      // A partial escape at the end; try shorter.
    }
  }
  return "";
}

interface Frame {
  kind: "object" | "array";
  /** In an object: the next string is a key. */
  expectKey: boolean;
  key?: string;
  /** Elements opened, in an array. */
  elements: number;
}

export class OversizedRecordScanner {
  private readonly stack: Frame[] = [];
  private inString = false;
  private escape = false;
  /** The string being read, and whether it is a key, kept or skipped. */
  private stringRole: "key" | "keep" | "skip" = "skip";
  private captured: Buffer[] = [];
  private capturedBytes = 0;
  private stringCut = false;
  private literal: number[] | undefined;
  private literalKey: string | undefined;
  private done = false;
  private readonly decoder = strict();
  private readonly summary: OversizedRecordSummary = {
    keys: [],
    values: new Map(),
    cut: new Set(),
    calls: [],
  };

  push(chunk: Buffer): void {
    if (this.summary.malformed) return;
    try {
      this.decoder.decode(chunk, { stream: true });
    } catch {
      this.fail("a line is not valid UTF-8");
      return;
    }
    let i = 0;
    while (i < chunk.length && !this.summary.malformed) {
      if (this.inString) {
        i = this.inStringBytes(chunk, i);
        continue;
      }
      const byte = chunk[i]!;
      i++;
      if (this.literal) {
        if (byte === 0x2c || byte === 0x7d || byte === 0x5d || byte <= 0x20) {
          this.endLiteral();
        } else {
          if (this.literal.length < 64) this.literal.push(byte);
          continue;
        }
      }
      this.structural(byte);
    }
  }

  finish(): OversizedRecordSummary {
    try {
      this.decoder.decode();
    } catch {
      this.fail("a line is not valid UTF-8");
    }
    if (this.literal) this.endLiteral();
    if (!this.summary.malformed && (!this.done || this.inString))
      this.fail("a line is not one JSON object");
    return this.summary;
  }

  private fail(reason: string): void {
    this.summary.malformed ??= reason;
  }

  private get top(): Frame | undefined {
    return this.stack.at(-1);
  }

  /** Inside a string: up to and including its closing quote. */
  private inStringBytes(chunk: Buffer, from: number): number {
    let i = from;
    if (this.escape) {
      this.escape = false;
      this.keep(chunk.subarray(i, i + 1));
      i++;
    }
    for (;;) {
      const quote = chunk.indexOf(0x22, i);
      const slash = chunk.indexOf(0x5c, i);
      const stop =
        quote < 0 ? slash : slash < 0 ? quote : Math.min(quote, slash);
      if (stop < 0) {
        this.keep(chunk.subarray(i));
        return chunk.length;
      }
      if (stop === slash) {
        this.keep(chunk.subarray(i, stop + 1));
        if (stop + 1 >= chunk.length) {
          this.escape = true;
          return chunk.length;
        }
        this.keep(chunk.subarray(stop + 1, stop + 2));
        i = stop + 2;
        continue;
      }
      this.keep(chunk.subarray(i, stop));
      this.inString = false;
      this.endString();
      return stop + 1;
    }
  }

  private keep(bytes: Buffer): void {
    if (this.stringRole === "skip" || !bytes.length) return;
    const limit = this.stringRole === "key" ? KEY_BYTES : KEEP_BYTES;
    const room = limit - this.capturedBytes;
    if (bytes.length > room) this.stringCut = true;
    if (room <= 0) return;
    const part = Buffer.from(bytes.subarray(0, room));
    this.captured.push(part);
    this.capturedBytes += part.length;
  }

  private takeCaptured(): Buffer {
    const raw = Buffer.concat(this.captured, this.capturedBytes);
    this.captured = [];
    this.capturedBytes = 0;
    return raw;
  }

  private endString(): void {
    const frame = this.top;
    const role = this.stringRole;
    const raw = this.takeCaptured();
    const cut = this.stringCut;
    this.stringCut = false;
    this.stringRole = "skip";
    if (role === "key" && frame) {
      frame.key = cut ? undefined : decodeCut(raw);
      return;
    }
    if (role !== "keep" || !frame) return;
    const value = decodeCut(raw);
    if (this.stack.length === 1 && frame.key !== undefined) {
      this.summary.values.set(frame.key, value);
      if (cut) this.summary.cut.add(frame.key);
    } else if (this.stack.length === 3 && frame.key === "name") {
      const call = this.summary.calls.at(-1);
      if (call) call.name = cut ? undefined : value;
    }
  }

  private endLiteral(): void {
    const text = Buffer.from(this.literal!).toString("latin1");
    const key = this.literalKey;
    this.literal = undefined;
    this.literalKey = undefined;
    if (key === undefined) return;
    const number = Number(text);
    if (text !== "" && Number.isFinite(number))
      this.summary.values.set(key, number);
  }

  /** Records the kind of the value starting now, for the current key. */
  private valueStarts(kind: JsonKind): void {
    const frame = this.top;
    if (!frame) return;
    if (frame.kind === "array") {
      if (this.stack.length === 2 && kind === "object") {
        // A tool_calls element.
        if (this.stack[0]!.key === "tool_calls")
          this.summary.calls.push({ argsObject: false, keys: 0 });
      }
      frame.elements++;
      return;
    }
    if (frame.key === undefined) return;
    if (this.stack.length === 1) this.summary.keys.push([frame.key, kind]);
    else if (this.stack.length === 3 && this.stack[0]!.key === "tool_calls") {
      const call = this.summary.calls.at(-1);
      if (call) {
        call.keys++;
        if (frame.key === "args" && kind === "object") call.argsObject = true;
      }
    }
  }

  private structural(byte: number): void {
    if (byte <= 0x20) return;
    if (this.done) {
      this.fail("a line has text after its JSON object");
      return;
    }
    const frame = this.top;
    switch (byte) {
      case 0x7b: // {
      case 0x5b: {
        // [
        if (!frame) {
          if (byte !== 0x7b) return this.fail("a line is not a JSON object");
        } else if (frame.kind === "object" && frame.expectKey)
          return this.fail("a line is not one JSON object");
        else this.valueStarts(byte === 0x7b ? "object" : "array");
        this.stack.push({
          kind: byte === 0x7b ? "object" : "array",
          expectKey: byte === 0x7b,
          elements: 0,
        });
        return;
      }
      case 0x7d: // }
      case 0x5d: {
        // ]
        if (!frame || frame.kind !== (byte === 0x7d ? "object" : "array"))
          return this.fail("a line is not one JSON object");
        this.stack.pop();
        if (!this.stack.length) this.done = true;
        return;
      }
      case 0x3a: // :
        if (frame?.kind !== "object") this.fail("a line is not JSON");
        return;
      case 0x2c: // ,
        if (frame?.kind === "object") {
          frame.expectKey = true;
          frame.key = undefined;
        }
        return;
      case 0x22: {
        // "
        if (!frame) return this.fail("a line is not a JSON object");
        this.inString = true;
        if (frame.kind === "object" && frame.expectKey) {
          frame.expectKey = false;
          this.stringRole = "key";
          return;
        }
        this.valueStarts("string");
        this.stringRole =
          (this.stack.length === 1 && frame.key !== undefined) ||
          (this.stack.length === 3 && frame.key === "name")
            ? "keep"
            : "skip";
        return;
      }
      default: {
        if (!frame || (frame.kind === "object" && frame.expectKey))
          return this.fail("a line is not JSON");
        this.valueStarts(
          byte === 0x2d || (byte >= 0x30 && byte <= 0x39)
            ? "number"
            : "literal",
        );
        this.literal = [byte];
        this.literalKey =
          this.stack.length === 1 && frame.kind === "object"
            ? frame.key
            : undefined;
      }
    }
  }
}
