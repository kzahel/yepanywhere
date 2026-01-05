import type { EditAugment } from "@yep-anywhere/shared";
import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";

/**
 * Context value for edit augments.
 * Stores pre-computed unified diffs keyed by toolUseId.
 */
interface EditAugmentContextValue {
  /**
   * Get an edit augment by tool use ID.
   */
  getAugment: (toolUseId: string) => EditAugment | undefined;

  /**
   * Set an edit augment for a tool use ID.
   * Called when edit-augment SSE event arrives.
   */
  setAugment: (toolUseId: string, augment: EditAugment) => void;

  /**
   * Set multiple edit augments at once.
   * Called when loading session via REST (editAugments in response).
   */
  setAugments: (augments: Record<string, EditAugment>) => void;

  /**
   * Clear all augments.
   * Called when switching sessions.
   */
  clearAugments: () => void;

  /**
   * Version counter that increments on each mutation.
   * Used by useEditAugment to subscribe to changes.
   */
  version: number;
}

const EditAugmentContext = createContext<EditAugmentContextValue | null>(null);

interface EditAugmentProviderProps {
  children: ReactNode;
}

/**
 * Provider for edit augments.
 *
 * This context stores pre-computed structuredPatch and highlighted diff HTML
 * for Edit tool_use blocks. Augments arrive before the raw message, so the
 * client has rendering data ready when the message appears.
 */
export function EditAugmentProvider({ children }: EditAugmentProviderProps) {
  const [augments, setAugmentsState] = useState<Map<string, EditAugment>>(
    () => new Map(),
  );
  // Version counter to trigger re-renders in useEditAugment consumers
  const [version, setVersion] = useState(0);

  // Use a ref to track current augments for the getter
  // This keeps getAugment stable (no dependency on augments state)
  const augmentsRef = useRef<Map<string, EditAugment>>(augments);
  augmentsRef.current = augments;

  const getAugment = useCallback(
    (toolUseId: string): EditAugment | undefined => {
      return augmentsRef.current.get(toolUseId);
    },
    [],
  );

  const setAugment = useCallback(
    (toolUseId: string, augment: EditAugment): void => {
      setAugmentsState((prev) => {
        const next = new Map(prev);
        next.set(toolUseId, augment);
        return next;
      });
      setVersion((v) => v + 1);
    },
    [],
  );

  const setAugments = useCallback(
    (newAugments: Record<string, EditAugment>): void => {
      setAugmentsState((prev) => {
        const next = new Map(prev);
        for (const [toolUseId, augment] of Object.entries(newAugments)) {
          next.set(toolUseId, augment);
        }
        return next;
      });
      setVersion((v) => v + 1);
    },
    [],
  );

  const clearAugments = useCallback((): void => {
    setAugmentsState(new Map());
    setVersion((v) => v + 1);
  }, []);

  // Memoize the context value - only changes when version changes
  // The version prop allows useEditAugment consumers to re-render on mutations
  const value = useMemo<EditAugmentContextValue>(
    () => ({
      getAugment,
      setAugment,
      setAugments,
      clearAugments,
      version,
    }),
    [getAugment, setAugment, setAugments, clearAugments, version],
  );

  return (
    <EditAugmentContext.Provider value={value}>
      {children}
    </EditAugmentContext.Provider>
  );
}

/**
 * Hook to access the edit augment context.
 * Returns null if not within a provider (for graceful degradation).
 */
export function useEditAugmentContext(): EditAugmentContextValue | null {
  return useContext(EditAugmentContext);
}

/**
 * Hook to get an edit augment by tool use ID.
 * Convenience wrapper that handles the null context case.
 * Subscribes to context changes via the version counter.
 */
export function useEditAugment(
  toolUseId: string | undefined,
): EditAugment | undefined {
  const context = useEditAugmentContext();
  if (!context || !toolUseId) return undefined;
  // Access version to subscribe to changes - this triggers re-render when augments are updated
  const _version = context.version;
  return context.getAugment(toolUseId);
}
