import {
  type AntigravityTranscriptPosition,
  type AntigravityTurnScope,
  correlateAntigravitySubagentCalls,
  extractCreatedSubagentId,
  readAntigravitySubagentLaunches,
  readAntigravityTranscriptPosition,
  readAntigravityTranscriptPositionSync,
  readAntigravityTurnBoundary,
  readAntigravityTurnSubagentLaunches,
} from "../../sessions/antigravity-subagent-links.js";
import { AntigravitySummariesReader } from "../../sessions/antigravity-summaries.js";
import type { SDKMessage } from "../types.js";
import type { AntigravityBackground } from "./antigravity-background.js";
import { antigravitySummariesPath } from "./antigravity-runtime.js";
import type { AntigravityTranscript } from "./antigravity-transcript.js";

export interface AntigravitySubagentTrackerOptions {
  readonly sessionId: string;
  readonly storageScope: string;
  readonly modern: boolean;
  readonly signal: AbortSignal;
  readonly background: AntigravityBackground;
  readonly isInTurn: () => boolean;
  readonly publish: (message: SDKMessage, attributionModel?: string) => void;
  readonly onProviderRetentionChange?: () => void;
}

/**
 * Coordinates live Antigravity `invoke_subagent` correlation, per-prompt
 * `USER_INPUT` anchor verification/advancement, and bounded active-child
 * background retention reconciliation for one live ACP owner.
 */
export class AntigravitySubagentTracker {
  private summariesReader: AntigravitySummariesReader | undefined;
  private readonly claimedSubagentIds = new Set<string>();
  private readonly resolvedSubagentToolCalls = new Set<string>();
  private readonly pendingLookups = new Set<Promise<void>>();
  private lookupTail = Promise.resolve();

  private activeChildrenCursor = 0;
  private activeChildrenCursorVersion: string | undefined;
  private completedDiscoveryVersion: string | undefined;

  private anchorEpoch = 0;
  private baselineUserInputStep: number | undefined;
  private baselineDev: number | undefined;
  private baselineIno: number | undefined;
  private baselineSize: number | undefined;
  private submittedPromptsSinceBaseline = 0;
  private readonly trackedPromptScopes = new Set<AntigravityTurnScope>();

  constructor(private readonly opts: AntigravitySubagentTrackerOptions) {}

  private getSummariesReader(): AntigravitySummariesReader {
    this.summariesReader ??= new AntigravitySummariesReader(
      antigravitySummariesPath(this.opts.storageScope),
    );
    return this.summariesReader;
  }

  readRootSummary() {
    return this.getSummariesReader().readRow(this.opts.sessionId);
  }

  supportsRootSettlement(): boolean | undefined {
    return this.getSummariesReader().supportsRootSettlement();
  }

  /**
   * Initialize the session's `USER_INPUT` anchor and seed historical child IDs
   * on resumed sessions so an earlier turn's child can never be misattributed
   * to a new turn's call.
   */
  async initialize(resumed: boolean): Promise<void> {
    if (!this.opts.modern) return;
    this.invalidateTranscriptAnchors();
    if (resumed) {
      try {
        const priorSnap = this.getSummariesReader().readRelationshipSnapshot([
          this.opts.sessionId,
        ]);
        for (const row of priorSnap.rows) {
          if (
            typeof row.conversation_id === "string" &&
            row.conversation_id !== this.opts.sessionId
          ) {
            this.claimedSubagentIds.add(row.conversation_id);
          }
        }
      } catch {
        // Summaries DB may not exist yet.
      }
      for (const prior of await readAntigravitySubagentLaunches(
        this.opts.storageScope,
        this.opts.sessionId,
      )) {
        this.claimedSubagentIds.add(prior.childId);
      }
      const boundary = await readAntigravityTurnBoundary(
        this.opts.storageScope,
        this.opts.sessionId,
      );
      this.baselineUserInputStep = boundary?.step;
      this.baselineDev = boundary?.dev;
      this.baselineIno = boundary?.ino;
      this.baselineSize = boundary?.size;
    } else {
      this.baselineUserInputStep = -1;
      this.baselineDev = undefined;
      this.baselineIno = undefined;
      this.baselineSize = undefined;
    }
    this.submittedPromptsSinceBaseline = 0;
  }

