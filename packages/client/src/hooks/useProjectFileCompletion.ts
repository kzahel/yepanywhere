import {
  serverHasCapability,
  PROJECT_FILE_COMPLETION_CAPABILITY,
  type ProjectFileCompletionEntry,
  type ProjectFileCompletionResult,
} from "@yep-anywhere/shared";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from "react";
import { useCurrentSourceRuntime } from "../contexts/SourceRuntimeContext";
import { useClientSummarySourceKey } from "../lib/clientSummaryStore";
import { replaceTextareaRangeUndoably } from "../lib/composerTextarea";
import { recentProjectFileMentions } from "../lib/recentProjectPathLinks";
import type { RenderItem } from "@yep-anywhere/shared/transcript/items";
import { useVersion } from "./useVersion";

const EMPTY_ITEMS: RenderItem[] = [];
const enabledProjects = new Set<string>();

export function projectFileQuery(text: string, cursor: number) {
  const match = /(?:^|\s)@([^\s@]*)$/.exec(text.slice(0, cursor));
  if (!match) return null;
  return {
    query: match[1] ?? "",
    start: cursor - (match[1]?.length ?? 0) - 1,
    end: cursor + (/^[^\s@]*/.exec(text.slice(cursor))?.[0].length ?? 0),
  };
}

