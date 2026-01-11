/**
 * DAG (Directed Acyclic Graph) utilities for JSONL conversation parsing.
 *
 * Claude Code JSONL files are not linear logs - they form a DAG where each
 * message has a `parentUuid` pointing to its predecessor. This enables:
 * - Conversation branching (forking from any point)
 * - Dead branches (abandoned paths remain in file but are unreachable)
 * - Clean recovery (resumption picks any node as continuation point)
 */

import {
  type ClaudeSessionEntry,
  getLogicalParentUuid,
  getMessageContent,
} from "@yep-anywhere/shared";

/** A node in the conversation DAG */
export interface DagNode {
  uuid: string;
  parentUuid: string | null;
  /** Original position in JSONL file (0-indexed line number) */
  lineIndex: number;
  raw: ClaudeSessionEntry;
}

/** Info about an alternate branch (not selected as active) */
export interface AlternateBranch {
  /** The tip node of this branch */
  tipUuid: string;
  /** Number of messages from root to tip */
  length: number;
  /** Type of the tip message (user/assistant) */
  tipType: string;
}

/** Result of building and traversing the DAG */
export interface DagResult {
  /** Messages on the active branch, in conversation order (root to tip) */
  activeBranch: DagNode[];
  /** UUIDs of all messages on the active branch (for quick lookup) */
  activeBranchUuids: Set<string>;
  /** The tip node (most recent message with no children), or null if empty */
  tip: DagNode | null;
  /** Whether the session has multiple branches (forks detected) */
  hasBranches: boolean;
  /** Info about alternate branches not selected as active */
  alternateBranches: AlternateBranch[];
}

/**
 * Walk from a tip to root, returning the branch length.
 * Also handles compact_boundary nodes by following logicalParentUuid.
 */
function walkBranchLength(
  tipUuid: string,
  nodeMap: Map<string, DagNode>,
): number {
  let length = 0;
  let currentUuid: string | null = tipUuid;
  const visited = new Set<string>();

  while (currentUuid && !visited.has(currentUuid)) {
    visited.add(currentUuid);
    const node = nodeMap.get(currentUuid);
    if (!node) break;

    length++;

    // Determine next node: use parentUuid, or logicalParentUuid for compact_boundary
    let nextUuid = node.parentUuid;
    const logicalParent = getLogicalParentUuid(node.raw);
    if (!nextUuid && logicalParent) {
      nextUuid = logicalParent;
    }

    currentUuid = nextUuid;
  }

  return length;
}

/**
 * Build a DAG from raw JSONL messages and find the active conversation branch.
 *
 * Algorithm:
 * 1. Build maps: uuid → node, parentUuid → children
 * 2. Find tips: messages with no children
 * 3. Select active tip: longest branch wins (tiebreaker: latest lineIndex)
 * 4. Walk from tip to root via parentUuid chain
 * 5. Return active branch in conversation order (root to tip)
 *
 * Messages without uuid (like queue-operation, file-history-snapshot) are skipped.
 */
