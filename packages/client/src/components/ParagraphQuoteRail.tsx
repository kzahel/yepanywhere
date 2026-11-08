import {
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useI18n } from "../i18n";
import { createCommentAnchor, type CommentAnchor } from "../lib/commentAnchors";
import {
  getMarkdownSnippetForElement,
  getMarkdownSnippetForSubElement,
} from "../lib/markdownSelectionCopy";
import { IconButton } from "./ui/Button";

const PARAGRAPH_BLOCK_SELECTOR =
  "p, ul, ol, blockquote, pre, h1, h2, h3, h4, h5, h6, table";
const QUOTE_RAIL_OVERSCAN_PX = 200;
const QUOTE_RAIL_RESIZE_SETTLE_MS = 120;

interface ParagraphTarget {
  blockIndex: number;
  top: number;
  height: number;
}

function isMermaidBlock(element: HTMLElement): boolean {
  const block = element.closest("[data-ya-code-block], pre");
  const code = block?.querySelector(":scope > pre > code, :scope > code");
  return Array.from(code?.classList ?? []).some(
    (name) => name.toLowerCase() === "language-mermaid",
  );
}

function collectTopLevelBlocks(content: HTMLElement): {
  blocks: HTMLElement[];
  onlyMermaid: boolean;
} {
  const all = Array.from(
    content.querySelectorAll<HTMLElement>(PARAGRAPH_BLOCK_SELECTOR),
  );
  const eligible = all.filter((element) => !isMermaidBlock(element));
  const blocks = eligible.filter((element) => {
    const parentBlock = element.parentElement?.closest(
      PARAGRAPH_BLOCK_SELECTOR,
    );
    return !parentBlock || !content.contains(parentBlock);
  });
  return { blocks, onlyMermaid: all.length > 0 && eligible.length === 0 };
}

function paragraphTargetsEqual(
  left: ParagraphTarget[],
  right: ParagraphTarget[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (target, index) =>
        target.blockIndex === right[index]?.blockIndex &&
        target.top === right[index]?.top &&
        target.height === right[index]?.height,
    )
  );
}

function getParagraphBlock(
  blocks: HTMLElement[],
  blockIndex: number,
): HTMLElement {
  const block = blocks[blockIndex];
  if (!block) throw new Error(`Missing paragraph block ${blockIndex}`);
  return block;
}

function measureParagraphTargets(
  blocks: HTMLElement[],
  visibleIndexes: Set<number>,
  surface: HTMLElement,
): ParagraphTarget[] {
  const surfaceRect = surface.getBoundingClientRect();
  return Array.from(visibleIndexes)
    .sort((left, right) => left - right)
    .map((blockIndex) => {
      const rect = getParagraphBlock(
        blocks,
        blockIndex,
      ).getBoundingClientRect();
      return {
        blockIndex,
        top: rect.top - surfaceRect.top + surface.scrollTop,
        height: rect.height,
      };
    });
}

