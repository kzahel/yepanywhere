import {
  ACLI_COMMENTARY_RENDERING_CAPABILITY,
  initialAcliFormat,
  decodeCodeModeOutput,
  serverHasCapability,
} from "@yep-anywhere/shared";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { usePublicShareContext } from "../contexts/PublicShareContext";
import { useOptionalSessionMetadata } from "../contexts/SessionMetadataContext";
import { useCurrentSourceRuntime } from "../contexts/SourceRuntimeContext";
import { useAcliCommentarySetting } from "../hooks/useAcliCommentarySetting";
import { useRetainedVersionInfo } from "../hooks/useVersion";
import { useI18n } from "../i18n";
import {
  AcliToolOutput,
  type AcliOutputProjection,
} from "../lib/acliToolOutput";
import { getDisplayBashCommandFromInput } from "../lib/bashCommand";
import type { YaSourceRuntime } from "../lib/sourceRuntime";
import { renderCommentary } from "../lib/renderCommentary";
import { readToolCommentaryOutput as readOutput } from "../lib/toolCommentarySource";
import {
  joinWorkflowOutputs,
  projectWorkflowFragments,
  type WorkflowAnnotation,
} from "@yep-anywhere/shared/transcript/workflowTags";
import type {
  ToolCallItem,
  ToolResultData,
} from "@yep-anywhere/shared/transcript/items";
import { AcliCommentary } from "./AcliCommentary";
import { ActivityDetailModal } from "./ActivityDetailModal";
import { BashModalContent } from "./renderers/tools/BashOutputDetail";
import type { BashInput, BashResult } from "./renderers/tools/types";

interface Props {
  id: string;
  toolName: string;
  toolInput: unknown;
  toolResult?: ToolResultData;
  status: ToolCallItem["status"];
  workflow?: WorkflowAnnotation;
  children: (
    input: unknown,
    result: ToolResultData | undefined,
    workflow: WorkflowAnnotation | undefined,
  ) => ReactNode;
}

interface Output {
  stdout: string;
  stderr: string;
  stdoutSequenced: boolean;
  shell: BashResult | null;
}

type InvocationProps = Props & {
  projectId: string;
  runtime: YaSourceRuntime;
  supported: boolean | null;
};

interface CodeModePart {
  index: number;
  result: ToolResultData;
  replaceText: (text: string) => { type: string; text: string };
}

const codeModeResults = new WeakMap<
  ToolResultData,
  {
    source: unknown;
    blocks: { type: string; text: string }[];
    parts: CodeModePart[];
    textParts: Array<{ index: number; text: string }>;
  }
>();

function firstLineDeclaresCommentary(text: string, pending: boolean) {
  return initialAcliFormat(text, !pending) !== null;
}

function CodeModeBoundary(props: InvocationProps) {
  const source = props.toolResult?.structured ?? props.toolResult?.content;
  const decoded = useMemo(() => {
    const cached = props.toolResult
      ? codeModeResults.get(props.toolResult)
      : undefined;
    if (cached?.source === source && props.status !== "pending") return cached;
    const output = decodeCodeModeOutput(source);
    if (!output) return null;
    const selected = output.parts.flatMap((part, index) =>
      firstLineDeclaresCommentary(part.text, props.status === "pending")
        ? [{ part, index }]
        : [],
    );
    if (!selected.length) return null;
    // The shared decoder validates the envelope and recognizes command results.
    // Only its declared text leaves participate; arbitrary JSON strings do not.
    const blocks = (
      typeof source === "string" ? JSON.parse(source) : source
    ) as {
      type: string;
      text: string;
    }[];
    const parts: CodeModePart[] = selected.map(({ part, index }) => {
      const block = blocks[index]!;
      const envelope =
        part.kind === "command-output" ? JSON.parse(block.text) : null;
      return {
        index,
        result: {
          ...props.toolResult,
          content: part.text,
          structured: undefined,
          isError: props.toolResult?.isError ?? props.status === "error",
        },
        replaceText: (text) => ({
          ...block,
          text: envelope
            ? JSON.stringify(
                envelope.status === "fulfilled"
                  ? { ...envelope, value: { ...envelope.value, output: text } }
                  : { ...envelope, output: text },
              )
            : part.kind === "script-status"
              ? block.text
              : text,
        }),
      };
    });
    const textParts = output.parts.flatMap((part, index) =>
      part.kind === "script-status" ? [] : [{ index, text: part.text }],
    );
    const result = { source, blocks, parts, textParts };
    if (props.toolResult && props.status !== "pending")
      codeModeResults.set(props.toolResult, result);
    return result;
  }, [source, props.toolResult, props.status]);
  const [projections, setProjections] = useState(
    () =>
      new Map<
        number,
        { result?: ToolResultData; workflow?: WorkflowAnnotation }
      >(),
  );
  const project = useCallback(
    (
      index: number,
      result: ToolResultData | undefined,
      workflow: WorkflowAnnotation | undefined,
    ) => {
      setProjections((current) => {
        if (
          current.has(index) &&
          current.get(index)?.result === result &&
          current.get(index)?.workflow === workflow
        )
          return current;
        return new Map(current).set(index, { result, workflow });
      });
    },
    [],
  );
  const input = record(props.toolInput);
  const leafInput = useMemo(() => ({ cmd: input?.source }), [input?.source]);
  if (!decoded || props.supported === false)
    return props.children(props.toolInput, props.toolResult, props.workflow);
  const blocks = [...decoded.blocks];
  for (const part of decoded.parts)
    blocks[part.index] = part.replaceText(
      projections.get(part.index)?.result?.content ?? "",
    );
  const context = props.workflow?.toolContext;
  const workflow = context
    ? joinWorkflowOutputs(
        decoded.textParts.map((part) => {
          if (decoded.parts.some((selected) => selected.index === part.index))
            return (
              projections.get(part.index)?.workflow ?? {
                markers: [],
                outputText: "",
              }
            );
          return projectWorkflowFragments(
            [[{ id: String(part.index), kind: "data", text: part.text }]],
            context,
          ).data;
        }),
      )
    : props.workflow;
  return (
    <>
      {props.children(
        props.toolInput,
        {
          ...props.toolResult,
          content: JSON.stringify(blocks),
          structured: blocks,
          isError: props.toolResult?.isError ?? props.status === "error",
        },
        workflow,
      )}
      {decoded.parts.map((part) => (
        <InvocationBoundary
          {...props}
          key={part.index}
          id={`${props.id}:${part.index}`}
          toolName="Exec output"
          toolInput={leafInput}
          toolResult={part.result}
        >
          {(_input, result, workflow) => (
            <CodeModeProjection
              index={part.index}
              result={result}
              workflow={workflow}
              project={project}
            />
          )}
        </InvocationBoundary>
      ))}
    </>
  );
}

