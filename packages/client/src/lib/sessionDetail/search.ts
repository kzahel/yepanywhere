import { getLatestMessageTimestampMs } from "../messageAge";
import { parseUserPrompt } from "../parseUserPrompt";
import { isLegacyCodexSetupText } from "@yep-anywhere/shared/transcript/codexLegacySetup";
import type { ContentBlock } from "../../types";
import type {
  RenderItem,
  ToolCallItem,
  UserPromptItem,
} from "@yep-anywhere/shared/transcript/items";
import {
  type AssistantRenderSegment,
  buildAssistantRenderSegments,
  getExploredEntrySearchPreview,
  getExploredEntrySearchText,
} from "./exploration";
import {
  getExplorationEntryDisplayLabel,
  getExplorationEntrySearchText,
  getExplorationEntrySummaryText,
  isCanonicalExplorationEntry,
} from "./explorationPresentation";
import {
  getLatestRenderItemsTimestampMs,
  type RenderTurnGroup,
} from "./renderItems";

export interface RenderNavAnchor {
  id: string;
  preview: string;
  searchText?: string;
  targetId?: string;
  timestampMs?: number | null;
}

export interface CorrectablePrompt {
  id: string;
  content: string;
}

export interface SearchMatchProjectionInput<
  TAnchor extends RenderNavAnchor = RenderNavAnchor,
> {
  anchors: readonly TAnchor[];
  caseSensitive?: boolean;
  query: string;
  searchReady: boolean;
}

export interface SearchMatchProjection<
  TAnchor extends RenderNavAnchor = RenderNavAnchor,
> {
  matchIds: Set<string>;
  matchTargetIds: Set<string>;
  matches: TAnchor[];
  previewsById: Map<string, string>;
}

export interface SearchSelectionProjectionInput<
  TAnchor extends RenderNavAnchor = RenderNavAnchor,
> {
  anchors: readonly TAnchor[];
  previewsById: ReadonlyMap<string, string>;
  searchReady: boolean;
  selectedId?: string | null;
}

export interface SearchSelectionProjection<
  TAnchor extends RenderNavAnchor = RenderNavAnchor,
> {
  selectedAnchor: TAnchor | null;
  selectedPreview: string | null;
  selectedTargetId: string | null;
}

export type RenderSearchScope = "user" | "all" | "full";

export interface ActiveSearchAnchorsInput<
  TAnchor extends RenderNavAnchor = RenderNavAnchor,
> {
  allAnchors: readonly TAnchor[];
  fullAnchors: readonly TAnchor[];
  scope: RenderSearchScope;
  userAnchors: readonly TAnchor[];
}

export interface SearchPanelProjectionInput<
  TAnchor extends RenderNavAnchor = RenderNavAnchor,
> {
  matches: readonly TAnchor[];
  scope: RenderSearchScope;
  searchReady: boolean;
  selectedId?: string | null;
}

export interface SearchPanelProjection {
  countLabel: string;
  scopeAriaLabel: string;
  scopeLabel: string;
  shortcutKeys: string;
}

export interface SearchNavigatorStateProjectionInput {
  caseSensitive?: boolean;
  matchIds: ReadonlySet<string>;
  preview: string | null;
  previewsById: ReadonlyMap<string, string>;
  query: string;
  searchReady: boolean;
  selectedAnchorId?: string | null;
}

export interface SearchNavigatorStateProjection {
  activeId: string | null;
  caseSensitive?: boolean;
  matchIds: ReadonlySet<string>;
  preview: string | null;
  previewsById: ReadonlyMap<string, string>;
  query: string;
}

export interface SearchVisibleTurnGroupsInput<
  TTurnGroup extends RenderTurnGroup = RenderTurnGroup,
> {
  matchIds: ReadonlySet<string>;
  matchTargetIds?: ReadonlySet<string>;
  scope: RenderSearchScope;
  searchReady: boolean;
  turnGroups: readonly TTurnGroup[];
}

export function getPromptTextForCorrection(
  content: string | ContentBlock[],
): string {
  const rawText =
    typeof content === "string"
      ? content
      : content
          .filter(
            (block): block is ContentBlock & { type: "text"; text: string } =>
              block.type === "text" && typeof block.text === "string",
          )
          .map((block) => block.text)
          .join("\n");
  return parseUserPrompt(rawText).text.trim();
}