export function ParagraphQuoteRail({
  alwaysShowQuoteCircle,
  contentRef,
  layoutKey,
  onQuoteBlock,
  paragraphQuoteCirclesEnabled,
  sourceRef,
  surfaceRef,
}: {
  alwaysShowQuoteCircle: boolean;
  contentRef: RefObject<HTMLElement | null>;
  layoutKey: string;
  onQuoteBlock: (anchor: CommentAnchor) => void;
  paragraphQuoteCirclesEnabled: boolean;
  sourceRef: RefObject<HTMLElement | null>;
  surfaceRef: RefObject<HTMLElement | null>;
}) {
  const { t } = useI18n();
  const paragraphBlocksRef = useRef<HTMLElement[]>([]);
  const [paragraphTargets, setParagraphTargets] = useState<ParagraphTarget[]>(
    [],
  );
  const [onlyMermaid, setOnlyMermaid] = useState(false);

  useEffect(() => {
    void layoutKey;
    const content = contentRef.current;
    const surface = surfaceRef.current;
    if (!content || !surface) {
      if (paragraphBlocksRef.current.length > 0) {
        paragraphBlocksRef.current = [];
        setParagraphTargets([]);
      }
      return;
    }

    let blocks: HTMLElement[] = [];
    let blockIndexes = new WeakMap<HTMLElement, number>();
    const visibleIndexes = new Set<number>();
    let frameId = 0;
    let resizeTimer = 0;
    let observingBlocks = false;
    const measure = () => {
      frameId = 0;
      const targets = measureParagraphTargets(blocks, visibleIndexes, surface);
      paragraphBlocksRef.current = targets.map((target) =>
        getParagraphBlock(blocks, target.blockIndex),
      );
      setParagraphTargets((previous) =>
        paragraphTargetsEqual(previous, targets) ? previous : targets,
      );
    };
    const scheduleMeasure = () => {
      if (frameId !== 0) return;
      frameId = requestAnimationFrame(measure);
    };
    const scheduleResizeMeasure = () => {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(
        scheduleMeasure,
        QUOTE_RAIL_RESIZE_SETTLE_MS,
      );
    };

    // Large rendered files can contain thousands of blocks. Let the browser
    // track the visible neighborhood so a resize only measures and renders
    // quote controls that can appear in the scrollport.
    const intersectionObserver: IntersectionObserver | null =
      !paragraphQuoteCirclesEnabled ||
      typeof IntersectionObserver === "undefined"
        ? null
        : new IntersectionObserver(
            (entries) => {
              const surfaceEntry = entries.find(
                (entry) => entry.target === surface,
              );
              if (surfaceEntry && !surfaceEntry.isIntersecting) {
                // Parking is a transition, not a state to reassert. Observing
                // a target queues an initial observation for it, so the
                // disconnect/observe pair below hands this same callback
                // another non-intersecting surface entry on the next frame.
                // Without this guard that entry parks the rail again, and a
                // rail whose surface sits outside the scrollport schedules a
                // measurement every frame for as long as the page is open —
                // once per off-screen text block, so a long transcript pays it
                // many times over.
                if (!observingBlocks) return;
                observingBlocks = false;
                visibleIndexes.clear();
                intersectionObserver?.disconnect();
                intersectionObserver?.observe(surface);
                scheduleMeasure();
                return;
              }
              if (surfaceEntry?.isIntersecting && !observingBlocks) {
                observingBlocks = true;
                for (const block of blocks) {
                  intersectionObserver?.observe(block);
                }
              }
              for (const entry of entries) {
                if (!(entry.target instanceof HTMLElement)) continue;
                const blockIndex = blockIndexes.get(entry.target);
                if (blockIndex === undefined) continue;
                if (entry.isIntersecting) {
                  visibleIndexes.add(blockIndex);
                } else {
                  visibleIndexes.delete(blockIndex);
                }
              }
              scheduleMeasure();
            },
            {
              rootMargin: `${QUOTE_RAIL_OVERSCAN_PX}px 0px`,
            },
          );
    const refreshBlocks = () => {
      if (intersectionObserver) {
        for (const block of blocks) intersectionObserver.unobserve(block);
      }
      const collected = collectTopLevelBlocks(content);
      setOnlyMermaid(collected.onlyMermaid);
      if (!paragraphQuoteCirclesEnabled) {
        paragraphBlocksRef.current = [];
        setParagraphTargets((previous) =>
          previous.length > 0 ? [] : previous,
        );
        return;
      }
      blocks = collected.blocks;
      blockIndexes = new WeakMap<HTMLElement, number>();
      blocks.forEach((block, blockIndex) => {
        blockIndexes.set(block, blockIndex);
      });
      visibleIndexes.clear();
      if (intersectionObserver && observingBlocks) {
        for (const block of blocks) intersectionObserver.observe(block);
      } else if (!intersectionObserver) {
        for (let blockIndex = 0; blockIndex < blocks.length; blockIndex += 1) {
          visibleIndexes.add(blockIndex);
        }
      }
      scheduleMeasure();
    };
    refreshBlocks();
    if (intersectionObserver) {
      intersectionObserver.observe(surface);
    }
    const observer =
      !paragraphQuoteCirclesEnabled || typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(scheduleResizeMeasure);
    observer?.observe(content);
    const mutationObserver = new MutationObserver(refreshBlocks);
    mutationObserver.observe(content, { childList: true, subtree: true });
    return () => {
      observer?.disconnect();
      mutationObserver.disconnect();
      intersectionObserver?.disconnect();
      if (frameId !== 0) cancelAnimationFrame(frameId);
      window.clearTimeout(resizeTimer);
    };
  }, [contentRef, layoutKey, paragraphQuoteCirclesEnabled, surfaceRef]);

  const handleQuoteBlock = useCallback(() => {
    const sourceElement = sourceRef.current;
    const contentElement = contentRef.current;
    if (!sourceElement) return;
    const sourceSnippet = getMarkdownSnippetForElement(sourceElement);
    if (!sourceSnippet) return;
    const visibleSnippet =
      contentElement && contentElement !== sourceElement
        ? getMarkdownSnippetForSubElement(sourceElement, contentElement)
        : null;
    onQuoteBlock(
      createCommentAnchor(
        visibleSnippet
          ? {
              ...sourceSnippet,
              range: visibleSnippet.range,
              selectedText: visibleSnippet.selectedText,
            }
          : sourceSnippet,
      ),
    );
  }, [contentRef, onQuoteBlock, sourceRef]);

  const quoteParagraph = useCallback(
    (index: number) => {
      const sourceElement = sourceRef.current;
      const blockElement = paragraphBlocksRef.current[index];
      if (!sourceElement || !blockElement) return;
      const snippet = getMarkdownSnippetForSubElement(
        sourceElement,
        blockElement,
      );
      if (snippet) onQuoteBlock(createCommentAnchor(snippet));
    },
    [onQuoteBlock, sourceRef],
  );

  if (onlyMermaid) return null;

  return (
    <div className="text-block-quote-rail">
      {paragraphQuoteCirclesEnabled && paragraphTargets.length > 0 ? (
        paragraphTargets.map((target, index) => (
          <IconButton
            key={target.blockIndex}
            size="dense"
            className={`text-block-quote text-block-quote-paragraph ${alwaysShowQuoteCircle ? "always-visible" : ""}`}
            style={{ top: `${target.top + target.height}px` }}
            onClick={() => quoteParagraph(index)}
            label={t("sessionQuoteBlock")}
          >
            &gt;
          </IconButton>
        ))
      ) : (
        <IconButton
          size="dense"
          className={`text-block-quote text-block-quote-fallback ${alwaysShowQuoteCircle ? "always-visible" : ""}`}
          onClick={handleQuoteBlock}
          label={t("sessionQuoteBlock")}
        >
          &gt;
        </IconButton>
      )}
    </div>
  );
}