  async onCompacted(): Promise<void> {
    if (!this.opts.modern) return;
    this.invalidateTranscriptAnchors();
    const boundary = await readAntigravityTurnBoundary(
      this.opts.storageScope,
      this.opts.sessionId,
    );
    this.baselineUserInputStep = boundary?.step;
    this.baselineDev = boundary?.dev;
    this.baselineIno = boundary?.ino;
    this.baselineSize = boundary?.size;
    this.submittedPromptsSinceBaseline = 0;
  }

  async readStartPosition(): Promise<
    AntigravityTranscriptPosition | undefined
  > {
    if (!this.opts.modern) return undefined;
    const pos = await readAntigravityTranscriptPosition(
      this.opts.storageScope,
      this.opts.sessionId,
    );
    // If a prior turn invalidated the anchor (or the transcript was replaced /
    // truncated between turns), establish a fresh boundary on the current file
    // before submitting the next turn while keeping all old scopes invalidated.
    const replacedOrTruncated =
      (this.baselineDev !== undefined &&
        pos?.dev !== undefined &&
        (this.baselineDev !== pos.dev || this.baselineIno !== pos.ino)) ||
      (this.baselineSize !== undefined &&
        pos !== undefined &&
        pos.byte < this.baselineSize);
    if (this.baselineUserInputStep === undefined || replacedOrTruncated) {
      if (replacedOrTruncated) this.invalidateTranscriptAnchors();
      const boundary = await readAntigravityTurnBoundary(
        this.opts.storageScope,
        this.opts.sessionId,
      );
      this.baselineUserInputStep = boundary?.step;
      this.baselineDev = boundary?.dev;
      this.baselineIno = boundary?.ino;
      this.baselineSize = boundary?.size;
      this.submittedPromptsSinceBaseline = 0;
      if (boundary) {
        return {
          byte: boundary.size ?? 0,
          ...(boundary.dev !== undefined ? { dev: boundary.dev } : {}),
          ...(boundary.ino !== undefined ? { ino: boundary.ino } : {}),
        };
      }
    }
    return pos;
  }

  readStartPositionSync(): AntigravityTranscriptPosition | undefined {
    if (!this.opts.modern) return undefined;
    return readAntigravityTranscriptPositionSync(
      this.opts.storageScope,
      this.opts.sessionId,
    );
  }

  /** Allocate a new bounded prompt scope for a submitted prompt or steer. */
  beginPrompt(
    promptText: string,
    startPosition?: AntigravityTranscriptPosition,
  ): AntigravityTurnScope | undefined {
    // If a pre-submission position already sees a different inode or smaller
    // file than the baseline anchor, invalidate stale scopes immediately.
    const replacedOrTruncated =
      (this.baselineDev !== undefined &&
        startPosition?.dev !== undefined &&
        (this.baselineDev !== startPosition.dev ||
          this.baselineIno !== startPosition.ino)) ||
      (this.baselineSize !== undefined &&
        startPosition !== undefined &&
        startPosition.byte < this.baselineSize);
    if (replacedOrTruncated) {
      this.invalidateTranscriptAnchors();
    }
    const anchorDev = this.baselineDev ?? startPosition?.dev;
    const anchorIno = this.baselineIno ?? startPosition?.ino;
    const anchorSize = this.baselineSize ?? startPosition?.byte;
    const scope =
      this.opts.modern && this.baselineUserInputStep !== undefined
        ? {
            afterStepExclusive: this.baselineUserInputStep,
            ...(anchorDev !== undefined ? { anchorDev } : {}),
            ...(anchorIno !== undefined ? { anchorIno } : {}),
            ...(anchorSize !== undefined ? { anchorSize } : {}),
            promptOffset: this.submittedPromptsSinceBaseline,
            promptText,
            ...(startPosition !== undefined
              ? {
                  startByte: startPosition.byte,
                  ...(startPosition.dev !== undefined
                    ? { startDev: startPosition.dev }
                    : {}),
                  ...(startPosition.ino !== undefined
                    ? { startIno: startPosition.ino }
                    : {}),
                }
              : {}),
          }
        : undefined;
    if (scope) this.trackedPromptScopes.add(scope);
    this.submittedPromptsSinceBaseline++;
    return scope;
  }

  releasePromptScopes(scopes: Iterable<AntigravityTurnScope>): void {
    for (const scope of scopes) {
      this.trackedPromptScopes.delete(scope);
    }
  }