function getUserTurnPreview(content: string | ContentBlock[]): string {
  const text = getPromptTextForCorrection(content).replace(/\s+/g, " ").trim();
  return getSearchPreviewFallback(text);
}

export function getSearchPreviewFallback(text: string): string {
  const compactText = text.replace(/\s+/g, " ").trim();
  if (compactText.length <= 180) {
    return compactText;
  }
  return `${compactText.slice(0, 177).trimEnd()}...`;
}

export function normalizeSearchText(
  text: string,
  caseSensitive = false,
): string {
  const compactText = text.replace(/\s+/g, " ").trim();
  return caseSensitive ? compactText : compactText.toLowerCase();
}

export function hasSearchableUserTurn(items: readonly RenderItem[]): boolean {
  return items.some((item) => getSearchableUserTurnPreview(item));
}

export function getSearchReady({
  active,
  minQueryLength = 2,
  query,
}: {
  active: boolean;
  minQueryLength?: number;
  query: string;
}): boolean {
  return active && normalizeSearchText(query).length >= minQueryLength;
}

export function getActiveSearchAnchors<
  TAnchor extends RenderNavAnchor = RenderNavAnchor,
>({
  allAnchors,
  fullAnchors,
  scope,
  userAnchors,
}: ActiveSearchAnchorsInput<TAnchor>): readonly TAnchor[] {
  if (scope === "full") {
    return fullAnchors;
  }
  return scope === "all" ? allAnchors : userAnchors;
}

export function getSearchScopeLabel(scope: RenderSearchScope): string {
  if (scope === "full") {
    return "Full session";
  }
  return scope === "all" ? "All turns" : "User turns";
}

export function getSearchScopeAriaLabel(scope: RenderSearchScope): string {
  if (scope === "full") {
    return "Reverse search full session";
  }
  return scope === "all"
    ? "Reverse search all turns"
    : "Reverse search user turns";
}

export function getSearchScopeKeys(scope: RenderSearchScope): string {
  if (scope === "full") {
    return "Ctrl+Alt+S";
  }
  return scope === "all" ? "Ctrl+S" : "Ctrl+R/Ctrl+Alt+R";
}

export function getSearchPanelProjection<
  TAnchor extends RenderNavAnchor = RenderNavAnchor,
>({
  matches,
  scope,
  searchReady,
  selectedId,
}: SearchPanelProjectionInput<TAnchor>): SearchPanelProjection {
  const selectedIndex = selectedId
    ? matches.findIndex((anchor) => anchor.id === selectedId)
    : -1;
  return {
    countLabel: !searchReady
      ? "2+ chars"
      : matches.length > 0
        ? `${Math.max(1, selectedIndex + 1)}/${matches.length}`
        : "0/0",
    scopeAriaLabel: getSearchScopeAriaLabel(scope),
    scopeLabel: getSearchScopeLabel(scope),
    shortcutKeys: getSearchScopeKeys(scope),
  };
}

export function getSearchNavigatorStateProjection({
  caseSensitive,
  matchIds,
  preview,
  previewsById,
  query,
  searchReady,
  selectedAnchorId,
}: SearchNavigatorStateProjectionInput): SearchNavigatorStateProjection | null {
  return searchReady
    ? {
        activeId: selectedAnchorId ?? null,
        caseSensitive,
        matchIds,
        preview,
        previewsById,
        query,
      }
    : null;
}

export function buildSearchPreview(
  text: string,
  query: string,
  caseSensitive = false,
): string {
  const compactText = text.replace(/\s+/g, " ").trim();
  const normalizedText = normalizeSearchText(compactText, caseSensitive);
  const normalizedQuery = normalizeSearchText(query, caseSensitive);
  const fallback =
    compactText.length > 420
      ? `${compactText.slice(0, 417).trimEnd()}...`
      : compactText;
  if (!normalizedQuery) {
    return fallback;
  }

  const matchIndexes: number[] = [];
  let searchFrom = 0;
  while (matchIndexes.length < 3) {
    const index = normalizedText.indexOf(normalizedQuery, searchFrom);
    if (index === -1) break;
    matchIndexes.push(index);
    searchFrom = index + normalizedQuery.length;
  }
  if (matchIndexes.length === 0) {
    return fallback;
  }

  return matchIndexes
    .map((index) => {
      const start = Math.max(0, index - 96);
      const end = Math.min(
        compactText.length,
        index + normalizedQuery.length + 180,
      );
      const prefix = start > 0 ? "..." : "";
      const suffix = end < compactText.length ? "..." : "";
      return `${prefix}${compactText.slice(start, end).trim()}${suffix}`;
    })
    .join(" ... ");
}