export function useProjectFileCompletion(options: {
  projectId?: string | null;
  text: string;
  textarea: RefObject<HTMLTextAreaElement | null>;
  setText: (text: string) => void;
  replace?: (start: number, end: number, replacement: string) => string | null;
  items?: RenderItem[];
  disabled?: boolean;
}) {
  const sourceKey = useClientSummarySourceKey();
  const runtime = useCurrentSourceRuntime();
  const { version } = useVersion();
  const key = JSON.stringify([sourceKey, options.projectId]);
  const storageKey = `ya:file-completion:${key}`;
  const [cursor, setCursor] = useState(options.text.length);
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [selection, setSelection] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<{
    key: string;
    result?: ProjectFileCompletionResult;
    error?: string;
  } | null>(null);
  const provisional = useRef<{ value: string; cursor: number } | null>(null);
  const token = projectFileQuery(options.text, cursor);
  const query = token?.query;
  let sticky = enabledProjects.has(storageKey);
  try {
    sticky ||= localStorage.getItem(storageKey) === "1";
  } catch {
    /* Storage is optional; this browser session retains enablement. */
  }
  const active =
    !!options.projectId &&
    !options.disabled &&
    focused &&
    serverHasCapability(version, PROJECT_FILE_COMPLETION_CAPABILITY) &&
    token !== null &&
    (sticky || token.query.length >= 2);
  const queryKey = active
    ? JSON.stringify([key, token?.start, token?.query])
    : null;
  const visible = queryKey !== null && dismissed !== queryKey;
  useEffect(() => {
    setDismissed((previous) => (previous === queryKey ? previous : null));
    setSelection(null);
  }, [queryKey]);
  const items = options.items ?? EMPTY_ITEMS;
  const recent = useMemo(
    () => (visible ? recentProjectFileMentions(items) : []),
    [items, visible],
  );

  useEffect(() => {
    if (!visible || !queryKey || !options.projectId || query === undefined)
      return;
    let stopped = false;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const params = new URLSearchParams({ q: query });
    let recentBytes = 0;
    for (const path of recent) {
      const bytes = encodeURIComponent(path).length + 8;
      if (recentBytes + bytes > 4096) continue;
      params.append("recent", path);
      recentBytes += bytes;
    }
    const path = `/projects/${options.projectId}/file-completion?${params}`;
    const read = async () => {
      try {
        const result =
          await runtime.transport.fetch<ProjectFileCompletionResult>(path, {
            signal: abort.signal,
          });
        if (stopped) return;
        setSnapshot({ key: queryKey, result });
        if (result.pending) timer = setTimeout(read, 250);
      } catch (error) {
        if (!stopped)
          setSnapshot({
            key: queryKey,
            error: error instanceof Error ? error.message : String(error),
          });
      }
    };
    // Coalesce ordinary typing, but never schedule anything before activation.
    timer = setTimeout(read, 75);
    return () => {
      stopped = true;
      abort.abort();
      clearTimeout(timer);
    };
  }, [visible, queryKey, options.projectId, query, recent, runtime]);

  const current = visible && snapshot?.key === queryKey ? snapshot : null;
  const entries = current?.result?.entries ?? [];
  const selected =
    entries.find((entry) => entry.path === selection) ?? entries[0];

  function replace(start: number, end: number, value: string) {
    const textarea = options.textarea.current;
    if (!textarea) return;
    if (options.replace) options.replace(start, end, value);
    else {
      replaceTextareaRangeUndoably(textarea, start, end, value);
      options.setText(textarea.value);
    }
    textarea.setSelectionRange(start + value.length, start + value.length);
    setCursor(start + value.length);
  }

  function accept(entry: ProjectFileCompletionEntry) {
    const textarea = options.textarea.current;
    if (
      !textarea ||
      !token ||
      !visible ||
      textarea.selectionStart !== textarea.selectionEnd
    )
      return;
    const path = /[\s"\\]/.test(entry.path)
      ? JSON.stringify(entry.path)
      : entry.path;
    replace(token.start, token.end, `${path} `);
    provisional.current = {
      value: textarea.value,
      cursor: token.start + path.length + 1,
    };
    enabledProjects.add(storageKey);
    try {
      localStorage.setItem(storageKey, "1");
    } catch {
      /* Session-local enablement remains available. */
    }
    setDismissed(queryKey);
  }

  function onKeyDown(event: KeyboardEvent) {
    if (event.nativeEvent.isComposing) return false;
    const pending = provisional.current;
    const textarea = options.textarea.current;
    if (
      pending &&
      textarea &&
      textarea.value === pending.value &&
      textarea.selectionStart === pending.cursor &&
      textarea.selectionEnd === pending.cursor &&
      (event.key === " " || event.key === "Enter")
    ) {
      replace(pending.cursor - 1, pending.cursor, "");
      provisional.current = null;
    } else if (!["Shift", "Control", "Alt", "Meta"].includes(event.key))
      provisional.current = null;
    if (
      !visible ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      event.shiftKey
    )
      return false;
    if (event.key === "Escape") {
      event.preventDefault();
      setDismissed(queryKey);
      return true;
    }
    if (selected && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
      event.preventDefault();
      const index = entries.indexOf(selected);
      setSelection(
        entries[
          (index + (event.key === "ArrowDown" ? 1 : -1) + entries.length) %
            entries.length
        ]?.path ?? null,
      );
      return true;
    }
    if (event.key === "Tab" && selected) {
      event.preventDefault();
      accept(selected);
      return true;
    }
    return false;
  }

  // Mobile keyboards may insert separators without a corresponding keydown.
  function normalizeInput(value: string) {
    const pending = provisional.current;
    provisional.current = null;
    if (
      pending &&
      (value ===
        pending.value.slice(0, pending.cursor) +
          " " +
          pending.value.slice(pending.cursor) ||
        value ===
          pending.value.slice(0, pending.cursor) +
            "\n" +
            pending.value.slice(pending.cursor))
    ) {
      const textarea = options.textarea.current;
      if (textarea) {
        textarea.setRangeText(
          "",
          pending.cursor - 1,
          pending.cursor,
          "preserve",
        );
        setCursor(textarea.selectionStart);
        return textarea.value;
      }
    }
    setCursor(options.textarea.current?.selectionStart ?? value.length);
    return value;
  }

  return {
    visible,
    entries,
    selected: selected?.path,
    accept,
    onKeyDown,
    normalizeInput,
    pending: visible && (!current || current.result?.pending),
    truncated: current?.result?.truncated ?? false,
    error: current?.error,
    onSelect: () => {
      setCursor(
        options.textarea.current?.selectionStart ?? options.text.length,
      );
    },
    onFocus: () => setFocused(true),
    onBlur: () => {
      setFocused(false);
      provisional.current = null;
    },
  };
}
