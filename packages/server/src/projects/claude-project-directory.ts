/** Pinned SDK/native CLI conventional key; keep aligned during Claude refresh. */
export function claudeCwdProjectDirectory(cwd: string): string {
  const normalized = process.platform === "darwin" ? cwd.normalize("NFC") : cwd;
  const encoded = normalized.replace(/[^a-zA-Z0-9]/g, "-");
  if (encoded.length <= 200) return encoded;
  let hash = 0;
  for (let index = 0; index < normalized.length; index++)
    hash = ((hash << 5) - hash + normalized.charCodeAt(index)) | 0;
  return `${encoded.slice(0, 200)}-${Math.abs(hash).toString(36)}`;
}