export function getSearchMatchProjection<TAnchor extends RenderNavAnchor>({
  anchors,
  caseSensitive = false,
  query,
  searchReady,
}: SearchMatchProjectionInput<TAnchor>): SearchMatchProjection<TAnchor> {
  const matches: TAnchor[] = [];
  const matchIds = new Set<string>();
  const matchTargetIds = new Set<string>();
  const previewsById = new Map<string, string>();

  if (searchReady) {
    const normalizedQuery = normalizeSearchText(query, caseSensitive);
    for (const anchor of anchors) {
      const searchableText = anchor.searchText ?? anchor.preview;
      if (
        normalizeSearchText(searchableText, caseSensitive).includes(
          normalizedQuery,
        )
      ) {
        matches.push(anchor);
        matchIds.add(anchor.id);
        matchTargetIds.add(anchor.targetId ?? anchor.id);
        previewsById.set(
          anchor.id,
          buildSearchPreview(searchableText, query, caseSensitive),
        );
      }
    }
  }

  return {
    matchIds,
    matchTargetIds,
    matches,
    previewsById,
  };
}

export function getSearchSelectionProjection<TAnchor extends RenderNavAnchor>({
  anchors,
  previewsById,
  searchReady,
  selectedId,
}: SearchSelectionProjectionInput<TAnchor>): SearchSelectionProjection<TAnchor> {
  const selectedAnchor =
    selectedId && searchReady
      ? (anchors.find((anchor) => anchor.id === selectedId) ?? null)
      : null;
  const selectedPreview =
    selectedAnchor && searchReady
      ? (previewsById.get(selectedAnchor.id) ?? null)
      : null;

  return {
    selectedAnchor,
    selectedPreview,
    selectedTargetId: selectedAnchor?.targetId ?? selectedAnchor?.id ?? null,
  };
}

export function isSessionSetupText(
  text: string,
  sources: UserPromptItem["sourceMessages"] = [],
): boolean {
  return isLegacyCodexSetupText(text, sources);
}

export function getSearchableUserTurnPreview(item: RenderItem): string | null {
  if (item.type !== "user_prompt" || item.isSubagent) {
    return null;
  }
  const content = getPromptTextForCorrection(item.content);
  if (isSessionSetupText(content, item.sourceMessages)) return null;
  const preview = getUserTurnPreview(item.content);
  return preview || null;
}

export function selectLatestCorrectablePrompt(
  items: readonly RenderItem[],
): CorrectablePrompt | null {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item?.type !== "user_prompt" || item.isSubagent) {
      continue;
    }
    const content = getPromptTextForCorrection(item.content);
    if (!content || isSessionSetupText(content, item.sourceMessages)) {
      continue;
    }
    return { id: item.id, content };
  }
  return null;
}

function stringifySearchValue(value: unknown): string {
  const seen = new WeakSet<object>();

  const stringify = (nestedValue: unknown): string => {
    if (nestedValue === null || nestedValue === undefined) {
      return "";
    }
    if (typeof nestedValue === "string") {
      return nestedValue;
    }
    if (
      typeof nestedValue === "number" ||
      typeof nestedValue === "boolean" ||
      typeof nestedValue === "bigint"
    ) {
      return String(nestedValue);
    }
    if (typeof nestedValue !== "object") {
      return String(nestedValue);
    }
    if (seen.has(nestedValue)) {
      return "[Circular]";
    }
    seen.add(nestedValue);
    if (Array.isArray(nestedValue)) {
      return nestedValue.map(stringify).filter(Boolean).join("\n");
    }
    return Object.entries(nestedValue as Record<string, unknown>)
      .map(([key, entryValue]) => {
        const text = stringify(entryValue);
        return text ? `${key}: ${text}` : key;
      })
      .filter(Boolean)
      .join("\n");
  };

  return stringify(value);
}