export function buildDag(messages: ClaudeSessionEntry[]): DagResult {
  const nodeMap = new Map<string, DagNode>();
  const childrenMap = new Map<string | null, string[]>();

  // Build node map and children map
  for (let lineIndex = 0; lineIndex < messages.length; lineIndex++) {
    const raw = messages[lineIndex];
    if (!raw) continue;

    // Access uuid - only some entry types have it
    const uuid = "uuid" in raw ? raw.uuid : undefined;
    if (!uuid) continue; // Skip messages without uuid (internal types)

    // Access parentUuid - only some entry types have it
    const parentUuid = "parentUuid" in raw ? (raw.parentUuid ?? null) : null;

    const node: DagNode = {
      uuid,
      parentUuid,
      lineIndex,
      raw,
    };
    nodeMap.set(uuid, node);

    // Track children for each parent
    const children = childrenMap.get(parentUuid);
    if (children) {
      children.push(uuid);
    } else {
      childrenMap.set(parentUuid, [uuid]);
    }
  }

  // Find tips (nodes with no children) and calculate branch lengths
  const tipsWithLength: Array<{ node: DagNode; length: number }> = [];
  for (const node of nodeMap.values()) {
    const children = childrenMap.get(node.uuid);
    if (!children || children.length === 0) {
      const length = walkBranchLength(node.uuid, nodeMap);
      tipsWithLength.push({ node, length });
    }
  }

  // Select the "active" tip: longest branch wins, tiebreaker is latest lineIndex
  // This ensures we show the most complete conversation, not just the most recent append
  const selectedTip =
    tipsWithLength.length > 0
      ? tipsWithLength.reduce((best, current) => {
          if (current.length > best.length) return current;
          if (
            current.length === best.length &&
            current.node.lineIndex > best.node.lineIndex
          ) {
            return current;
          }
          return best;
        })
      : null;

  const tip = selectedTip?.node ?? null;
  const hasBranches = tipsWithLength.length > 1;

  // Build alternate branches info (all tips except the selected one)
  const alternateBranches: AlternateBranch[] = hasBranches
    ? tipsWithLength
        .filter((t) => t.node.uuid !== tip?.uuid)
        .map((t) => ({
          tipUuid: t.node.uuid,
          length: t.length,
          tipType: t.node.raw.type,
        }))
        .sort((a, b) => b.length - a.length) // Sort by length descending
    : [];

  // Walk from tip to root, collecting the active branch
  const activeBranch: DagNode[] = [];
  const activeBranchUuids = new Set<string>();
  const visited = new Set<string>(); // Cycle detection (defensive)

  let current: DagNode | null = tip;
  while (current && !visited.has(current.uuid)) {
    visited.add(current.uuid);
    activeBranch.unshift(current); // Prepend to maintain root→tip order
    activeBranchUuids.add(current.uuid);

    // Determine next node: use parentUuid, or logicalParentUuid for compact_boundary
    let nextUuid = current.parentUuid;
    const logicalParent = getLogicalParentUuid(current.raw);
    if (!nextUuid && logicalParent) {
      // Follow the logical parent chain across the compaction boundary
      nextUuid = logicalParent;
    }

    current = nextUuid ? (nodeMap.get(nextUuid) ?? null) : null;
  }

  return {
    activeBranch,
    activeBranchUuids,
    tip,
    hasBranches,
    alternateBranches,
  };
}

/**
 * Build a Set of all tool_result IDs from raw messages.
 *
 * This scans ALL messages (not just active branch) because parallel tool calls
 * can result in tool_results being on sibling branches. For example, when Claude
 * makes two parallel Read calls, the JSONL structure can be:
 *
 *   tool_use #1 (Read file A)
 *   ├── tool_use #2 (Read file B)
 *   │   └── tool_result for file B → continues to conversation tip
 *   └── tool_result for file A (sibling branch, no children)
 *
 * The tool_result for file A is valid but ends up on a "dead branch" because
 * the active path goes through tool_use #2. By collecting all tool_result IDs
 * from the entire file, we correctly identify that the tool_use was completed.
 */
export function collectAllToolResultIds(
  messages: ClaudeSessionEntry[],
): Set<string> {
  const toolResultIds = new Set<string>();

  for (const msg of messages) {
    const content = getMessageContent(msg);
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      if (typeof block === "string") continue;

      if (
        block.type === "tool_result" &&
        "tool_use_id" in block &&
        block.tool_use_id
      ) {
        toolResultIds.add(block.tool_use_id);
      }
    }
  }

  return toolResultIds;
}

/**
 * Find orphaned tool_use blocks on the active branch.
 *
 * A tool_use is orphaned if its ID doesn't have a matching tool_result
 * anywhere in the session. This happens when a process is killed while
 * waiting for tool approval or during tool execution.
 *
 * @param activeBranch - The active conversation branch (tool_uses to check)
 * @param allToolResultIds - Pre-built Set of all tool_result IDs from the entire session
 */
export function findOrphanedToolUses(
  activeBranch: DagNode[],
  allToolResultIds: Set<string>,
): Set<string> {
  const toolUseIds = new Set<string>();

  // Collect tool_use IDs from active branch
  for (const node of activeBranch) {
    const content = getMessageContent(node.raw);
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      // Skip string content blocks (can appear in user messages)
      if (typeof block === "string") continue;

      if (block.type === "tool_use" && "id" in block && block.id) {
        toolUseIds.add(block.id);
      }
    }
  }

  // Orphaned = tool_use without matching tool_result anywhere in session
  const orphaned = new Set<string>();
  for (const id of toolUseIds) {
    if (!allToolResultIds.has(id)) {
      orphaned.add(id);
    }
  }

  return orphaned;
}
