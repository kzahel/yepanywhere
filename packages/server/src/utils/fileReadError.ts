/** A failed observation is not evidence that provider history was removed. */
export function isTransientFileReadError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return (
    code !== undefined &&
    [
      "EACCES",
      "EPERM",
      "EBUSY",
      "EAGAIN",
      "EINTR",
      "EMFILE",
      "ENFILE",
      "EIO",
      "ESTALE",
      "ETIMEDOUT",
    ].includes(code)
  );
}