  isCallResolved(toolCallId: string): boolean {
    return this.resolvedSubagentToolCalls.has(toolCallId);
  }

  reconcile(opts: { silent?: boolean; inTurn?: boolean } = {}): void {
    if (!this.opts.modern || this.opts.signal.aborted) return;
    const reader = this.getSummariesReader();
    const inTurn = opts.inTurn ?? this.opts.isInTurn();
    let changedState = false;
    // Always track verified active direct children from summaries DB
    // independently of whether individual tool calls could be linked
    // (for example, when two identical launches stay intentionally unlinked).
    // Skip scanning altogether once a full pass completed for the current
    // DB+WAL+data_version, even on multi-page unindexed stores.
    const discovery = reader.readActiveDirectChildren(this.opts.sessionId, {
      afterRowId: this.activeChildrenCursor,
      knownCompletedVersion: this.completedDiscoveryVersion,
    });
    if (discovery && !discovery.skippedUnchanged) {
      // Always keep verified active children discovered on this page even
      // if an unrelated WAL commit changed DB version mid-walk.
      for (const child of discovery.children) {
        if (
          this.opts.background.trackSubagent(
            child.conversationId,
            child.title ?? child.agentName ?? "Subagent",
            child.agentName,
            inTurn,
            { seenInSummaries: true, notify: !opts.silent },
          )
        ) {
          changedState = true;
        }
      }
      const versionChangedMidWalk =
        this.activeChildrenCursor > 0 &&
        this.activeChildrenCursorVersion !== undefined &&
        this.activeChildrenCursorVersion !== discovery.versionKey;
      if (discovery.truncated && discovery.nextCursorRowId !== undefined) {
        this.activeChildrenCursor = discovery.nextCursorRowId;
        if (versionChangedMidWalk) {
          // Mixed-version walk: keep advancing pages so later pages are
          // never starved, while preventing completion claim at walk end.
          this.activeChildrenCursorVersion = "";
        } else if (this.activeChildrenCursorVersion === undefined) {
          this.activeChildrenCursorVersion = discovery.versionKey;
        }
        this.completedDiscoveryVersion = undefined;
      } else {
        this.activeChildrenCursor = 0;
        // Only mark discovery complete for `discovery.versionKey` when the
        // entire walk ran on that single DB version.
        this.completedDiscoveryVersion = versionChangedMidWalk
          ? undefined
          : discovery.versionKey;
        this.activeChildrenCursorVersion = undefined;
      }
    }
    if (this.opts.background.hasActiveSubagents()) {
      const statuses = reader.readChildStatuses(
        this.opts.background.activeSubagentIds(),
      );
      if (
        this.opts.background.reconcileSubagents(statuses, {
          expectedParentId: this.opts.sessionId,
          notify: !opts.silent,
        })
      ) {
        changedState = true;
      }
    }
    if (changedState && opts.silent) {
      queueMicrotask(() => {
        if (!this.opts.signal.aborted) this.opts.onProviderRetentionChange?.();
      });
    }
  }

  private isScopeCurrent(scope: AntigravityTurnScope, epoch: number): boolean {
    return (
      epoch === this.anchorEpoch &&
      scope.promptOffset >= 0 &&
      this.trackedPromptScopes.has(scope)
    );
  }

  private invalidateTranscriptAnchors(): void {
    this.anchorEpoch++;
    this.baselineUserInputStep = undefined;
    this.baselineDev = undefined;
    this.baselineIno = undefined;
    this.baselineSize = undefined;
    this.submittedPromptsSinceBaseline = 0;
    for (const scope of this.trackedPromptScopes) {
      scope.verifiedUserStep = undefined;
      scope.promptOffset = -1;
    }
    this.trackedPromptScopes.clear();
  }

