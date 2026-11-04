import styles from "./defineTool.module.css";
import { ToolOutputText } from "../../ToolOutputText";
import type { ReactNode } from "react";
import type { z } from "zod";
import type { ToolCallItem } from "@yep-anywhere/shared/transcript/items";
import type { RenderContext } from "../types";
import {
  RawToolDisplay,
  ToolDisplayBoundary,
} from "../../blocks/ToolDisplayBoundary";
import type { ToolSummaryContext } from "./types";

import {
  prepareDisplay,
  type DisplayContract,
  type DisplayRecord,
  type DisplayStatus,
} from "./prepareDisplay";
import { toolDisplayDiagnostics } from "./displayDiagnostics";
export type { DisplayRecord, DisplayStatus } from "./prepareDisplay";
export { toolDisplayDiagnostics } from "./displayDiagnostics";

type ToolDisplayContext = Omit<RenderContext, "toolUseResult" | "getToolUse">;

export interface PreparedToolDisplay {
  readonly kind: "rich" | "partial" | "raw";
  readonly reason?: "input" | "result";
  readonly status: DisplayStatus;
  readonly isError: boolean;
  getDisplayName(status?: DisplayStatus): string;
  getUseSummary(context?: ToolSummaryContext): string | undefined;
  getResultSummary(context?: ToolSummaryContext): string | undefined;
  renderToolUse(context: RenderContext): ReactNode;
  renderToolResult(context: RenderContext): ReactNode;
  renderCollapsedPreview(context: RenderContext): ReactNode;
  renderInteractiveSummary(context: RenderContext): ReactNode;
  renderInline(context: RenderContext): ReactNode;
}

const checkedDefinition = Symbol("checked tool definition");
export interface CheckedToolDefinition {
  readonly [checkedDefinition]: true;
  readonly tool: string;
  readonly displayName?: string;
  readonly pendingDisplayName?: string;
  readonly variants: readonly string[];
  readonly standaloneResult: boolean;
  readonly operations: readonly string[];
  prepare(record: DisplayRecord): PreparedToolDisplay;
}

/** The closure captures schema output and its callbacks BEFORE type erasure.
 * Raw values belong only to this inspection/dispatch layer. No registry API
 * returns the callbacks or accepts a hand-written assertion of checked data.
 */
export function defineTool<
  I extends z.ZodType,
  R extends z.ZodType,
  const T extends string,
  F extends z.ZodType = R,
