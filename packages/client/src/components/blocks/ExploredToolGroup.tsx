import { type CSSProperties, memo, useId, useRef, useState } from "react";
import { useRememberedDisclosureState } from "../../contexts/RememberedDisclosureStateContext";
import { useOptionalSessionMetadata } from "../../contexts/SessionMetadataContext";
import { useI18n } from "../../i18n";
import { MESSAGE_STALE_THRESHOLD_MS } from "../../lib/messageAge";
import {
  getExplorationKind,
  getExploredEntryFallbackSummary,
  getLatestRenderItemsTimestampMs,
} from "../../lib/sessionDetail/renderSelectors";
import {
  estimateExplorationGroupHeightPx,
  getExplorationEntryDisplayLabel,
  isCanonicalExplorationEntry,
} from "../../lib/sessionDetail/explorationPresentation";
import type {
  ExplorationEntry,
  ExplorationParent,
  ExplorationProjection,
} from "../../lib/sessionDetail/explorationProjection";
import { makeDisplayPath } from "../../lib/text";
import type { ToolCallItem } from "@yep-anywhere/shared/transcript/items";
import { MessageAge } from "../MessageAge";
import {
  collectExploredImages,
  ExploredImageStrip,
} from "./ExploredImageStrip";
import { toolRegistry } from "../renderers/tools";
import type { RenderContext } from "../renderers/types";
import { SessionFilePathLink } from "../SessionFilePathLink";
import { getToolSummary } from "../tools/summaries";
import { ToolCallRow } from "./ToolCallRow";

interface Props {
  id: string;
  projection: ExplorationProjection;
  sessionProvider?: string;
  staleNowMs?: number;
}

function statusGlyph(status: ToolCallItem["status"]): string {
  switch (status) {
    case "pending":
      return ".";
    case "error":
      return "!";
    case "aborted":
      return "x";
    case "incomplete":
      return "?";
    case "complete":
      return "";
  }
}

function renderEntrySummary(
  item: ToolCallItem,
  sessionProvider: string | undefined,
  projectPath: string | null | undefined,
) {
  const kind = getExplorationKind(item.toolName);
  const result = item.toolResult?.structured ?? item.toolResult?.content;
  const isComplete = item.status === "complete";
  const isError = item.toolResult?.isError ?? item.status === "error";
  const context: RenderContext = {
    isStreaming: item.status === "pending",
    theme: "dark",
    toolUseId: item.id,
    provider: sessionProvider,
    projectPath,
  };

  // Only a renderer that understood this record can supply the one line an
  // entry occupies. When the payload misses its display contract the renderer
  // answers with its raw fallback instead — a heading, a notice and
  // pretty-printed JSON — which does not belong in a single-line cell. The
  // prepared kind is that judgement, per record rather than per tool, so an
  // unrecognized envelope takes the group's own compact fallback below.
  const displayKind = toolRegistry.prepare(item.toolName, {
    input: item.toolInput,
    result,
    status: item.status,
    isError: item.toolResult?.isError,
  }).kind;
  if (
    (kind === "read" || kind === "search") &&
    isComplete &&
    displayKind === "rich" &&
    toolRegistry.hasInteractiveSummary(item.toolName)
  ) {
    const summary = toolRegistry.renderInteractiveSummary(
      item.toolName,
      item.toolInput,
      result,
      isError,
      context,
    );
    if (summary) {
      return summary;
    }
  }

  if (isComplete && (kind === "search" || kind === "list")) {
    return getToolSummary(
      item.toolName,
      item.toolInput,
      item.toolResult,
      item.status,
      { projectPath },
    );
  }

  return getExploredEntryFallbackSummary(item, projectPath);
}

function projectedEntryRenderId(parent: ExplorationParent): string | undefined {
  return parent.entries.length === 1 ? parent.item.id : undefined;
}

function parentNeedsRawDetails(parent: ExplorationParent): boolean {
  return (
    parent.entries.length > 1 ||
    getExplorationKind(parent.item.toolName) === null
  );
}