  private advanceVerifiedAnchor(
    scope: AntigravityTurnScope,
    verifiedStep: number,
    verifiedDev?: number,
    verifiedIno?: number,
    verifiedSize?: number,
  ): void {
    if (scope.promptOffset < 0 || !this.trackedPromptScopes.has(scope)) return;
    scope.verifiedUserStep = verifiedStep;
    if (verifiedDev !== undefined && verifiedIno !== undefined) {
      scope.anchorDev = verifiedDev;
      scope.anchorIno = verifiedIno;
    }
    if (verifiedSize !== undefined) {
      scope.anchorSize =
        scope.anchorSize !== undefined
          ? Math.max(scope.anchorSize, verifiedSize)
          : verifiedSize;
    }
    if (
      this.baselineUserInputStep !== undefined &&
      scope.afterStepExclusive === this.baselineUserInputStep
    ) {
      const oldBaseline = this.baselineUserInputStep;
      const delta = scope.promptOffset + 1;
      this.baselineUserInputStep = verifiedStep;
      if (verifiedDev !== undefined && verifiedIno !== undefined) {
        this.baselineDev = verifiedDev;
        this.baselineIno = verifiedIno;
      }
      if (verifiedSize !== undefined) {
        this.baselineSize =
          this.baselineSize !== undefined
            ? Math.max(this.baselineSize, verifiedSize)
            : verifiedSize;
      }
      this.submittedPromptsSinceBaseline = Math.max(
        0,
        this.submittedPromptsSinceBaseline - delta,
      );
      for (const other of this.trackedPromptScopes) {
        if (
          other !== scope &&
          other.verifiedUserStep === undefined &&
          other.afterStepExclusive === oldBaseline &&
          other.promptOffset > scope.promptOffset
        ) {
          other.afterStepExclusive = verifiedStep;
          if (verifiedDev !== undefined && verifiedIno !== undefined) {
            other.anchorDev = verifiedDev;
            other.anchorIno = verifiedIno;
          }
          if (verifiedSize !== undefined) {
            other.anchorSize =
              other.anchorSize !== undefined
                ? Math.max(other.anchorSize, verifiedSize)
                : verifiedSize;
          }
          other.promptOffset -= delta;
        }
      }
    }
  }

  private enqueue(work: () => Promise<void>): void {
    const task = this.lookupTail
      .then(work, work)
      .catch(() => {})
      .finally(() => {
        this.pendingLookups.delete(task);
      });
    this.lookupTail = task;
    this.pendingLookups.add(task);
  }

  schedulePromptAnchorVerification(promptScope: AntigravityTurnScope): void {
    const epoch = this.anchorEpoch;
    if (
      !this.opts.modern ||
      this.opts.signal.aborted ||
      promptScope.verifiedUserStep !== undefined ||
      !this.isScopeCurrent(promptScope, epoch)
    ) {
      return;
    }
    this.enqueue(async () => {
      if (
        this.opts.signal.aborted ||
        promptScope.verifiedUserStep !== undefined ||
        !this.isScopeCurrent(promptScope, epoch)
      ) {
        return;
      }
      const result = await readAntigravityTurnSubagentLaunches(
        this.opts.storageScope,
        this.opts.sessionId,
        promptScope,
      );
      if (
        this.opts.signal.aborted ||
        !this.isScopeCurrent(promptScope, epoch)
      ) {
        return;
      }
      if (result.replaced) {
        this.invalidateTranscriptAnchors();
        return;
      }
      if (result.verifiedUserStep !== undefined) {
        this.advanceVerifiedAnchor(
          promptScope,
          result.verifiedUserStep,
          result.verifiedDev,
          result.verifiedIno,
          result.verifiedSize,
        );
      }
    });
  }