>(
  contract: DisplayContract<I, R, F>,
  callbacks: ToolCallbacks<NoInfer<z.output<I>>, NoInfer<z.output<R>>> &
    FailureCallbacks<
      NoInfer<z.output<I>>,
      NoInfer<z.output<R>>,
      NoInfer<z.output<F>>
    > & {
      tool: T;
    },
): CheckedToolDefinition & { readonly tool: T } {
  // The failure schema's output reaches the dispatch layer through the same
  // parse slot as the result. `FailureCallbacks` makes `renderFailure`
  // mandatory exactly when the two shapes differ, so the alternative below —
  // handing failure data to the result callbacks — is only ever taken where
  // the contract proved them interchangeable.
  const { renderFailure, renderCollapsedFailure, getFailureSummary } =
    callbacks as {
      renderFailure?: FailureRenderer<z.output<I>, z.output<F>>;
      renderCollapsedFailure?: FailureRenderer<z.output<I>, z.output<F>>;
      getFailureSummary?: FailureSummary<z.output<I>, z.output<F>>;
    };
  const operations = [
    "renderToolUse",
    "renderToolResult",
    "getUseSummary",
    "getResultSummary",
    "renderCollapsedPreview",
    "renderInteractiveSummary",
    "renderInline",
    "displayNameForCall",
  ].filter((key) => typeof Reflect.get(callbacks, key) === "function");
  return Object.freeze({
    [checkedDefinition]: true as const,
    tool: callbacks.tool,
    displayName: callbacks.displayName,
    pendingDisplayName: callbacks.pendingDisplayName,
    variants: contract.variants,
    standaloneResult: contract.standaloneResult,
    operations,
    prepare(record: DisplayRecord): PreparedToolDisplay {
      const {
        isError,
        input,
        result,
        partialResult,
        inputEligible,
        reason,
        kind,
      } = prepareDisplay(contract, record);
      const failure =
        renderFailure && isError && contract.failure && result?.success
          ? { data: result.data as z.output<F>, render: renderFailure }
          : undefined;
      const checked =
        failure || !result?.success
          ? undefined
          : { data: result.data as z.output<R> };
      const name = (status = record.status) =>
        (status === "pending" ? callbacks.pendingDisplayName : undefined) ??
        callbacks.displayName ??
        callbacks.tool;
      const raw = (context: RenderContext) => (
        <RawToolDisplay
          id={context.toolUseId ?? callbacks.tool}
          toolName={record.toolName ?? callbacks.tool}
          toolInput={record.input}
          toolResult={record.result}
          status={record.status}
        />
      );
      const partial = () =>
        partialResult?.success &&
        !callbacks.omitPartialResult?.(partialResult.data) ? (
          <pre className={styles.partial} data-tool-display="partial">
            <ToolOutputText text={partialResult.data} />
          </pre>
        ) : null;
      const safeSummary = (fn: () => string | undefined) => {
        try {
          return fn();
        } catch {
          toolDisplayDiagnostics.synchronousCatches++;
          return undefined;
        }
      };
      const render = (
        context: RenderContext,
        fn: (context: ToolDisplayContext) => ReactNode,
      ) => {
        if (kind === "raw") return raw(context);
        try {
          const {
            toolUseResult: _rawResult,
            getToolUse: _rawLookup,
            ...checkedContext
          } = context;
          const node = fn(checkedContext);
          if (node == null || node === false) return node;
          return (
            <ToolDisplayBoundary
              id={context.toolUseId ?? callbacks.tool}
              toolName={record.toolName ?? callbacks.tool}
              toolInput={record.input}
              toolResult={record.result}
              status={record.status}
            >
              {node}
            </ToolDisplayBoundary>
          );
        } catch {
          toolDisplayDiagnostics.synchronousCatches++;
          return raw(context);
        }
      };
      return {
        kind,
        reason,
        status: record.status,
        isError,
        getDisplayName: (status = record.status) =>
          (input.success
            ? safeSummary(() =>
                callbacks.displayNameForCall?.(input.data, status),
              )
            : undefined) ?? name(status),
        getUseSummary: (context) =>
          input.success
            ? safeSummary(() => callbacks.getUseSummary?.(input.data, context))
            : undefined,
        getResultSummary: (context) =>
          !inputEligible
            ? undefined
            : failure
              ? safeSummary(() =>
                  getFailureSummary?.(
                    failure.data,
                    input.success ? input.data : undefined,
                  ),
                )
              : checked
                ? safeSummary(() =>
                    callbacks.getResultSummary?.(
                      checked.data,
                      isError,
                      input.success ? input.data : undefined,
                      context,
                    ),
                  )
                : undefined,
        renderToolUse: (context) =>
          render(context, (context) =>
            input.success
              ? callbacks.renderToolUse(input.data, context)
              : raw(context),
          ),
        renderToolResult: (context) =>
          render(context, (context) =>
            partialResult?.success ? (
              <>
                {input.success
                  ? callbacks.renderToolUse(input.data, context)
                  : null}
                {partial()}
              </>
            ) : failure ? (
              failure.render(
                failure.data,
                context,
                input.success ? input.data : undefined,
              )
            ) : checked ? (
              callbacks.renderToolResult(
                checked.data,
                isError,
                context,
                input.success ? input.data : undefined,
              )
            ) : (
              raw(context)
            ),
          ),
        renderCollapsedPreview: (context) =>
          render(context, (context) =>
            partialResult?.success ? (
              <>
                {input.success
                  ? callbacks.renderCollapsedPreview?.(
                      input.data,
                      undefined,
                      isError,
                      context,
                    )
                  : null}
                {partial()}
              </>
            ) : failure && renderCollapsedFailure ? (
              renderCollapsedFailure(
                failure.data,
                context,
                input.success ? input.data : undefined,
              )
            ) : input.success ? (
              (callbacks.renderCollapsedPreview?.(
                input.data,
                checked?.data,
                isError,
                context,
              ) ?? null)
            ) : (
              raw(context)
            ),
          ),
        renderInteractiveSummary: (context) =>
          render(context, (context) =>
            input.success
              ? (callbacks.renderInteractiveSummary?.(
                  input.data,
                  checked?.data,
                  isError,
                  context,
                ) ?? null)
              : raw(context),
          ),
        renderInline: (context) =>
          render(context, (context) =>
            partialResult?.success ? (
              <>
                {input.success
                  ? callbacks.renderInline?.(
                      input.data,
                      undefined,
                      isError,
                      record.status,
                      context,
                    )
                  : null}
                {partial()}
              </>
            ) : input.success ? (
              (callbacks.renderInline?.(
                input.data,
                checked?.data,
                isError,
                record.status,
                context,
              ) ?? null)
            ) : (
              raw(context)
            ),
          ),
      };
    },
  });
}

