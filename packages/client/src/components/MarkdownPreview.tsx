import {
  type CSSProperties,
  forwardRef,
  type KeyboardEventHandler,
  memo,
  type MouseEventHandler,
  useCallback,
  useMemo,
  useRef,
  useState,
} from "react";
import { useGlossaryArtifact } from "../contexts/GlossaryContext";
import {
  codeFenceRootClass,
  useCodeFenceRenderers,
} from "../hooks/useCodeFenceRenderers";
import { annotateGlossaryHtml } from "../lib/glossary/annotateGlossaryHtml";
import densityStyles from "./FileViewerDensityControls.module.css";
import { IconButton } from "./ui/Button";
import { useInlineCodeActions } from "../hooks/useInlineCodeActions";

const FILE_VIEWER_DENSITY_STORAGE_KEY = "yep-anywhere-file-viewer-density-zoom";
const FILE_VIEWER_DENSITY_MIN = -4;
const FILE_VIEWER_DENSITY_MAX = 6;
const FILE_VIEWER_FONT_STEP_PX = 0.5;
const FILE_VIEWER_VSPACE_STEP_PX = 1;
export interface MarkdownPreviewDensityOffsets {
  fontSizeOffsetPx?: number;
  verticalSpacingOffsetPx?: number;
}

type MarkdownPreviewStyle = CSSProperties & {
  "--markdown-preview-font-size-offset"?: string;
  "--markdown-preview-vspace-offset"?: string;
  "--source-font-size-offset"?: string;
  "--source-vspace-offset"?: string;
};

export const FILE_MARKDOWN_PREVIEW_BASE_DENSITY: MarkdownPreviewDensityOffsets =
  {
    fontSizeOffsetPx: -1,
    verticalSpacingOffsetPx: -2,
  };

export const FILE_SOURCE_BASE_DENSITY: MarkdownPreviewDensityOffsets = {
  fontSizeOffsetPx: 0,
  verticalSpacingOffsetPx: 0,
};

function clampDensityZoom(value: number): number {
  return Math.min(
    FILE_VIEWER_DENSITY_MAX,
    Math.max(FILE_VIEWER_DENSITY_MIN, value),
  );
}

function readStoredDensityZoom(): number {
  if (typeof sessionStorage === "undefined") {
    return 0;
  }
  try {
    const stored = Number(
      sessionStorage.getItem(FILE_VIEWER_DENSITY_STORAGE_KEY),
    );
    return Number.isFinite(stored) ? clampDensityZoom(stored) : 0;
  } catch {
    return 0;
  }
}

function writeStoredDensityZoom(value: number) {
  if (typeof sessionStorage === "undefined") {
    return;
  }
  try {
    if (value === 0) {
      sessionStorage.removeItem(FILE_VIEWER_DENSITY_STORAGE_KEY);
    } else {
      sessionStorage.setItem(FILE_VIEWER_DENSITY_STORAGE_KEY, String(value));
    }
  } catch {
    // The in-memory density still applies when storage is unavailable.
  }
}

export function combineDensityOffsets(
  base: MarkdownPreviewDensityOffsets,
  adjustment: MarkdownPreviewDensityOffsets,
): MarkdownPreviewDensityOffsets {
  return {
    fontSizeOffsetPx:
      (base.fontSizeOffsetPx ?? 0) + (adjustment.fontSizeOffsetPx ?? 0),
    verticalSpacingOffsetPx:
      (base.verticalSpacingOffsetPx ?? 0) +
      (adjustment.verticalSpacingOffsetPx ?? 0),
  };
}

export function getMarkdownPreviewStyle({
  fontSizeOffsetPx = 0,
  verticalSpacingOffsetPx = 0,
}: MarkdownPreviewDensityOffsets = {}): MarkdownPreviewStyle {
  return {
    "--markdown-preview-font-size-offset": `${fontSizeOffsetPx}px`,
    "--markdown-preview-vspace-offset": `${verticalSpacingOffsetPx}px`,
  };
}

export function getSourceViewStyle({
  fontSizeOffsetPx = 0,
  verticalSpacingOffsetPx = 0,
}: MarkdownPreviewDensityOffsets = {}): MarkdownPreviewStyle {
  return {
    "--source-font-size-offset": `${fontSizeOffsetPx}px`,
    "--source-vspace-offset": `${verticalSpacingOffsetPx}px`,
  };
}

