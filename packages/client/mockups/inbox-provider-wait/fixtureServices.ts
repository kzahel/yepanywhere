/** Isolated inbox fixture: no YA server, so no version snapshot. */
export function useVersion() {
  return {
    version: null,
    loading: false,
    error: null,
    refetch: async () => null,
    refetchFresh: async () => null,
  };
}

export function useRetainedVersionInfo() {
  return null;
}
