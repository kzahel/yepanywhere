/** Profile-owned query observers, released with their collection query owner.
 * No per-session listener or timer; observers only invalidate derived state.
 */
export class CollectionMetadataChanges {
  private readonly listeners = new Set<(sessionId: string) => void>();
  readonly subscribe = (
    listener: (sessionId: string) => void,
  ): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  publish(sessionId: string): void {
    for (const listener of this.listeners) {
      try {
        listener(sessionId);
      } catch (error) {
        console.error(
          "[SessionMetadataRows] Collection observer failed",
          error,
        );
      }
    }
  }
}
