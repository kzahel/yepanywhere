import {
  memo,
  type MouseEvent,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ProjectPathLinkTarget } from "@yep-anywhere/shared";
import { createPortal } from "react-dom";
import {
  type PublicShareContextValue,
  usePublicShareContext,
} from "../../contexts/PublicShareContext";
import { useRenderModeToggle } from "../../contexts/RenderModeContext";
import { useProjectPathLinkSettings } from "../../contexts/ProjectPathLinkSettingsContext";
import { useOptionalSessionMetadata } from "../../contexts/SessionMetadataContext";
import type { CommentAnchor } from "../../lib/commentAnchors";
import { useStreamingMarkdownContext } from "../../contexts/StreamingMarkdownContext";
import {
  codeFenceRootClass,
  useCodeFenceRenderers,
} from "../../hooks/useCodeFenceRenderers";
import { useInnerHtml } from "../../hooks/useInnerHtml";
import { useInlineCodeActions } from "../../hooks/useInlineCodeActions";
import { useStreamingMarkdown } from "../../hooks/useStreamingMarkdown";
import { useI18n } from "../../i18n";
import { registerMarkdownCopySource } from "../../lib/markdownSelectionCopy";
import { annotateProjectPathLinksHtml } from "../../lib/projectPathLinks";
import { FileViewerModal } from "../FilePathLink";
import {
  LocalFileModal,
  LocalMediaModal,
  useLocalMediaInlinePreviews,
  useLocalResourceClick,
} from "../LocalMediaModal";
import { IconButton, Button } from "../ui/Button";
import { renderFixedFontMath } from "../ui/FixedFontMathToggle";
import { RenderModeGlyph } from "../ui/RenderModeGlyph";
import { useTurnImageGalleryNavigation } from "../TurnImageGallery";
import { ParagraphQuoteRail } from "../ParagraphQuoteRail";
import styles from "./TextBlock.module.css";
import { useGlossaryArtifact } from "../../contexts/GlossaryContext";
import { annotateGlossaryHtml } from "../../lib/glossary/annotateGlossaryHtml";
import { annotateIssueMentionsHtml } from "../../lib/issueMentionLinks";
import {
  IssueMentionLinksContext,
  IssueMentionText,
} from "../IssueMentionText";
import { LinkifiedText } from "../ui/LinkifiedText";
import {
  findTurnInlineImageAnchor,
  getTurnInlineImageTargetForTarget,
} from "../../lib/turnInlineMedia";
import {
  rewriteSessionAppLinksHtml,
  useSessionAppLinkRewriter,
} from "../SessionAppLinks";

const EMPTY_LOCAL_MATH_PREVIEW = { html: "", changed: false };

function htmlToText(html: string): string {
  if (typeof document === "undefined") {
    return html;
  }
  const template = document.createElement("template");
  template.innerHTML = html;
  return template.content.textContent ?? "";
}

const RenderedHtmlIsland = memo(function RenderedHtmlIsland({
  artifact,
  className,
  html,
  projectId,
  projectPathLinks,
  publicShare,
}: {
  artifact?: import("@yep-anywhere/shared").GlossaryArtifact;
  className?: string;
  html: string;
  projectId?: string;
  projectPathLinks?: readonly ProjectPathLinkTarget[];
  publicShare?: PublicShareContextValue | null;
}) {
  const rewriteHref = useSessionAppLinkRewriter();
  const issueLinks = useContext(IssueMentionLinksContext);
  const { projectPaths, mentionedDirectories } = useProjectPathLinkSettings();
  const renderedHtml = useMemo(() => {
    const withProjectPaths = annotateProjectPathLinksHtml(
      html,
      projectPathLinks,
      projectId,
      publicShare,
      { projectPaths, mentionedDirectories },
    ).html;
    const withIssues = annotateIssueMentionsHtml(withProjectPaths, issueLinks);
    const withGlossary = annotateGlossaryHtml(withIssues, artifact).html;
    return rewriteSessionAppLinksHtml(withGlossary, rewriteHref);
  }, [
    artifact,
    issueLinks,
    html,
    projectId,
    projectPathLinks,
    publicShare,
    rewriteHref,
    projectPaths,
    mentionedDirectories,
  ]);
  const innerHtml = useInnerHtml(renderedHtml);
  return (
    <div
      className={className}
      // biome-ignore lint/security/noDangerouslySetInnerHtml: server-rendered or local trusted HTML
      dangerouslySetInnerHTML={innerHtml}
    />
  );
});