export function getContentBlocksText(content: string | ContentBlock[]): string {
  if (typeof content === "string") {
    return content;
  }
  return content
    .map((block) => {
      if (block.type === "text" && typeof block.text === "string") {
        return block.text;
      }
      if (block.type === "thinking" && typeof block.thinking === "string") {
        return block.thinking;
      }
      if (block.type === "tool_use") {
        return [block.name, block.id, stringifySearchValue(block.input)].join(
          "\n",
        );
      }
      if (block.type === "tool_result") {
        return [
          block.tool_use_id,
          typeof block.content === "string"
            ? block.content
            : stringifySearchValue(block.content),
        ].join("\n");
      }
      return stringifySearchValue(block);
    })
    .filter(Boolean)
    .join("\n");
}

export function joinSearchParts(
  parts: Array<string | null | undefined>,
): string {
  return parts
    .map((part) => part?.trim() ?? "")
    .filter(Boolean)
    .join("\n");
}

export function getToolSearchText(item: RenderItem): string {
  if (item.type !== "tool_call") {
    return "";
  }
  return joinSearchParts([
    item.toolName,
    item.id,
    item.status,
    stringifySearchValue(item.toolInput),
    item.toolResult?.isError ? "error" : null,
    item.toolResult?.content,
    stringifySearchValue(item.toolResult?.structured),
  ]);
}

export function getToolSearchPreview(item: ToolCallItem): string {
  const input = stringifySearchValue(item.toolInput).replace(/\s+/g, " ");
  const detail = input ? `: ${getSearchPreviewFallback(input)}` : "";
  return `${item.toolName}${detail}`;
}

export function getSystemSearchText(item: RenderItem): string {
  if (item.type !== "system" || item.subtype === "history_search_gap") {
    return "";
  }
  return joinSearchParts([
    item.content,
    ...(item.details ?? []).map(getContentBlocksText),
  ]);
}

function getUserSearchAnchor(item: UserPromptItem): RenderNavAnchor | null {
  const text = getPromptTextForCorrection(item.content);
  if (isSessionSetupText(text, item.sourceMessages)) return null;
  const preview = getSearchPreviewFallback(text);
  if (!preview) {
    return null;
  }
  return {
    id: item.id,
    preview,
    searchText: text,
    timestampMs: getLatestMessageTimestampMs(item.sourceMessages),
  };
}

export function getUserTurnNavAnchors(
  items: readonly RenderItem[],
): RenderNavAnchor[] {
  const anchors: RenderNavAnchor[] = [];
  for (const item of items) {
    const preview = getSearchableUserTurnPreview(item);
    if (!preview) {
      continue;
    }
    anchors.push({
      id: item.id,
      preview,
      timestampMs: getLatestMessageTimestampMs(item.sourceMessages),
    });
  }
  return anchors;
}

export function getUserTurnSearchAnchors(
  items: readonly RenderItem[],
): RenderNavAnchor[] {
  const anchors: RenderNavAnchor[] = [];
  for (const item of items) {
    if (item.type !== "user_prompt" || item.isSubagent) {
      continue;
    }
    const anchor = getUserSearchAnchor(item);
    if (anchor) {
      anchors.push(anchor);
    }
  }
  return anchors;
}

export function getAllTurnSearchAnchors(
  items: readonly RenderItem[],
): RenderNavAnchor[] {
  const anchors: RenderNavAnchor[] = [];
  for (const item of items) {
    if (item.type === "user_prompt") {
      const anchor = getUserSearchAnchor(item);
      if (anchor) {
        anchors.push(anchor);
      }
      continue;
    }
    if (item.type === "text") {
      const preview = getSearchPreviewFallback(item.text);
      if (preview) {
        anchors.push({
          id: item.id,
          preview,
          searchText: item.text,
          timestampMs: getLatestMessageTimestampMs(item.sourceMessages),
        });
      }
      continue;
    }
    if (item.type === "system") {
      const systemSearchText = getSystemSearchText(item);
      const preview = getSearchPreviewFallback(systemSearchText);
      if (preview) {
        anchors.push({
          id: item.id,
          preview,
          searchText: systemSearchText,
          timestampMs: getLatestMessageTimestampMs(item.sourceMessages),
        });
      }
    }
  }
  return anchors;
}

