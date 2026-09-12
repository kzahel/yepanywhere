import * as fs from "node:fs/promises";

/** Flush directory metadata where the runtime supports it. File sync stays strict. */
export async function syncDirectory(directory: string): Promise<void> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(directory, "r");
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // Windows cannot flush these read-only directory handles. Restrict this
    // fallback to the directory operation and known unsupported errors; real
    // I/O failures and every non-Windows failure must still reach the caller.
    if (
      process.platform !== "win32" ||
      !["EISDIR", "EINVAL", "EPERM"].includes(code ?? "")
    ) {
      throw error;
    }
  } finally {
    await handle?.close();
  }
}
