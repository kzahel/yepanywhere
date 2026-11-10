import {
  createParseState,
  type ClaudeSummaryParseState,
  type CompactClaudeSummaryNode,
} from "./claude-summary.js";

/** Keep only the witnesses used by summary selectors, in their original order. */
export function condenseClaudeSummary(
  nodes: readonly CompactClaudeSummaryNode[],
): CompactClaudeSummaryNode[] {
  const keep = new Set<CompactClaudeSummaryNode>();
  const last = (
    predicate: (node: CompactClaudeSummaryNode) => boolean,
    end = nodes.length,
  ) => {
    for (let i = end - 1; i >= 0; i--) {
      const node = nodes[i]!;
      if (predicate(node)) {
        keep.add(node);
        return i;
      }
    }
    return -1;
  };
  last((n) => n.type === "assistant" && !!n.model && n.model !== "<synthetic>");
  last((n) => n.type === "assistant" && !!n.usage && total(n) > 0);
  last((n) => n.type === "assistant" && !!n.usage);
  const compact = last((n) => !!n.compactionPreTokens);
  if (compact >= 0)
    last((n) => n.type === "assistant" && !!n.usage && total(n) > 0, compact);
  last(
    (n) =>
      !!n.awaySummaryExcerpt ||
      (n.type === "assistant" && !!n.assistantExcerpt),
  );
  last((n) => n.type === "assistant" && !!n.assistantToolName);
  last((n) => !!n.humanTurn && Number.isFinite(Date.parse(n.timestamp)));
  last(
    (n) =>
      (n.type === "assistant" || n.type === "user") &&
      Number.isFinite(Date.parse(n.timestamp)),
  );
  return nodes.filter((n) => keep.has(n));
}
function total(n: CompactClaudeSummaryNode) {
  return (
    (n.usage?.input_tokens ?? 0) +
    (n.usage?.cache_read_input_tokens ?? 0) +
    (n.usage?.cache_creation_input_tokens ?? 0)
  );
}
export function projectedClaudeSummary(
  source: ClaudeSummaryParseState,
  witnesses: readonly CompactClaudeSummaryNode[],
  count: number,
): ClaudeSummaryParseState {
  const state = createParseState();
  state.firstTimestamp = source.firstTimestamp;
  state.firstUserTitleContent = source.firstUserTitleContent;
  state.firstUserTitleCaptured = source.firstUserTitleCaptured;
  state.metrics = { ...source.metrics };
  state.projectedMessageCount = count;
  let parent: string | null = null;
  for (const node of witnesses) {
    state.nodeMap.set(node.uuid, {
      ...node,
      parentUuid: parent,
      logicalParentUuid: undefined,
    });
    if (parent) state.childrenMap.set(parent, [node.uuid]);
    parent = node.uuid;
  }
  return state;
}
