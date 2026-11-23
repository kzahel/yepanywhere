/**
 * A USER_INPUT's content as `agy` 1.5.13 and 1.5.14 log a prompt whose
 * wrapped request passes 192,000 UTF-8 bytes: the first 192,000 bytes, cut
 * at a character boundary, then a notice of how many bytes were dropped
 * (measured; topics/antigravity-native-storage.md, "Clipped prompts").
 */
export function agyClippedContent(wrapped: string): string {
  const bytes = Buffer.from(wrapped, "utf8");
  if (bytes.length <= 192_000) return wrapped;
  let end = 192_000;
  // A continuation byte starts no character.
  while ((bytes[end]! & 0xc0) === 0x80) end--;
  return `${bytes.subarray(0, end).toString("utf8")}\n<truncated ${bytes.length - end} bytes>\n\nNOTE: The output was truncated because it was too long. Use a more targeted query or a smaller range to get the information you need.`;
}