interface Props {
  text: string;
  isStreaming?: boolean;
  /**
   * The provider cut this text off mid-generation to take a steering message,
   * so it stops wherever generation stopped rather than where the agent meant
   * to end.
   */
  abortedMidStream?: boolean;
  /** Pre-rendered HTML from server (for completed messages) */
  augmentHtml?: string;
  projectPathLinks?: readonly ProjectPathLinkTarget[];
  onQuoteBlock?: (anchor: CommentAnchor) => void;
  alwaysShowQuoteCircle?: boolean;
  paragraphQuoteCirclesEnabled?: boolean;
  renderItemId?: string;
  timelineAction?: ReactNode;
}

export const TextBlock = memo(function TextBlock({
  text,
  isStreaming = false,
  abortedMidStream = false,
  augmentHtml,
  projectPathLinks,
  onQuoteBlock,
  alwaysShowQuoteCircle = false,
  paragraphQuoteCirclesEnabled = true,
  renderItemId,
  timelineAction,
}: Props) {
  const { t } = useI18n();
  const inlineCode = useInlineCodeActions();
  const { projectPaths, mentionedDirectories } = useProjectPathLinkSettings();
  const [copied, setCopied] = useState(false);
  const [galleryActionHost, setGalleryActionHost] =
    useState<HTMLElement | null>(null);
  const copySourceRef = useRef<HTMLDivElement>(null);
  const textBlockRef = useRef<HTMLDivElement>(null);
  const localMathPreview = useMemo(
    () => (isStreaming ? EMPTY_LOCAL_MATH_PREVIEW : renderFixedFontMath(text)),
    [isStreaming, text],
  );
  const glossary = useGlossaryArtifact();
  const glossaryArtifact =
    glossary.state === "ready" && glossary.result?.status === "ready"
      ? glossary.result.artifact
      : undefined;
  const publicShare = usePublicShareContext();
  const issueLinks = useContext(IssueMentionLinksContext);
  const rewriteHref = useSessionAppLinkRewriter();
  const sessionMetadata = useOptionalSessionMetadata();
  const projectId =
    sessionMetadata?.projectId ?? publicShare?.projectId ?? undefined;
  const transformRenderedHtml = useCallback(
    (html: string) => {
      const withProjectPaths = annotateProjectPathLinksHtml(
        html,
        projectPathLinks,
        projectId,
        publicShare,
        { projectPaths, mentionedDirectories },
      ).html;
      const withGlossary = annotateGlossaryHtml(
        annotateIssueMentionsHtml(withProjectPaths, issueLinks),
        glossaryArtifact,
      ).html;
      return rewriteSessionAppLinksHtml(withGlossary, rewriteHref);
    },
    [
      glossaryArtifact,
      issueLinks,
      projectId,
      projectPathLinks,
      publicShare,
      rewriteHref,
      projectPaths,
      mentionedDirectories,
    ],
  );
  const serverMarkdownChanged = useMemo(() => {
    if (!augmentHtml) return false;
    return htmlToText(augmentHtml).trim() !== text.trim();
  }, [augmentHtml, text]);

  // Streaming markdown hook for server-rendered content
  const streamingMarkdown = useStreamingMarkdown({
    transformHtml: transformRenderedHtml,
  });
  const streamingContext = useStreamingMarkdownContext();

  // Track whether we're actively using streaming markdown (received at least one augment)
  const [useStreamingContent, setUseStreamingContent] = useState(false);

  // Register with context when streaming and context is available
  useEffect(() => {
    if (!isStreaming || !streamingContext) {
      // Reset streaming state when not streaming
      // (HTML is captured to markdownAugments before component remounts)
      if (!isStreaming) {
        setUseStreamingContent(false);
        streamingMarkdown.reset();
      }
      return;
    }

    // Register handlers with the context
    const unregister = streamingContext.registerStreamingHandler({
      onAugment: (augment) => {
        // Mark that we're using streaming content on first augment
        setUseStreamingContent((current) => (current ? current : true));
        streamingMarkdown.onAugment(augment);
      },
      onPending: streamingMarkdown.onPending,
      onStreamEnd: streamingMarkdown.onStreamEnd,
      captureHtml: streamingMarkdown.captureHtml,
    });

    return unregister;
  }, [
    isStreaming,
    streamingContext,
    streamingMarkdown.captureHtml,
    streamingMarkdown.onAugment,
    streamingMarkdown.onPending,
    streamingMarkdown.onStreamEnd,
    streamingMarkdown.reset,
  ]);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 3000);
    } catch (err) {
      console.error("Failed to copy text:", err);
    }
  }, [text]);

  useEffect(() => {
    const element = copySourceRef.current;
    if (!element) {
      return;
    }

    return registerMarkdownCopySource(element, text);
  }, [text]);

  const {
    modal,
    localFileModal,
    projectFileModal,
    handleClick,
    handleContextMenu,
    closeModal,
    closeLocalFileModal,
    closeProjectFileModal,
    contextMenuElement,
  } = useLocalResourceClick();
  const turnImageGallery = useTurnImageGalleryNavigation();
  useLocalMediaInlinePreviews(copySourceRef, undefined, undefined, {
    suppressAutomaticImages: turnImageGallery?.available === true,
  });
  const diagramViewer = useCodeFenceRenderers(copySourceRef);
  const handleContentClick = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      const content = copySourceRef.current;
      const galleryImageTarget =
        content && renderItemId && turnImageGallery?.available
          ? getTurnInlineImageTargetForTarget(
              content,
              renderItemId,
              event.target,
            )
          : null;
      if (
        galleryImageTarget &&
        turnImageGallery?.candidateIds.has(galleryImageTarget.id)
      ) {
        event.preventDefault();
        event.stopPropagation();
        if (galleryImageTarget.kind === "link") {
          turnImageGallery.openImage(galleryImageTarget.id);
        } else if (turnImageGallery.active) {
          turnImageGallery.collapse();
        } else {
          turnImageGallery.activate(galleryImageTarget.id);
        }
        return;
      }
      handleClick(event);
    },
    [handleClick, renderItemId, turnImageGallery],
  );

  const showStreamingContent = isStreaming && useStreamingContent;
  const canToggleRendered = serverMarkdownChanged || localMathPreview.changed;
  const { showRendered, toggleLocalMode } = useRenderModeToggle(
    canToggleRendered,
    {
      participateInGlobalMode: false,
      resetDependencies: [
        isStreaming,
        isStreaming ? "" : text,
        augmentHtml ?? "",
      ],
    },
  );

  // Always render streaming container when isStreaming so refs are attached
  // before first augment arrives. Hidden until useStreamingContent becomes true.
  const renderStreamingContainer = isStreaming;
  const paragraphLayoutKey = [showRendered, text, augmentHtml ?? ""].join("\0");
  const galleryActionTarget = turnImageGallery?.actionTarget ?? null;
  const galleryActive = turnImageGallery?.active === true;

  useEffect(() => {
    const content = copySourceRef.current;
    if (
      !content ||
      !showRendered ||
      showStreamingContent ||
      !renderItemId ||
      !turnImageGallery?.available
    ) {
      return;
    }

    const toggles = content.querySelectorAll<HTMLButtonElement>(
      "button.local-media-inline-toggle[data-media-type='image']",
    );
    for (const toggle of toggles) {
      const target = getTurnInlineImageTargetForTarget(
        content,
        renderItemId,
        toggle,
      );
      if (!target || !turnImageGallery.candidateIds.has(target.id)) {
        continue;
      }
      const label = turnImageGallery.candidateLabels.get(target.id) ?? "";
      const controlLabel = galleryActive
        ? t("turnImageGalleryCollapse")
        : t("turnImageGalleryExpandAt", { label });
      toggle.dataset.expanded = String(galleryActive);
      toggle.setAttribute("aria-expanded", String(galleryActive));
      toggle.setAttribute("aria-label", controlLabel);
      toggle.title = controlLabel;
      toggle.textContent = galleryActive ? "−" : "+";
    }
  }, [
    galleryActive,
    renderItemId,
    showRendered,
    showStreamingContent,
    t,
    turnImageGallery,
  ]);

  useLayoutEffect(() => {
    const content = copySourceRef.current;
    let host: HTMLSpanElement | null = null;
    if (
      content &&
      showRendered &&
      !showStreamingContent &&
      renderItemId &&
      galleryActionTarget?.sourceItemId === renderItemId
    ) {
      const anchor = findTurnInlineImageAnchor(
        content,
        galleryActionTarget.sourceIndex,
      );
      const group = anchor?.closest(".local-media-link-group");
      if (group) {
        host = document.createElement("span");
        host.className = "turn-image-gallery-inline-action-host";
        group.append(host);
      }
    }
    setGalleryActionHost(host);
    return () => host?.remove();
  }, [galleryActionTarget, renderItemId, showRendered, showStreamingContent]);

  return (
    <div
      ref={textBlockRef}
      className={`${styles.root} text-block text-block-assistant timeline-item${isStreaming ? " streaming" : ""}`}
      data-turn-image-source-id={renderItemId}
    >
      {timelineAction ? (
        <span className={styles.timelineAction}>{timelineAction}</span>
      ) : null}
      {onQuoteBlock ? (
        <ParagraphQuoteRail
          alwaysShowQuoteCircle={alwaysShowQuoteCircle}
          contentRef={copySourceRef}
          layoutKey={paragraphLayoutKey}
          onQuoteBlock={onQuoteBlock}
          paragraphQuoteCirclesEnabled={
            paragraphQuoteCirclesEnabled && !showStreamingContent
          }
          sourceRef={copySourceRef}
          surfaceRef={textBlockRef}
        />
      ) : null}
      <div className="text-block-actions">
        {canToggleRendered && (
          <IconButton
            variant="secondary"
            size="dense"
            className="text-block-toggle"
            onClick={toggleLocalMode}
            label={showRendered ? "Show source" : "Show rendered"}
            aria-pressed={showRendered}
          >
            <RenderModeGlyph />
          </IconButton>
        )}
        <IconButton
          variant={copied ? "success-outline" : "outline"}
          size="dense"
          className={`text-block-copy ${copied ? "copied" : ""}`}
          onClick={handleCopy}
          label={copied ? "Copied!" : "Copy markdown"}
        >
          {copied ? <CheckIcon /> : <CopyIcon />}
        </IconButton>
      </div>

      {/* biome-ignore lint/a11y/noStaticElementInteractions: click is delegated to media/link elements inside rendered markdown */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: keyboard activation remains on the descendant links/controls */}
      <div
        ref={copySourceRef}
        className={`text-block-content ${codeFenceRootClass}`}
        onClick={handleContentClick}
        onDoubleClick={inlineCode.handleDoubleClick}
        onContextMenu={(event) => {
          if (!inlineCode.handleContextMenu(event)) handleContextMenu(event);
        }}
      >
        {/* Always render streaming elements when streaming so refs are ready for augments */}
        {renderStreamingContainer && (
          <div
            style={
              showStreamingContent && showRendered
                ? undefined
                : { display: "none" }
            }
          >
            <div
              ref={streamingMarkdown.containerRef}
              className="streaming-blocks"
            />
            <span
              ref={streamingMarkdown.pendingRef}
              className="streaming-pending"
            />
          </div>
        )}

        {/* Show fallback content when not actively streaming */}
        {!showStreamingContent &&
          (showRendered && augmentHtml ? (
            <RenderedHtmlIsland
              artifact={glossaryArtifact}
              html={augmentHtml}
              projectId={projectId}
              projectPathLinks={projectPathLinks}
              publicShare={publicShare}
            />
          ) : showRendered && localMathPreview.changed ? (
            <RenderedHtmlIsland
              artifact={glossaryArtifact}
              className="text-block-local-rendered"
              html={localMathPreview.html}
              projectId={projectId}
              projectPathLinks={projectPathLinks}
              publicShare={publicShare}
            />
          ) : (
            <pre className={`${styles.source} text-block-source`}>
              <code>
                <LinkifiedText
                  text={text}
                  renderText={(plain) => <IssueMentionText text={plain} />}
                />
              </code>
            </pre>
          ))}
        {abortedMidStream && (
          <span
            className={`${styles.abortedMidStream} text-block-aborted-mid-stream`}
            title={t("textBlockAbortedMidStreamTitle")}
          >
            <span aria-hidden="true">⨯</span>
            {t("textBlockAbortedMidStream")}
          </span>
        )}
      </div>
      {galleryActionHost
        ? createPortal(
            <Button
              variant="outline"
              size="inline"
              className="turn-image-gallery-inline-action"
              aria-expanded={galleryActive}
              aria-label={t(
                galleryActive
                  ? "turnImageGalleryCollapse"
                  : "turnImageGalleryExpand",
              )}
              title={t(
                galleryActive
                  ? "turnImageGalleryCollapse"
                  : "turnImageGalleryExpand",
              )}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                if (galleryActive) {
                  turnImageGallery?.collapse();
                } else {
                  turnImageGallery?.show();
                }
              }}
            >
              <span aria-hidden="true">{galleryActive ? "−" : "+"}</span>
              {t("turnImageGalleryShow")}
            </Button>,
            galleryActionHost,
          )
        : null}

      {modal && (
        <LocalMediaModal
          path={modal.path}
          mediaType={modal.mediaType}
          onClose={closeModal}
        />
      )}

      {localFileModal && (
        <LocalFileModal
          resource={localFileModal.resource}
          initialPresentation={localFileModal.initialPresentation}
          onClose={closeLocalFileModal}
        />
      )}

      {projectFileModal && (
        <FileViewerModal
          projectId={projectFileModal.projectId}
          filePath={projectFileModal.filePath}
          lineNumber={projectFileModal.lineNumber}
          lineEnd={projectFileModal.lineEnd}
          initialPresentation={projectFileModal.initialPresentation}
          onClose={closeProjectFileModal}
        />
      )}
      {contextMenuElement}
      {inlineCode.menu}
      {diagramViewer}
    </div>
  );
});

function CopyIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="5" y="5" width="9" height="9" rx="1.5" />
      <path d="M11 5V3.5A1.5 1.5 0 0 0 9.5 2H3.5A1.5 1.5 0 0 0 2 3.5v6A1.5 1.5 0 0 0 3.5 11H5" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 8.5L6.5 12L13 4" />
    </svg>
  );
}