export function getFullSessionSearchAnchorForItem(
  item: RenderItem,
): RenderNavAnchor | null {
  switch (item.type) {
    case "user_prompt": {
      const text = getPromptTextForCorrection(item.content);
      const preview = getSearchPreviewFallback(text);
      return preview
        ? {
            id: item.id,
            preview,
            searchText: text,
            timestampMs: getLatestMessageTimestampMs(item.sourceMessages),
          }
        : null;
    }
    case "session_setup": {
      const text = joinSearchParts([
        item.title,
        ...item.prompts.map(getContentBlocksText),
      ]);
      return text
        ? {
            id: item.id,
            preview: item.title || getSearchPreviewFallback(text),
            searchText: text,
            timestampMs: getLatestMessageTimestampMs(item.sourceMessages),
          }
        : null;
    }
    case "transcript_display_object": {
      const object = item.object;
      if (object.kind === "bang-command") {
        const searchText = joinSearchParts([
          object.command,
          object.stdoutPreview,
          object.status,
          object.error,
        ]);
        return searchText
          ? {
              id: item.id,
              preview: `!!${object.command}`,
              searchText,
              timestampMs: getLatestMessageTimestampMs(item.sourceMessages),
            }
          : null;
      }
      const searchText = joinSearchParts([
        object.title,
        object.status,
        object.error,
      ]);
      return searchText
        ? {
            id: item.id,
            preview:
              object.title ??
              getSearchPreviewFallback(object.error ?? object.status),
            searchText,
            timestampMs: getLatestMessageTimestampMs(item.sourceMessages),
          }
        : null;
    }
    case "text":
      return item.text
        ? {
            id: item.id,
            preview: getSearchPreviewFallback(item.text),
            searchText: item.text,
            timestampMs: getLatestMessageTimestampMs(item.sourceMessages),
          }
        : null;
    case "thinking":
      return item.thinking
        ? {
            id: item.id,
            preview: `Thinking: ${getSearchPreviewFallback(item.thinking)}`,
            searchText: joinSearchParts(["Thinking", item.thinking]),
            timestampMs: getLatestMessageTimestampMs(item.sourceMessages),
          }
        : null;
    case "system": {
      const systemSearchText = getSystemSearchText(item);
      return systemSearchText
        ? {
            id: item.id,
            preview: getSearchPreviewFallback(systemSearchText),
            searchText: systemSearchText,
            timestampMs: getLatestMessageTimestampMs(item.sourceMessages),
          }
        : null;
    }
    case "task_notification": {
      const searchText = item.summary ?? item.raw;
      return searchText
        ? {
            id: item.id,
            preview: getSearchPreviewFallback(searchText),
            searchText,
            timestampMs: getLatestMessageTimestampMs(item.sourceMessages),
          }
        : null;
    }
    case "tool_call": {
      const searchText = getToolSearchText(item);
      return searchText
        ? {
            id: item.id,
            preview: getToolSearchPreview(item),
            searchText,
            timestampMs: getLatestMessageTimestampMs(item.sourceMessages),
          }
        : null;
    }
    case "conversation_activity": {
      const searchText = joinSearchParts(
        item.thinkingPreviews?.map((preview) => preview.thinking) ?? [],
      );
      return searchText
        ? {
            id: item.id,
            preview: `Thinking: ${getSearchPreviewFallback(searchText)}`,
            searchText: joinSearchParts(["Thinking", searchText]),
            timestampMs: getLatestMessageTimestampMs(item.sourceMessages),
          }
        : null;
    }
  }
}