export const ExploredToolGroup = memo(function ExploredToolGroup({
  id,
  projection,
  sessionProvider,
  staleNowMs,
}: Props) {
  const [expanded, setExpanded] = useRememberedDisclosureState(
    projection.disclosureOwnerId,
    "explored-group",
    true,
  );
  const [expandedParentIds, setExpandedParentIds] = useState<
    ReadonlySet<string>
  >(() => new Set());
  const accessibilityId = useId();
  const { t } = useI18n();
  const sessionMetadata = useOptionalSessionMetadata();
  const projectPath = sessionMetadata?.projectPath ?? null;
  const staticAgeNowMsRef = useRef(Date.now());
  const items = projection.parents.map((parent) => parent.item);
  const timestampMs = getLatestRenderItemsTimestampMs(items);
  const hasTimestamp = timestampMs !== null;
  const isLatestVisibleTimestamp = hasTimestamp && staleNowMs !== undefined;
  const ageNowMs = isLatestVisibleTimestamp
    ? (staleNowMs ?? Date.now())
    : staticAgeNowMsRef.current;
  const showAgeByDefault =
    isLatestVisibleTimestamp &&
    ageNowMs !== null &&
    timestampMs !== null &&
    ageNowMs - timestampMs >= MESSAGE_STALE_THRESHOLD_MS;
  const isPending = projection.parents.some(
    (parent) => parent.item.status === "pending",
  );
  const title = isPending
    ? t("explorationTitlePending")
    : t("explorationTitleComplete");
  const entryCount = projection.entries.length;
  const countLabel = t(
    entryCount === 1 ? "explorationItemCountOne" : "explorationItemCountMany",
    { count: entryCount },
  );
  const toggleLabel = expanded
    ? t("explorationCollapse")
    : t("explorationExpand");
  const rawParents = projection.parents.filter(parentNeedsRawDetails);
  const exploredImages = collectExploredImages(projection.parents);
  const bodyId = `${accessibilityId}-body`;
  const intrinsicHeight = estimateExplorationGroupHeightPx({
    detailRowCount: rawParents.length,
    entryCount,
    expanded,
  });
  const rowStyle: CSSProperties & {
    "--explored-group-intrinsic-height": string;
  } = {
    "--explored-group-intrinsic-height": `${intrinsicHeight}px`,
  };
  const toggleParentDetails = (parentId: string) => {
    setExpandedParentIds((current) => {
      const next = new Set(current);
      if (next.has(parentId)) {
        next.delete(parentId);
      } else {
        next.add(parentId);
      }
      return next;
    });
  };
  return (
    <div
      className={[
        "message-render-row",
        "explored-message-row",
        hasTimestamp ? "has-message-age" : "",
        showAgeByDefault ? "is-message-age-visible" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      data-render-type="explored"
      data-render-id={id}
      style={rowStyle}
    >
      <div className="message-render-content">
        <div className="explored-group timeline-item">
          <button
            type="button"
            className="timeline-dot-btn"
            onClick={() => setExpanded((value) => !value)}
            aria-label={toggleLabel}
            aria-controls={bodyId}
            aria-expanded={expanded}
            title={toggleLabel}
          />
          <button
            type="button"
            className="explored-group-header"
            onClick={() => setExpanded((value) => !value)}
            aria-controls={bodyId}
            aria-expanded={expanded}
          >
            <span className="explored-group-title">{title}</span>
            <span className="explored-group-count">{countLabel}</span>
            <span className="expand-chevron" aria-hidden="true">
              {expanded ? "▾" : "▸"}
            </span>
          </button>
          {expanded && (
            <div className="explored-group-body" id={bodyId} role="list">
              {projection.parents.flatMap((parent) =>
                parent.entries.map((entry) => (
                  <div
                    key={entry.id}
                    className={`explored-entry status-${parent.item.status}`}
                    data-render-id={projectedEntryRenderId(parent)}
                    data-exploration-entry-id={entry.id}
                    data-exploration-kind={entry.kind}
                    data-exploration-parent-id={entry.parentId}
                    data-render-type={parent.item.type}
                    role="listitem"
                  >
                    <span className="explored-entry-status" aria-hidden="true">
                      {statusGlyph(parent.item.status)}
                    </span>
                    <span className="explored-entry-tool">
                      {getExplorationEntryDisplayLabel(parent, entry)}
                    </span>
                    {/* A block container, not an inline one: a renderer that
                        crashes mid-render still answers with its raw
                        fallback block, and a block inside an inline box
                        paints outside the row instead of being clipped by
                        it. */}
                    <div className="explored-entry-summary">
                      {isCanonicalExplorationEntry(parent, entry)
                        ? renderEntrySummary(
                            parent.item,
                            sessionProvider,
                            projectPath,
                          )
                        : renderProjectedEntrySummary(entry, projectPath, t)}
                    </div>
                  </div>
                )),
              )}
              {rawParents.map((parent, parentIndex) => {
                const parentExpanded = expandedParentIds.has(parent.item.id);
                const detailsLabel = parentExpanded
                  ? t("explorationHideCommandDetails")
                  : t("explorationShowCommandDetails");
                const rawDetailsId = `${accessibilityId}-raw-${parentIndex}`;
                return (
                  <div
                    key={`details-${parent.item.id}`}
                    className="explored-parent-details"
                  >
                    <button
                      type="button"
                      className="explored-parent-details-toggle"
                      onClick={() => toggleParentDetails(parent.item.id)}
                      aria-controls={rawDetailsId}
                      aria-expanded={parentExpanded}
                    >
                      <span className="expand-chevron" aria-hidden="true">
                        {parentExpanded ? "▾" : "▸"}
                      </span>
                      {detailsLabel}
                    </button>
                    {parentExpanded && (
                      <div className="explored-parent-raw" id={rawDetailsId}>
                        <ToolCallRow
                          id={parent.item.id}
                          toolName={parent.item.toolName}
                          toolInput={parent.item.toolInput}
                          toolResult={parent.item.toolResult}
                          status={parent.item.status}
                          sessionProvider={sessionProvider}
                        />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
          {/* Outside the entry list: that list is a short scrolling box, and
              thumbnails inside it would push every filename out of view. */}
          {expanded && exploredImages.length > 0 && (
            <ExploredImageStrip images={exploredImages} />
          )}
        </div>
      </div>
      <MessageAge timestampMs={timestampMs} nowMs={ageNowMs ?? Date.now()} />
    </div>
  );
});

type Translate = ReturnType<typeof useI18n>["t"];

function renderProjectedEntrySummary(
  entry: ExplorationEntry,
  projectPath: string | null | undefined,
  t: Translate,
) {
  if (entry.kind === "read") {
    const sourcePath = entry.absolutePath ?? entry.path ?? entry.name ?? "";
    const displaySource = entry.path ?? sourcePath;
    const displayPath = displaySource
      ? makeDisplayPath(displaySource, projectPath)
      : (entry.name ?? "file");
    const range =
      entry.startLine !== undefined && entry.endLine !== undefined
        ? t("explorationLineRange", {
            start: entry.startLine,
            end: entry.endLine,
          })
        : entry.startLine !== undefined
          ? t("explorationLine", { line: entry.startLine })
          : "";
    return (
      <span
        className="explored-entry-semantic-summary"
        title={[displayPath, range].filter(Boolean).join(" · ")}
      >
        <span className="explored-entry-path">
          <SessionFilePathLink
            displayPath={displayPath}
            filePath={sourcePath}
            lineEnd={entry.endLine}
            lineNumber={entry.startLine}
            showLineSuffix={false}
          />
        </span>
        {range && (
          <span className="explored-entry-range">
            <SessionFilePathLink
              displayPath={range}
              filePath={sourcePath}
              lineEnd={entry.endLine}
              lineNumber={entry.startLine}
              showCopyButton={false}
              showLineSuffix={false}
              viewMode="range"
            />
          </span>
        )}
      </span>
    );
  }

  if (entry.kind === "search") {
    const scope = entry.path ? makeDisplayPath(entry.path, projectPath) : "";
    return (
      <span
        className="explored-entry-semantic-summary"
        title={[entry.query, scope].filter(Boolean).join(" · ")}
      >
        <span className="explored-entry-query">{entry.query}</span>
        {scope && (
          <span className="explored-entry-scope">
            <SessionFilePathLink
              displayPath={scope}
              filePath={entry.path ?? scope}
              showCopyButton={false}
              showLineSuffix={false}
            />
          </span>
        )}
      </span>
    );
  }

  const path = entry.path ? makeDisplayPath(entry.path, projectPath) : ".";
  return (
    <span className="explored-entry-semantic-summary" title={path}>
      <span className="explored-entry-path">{path}</span>
    </span>
  );
}