function CodeModeProjection({
  index,
  result,
  workflow,
  project,
}: {
  index: number;
  result: ToolResultData | undefined;
  workflow?: WorkflowAnnotation;
  project: (
    index: number,
    result: ToolResultData | undefined,
    workflow: WorkflowAnnotation | undefined,
  ) => void;
}) {
  // Publish cleaned command data before the same paint as its sibling prose.
  // Stable keyed siblings keep existing streams mounted as new blocks arrive.
  useLayoutEffect(
    () => project(index, result, workflow),
    [index, result, workflow, project],
  );
  return null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function ToolCommentaryBoundary(props: Props) {
  const { acliCommentaryEnabled } = useAcliCommentarySetting();
  const metadata = useOptionalSessionMetadata();
  const publicShare = usePublicShareContext();
  const runtime = useCurrentSourceRuntime();
  const version = useRetainedVersionInfo(runtime.sourceKey);
  if (!acliCommentaryEnabled || !metadata || publicShare)
    return props.children(props.toolInput, props.toolResult, props.workflow);
  const Boundary =
    props.toolName === "Exec" ? CodeModeBoundary : InvocationBoundary;
  return (
    <Boundary
      key={`${runtime.sourceKey}:${metadata.projectId}:${metadata.sessionId}:${props.id}:${JSON.stringify(props.workflow?.toolContext)}`}
      {...props}
      projectId={metadata.projectId}
      runtime={runtime}
      supported={
        version
          ? serverHasCapability(version, ACLI_COMMENTARY_RENDERING_CAPABILITY)
          : null
      }
    />
  );
}

function InvocationBoundary(props: InvocationProps) {
  const output = useMemo(
    () =>
      readOutput({
        toolName: props.toolName,
        toolInput: props.toolInput,
        toolResult: props.toolResult,
        status: props.status,
      }),
    [props.toolResult, props.toolInput, props.toolName, props.status],
  );
  const [mode, setMode] = useState<"commentary" | "raw" | null>(null);
  const declared = [output.stdout, output.stderr].some((text) =>
    firstLineDeclaresCommentary(text, props.status === "pending"),
  );
  if (mode === null) {
    if (props.supported === false) setMode("raw");
    else if (declared && props.supported) setMode("commentary");
    else if (
      !declared &&
      (props.status !== "pending" || output.stdout.includes("\n"))
    )
      setMode("raw");
  }
  if (mode === "commentary")
    return <CommentaryOutput {...props} output={output} />;
  if (mode === "raw")
    return props.children(props.toolInput, props.toolResult, props.workflow);
  // Do not publish an undecided record, then move its metadata after paint.
  const input = record(props.toolInput);
  return props.children(
    input ? { ...input, _previewResult: undefined } : props.toolInput,
    undefined,
    undefined,
  );
}

const completed = new WeakMap<
  ToolResultData,
  {
    sourceKey: string;
    source: string;
    stderr: string;
    projection: AcliOutputProjection;
    workflowKey: string;
  }
>();

function CommentaryOutput(
  props: Props & {
    projectId: string;
    runtime: YaSourceRuntime;
    output: Output;
  },
) {
  const { t } = useI18n();
  // The outer key remounts this invocation when its serialized schema changes.
  const [workflowContext] = useState(props.workflow?.toolContext);
  const [initial] = useState(() => {
    const cached = props.toolResult
      ? completed.get(props.toolResult)
      : undefined;
    return cached?.sourceKey === props.runtime.sourceKey &&
      cached.workflowKey === JSON.stringify(props.workflow?.toolContext) &&
      cached.source === props.output.stdout &&
      cached.stderr === props.output.stderr &&
      props.status !== "pending"
      ? cached
      : null;
  });
  const [projection, setProjection] = useState<AcliOutputProjection | null>(
    initial?.projection ?? null,
  );
  const [viewerOpen, setViewerOpen] = useState(false);
  const engine = useRef<AcliToolOutput | null>(null);
  const restart = useRef<(() => void) | null>(null);
  const latest = useRef(props);
  latest.current = props;
  const command =
    getDisplayBashCommandFromInput(props.toolInput) || props.toolName;

  useEffect(() => {
    let abort = new AbortController();
    const create = (cached?: {
      source: string;
      stderr: string;
      projection: AcliOutputProjection;
    }) =>
      new AcliToolOutput(
        (texts) =>
          renderCommentary(props.runtime, props.projectId, texts, abort.signal),
        (next) => {
          setProjection(next);
          const current = latest.current;
          if (
            next.complete &&
            current.toolResult &&
            current.status !== "pending"
          )
            completed.set(current.toolResult, {
              sourceKey: current.runtime.sourceKey,
              source: current.output.stdout,
              stderr: current.output.stderr,
              projection: next,
              workflowKey: JSON.stringify(current.workflow?.toolContext),
            });
        },
        cached,
        props.output.stdoutSequenced,
        workflowContext,
      );
    restart.current = () => {
      abort.abort();
      engine.current?.stop();
      abort = new AbortController();
      engine.current = create();
      const current = latest.current;
      engine.current.appendSnapshot(
        current.output.stdout,
        current.status !== "pending",
        current.output.stderr,
      );
    };
    engine.current = create(initial ?? undefined);
    const current = latest.current;
    engine.current.appendSnapshot(
      current.output.stdout,
      current.status !== "pending",
      current.output.stderr,
    );
    return () => {
      abort.abort();
      engine.current?.stop();
      engine.current = null;
      restart.current = null;
    };
  }, [
    props.projectId,
    props.runtime,
    props.output.stdoutSequenced,
    initial,
    workflowContext,
  ]);

  useEffect(() => {
    if (!engine.current) return;
    if (
      !engine.current.appendSnapshot(
        props.output.stdout,
        props.status !== "pending",
        props.output.stderr,
      )
    ) {
      // Reconcile a replacement atomically after rendering; never mix the old
      // invocation's context with its replacement or flash raw metadata.
      restart.current?.();
    }
  }, [props.output.stdout, props.output.stderr, props.status]);

  const closeViewer = useCallback(() => setViewerOpen(false), []);
  const openViewer = useCallback(() => setViewerOpen(true), []);
  const projectedResult = useMemo(() => {
    if (!projection) return undefined;
    const stderr = projection.stderr;
    return {
      ...props.toolResult,
      content: projection.stdout,
      isError: props.toolResult?.isError ?? props.status === "error",
      structured: props.output.shell
        ? { ...props.output.shell, stdout: projection.stdout, stderr }
        : props.output.stderr
          ? { stdout: projection.stdout, stderr }
          : undefined,
    };
  }, [props.toolResult, props.output, projection, props.status]);
  const projectedInput = useMemo(() => {
    const input = record(props.toolInput);
    return input
      ? { ...input, _previewResult: projectedResult?.structured }
      : props.toolInput;
  }, [props.toolInput, projectedResult]);
  return (
    <>
      {props.children(projectedInput, projectedResult, projection?.workflow)}
      {projection ? (
        <AcliCommentary
          items={projection.commentary}
          command={command}
          onOpenOutput={openViewer}
        />
      ) : null}
      {projection?.failed ? (
        <span role="status">{t("acliCommentaryUnavailable")}</span>
      ) : null}
      {viewerOpen ? (
        <ActivityDetailModal
          title={command}
          label={command}
          onClose={closeViewer}
        >
          {props.output.shell ? (
            <BashModalContent
              input={props.toolInput as BashInput}
              result={projectedResult?.structured as BashResult}
              isError={props.toolResult?.isError ?? props.status === "error"}
              projectPathLinks={props.toolResult?.projectPathLinks}
            />
          ) : (
            <pre>{projection?.stdout}</pre>
          )}
          <details>
            <summary>{t("workflowOriginalOutput")}</summary>
            <pre>
              {props.output.stdout}
              {props.output.stderr ? `\n${props.output.stderr}` : ""}
            </pre>
          </details>
        </ActivityDetailModal>
      ) : null}
    </>
  );
}