export function getFullSessionSearchAnchorsForSegment(
  segment: AssistantRenderSegment,
): RenderNavAnchor[] {
  if (segment.kind === "item") {
    const anchor = getFullSessionSearchAnchorForItem(segment.item);
    return anchor ? [anchor] : [];
  }

  const entryCount = segment.projection.entries.length;
  const rawMultiParentSearchText = segment.projection.parents.flatMap(
    (parent) => {
      if (parent.entries.length < 2) return [];
      const parentAnchor = getFullSessionSearchAnchorForItem(parent.item);
      return parentAnchor?.searchText ? [parentAnchor.searchText] : [];
    },
  );
  const anchors: RenderNavAnchor[] = [
    {
      id: segment.id,
      preview: `Explored: ${entryCount} ${entryCount === 1 ? "item" : "items"}`,
      searchText: joinSearchParts([
        "Explored",
        "Exploring",
        `${entryCount} ${entryCount === 1 ? "item" : "items"}`,
        ...rawMultiParentSearchText,
      ]),
      timestampMs: getLatestRenderItemsTimestampMs(segment.items),
    },
  ];

  for (const parent of segment.projection.parents) {
    const parentAnchor = getFullSessionSearchAnchorForItem(parent.item);
    for (const entry of parent.entries) {
      const canonical = isCanonicalExplorationEntry(parent, entry);
      const entrySummary = getExplorationEntrySummaryText(entry);
      const exploredPreview = canonical
        ? getExploredEntrySearchPreview(parent.item)
        : `${getExplorationEntryDisplayLabel(parent, entry)}: ${entrySummary}`;
      const exploredSearchText = canonical
        ? getExploredEntrySearchText(parent.item)
        : getExplorationEntrySearchText(parent, entry);
      const includeParentSearchText = parent.entries.length === 1;
      anchors.push({
        id: canonical
          ? `${segment.id}:${parent.item.id}`
          : `${segment.id}:entry:${entry.id}`,
        preview: `Explored / ${exploredPreview}`,
        searchText: joinSearchParts([
          exploredSearchText,
          includeParentSearchText ? parentAnchor?.searchText : undefined,
        ]),
        targetId: segment.id,
        timestampMs:
          parentAnchor?.timestampMs ??
          getLatestMessageTimestampMs(parent.item.sourceMessages),
      });
    }
  }

  return anchors;
}

export function getFullSessionSearchAnchors(
  turnGroups: readonly RenderTurnGroup[],
): RenderNavAnchor[] {
  const anchors: RenderNavAnchor[] = [];
  for (const group of turnGroups) {
    if (group.isUserPrompt) {
      const item = group.items[0];
      const anchor = item ? getFullSessionSearchAnchorForItem(item) : null;
      if (anchor) {
        anchors.push(anchor);
      }
      continue;
    }

    for (const segment of buildAssistantRenderSegments(group.items)) {
      anchors.push(...getFullSessionSearchAnchorsForSegment(segment));
    }
  }
  return anchors;
}

function turnGroupHasFullSessionMatch(
  group: RenderTurnGroup,
  matchTargetIds: ReadonlySet<string>,
): boolean {
  if (group.items.some((item) => matchTargetIds.has(item.id))) {
    return true;
  }

  return buildAssistantRenderSegments(group.items).some((segment) =>
    segment.kind === "explored"
      ? matchTargetIds.has(segment.id) ||
        segment.items.some((item) => matchTargetIds.has(item.id))
      : matchTargetIds.has(segment.item.id),
  );
}

export function getSearchVisibleTurnGroups<TTurnGroup extends RenderTurnGroup>({
  matchIds,
  matchTargetIds = matchIds,
  scope,
  searchReady,
  turnGroups,
}: SearchVisibleTurnGroupsInput<TTurnGroup>): readonly TTurnGroup[] {
  if (!searchReady || matchIds.size === 0) {
    return turnGroups;
  }

  let currentUserTurnId: string | null = null;
  const visibleGroups: TTurnGroup[] = [];
  for (const group of turnGroups) {
    const firstItem = group.items[0];
    if (group.isUserPrompt && firstItem?.type === "user_prompt") {
      currentUserTurnId = firstItem.id;
    }

    const isVisible =
      scope === "full"
        ? turnGroupHasFullSessionMatch(group, matchTargetIds)
        : scope === "all"
          ? group.items.some((item) => matchIds.has(item.id)) ||
            (!!currentUserTurnId && matchIds.has(currentUserTurnId))
          : !!currentUserTurnId && matchIds.has(currentUserTurnId);

    if (isVisible) {
      visibleGroups.push(group);
    }
  }
  return visibleGroups;
}
