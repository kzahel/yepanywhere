import {
  type CSSProperties,
  type RefObject,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

const HEIGHT_EPSILON_PX = 0.5;

export interface UserPromptActionLayout {
  columns: number;
  rows: number;
}

interface ActionLayoutCandidate extends UserPromptActionLayout {
  actionBlockSize: number;
  promptBlockSize: number;
  totalBlockSize: number;
}

export function chooseUserPromptActionLayout({
  actionCount,
  actionGap,
  actionSize,
  availableInlineSize,
  inlineEndInset,
  measurePromptBlockSize,
}: {
  actionCount: number;
  actionGap: number;
  actionSize: number;
  availableInlineSize: number;
  inlineEndInset: number;
  measurePromptBlockSize: (maxInlineSize: number) => number;
}): UserPromptActionLayout {
  if (actionCount <= 1) {
    return { columns: 1, rows: Math.max(1, actionCount) };
  }

  const columnOptions = [
    ...new Set([1, Math.min(2, actionCount), actionCount]),
  ];
  const candidates: ActionLayoutCandidate[] = columnOptions.map((columns) => {
    const rows = Math.ceil(actionCount / columns);
    const actionInlineSize =
      columns * actionSize + Math.max(0, columns - 1) * actionGap;
    const promptInlineSize = Math.max(
      1,
      availableInlineSize - actionInlineSize - actionGap - inlineEndInset,
    );
    const promptBlockSize = measurePromptBlockSize(promptInlineSize);
    const actionBlockSize =
      rows * actionSize + Math.max(0, rows - 1) * actionGap;
    return {
      columns,
      rows,
      actionBlockSize,
      promptBlockSize,
      totalBlockSize: Math.max(actionBlockSize, promptBlockSize),
    };
  });

  const containing = candidates.find(
    (candidate) =>
      candidate.actionBlockSize <=
      candidate.promptBlockSize + HEIGHT_EPSILON_PX,
  );
  if (containing) {
    return { columns: containing.columns, rows: containing.rows };
  }

  const baselinePromptSize = candidates[0]?.promptBlockSize ?? 0;
  const samePromptHeight = candidates.filter(
    (candidate) =>
      candidate.promptBlockSize <= baselinePromptSize + HEIGHT_EPSILON_PX,
  );
  const pool = samePromptHeight.length > 1 ? samePromptHeight : candidates;
  const best = pool.reduce((current, candidate) => {
    if (candidate.totalBlockSize !== current.totalBlockSize) {
      return candidate.totalBlockSize < current.totalBlockSize
        ? candidate
        : current;
    }
    if (candidate.promptBlockSize !== current.promptBlockSize) {
      return candidate.promptBlockSize < current.promptBlockSize
        ? candidate
        : current;
    }
    return candidate.columns < current.columns ? candidate : current;
  });
  return { columns: best.columns, rows: best.rows };
}

function numericCssValue(value: string, fallback: number): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function defaultLayout(actionCount: number): UserPromptActionLayout {
  return { columns: 1, rows: Math.max(1, actionCount) };
}

export interface UserPromptActionPacking {
  actionsRef: RefObject<HTMLDivElement | null>;
  bubbleRef: RefObject<HTMLDivElement | null>;
  containerRef: RefObject<HTMLDivElement | null>;
  layout: UserPromptActionLayout;
  style: CSSProperties;
}

export function useUserPromptActionPacking(
  actionCount: number,
  measurementKey: string,
): UserPromptActionPacking {
  const containerRef = useRef<HTMLDivElement>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);
  const actionsRef = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useState(() => defaultLayout(actionCount));

  const measure = useCallback(() => {
    const container = containerRef.current;
    const bubble = bubbleRef.current;
    const actions = actionsRef.current;
    const firstAction = actions?.querySelector<HTMLElement>(
      "[data-user-prompt-action]",
    );
    if (!container || !bubble || !actions || !firstAction) return;

    const containerRect = container.getBoundingClientRect();
    const actionRect = firstAction.getBoundingClientRect();
    const actionsRect = actions.getBoundingClientRect();
    if (containerRect.width <= 0 || actionRect.width <= 0) return;

    const actionsStyle = getComputedStyle(actions);
    const containerStyle = getComputedStyle(container);
    const actionGap = numericCssValue(actionsStyle.columnGap, 4);
    const actionSize = Math.max(actionRect.width, actionRect.height);
    const inlineEndInset = Math.max(
      0,
      containerStyle.direction === "rtl"
        ? actionsRect.left - containerRect.left
        : containerRect.right - actionsRect.right,
    );

    const probeHost = document.createElement("div");
    const probe = bubble.cloneNode(true) as HTMLDivElement;
    probeHost.setAttribute("aria-hidden", "true");
    for (const element of probe.querySelectorAll("[id]")) {
      element.removeAttribute("id");
    }
    Object.assign(probeHost.style, {
      boxSizing: "border-box",
      contain: "layout style paint",
      direction: containerStyle.direction,
      inset: "0 auto auto 0",
      margin: "0",
      pointerEvents: "none",
      position: "fixed",
      visibility: "hidden",
      width: `${containerRect.width}px`,
      zIndex: "-1",
    });
    Object.assign(probe.style, {
      margin: "0",
      maxHeight: "none",
      minWidth: "0",
    });
    probeHost.append(probe);
    container.append(probeHost);
    try {
      const next = chooseUserPromptActionLayout({
        actionCount,
        actionGap,
        actionSize,
        availableInlineSize: containerRect.width,
        inlineEndInset,
        measurePromptBlockSize: (maxInlineSize) => {
          probeHost.style.paddingInlineEnd = `${containerRect.width - maxInlineSize}px`;
          return probe.getBoundingClientRect().height;
        },
      });
      setLayout((current) =>
        current.columns === next.columns && current.rows === next.rows
          ? current
          : next,
      );
    } finally {
      probeHost.remove();
    }
  }, [actionCount]);

  useLayoutEffect(() => {
    // The probe measures a clone of the rendered bubble, so new prompt text
    // invalidates the packing even though nothing here reads the digest of it.
    void measurementKey;
    setLayout((current) => {
      const fallback = defaultLayout(actionCount);
      return current.columns <= actionCount &&
        current.rows === Math.ceil(actionCount / current.columns)
        ? current
        : fallback;
    });
    measure();

    if (typeof ResizeObserver === "undefined") return;
    let animationFrame = 0;
    const scheduleMeasure = () => {
      cancelAnimationFrame(animationFrame);
      animationFrame = requestAnimationFrame(measure);
    };
    const observer = new ResizeObserver(scheduleMeasure);
    if (containerRef.current) observer.observe(containerRef.current);
    if (bubbleRef.current) observer.observe(bubbleRef.current);
    if (actionsRef.current) observer.observe(actionsRef.current);
    return () => {
      cancelAnimationFrame(animationFrame);
      observer.disconnect();
    };
  }, [actionCount, measure, measurementKey]);

  return {
    actionsRef,
    bubbleRef,
    containerRef,
    layout,
    style: {
      "--user-prompt-action-columns": layout.columns,
      "--user-prompt-action-count": actionCount,
      "--user-prompt-action-rows": layout.rows,
    } as CSSProperties,
  };
}