type FailureRenderer<TInput, TFailure> = (
  failure: TFailure,
  context: ToolDisplayContext,
  input?: TInput,
) => ReactNode;
type FailureSummary<TInput, TFailure> = (
  failure: TFailure,
  input?: TInput,
) => string;

/** Display of a rejection whose shape the contract's `failure` schema checks.
 * Required when that shape is not the success shape, since the result
 * callbacks could not then receive it.
 */
type FailureCallbacks<TInput, TResult, TFailure> = {
  getFailureSummary?: FailureSummary<TInput, TFailure>;
  /** Collapsed-row display of a checked rejection. Without it the collapsed
   * preview receives no result for a rejection, only `isError`. */
  renderCollapsedFailure?: FailureRenderer<TInput, TFailure>;
} & ([TFailure] extends [TResult]
  ? { renderFailure?: FailureRenderer<TInput, TFailure> }
  : { renderFailure: FailureRenderer<TInput, TFailure> });

/**
 * Tool renderer interface
 */
interface ToolCallbacks<TInput, TResult> {
  /** Tool name (e.g., "Bash", "Edit", "Read") */
  tool: string;
  /** Display name shown in UI (defaults to tool name) */
  displayName?: string;
  /**
   * Display name shown while the call is still in progress (status "pending"),
   * so the verb can read in the present tense live and past tense once
   * finished (e.g. Bash "Running" -> "Ran", AskUserQuestion "Asking" ->
   * "Asked"). Falls back to `displayName` when unset.
   */
  pendingDisplayName?: string;
  /**
   * Dynamic display-name override, consulted before displayName /
   * pendingDisplayName. Lets a renderer reflect call state only the input
   * carries — e.g. a backgrounded Bash run keeps reading "Running" after
   * the tool call itself completed. Return undefined to fall through.
   */
  displayNameForCall?: (
    input: TInput,
    status: "pending" | "complete" | "error" | "aborted" | "incomplete",
  ) => string | undefined;
  /**
   * Whether a plain-text result only restates what the row already shows,
   * so its text block is left out. The input display still renders.
   */
  omitPartialResult?: (text: string) => boolean;
  /** Render the tool_use block (what Claude wants to do) */
  renderToolUse: (input: TInput, context: ToolDisplayContext) => ReactNode;
  /** Render the tool_result block (what happened) */
  renderToolResult: (
    result: TResult,
    isError: boolean,
    context: ToolDisplayContext,
    input?: TInput,
  ) => ReactNode;
  /** Summary for collapsed tool_use view */
  getUseSummary?: (input: TInput, context?: ToolSummaryContext) => string;
  /** Summary for collapsed tool_result view */
  getResultSummary?: (
    result: TResult,
    isError: boolean,
    input?: TInput,
    context?: ToolSummaryContext,
  ) => string;
  /**
   * Render an interactive summary that replaces the expand/collapse behavior.
   * When provided, the row won't expand - instead clicking invokes this component.
   */
  renderInteractiveSummary?: (
    input: TInput,
    result: TResult | undefined,
    isError: boolean,
    context: ToolDisplayContext,
  ) => ReactNode;
  /**
   * Render a preview shown in the collapsed state (below the header).
   * Used to show a condensed view of input/output without expanding.
   */
  renderCollapsedPreview?: (
    input: TInput,
    result: TResult | undefined,
    isError: boolean,
    context: ToolDisplayContext,
  ) => ReactNode;
  /**
   * Render inline without the standard tool row wrapper.
   * When provided, bypasses the entire tool-row structure (no header, chevrons, margins).
   * The tool has complete control over its rendering.
   */
  renderInline?: (
    input: TInput,
    result: TResult | undefined,
    isError: boolean,
    status: ToolCallItem["status"],
    context: ToolDisplayContext,
  ) => ReactNode;
}
