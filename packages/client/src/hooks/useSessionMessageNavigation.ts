import {
  getMessageId,
  messageHasId,
  type Message,
} from "@yep-anywhere/shared/transcript/message";
import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { useClientSummarySourceKey } from "../lib/clientSummaryStore";

export interface MessageNavigationOptions {
  target: string | null;
  enabled: boolean;
  onResolved?(target: string): Promise<void>;
  sessionId: string | undefined;
  messages: readonly Message[];
  loading: boolean;
  loadingOlder: boolean;
  hasOlder: boolean;
  olderCursor?: string;
  loadOlder(): Promise<void>;
  jump(messageId: string, onResolved: (found: boolean) => void): void;
  onError(kind: "unavailable" | "completion"): void;
}

/** The older page this navigation asked for, once it has landed. */
interface LandedOlderPage {
  key: string;
  cursor: string;
}

export function useSessionMessageNavigation(options: MessageNavigationOptions) {
  const location = useLocation();
  const sourceKey = useClientSummarySourceKey();
  const target = options.target;
  const key = JSON.stringify([
    sourceKey,
    options.sessionId,
    location.key,
    target,
  ]);
  const currentKey = useRef(key);
  currentKey.current = key;
  const handled = useRef<string | undefined>(undefined);
  // Callers pass a fresh options literal every render, so the decision reads
  // the current callbacks here rather than re-running whenever an inline
  // arrow function gets a new identity.
  const latest = useRef(options);
  latest.current = options;
  const inFlightPage = useRef<string | undefined>(undefined);
  const [landedPage, setLandedPage] = useState<LandedOlderPage | null>(null);

  useEffect(() => {
    currentKey.current = key;
    return () => {
      currentKey.current = "";
    };
  }, [key]);

  useEffect(() => {
    if (
      !target ||
      !options.sessionId ||
      options.loading ||
      options.loadingOlder ||
      handled.current === key ||
      !options.enabled
    )
      return;
    const message = options.messages.find((message) =>
      messageHasId(message, target),
    );
    if (!message) {
      // A page still on its way answers nothing yet. One that landed without
      // adding the target is the give-up signal, whether or not it changed
      // the message array or the cursor, so the decision reads the landing
      // rather than re-running on an opaque counter.
      if (inFlightPage.current === key) return;
      const landedHere =
        landedPage?.key === key && landedPage.cursor === options.olderCursor;
      if (options.hasOlder && options.olderCursor && !landedHere) {
        const cursor = options.olderCursor;
        inFlightPage.current = key;
        void latest.current
          .loadOlder()
          .catch(() => {
            if (currentKey.current === key) {
              handled.current = key;
              latest.current.onError("unavailable");
            }
          })
          .finally(() => {
            if (inFlightPage.current === key) inFlightPage.current = undefined;
            setLandedPage({ key, cursor });
          });
        return;
      }
      handled.current = key;
      latest.current.onError("unavailable");
      return;
    }
    handled.current = key;
    latest.current.jump(getMessageId(message), (found) => {
      if (currentKey.current !== key) return;
      if (!found) {
        latest.current.onError("unavailable");
        return;
      }
      void latest.current.onResolved?.(target).catch(() => {
        if (currentKey.current === key) latest.current.onError("completion");
      });
    });
  }, [
    key,
    target,
    options.enabled,
    options.sessionId,
    options.loading,
    options.loadingOlder,
    options.messages,
    options.hasOlder,
    options.olderCursor,
    landedPage,
  ]);
}
