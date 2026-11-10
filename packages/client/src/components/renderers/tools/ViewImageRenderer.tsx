import pathStyles from "../../FilePathLink.module.css";
import readStyles from "./ReadRenderer.module.css";
import { toolDisplayContracts } from "./toolDisplayContracts";
import { defineTool } from "./defineTool";
import { useCallback, useState } from "react";
import { useCurrentSourceRuntime } from "../../../contexts/SourceRuntimeContext";
import { getPathBasename, makeDisplayPath } from "../../../lib/text";
import { useImageResourceActions } from "../../ImageResourceActions";
import {
  fetchLocalMediaBlob,
  LocalMediaModal,
  useLocalFileScope,
} from "../../LocalMediaModal";
import { Button } from "../../ui/Button";

function getFileName(path: string): string {
  return getPathBasename(path);
}

/**
 * Clickable filename button that opens a modal to view the image.
 * Does NOT fetch anything until the modal is opened.
 */
function ViewImageButton({
  path,
  className,
  inline,
  onClick,
  onContextMenu,
  projectPath,
}: {
  path: string;
  className: string | undefined;
  inline?: boolean;
  onClick: (e: React.MouseEvent) => void;
  onContextMenu: (e: React.MouseEvent<Element>) => void;
  projectPath?: string | null;
}) {
  const displayPath = makeDisplayPath(path, projectPath);
  return (
    <Button
      mono
      textFlow="wrap"
      variant={inline ? "link" : "outline"}
      size="small"
      className={className}
      onClick={onClick}
      onContextMenu={onContextMenu}
    >
      {getFileName(displayPath)}{" "}
      <span
        className={pathStyles.fileLineCountInline}
        data-file-line-count-inline
      >
        (image)
      </span>
    </Button>
  );
}

/**
 * Shared component: clickable filename + lazy-loading modal.
 */
function ViewImageClickable({
  path,
  buttonClass,
  inline,
  stopPropagation,
  projectPath,
}: {
  path: string;
  buttonClass: string | undefined;
  inline?: boolean;
  stopPropagation?: boolean;
  projectPath?: string | null;
}) {
  const [showModal, setShowModal] = useState(false);
  const transport = useCurrentSourceRuntime().transport;
  const fileScope = useLocalFileScope();
  const loadBlob = useCallback(
    () => fetchLocalMediaBlob(path, undefined, "modal", transport, fileScope),
    [path, transport, fileScope],
  );
  const openViewer = useCallback(() => setShowModal(true), []);
  const imageActions = useImageResourceActions({
    fileName: getFileName(path),
    filePath: path,
    loadBlob,
    onOpen: openViewer,
    projectPath,
  });

  return (
    <>
      <ViewImageButton
        path={path}
        className={buttonClass}
        inline={inline}
        onContextMenu={imageActions.handleContextMenu}
        projectPath={projectPath}
        onClick={(e) => {
          if (stopPropagation) e.stopPropagation();
          openViewer();
        }}
      />
      {showModal && (
        <LocalMediaModal
          path={path}
          mediaType="image"
          onClose={() => setShowModal(false)}
        />
      )}
      {imageActions.contextMenuElement}
    </>
  );
}

export const viewImageRenderer = defineTool(toolDisplayContracts.ViewImage, {
  tool: "ViewImage",
  displayName: "View Image",

  renderToolUse(input, context) {
    const { path } = input;
    return (
      <div className={readStyles.readImageResult} data-read-image-result>
        <ViewImageClickable
          path={path}
          buttonClass={pathStyles.fileLinkButton}
          projectPath={context.projectPath}
        />
      </div>
    );
  },

  renderToolResult(_result, _isError, context, input) {
    if (!input) return null;
    const { path } = input;
    return (
      <div className={readStyles.readImageResult} data-read-image-result>
        <ViewImageClickable
          path={path}
          buttonClass={pathStyles.fileLinkButton}
          projectPath={context.projectPath}
        />
      </div>
    );
  },

  getUseSummary(input, context) {
    const path = input?.path ?? "";
    return getFileName(makeDisplayPath(path, context?.projectPath));
  },

  getResultSummary(_result, isError) {
    return isError ? "Error" : "Image loaded";
  },

  renderInteractiveSummary(input, _result, _isError, context) {
    const { path } = input;
    return (
      <ViewImageClickable
        path={path}
        buttonClass={pathStyles.fileLinkInline}
        inline
        projectPath={context.projectPath}
        stopPropagation
      />
    );
  },
});
