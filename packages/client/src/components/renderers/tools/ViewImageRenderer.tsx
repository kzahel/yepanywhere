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
import { ButtonBase } from "../../ui/Button";

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
  onClick,
  onContextMenu,
  projectPath,
}: {
  path: string;
  className: string;
  onClick: (e: React.MouseEvent) => void;
  onContextMenu: (e: React.MouseEvent<Element>) => void;
  projectPath?: string | null;
}) {
  const displayPath = makeDisplayPath(path, projectPath);
  return (
    <ButtonBase
      className={className}
      onClick={onClick}
      onContextMenu={onContextMenu}
    >
      {getFileName(displayPath)}
      <span className="file-line-count-inline">(image)</span>
    </ButtonBase>
  );
}

/**
 * Shared component: clickable filename + lazy-loading modal.
 */
function ViewImageClickable({
  path,
  buttonClass,
  stopPropagation,
  projectPath,
}: {
  path: string;
  buttonClass: string;
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
      <div className="read-image-result">
        <ViewImageClickable
          path={path}
          buttonClass="file-link-button"
          projectPath={context.projectPath}
        />
      </div>
    );
  },

  renderToolResult(_result, _isError, context, input) {
    if (!input) return null;
    const { path } = input;
    return (
      <div className="read-image-result">
        <ViewImageClickable
          path={path}
          buttonClass="file-link-button"
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
        buttonClass="file-link-inline"
        projectPath={context.projectPath}
        stopPropagation
      />
    );
  },
});
