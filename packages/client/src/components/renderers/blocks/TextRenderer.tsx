import textStyles from "../../blocks/TextBlock.module.css";
import { FileViewerModal } from "../../FilePathLink";
import {
  LocalFileModal,
  LocalMediaModal,
  useLocalResourceClick,
} from "../../LocalMediaModal";
import type { ContentBlock, ContentRenderer } from "../types";
import { useSessionAppLinksHtml } from "../../SessionAppLinks";
import { InnerHtml } from "../../ui/InnerHtml";
import { useInlineCodeActions } from "../../../hooks/useInlineCodeActions";

interface TextBlock extends ContentBlock {
  type: "text";
  text: string;
  /** Server-rendered HTML (if available) */
  _renderedHtml?: string;
}

/**
 * Text renderer - displays text content with markdown rendering
 */
function TextRendererComponent({ block }: { block: TextBlock }) {
  const inlineCode = useInlineCodeActions();
  const renderedHtml = useSessionAppLinksHtml(block._renderedHtml ?? "");
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

  // Prefer server-rendered HTML if available
  if (block._renderedHtml) {
    return (
      // biome-ignore lint/a11y/noStaticElementInteractions: click is delegated to local resource links inside rendered markdown
      // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard activation remains on descendant links/controls
      <div
        className={textStyles.textBlock}
        data-text-block
        onClick={handleClick}
        onDoubleClick={inlineCode.handleDoubleClick}
        onContextMenu={(event) => {
          if (!inlineCode.handleContextMenu(event)) handleContextMenu(event);
        }}
      >
        {/* Server-rendered markdown. */}
        <InnerHtml trustedHtml={renderedHtml} />
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
      </div>
    );
  }

  // Fallback to plain text when server-rendered HTML is not available
  return (
    <div className={textStyles.textBlock} data-text-block>
      <pre style={{ whiteSpace: "pre-wrap", fontFamily: "inherit" }}>
        {block.text}
      </pre>
    </div>
  );
}

export const textRenderer: ContentRenderer<TextBlock> = {
  type: "text",
  render(block, _context) {
    return <TextRendererComponent block={block as TextBlock} />;
  },
  getSummary(block) {
    const text = (block as TextBlock).text;
    return text.length > 100 ? `${text.slice(0, 97)}...` : text;
  },
};
