/**
 * DAG (Directed Acyclic Graph) utilities for JSONL conversation parsing.
 *
 * Claude Code JSONL files are not linear logs - they form a DAG where each
 * message has a `parentUuid` pointing to its predecessor. This enables:
 * - Conversation branching (forking from any point)
 * - Dead branches (abandoned paths remain in file but are unreachable)
 * - Clean recovery (resumption picks any node as continuation point)
 */

/** Raw content block from JSONL */
interface RawContentBlock {
  type: string;
  id?: string;
  tool_use_id?: string;
}

/** Raw JSONL message format */
export interface RawSessionMessage {
  type: string;
  message?: {
    content: string | RawContentBlock[];
  };
  uuid?: string;
  parentUuid?: string | null;
}

/** A node in the conversation DAG */
export interface DagNode {
  uuid: string;
  parentUuid: string | null;
  /** Original position in JSONL file (0-indexed line number) */
  lineIndex: number;
  raw: RawSessionMessage;
}

/** Result of building and traversing the DAG */
export interface DagResult {
  /** Messages on the active branch, in conversation order (root to tip) */
  activeBranch: DagNode[];
  /** UUIDs of all messages on the active branch (for quick lookup) */
  activeBranchUuids: Set<string>;
  /** The tip node (most recent message with no children), or null if empty */
  tip: DagNode | null;
}

/**
 * Build a DAG from raw JSONL messages and find the active conversation branch.
 *
 * Algorithm:
 * 1. Build maps: uuid → node, parentUuid → children
 * 2. Find tips: messages with no children
 * 3. Select active tip: latest by lineIndex if multiple tips
 * 4. Walk from tip to root via parentUuid chain
 * 5. Return active branch in conversation order (root to tip)
 *
 * Messages without uuid (like queue-operation, file-history-snapshot) are skipped.
 */
export function buildDag(messages: RawSessionMessage[]): DagResult {
  const nodeMap = new Map<string, DagNode>();
  const childrenMap = new Map<string | null, string[]>();

  // Build node map and children map
  for (let lineIndex = 0; lineIndex < messages.length; lineIndex++) {
    const raw = messages[lineIndex];
    if (!raw) continue;

    const uuid = raw.uuid;
    if (!uuid) continue; // Skip messages without uuid (internal types)

    const node: DagNode = {
      uuid,
      parentUuid: raw.parentUuid ?? null,
      lineIndex,
      raw,
    };
    nodeMap.set(uuid, node);

    // Track children for each parent
    const parentKey = raw.parentUuid ?? null;
    const children = childrenMap.get(parentKey);
    if (children) {
      children.push(uuid);
    } else {
      childrenMap.set(parentKey, [uuid]);
    }
  }

  // Find tips (nodes with no children)
  const tips: DagNode[] = [];
  for (const node of nodeMap.values()) {
    const children = childrenMap.get(node.uuid);
    if (!children || children.length === 0) {
      tips.push(node);
    }
  }

  // Select the "active" tip (latest by lineIndex)
  const tip =
    tips.length > 0
      ? tips.reduce((latest, node) =>
          node.lineIndex > latest.lineIndex ? node : latest,
        )
      : null;

  // Walk from tip to root, collecting the active branch
  const activeBranch: DagNode[] = [];
  const activeBranchUuids = new Set<string>();
  const visited = new Set<string>(); // Cycle detection (defensive)

  let current: DagNode | null = tip;
  while (current && !visited.has(current.uuid)) {
    visited.add(current.uuid);
    activeBranch.unshift(current); // Prepend to maintain root→tip order
    activeBranchUuids.add(current.uuid);

    if (current.parentUuid) {
      current = nodeMap.get(current.parentUuid) ?? null;
    } else {
      current = null;
    }
  }

  return { activeBranch, activeBranchUuids, tip };
}

/**
 * Find orphaned tool_use blocks on the active branch.
 *
 * A tool_use is orphaned if its ID doesn't have a matching tool_result
 * on the active branch. This happens when a process is killed while
 * waiting for tool approval or during tool execution.
 */
export function findOrphanedToolUses(activeBranch: DagNode[]): Set<string> {
  const toolUseIds = new Set<string>();
  const toolResultIds = new Set<string>();

  for (const node of activeBranch) {
    const content = node.raw.message?.content;
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      if (block.type === "tool_use" && block.id) {
        toolUseIds.add(block.id);
      }
      if (block.type === "tool_result" && block.tool_use_id) {
        toolResultIds.add(block.tool_use_id);
      }
    }
  }

  // Orphaned = tool_use without matching tool_result
  const orphaned = new Set<string>();
  for (const id of toolUseIds) {
    if (!toolResultIds.has(id)) {
      orphaned.add(id);
    }
  }

  return orphaned;
}
