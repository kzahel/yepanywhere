export function reuseEqualSet<T>(
  previous: ReadonlySet<T>,
  next: ReadonlySet<T>,
) {
  if (previous.size !== next.size) return next;
  for (const value of next) {
    if (!previous.has(value)) return next;
  }
  return previous;
}