export function useFileViewerDensity() {
  const [zoom, setZoom] = useState(readStoredDensityZoom);
  const density = useMemo<MarkdownPreviewDensityOffsets>(
    () => ({
      fontSizeOffsetPx: zoom * FILE_VIEWER_FONT_STEP_PX,
      verticalSpacingOffsetPx: zoom * FILE_VIEWER_VSPACE_STEP_PX,
    }),
    [zoom],
  );
  const setBoundedZoom = useCallback((nextZoom: number) => {
    const bounded = clampDensityZoom(nextZoom);
    setZoom(bounded);
    writeStoredDensityZoom(bounded);
  }, []);
  return {
    canZoomIn: zoom < FILE_VIEWER_DENSITY_MAX,
    canZoomOut: zoom > FILE_VIEWER_DENSITY_MIN,
    density,
    zoom,
    zoomIn: () => setBoundedZoom(zoom + 1),
    zoomOut: () => setBoundedZoom(zoom - 1),
  };
}

interface MarkdownPreviewProps {
  ariaLabel?: string;
  className?: string;
  density?: MarkdownPreviewDensityOffsets;
  html: string;
  onClick?: MouseEventHandler<HTMLDivElement>;
  onContextMenu?: MouseEventHandler<HTMLDivElement>;
  onKeyDown?: KeyboardEventHandler<HTMLDivElement>;
  sourcePath?: string;
}

export const MarkdownPreview = memo(
  forwardRef<HTMLDivElement, MarkdownPreviewProps>(function MarkdownPreview(
    {
      ariaLabel,
      className,
      density,
      html,
      onClick,
      onContextMenu,
      onKeyDown,
      sourcePath,
    },
    ref,
  ) {
    const classes = ["markdown-preview", className].filter(Boolean).join(" ");
    const glossary = useGlossaryArtifact(sourcePath);
    const renderedHtml = useMemo(() => {
      if (glossary.state !== "ready" || glossary.result?.status !== "ready") {
        return html;
      }
      return annotateGlossaryHtml(html, glossary.result.artifact).html;
    }, [glossary, html]);
    const renderedMarkup = useMemo(
      () => ({ __html: renderedHtml }),
      [renderedHtml],
    );
    const renderedRef = useRef<HTMLDivElement>(null);
    const diagramViewer = useCodeFenceRenderers(renderedRef);
    const inlineCode = useInlineCodeActions();
    return (
      <div
        className={classes}
        role="region"
        aria-label={ariaLabel ?? "Markdown preview"}
        onClick={onClick}
        onDoubleClick={inlineCode.handleDoubleClick}
        onContextMenu={(event) => {
          if (!inlineCode.handleContextMenu(event)) onContextMenu?.(event);
        }}
        onKeyDown={onKeyDown}
        ref={ref}
        style={getMarkdownPreviewStyle(density)}
      >
        <div
          className={`markdown-rendered ${codeFenceRootClass}`}
          ref={renderedRef}
          // biome-ignore lint/security/noDangerouslySetInnerHtml: server-rendered markdown is sanitized
          dangerouslySetInnerHTML={renderedMarkup}
        />
        {inlineCode.menu}
        {diagramViewer}
      </div>
    );
  }),
);

interface FileViewerDensityControlsProps {
  canZoomIn: boolean;
  canZoomOut: boolean;
  onZoomIn: () => void;
  onZoomOut: () => void;
}

export function FileViewerDensityControls({
  canZoomIn,
  canZoomOut,
  onZoomIn,
  onZoomOut,
}: FileViewerDensityControlsProps) {
  return (
    <div
      className={densityStyles.controls}
      role="group"
      aria-label="Source zoom"
    >
      <IconButton
        size="small"
        onClick={onZoomOut}
        disabled={!canZoomOut}
        label="Zoom source and preview out"
      >
        <span className={densityStyles.operator} aria-hidden="true">
          −
        </span>
        <span className={densityStyles.smallLetter} aria-hidden="true">
          a
        </span>
      </IconButton>
      <IconButton
        size="small"
        onClick={onZoomIn}
        disabled={!canZoomIn}
        label="Zoom source and preview in"
      >
        <span className={densityStyles.largeLetter} aria-hidden="true">
          A
        </span>
        <span className={densityStyles.operator} aria-hidden="true">
          +
        </span>
      </IconButton>
    </div>
  );
}
