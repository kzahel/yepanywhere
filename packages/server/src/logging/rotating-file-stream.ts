import * as fs from "node:fs";
import { Writable } from "node:stream";

/** Size of the live file before it rotates. */
export const LOG_FILE_MAX_BYTES = 100 * 1024 * 1024;
/** Rotated files kept beside the live one (`<file>.1` is the newest). */
export const LOG_FILE_KEEP = 2;

export interface RotatingFileStreamOptions {
  maxBytes?: number;
  keep?: number;
}

/**
 * An append-only file stream that rotates by size: when the next chunk would
 * take the live file past `maxBytes`, it closes the file, shifts
 * `<file>.N` to `<file>.N+1` (dropping the oldest) and starts a new one, so
 * the log never holds more than `(keep + 1) * maxBytes` plus one chunk.
 * Rotation waits for the old descriptor to close, so it also works where an
 * open file cannot be renamed. A file already over the limit at startup
 * rotates on the first write. A failed rename keeps appending to the live
 * file and retries after another `maxBytes`.
 */
export function createRotatingFileStream(
  filePath: string,
  options: RotatingFileStreamOptions = {},
): Writable {
  const maxBytes = options.maxBytes ?? LOG_FILE_MAX_BYTES;
  const keep = options.keep ?? LOG_FILE_KEEP;
  let size = currentSize(filePath);
  let file = fs.createWriteStream(filePath, { flags: "a" });
  const append = (chunk: Buffer, callback: (error?: Error | null) => void) => {
    const write = () => {
      size += chunk.length;
      file.write(chunk, callback);
    };
    if (size === 0 || size + chunk.length <= maxBytes) {
      write();
      return;
    }
    rotate().then(() => (output.destroyed ? callback() : write()), callback);
  };
  const output = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      append(chunk, callback);
    },
    // Batches buffered log lines into one append, as fs.WriteStream does.
    writev(chunks, callback) {
      append(
        Buffer.concat(chunks.map(({ chunk }) => chunk as Buffer)),
        callback,
      );
    },
    final(callback) {
      file.end(callback);
    },
    destroy(error, callback) {
      file.destroy();
      callback(error);
    },
  });
  const forwardError = (error: Error) => output.destroy(error);
  file.on("error", forwardError);

  async function rotate(): Promise<void> {
    file.off("error", forwardError);
    // A failed close must not become an uncaught 'error' event.
    file.on("error", () => undefined);
    await new Promise<void>((resolve) => {
      file.end(() => resolve());
    });
    if (output.destroyed) return;
    try {
      shiftArchives(filePath, keep);
      size = currentSize(filePath);
    } catch {
      // Keep appending to the same file; retry after another maxBytes.
      size = 0;
    }
    file = fs.createWriteStream(filePath, { flags: "a" });
    file.on("error", forwardError);
  }
  return output;
}

function currentSize(filePath: string): number {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

/** Moves the live file aside first, so a failure leaves the archives as they were. */
function shiftArchives(filePath: string, keep: number): void {
  if (keep < 1) {
    fs.rmSync(filePath, { force: true });
    return;
  }
  const moving = `${filePath}.rotating`;
  fs.renameSync(filePath, moving);
  fs.rmSync(`${filePath}.${keep}`, { force: true });
  for (let index = keep - 1; index >= 1; index -= 1) {
    renameIfPresent(`${filePath}.${index}`, `${filePath}.${index + 1}`);
  }
  fs.renameSync(moving, `${filePath}.1`);
}

function renameIfPresent(from: string, to: string): void {
  try {
    fs.renameSync(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