  resolveCall(
    targetTranscript: AntigravityTranscript,
    toolCallId: string,
    attributionModel: string | undefined,
    inTurn: boolean,
    emitted: readonly SDKMessage[],
    turnScope?: AntigravityTurnScope,
    scopeCallIds?: ReadonlySet<string>,
  ): void {
    const call = targetTranscript.getSubagentCall(toolCallId);
    if (!this.opts.modern || !call || call.failed || !call.completed) return;
    const epoch = this.anchorEpoch;
    // Serialize live subagent lookups so parallel invoke_subagent calls in
    // one turn never race over `claimedSubagentIds`.
    this.enqueue(async () => {
      if (
        this.opts.signal.aborted ||
        call.failed ||
        !call.completed ||
        this.resolvedSubagentToolCalls.has(toolCallId)
      ) {
        return;
      }
      let childId: string | undefined;
      for (const msg of emitted) {
        const blocks = Array.isArray(msg.message?.content)
          ? msg.message.content
          : [];
        for (const block of blocks) {
          if (
            block &&
            typeof block === "object" &&
            block.type === "tool_result" &&
            block.tool_use_id === toolCallId &&
            !block.is_error
          ) {
            childId = extractCreatedSubagentId(block.content);
          }
        }
      }
      const reader = this.getSummariesReader();
      const isAllowedLiveChild = (
        candidateId: string,
        pairedWithInvokeSubagent: boolean,
      ) => {
        if (this.claimedSubagentIds.has(candidateId)) return false;
        const row = reader.readRow(candidateId);
        if (row) return row.parentConversationId === this.opts.sessionId;
        // agy flushes conversation_summaries.db asynchronously after spawning
        // a subagent, so accept a freshly paired invoke_subagent result while
        // the summary row is still pending.
        return pairedWithInvokeSubagent;
      };
      if (childId && !isAllowedLiveChild(childId, true)) {
        childId = undefined;
      }
      if (
        !childId &&
        inTurn &&
        turnScope !== undefined &&
        this.isScopeCurrent(turnScope, epoch)
      ) {
        // Only inspect paired launches strictly inside this prompt's
        // verified `(turnUserStep, nextUserStep)` interval so neither a
        // late-flushing earlier turn nor a subsequent steer can bleed in.
        const turnResult = await readAntigravityTurnSubagentLaunches(
          this.opts.storageScope,
          this.opts.sessionId,
          turnScope,
        );
        if (this.opts.signal.aborted) return;
        if (!this.isScopeCurrent(turnScope, epoch)) {
          this.reconcile({ inTurn });
          return;
        }
        if (turnResult.replaced) {
          this.invalidateTranscriptAnchors();
          this.reconcile({ inTurn });
          return;
        }
        if (turnResult.verifiedUserStep !== undefined) {
          this.advanceVerifiedAnchor(
            turnScope,
            turnResult.verifiedUserStep,
            turnResult.verifiedDev,
            turnResult.verifiedIno,
            turnResult.verifiedSize,
          );
        }
        const launches = turnResult.launches;
        const allowedUnclaimed = new Set<string>();
        for (const launch of launches) {
          if (!launch.pairedWithInvokeSubagent) continue;
          const row = reader.readRow(launch.childId);
          if (row && row.parentConversationId !== this.opts.sessionId) continue;
          // Track every verified/provisional child launched in this prompt
          // for background retention even if identical calls remain unlinked.
          this.opts.background.trackSubagent(
            launch.childId,
            launch.role ?? launch.typeName ?? "Subagent",
            launch.typeName,
            inTurn,
            { seenInSummaries: row !== undefined },
          );
          if (!this.claimedSubagentIds.has(launch.childId)) {
            allowedUnclaimed.add(launch.childId);
          }
        }
        // Include every unresolved non-failed call belonging to this prompt
        // scope so parallel identical launches stay ambiguous and unlinked.
        const unresolvedCalls = targetTranscript
          .listSubagentCalls()
          .filter(
            (entry) =>
              !entry.failed &&
              !this.resolvedSubagentToolCalls.has(entry.toolUseId) &&
              (!scopeCallIds || scopeCallIds.has(entry.toolUseId)),
          );
        const correlated = correlateAntigravitySubagentCalls(
          unresolvedCalls,
          launches,
          allowedUnclaimed,
        );
        childId = correlated.get(toolCallId)?.childId;
      }
      if (
        !childId ||
        this.opts.signal.aborted ||
        this.claimedSubagentIds.has(childId)
      ) {
        this.reconcile({ inTurn });
        return;
      }
      const verifiedRow = reader.readRow(childId);
      if (
        verifiedRow &&
        verifiedRow.parentConversationId !== this.opts.sessionId
      )
        return;
      this.claimedSubagentIds.add(childId);
      this.resolvedSubagentToolCalls.add(toolCallId);
      const enriched = targetTranscript.enrichSubagentResult(
        toolCallId,
        childId,
        call.role,
      );
      if (enriched) {
        this.opts.publish(
          inTurn ? enriched : { ...enriched, _passiveProviderUpdate: true },
          attributionModel,
        );
      }
      this.opts.background.trackSubagent(
        childId,
        call.role ?? call.typeName ?? "Subagent",
        call.typeName,
        inTurn,
        { seenInSummaries: verifiedRow !== undefined },
      );
      this.reconcile({ inTurn });
    });
  }

  async drainPending(): Promise<void> {
    if (this.pendingLookups.size > 0) {
      await Promise.allSettled([...this.pendingLookups]);
    }
  }

  close(): void {
    this.summariesReader?.close();
    this.summariesReader = undefined;
  }
}
