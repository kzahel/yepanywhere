export function extractCodexOssUserText(message: unknown): string {
  if (!message || typeof message !== "object") return "";

  const userMsg = message as { text?: string };
  if (typeof userMsg.text === "string") return userMsg.text;

  const sdkMsg = message as { message?: { content?: string | unknown[] } };
  const content = sdkMsg.message?.content;

  if (typeof content === "string") return content;

  if (Array.isArray(content)) {
    return content
      .map((block: unknown) => {
        if (typeof block === "string") return block;
        if (
          typeof block === "object" &&
          block !== null &&
          "type" in block &&
          (block as { type: string }).type === "text" &&
          "text" in block
        ) {
          return (block as { text: string }).text;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }

  return "";
}
