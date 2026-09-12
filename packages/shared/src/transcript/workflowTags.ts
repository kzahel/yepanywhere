import { decodeCodeModeOutput } from "../code-mode-output.js";
import {
  AcliStreamDecoder,
  initialAcliFormat,
  acliRecordFragments,
  type AcliOutputFragment,
} from "../acli-output.js";
import { parseShellToolOutput } from "./shellToolOutput.js";
import type { Message } from "./message.js";
import type { RenderItem, ToolCallItem } from "./items.js";

export interface WorkflowMarker {
  start: number;
  end: number;
  prefix: string;
  title: string;
  kind: "stage" | "activation" | "unresolved" | "start" | "end";
  path?: string;
  schemaRef?: string;
}

export type WorkflowSchemaFiles = Readonly<Record<string, string | null>>;

export interface WorkflowAnnotation {
  markers: WorkflowMarker[];
  toolContext?: WorkflowToolContext;
  outputText?: string;
  /** Starts of independently decoded output blocks; JSON never crosses these. */
  outputBoundaries?: number[];
  parent?: { path: string; title: string };
  view?: "spans" | "matching-lines";
  visibleRanges?: Array<{ start: number; end: number }>;
}

interface ToolPolicy {
  containsTags: boolean;
  closed?: boolean;
  view?: "spans" | "matching-lines";
  whitelist?: string[];
}

interface Stage {
  title: string;
  policy: ToolPolicy;
  presentation: { collect: boolean; order: number };
}

interface Schema {
  id: string;
  title: string;
  root: string;
  stages: Map<string, Stage>;
  inline?: Set<string>;
}

interface Cursor {
  schema: Schema;
  path: string;
  instance?: string;
}

/** Serializable invocation snapshot, retained across async presentation/replay. */
export interface WorkflowToolContext {
  initial?: Omit<Cursor, "schema"> & {
    schema: Omit<Schema, "stages" | "inline"> & {
      stages: Array<[string, Stage]>;
      inline?: string[];
    };
  };
  schemaFiles?: WorkflowSchemaFiles;
  declarations: Array<[string, string]>;
}

interface WorkflowScanState {
  cursor?: Cursor;
  activated?: Schema;
  declarations: Map<string, string>;
}

const ACTIVATION = "@@visualization-schema/1 ";
const NO_TAGS: ToolPolicy = { containsTags: false, closed: false };
const INLINE_POLICY: ToolPolicy = { containsTags: true, view: "spans" };
const SEPARATE: Stage["presentation"] = { collect: false, order: 0 };

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function key(value: unknown): value is string {
  return (
    typeof value === "string" && value.length > 0 && !/[[\]\r\n]/.test(value)
  );
}

function prefix(line: string): string | undefined {
  return /^(?:\[[^[\]\r\n]+\])+/.exec(line)?.[0];
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function policy(value: unknown, inherited: ToolPolicy): ToolPolicy | undefined {
  if (value === undefined) return inherited;
  if (
    !record(value) ||
    (value.containsTags !== undefined &&
      typeof value.containsTags !== "boolean") ||
    (value.closed !== undefined && typeof value.closed !== "boolean")
  )
    return;
  if (
    value.view !== undefined &&
    value.view !== "spans" &&
    value.view !== "matching-lines"
  )
    return;
  if (
    value.whitelist !== undefined &&
    (!Array.isArray(value.whitelist) ||
      !value.whitelist.every(
        (path) => typeof path === "string" && prefix(path) === path,
      ))
  )
    return;
  return {
    containsTags: value.containsTags ?? false,
    closed: value.closed ?? false,
    view: value.view,
    whitelist: value.whitelist as string[] | undefined,
  };
}

function presentation(value: unknown): Stage["presentation"] | undefined {
  if (value === undefined) return SEPARATE;
  if (
    !record(value) ||
    (value.collect !== undefined && typeof value.collect !== "boolean") ||
    (value.order !== undefined &&
      (typeof value.order !== "number" || !Number.isFinite(value.order)))
  )
    return;
  return { collect: value.collect ?? false, order: value.order ?? 0 };
}

function parseSchema(value: unknown): Schema | undefined {
  if (
    !record(value) ||
    value.type !== "tagged-stages/1" ||
    typeof value.id !== "string" ||
    !value.id ||
    /\s/.test(value.id) ||
    !key(value.key) ||
    value.key === "workflow" ||
    typeof value.title !== "string" ||
    !Array.isArray(value.stages)
  )
    return;
  const rootPolicy = policy(value.toolOutput, NO_TAGS);
  const rootPresentation = presentation(value.presentation);
  if (!rootPolicy || !rootPresentation) return;
  const stages = new Map<string, Stage>();
  const root = `[${value.key}]`;
  stages.set(root, {
    title: value.title,
    policy: rootPolicy,
    presentation: rootPresentation,
  });
  function children(
    values: unknown[],
    parent: string,
    inherited: Stage,
    depth: number,
  ): boolean {
    if (depth > 32 || stages.size + values.length > 512) return false;
    for (const child of values) {
      if (
        !record(child) ||
        !key(child.key) ||
        (child.title !== undefined && typeof child.title !== "string") ||
        (child.children !== undefined && !Array.isArray(child.children))
      )
        return false;
      const path = `${parent}[${child.key}]`;
      const childPolicy = policy(child.toolOutput, inherited.policy);
      const childPresentation = presentation(child.presentation);
      if (
        stages.has(path) ||
        stages.size >= 512 ||
        !childPolicy ||
        !childPresentation
      )
        return false;
      const stage = {
        title: `${inherited.title} › ${child.title ?? child.key}`,
        policy: childPolicy,
        presentation: childPresentation,
      };
      stages.set(path, stage);
      if (
        Array.isArray(child.children) &&
        !children(child.children, path, stage, depth + 1)
      )
        return false;
    }
    return true;
  }
  if (!children(value.stages, root, stages.get(root)!, 1)) return;
  return { id: value.id, title: value.title, root, stages };
}

function inlineSchema(operand: string): Schema | undefined {
  const value = parseJson(operand);
  if (!Array.isArray(value)) return;
  const paths: string[] = [];
  for (const entry of value) {
    const atoms = typeof entry === "string" ? [entry] : entry;
    if (!Array.isArray(atoms) || !atoms.length || !atoms.every(key)) return;
    paths.push(atoms.map((atom) => `[${atom}]`).join(""));
  }
  return {
    id: "",
    title: "",
    root: "",
    stages: new Map(),
    inline: new Set(paths),
  };
}

export function workflowSchemaReference(operand: string) {
  if (!/^(?:\/|~\/|[A-Za-z]:[\\/]|\\\\)/.test(operand)) return;
  const fragment = operand.indexOf("#");
  return {
    path: fragment < 0 ? operand : operand.slice(0, fragment),
    id: fragment < 0 ? undefined : operand.slice(fragment + 1),
  };
}

// Interpret either a JSON file or a document containing fenced declarations.
// The browser's file resolver supplies bytes separately from transcript text.
export function readWorkflowSchema(
  text: string,
  operand: string,
): Schema | undefined {
  const reference = workflowSchemaReference(operand);
  if (!reference) return;
  const { id } = reference;
  const json = parseJson(text);
  if (record(json)) {
    const schema = parseSchema(json);
    return schema && (id === undefined || schema.id === id)
      ? schema
      : undefined;
  }
  const declarations: Schema[] = [];
  for (const match of text.matchAll(/^```json\s*\r?\n([\s\S]*?)^```\s*$/gm)) {
    const value = parseJson(match[1] ?? "");
    if (!record(value) || (id === undefined ? !value.type : value.id !== id))
      continue;
    const schema = parseSchema(value);
    if (!schema) return;
    declarations.push(schema);
  }
  return declarations.length === 1 ? declarations[0] : undefined;
}

function stage(cursor: Cursor): Stage {
  return (
    cursor.schema.stages.get(cursor.path) ?? {
      title: cursor.path.replace(/\]\[/g, " › ").replace(/^\[|\]$/g, ""),
      policy: cursor.schema.inline ? INLINE_POLICY : NO_TAGS,
      presentation: SEPARATE,
    }
  );
}

function pathTitle(schema: Schema, path: string): string {
  let current = "";
  let title = "";
  for (const atom of path.slice(1, -1).split("][")) {
    current += `[${atom}]`;
    title =
      schema.stages.get(current)?.title ??
      `${title ? `${title} › ` : ""}${atom}`;
  }
  return title;
}

function matchesTool(path: string, cursor: Cursor): boolean {
  if (cursor.schema.inline) return cursor.schema.inline.has(path);
  const effective = stage(cursor).policy;
  return (
    effective.containsTags &&
    (!effective.closed ||
      cursor.schema.stages.has(`${cursor.path}${path}`) ||
      effective.whitelist?.includes(path) === true)
  );
}

function toolOutputParts(item: ToolCallItem): string[] {
  const result = item.toolResult?.structured;
  if (item.toolName === "Exec") {
    const decoded = decodeCodeModeOutput(result ?? item.toolResult?.content);
    if (decoded) {
      const parts = decoded.parts
        .filter((part) => part.kind !== "script-status")
        .map((part) => part.text);
      return parts.length ? parts : [""];
    }
  }
  if (
    item.toolName === "Read" &&
    record(result) &&
    result.type === "text" &&
    record(result.file) &&
    typeof result.file.content === "string"
  ) {
    return [result.file.content];
  }
  const shell = ["bash", "exec_command", "shell_command"].includes(
    item.toolName.toLowerCase(),
  );
  if (
    record(result) &&
    (typeof result.stdout === "string" || typeof result.stderr === "string")
  )
    return [
      typeof result.stdout === "string"
        ? result.stdout
        : shell
          ? ""
          : (item.toolResult?.content ?? ""),
      typeof result.stderr === "string" ? result.stderr : "",
    ];
  if (shell) {
    const text = item.toolResult?.content ?? "";
    const parsed = parseShellToolOutput(text, {
      bareExitCodeIsEnvelope: item.toolResult?.isError,
    });
    return [parsed.hasEnvelope ? parsed.output : text];
  }
  return [item.toolResult?.content ?? ""];
}

function scanWorkflowText(
  text: string,
  initial: Cursor | undefined,
  tool: boolean,
  streaming: boolean,
  state: WorkflowScanState,
  schemaFiles?: WorkflowSchemaFiles,
  fenceContexts?: ReadonlyMap<number, string>,
  opaqueRanges?: readonly { start: number; end: number }[],
): WorkflowAnnotation {
  const annotation: WorkflowAnnotation = { markers: [] };
  let local = initial;
  const parent = initial?.path;
  if (initial && parent)
    annotation.parent = { path: parent, title: stage(initial).title };
  if (tool && initial && stage(initial).policy.containsTags)
    annotation.view = stage(initial).policy.view ?? "spans";
  const visibleRanges: Array<{ start: number; end: number }> = [];
  function showLine(start: number, end: number) {
    const previous = visibleRanges.at(-1);
    if (previous && previous.end >= start) previous.end = end;
    else visibleRanges.push({ start, end });
  }
  let fence: string | undefined;
  let fenceContext = "data";
  const fences = new Map<string, string | undefined>();
  let offset = 0;
  let opaqueIndex = 0;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "");
    const start = offset;
    const nextFenceContext = fenceContexts?.get(start);
    if (nextFenceContext !== undefined && nextFenceContext !== fenceContext) {
      fences.set(fenceContext, fence);
      fenceContext = nextFenceContext;
      fence = fences.get(fenceContext);
    }
    offset += raw.length + 1;
    const end = Math.min(offset, text.length);
    if (tool && annotation.view !== "matching-lines") showLine(start, end);
    if (streaming && offset > text.length) break;
    while (
      opaqueRanges?.[opaqueIndex] &&
      opaqueRanges[opaqueIndex]!.end <= start
    )
      opaqueIndex++;
    if (
      opaqueRanges?.[opaqueIndex] &&
      opaqueRanges[opaqueIndex]!.start <= start
    )
      continue;
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    const insideFence = fence !== undefined;
    if (fenceMatch) {
      if (!fence) fence = fenceMatch;
      else if (
        fenceMatch[0] === fence[0] &&
        fenceMatch.length >= fence.length &&
        /^ {0,3}(?:`+|~+)\s*$/.test(line)
      )
        fence = undefined;
    }
    const marker = (
      kind: WorkflowMarker["kind"],
      matched: string,
      title: string,
      path?: string,
    ) => {
      if (tool) showLine(start, end);
      annotation.markers.push({
        start,
        end: start + matched.length,
        prefix: matched,
        title,
        kind,
        ...(path ? { path } : {}),
      });
    };
    if (!insideFence && !fenceMatch && line.startsWith(ACTIVATION)) {
      const operand = line.slice(ACTIVATION.length).trim();
      const reference = workflowSchemaReference(operand);
      const fileContent = schemaFiles?.[operand];
      const embedded =
        reference && tool ? readWorkflowSchema(text, operand) : undefined;
      const schema = operand.startsWith("[")
        ? inlineSchema(operand)
        : reference
          ? (embedded ?? readWorkflowSchema(fileContent ?? "", operand))
          : undefined;
      const signature =
        schema && !schema.inline
          ? JSON.stringify([...schema.stages])
          : undefined;
      const previous = schema && state.declarations.get(schema.id);
      if (!schema || (previous !== undefined && previous !== signature)) {
        marker("unresolved", line, operand);
        if (reference) annotation.markers.at(-1)!.schemaRef = operand;
        continue;
      }
      if (signature) state.declarations.set(schema.id, signature);
      local = schema.inline ? { schema, path: "" } : undefined;
      // A nested script owns its following output, not the caller's cursor.
      // Unscoped schema reads still activate subsequent assistant activity.
      if (!tool || !initial) {
        state.activated = schema;
        state.cursor = local;
      }
      if (tool && schema.inline) annotation.view = "spans";
      marker("activation", line, schema.title);
      if (reference && !embedded)
        annotation.markers.at(-1)!.schemaRef = operand;
      continue;
    }
    if (!tool && (insideFence || fenceMatch)) continue;
    const path = prefix(line);
    if (!path) continue;
    if (!tool && !local?.schema.inline && path === "[workflow][start]") {
      const match = /^\[workflow\]\[start\] id=(\S+) schema=(\S+)\s*$/.exec(
        line,
      );
      if (
        match &&
        state.activated &&
        !state.activated.inline &&
        state.activated.id === match[2] &&
        !state.cursor
      ) {
        state.cursor = {
          schema: state.activated,
          path: state.activated.root,
          instance: match[1],
        };
        local = state.cursor;
        marker("start", path, state.activated.title);
      }
    } else if (!tool && !local?.schema.inline && path === "[workflow][end]") {
      const match =
        /^\[workflow\]\[end\] id=(\S+) status=(completed|blocked|failed)(?:\s|$)/.exec(
          line,
        );
      if (match && state.cursor && state.cursor.instance === match[1]) {
        marker("end", path, `${state.cursor.schema.title} · ${match[2]}`);
        state.cursor = undefined;
        local = undefined;
      }
    } else if (local) {
      const matched = tool
        ? matchesTool(path, local)
        : (local.schema.inline?.has(path) ?? local.schema.stages.has(path));
      if (!matched) continue;
      const fullPath = tool ? `${parent ?? ""}${path}` : path;
      const title =
        tool && initial && initial.schema !== local.schema && parent
          ? `${stage(initial).title} › ${pathTitle(local.schema, path)}`
          : pathTitle(local.schema, fullPath);
      marker("stage", path, title, fullPath);
      if (!tool) {
        state.cursor = { ...local, path };
        local = state.cursor;
      }
    }
  }
  if (tool && annotation.view) annotation.visibleRanges = visibleRanges;
  return annotation;
}

function captureToolContext(
  initial: Cursor | undefined,
  state: WorkflowScanState,
  schemaFiles?: WorkflowSchemaFiles,
): WorkflowToolContext {
  return {
    initial: initial
      ? {
          ...initial,
          schema: {
            ...initial.schema,
            stages: [...initial.schema.stages],
            inline: initial.schema.inline
              ? [...initial.schema.inline]
              : undefined,
          },
        }
      : undefined,
    schemaFiles,
    declarations: [...state.declarations],
  };
}

function appendAnnotation(
  target: WorkflowAnnotation,
  source: WorkflowAnnotation,
  text: string,
) {
  const previous = target.outputText ?? "";
  const separator = previous && text ? "\n" : "";
  const offset = previous.length + separator.length;
  target.outputText = previous + separator + text;
  target.outputBoundaries ??= [];
  target.outputBoundaries.push(
    ...(source.outputBoundaries ?? [0]).map((start) => start + offset),
  );
  target.parent ??= source.parent;
  target.view ??= source.view;
  target.markers.push(
    ...source.markers.map((marker) => ({
      ...marker,
      start: marker.start + offset,
      end: marker.end + offset,
    })),
  );
  target.visibleRanges ??= [];
  target.visibleRanges.push(
    ...(source.visibleRanges ?? [{ start: 0, end: text.length }]).map(
      (range) => ({ start: range.start + offset, end: range.end + offset }),
    ),
  );
}

export function joinWorkflowOutputs(
  parts: readonly WorkflowAnnotation[],
): WorkflowAnnotation {
  const result: WorkflowAnnotation = { markers: [], outputText: "" };
  for (const part of parts)
    appendAnnotation(result, part, part.outputText ?? "");
  return result;
}

/** Match decoded prose/data once, then map only within those source fragments. */
export function projectWorkflowFragments(
  streams: readonly (readonly AcliOutputFragment[])[],
  context: WorkflowToolContext,
  state: WorkflowScanState = { declarations: new Map(context.declarations) },
) {
  const initial: Cursor | undefined = context.initial
    ? {
        ...context.initial,
        schema: {
          ...context.initial.schema,
          stages: new Map(context.initial.schema.stages),
          inline: context.initial.schema.inline
            ? new Set(context.initial.schema.inline)
            : undefined,
        },
      }
    : undefined;
  const data: WorkflowAnnotation = { markers: [], outputText: "" };
  const combined: WorkflowAnnotation = { markers: [], outputText: "" };
  const commentary: Record<string, WorkflowAnnotation> = {};
  for (const fragments of streams) {
    let text = "";
    let previousKind: AcliOutputFragment["kind"] | undefined;
    const fenceContexts = new Map<number, string>();
    const spans = fragments.map((fragment) => {
      if (
        text &&
        !text.endsWith("\n") &&
        (fragment.kind === "commentary" || previousKind === "commentary")
      )
        text += "\n";
      const start = text.length;
      fenceContexts.set(start, fragment.kind === "data" ? "data" : fragment.id);
      text += fragment.text;
      previousKind = fragment.kind;
      return { fragment, start, end: text.length };
    });
    const annotation = scanWorkflowText(
      text,
      initial,
      true,
      false,
      state,
      context.schemaFiles,
      fenceContexts,
      spans.filter((span) => span.fragment.opaque),
    );
    appendAnnotation(combined, annotation, text);
    const streamData: WorkflowAnnotation = {
      markers: [],
      outputText: "",
      parent: annotation.parent,
      view: annotation.view,
      visibleRanges: [],
    };
    let currentStage: WorkflowMarker | undefined;
    let dataStage: WorkflowMarker | undefined;
    let markerIndex = 0;
    let rangeIndex = 0;
    const ranges = annotation.visibleRanges ?? [{ start: 0, end: text.length }];
    for (const { fragment, start, end } of spans) {
      const markers: WorkflowMarker[] = [];
      while (
        annotation.markers[markerIndex] &&
        annotation.markers[markerIndex]!.start < end
      ) {
        const marker = annotation.markers[markerIndex++]!;
        if (marker.start >= start) markers.push(marker);
      }
      const visibleRanges: Array<{ start: number; end: number }> = [];
      while (ranges[rangeIndex] && ranges[rangeIndex]!.end <= start)
        rangeIndex++;
      for (
        let index = rangeIndex;
        ranges[index] && ranges[index]!.start < end;
        index++
      ) {
        const range = ranges[index]!;
        const left = Math.max(start, range.start),
          right = Math.min(end, range.end);
        if (left < right)
          visibleRanges.push({ start: left - start, end: right - start });
      }
      const local: WorkflowAnnotation = {
        markers: markers.map((marker) => ({
          ...marker,
          start: marker.start - start,
          end: marker.end - start,
        })),
        parent: currentStage?.path
          ? { path: currentStage.path, title: currentStage.title }
          : annotation.parent,
        view: annotation.view,
        visibleRanges,
      };
      if (fragment.kind === "commentary") commentary[fragment.id] = local;
      else {
        const offset = streamData.outputText!.length;
        if (
          annotation.view === "spans" &&
          currentStage &&
          currentStage !== dataStage &&
          !markers.some((marker) => marker.start === start)
        )
          streamData.markers.push({
            ...currentStage,
            prefix: "",
            start: offset,
            end: offset,
          });
        streamData.markers.push(
          ...local.markers.map((marker) => ({
            ...marker,
            start: marker.start + offset,
            end: marker.end + offset,
          })),
        );
        streamData.visibleRanges!.push(
          ...local.visibleRanges!.map((range) => ({
            start: range.start + offset,
            end: range.end + offset,
          })),
        );
        streamData.outputText += fragment.text;
      }
      for (const marker of markers) {
        if (marker.kind === "stage") currentStage = marker;
        else if (marker.kind === "activation") currentStage = undefined;
      }
      if (fragment.kind === "data") dataStage = currentStage;
    }
    appendAnnotation(data, streamData, streamData.outputText!);
  }
  return { data, combined, commentary };
}

/** Visible Markdown segments; boundaries render separately from trusted HTML. */
export function workflowCommentarySegments(
  text: string,
  annotation: WorkflowAnnotation,
) {
  const segments: Array<{ text: string; marker?: WorkflowMarker }> = [];
  for (const range of annotation.visibleRanges ?? [
    { start: 0, end: text.length },
  ]) {
    let offset = range.start;
    let marker: WorkflowMarker | undefined;
    for (const next of annotation.markers) {
      if (next.start < range.start || next.start >= range.end) continue;
      if (offset < next.start || marker)
        segments.push({ text: text.slice(offset, next.start), marker });
      marker = next;
      offset = next.end;
    }
    if (offset < range.end || marker)
      segments.push({ text: text.slice(offset, range.end), marker });
  }
  return segments;
}

/** Preserve invocation-time context while visiting results in arrival order. */
export function annotateWorkflowTags(
  messages: Message[],
  items: RenderItem[],
  schemaFiles?: WorkflowSchemaFiles,
): RenderItem[] {
  const events = new Map<
    Message,
    Array<{ item: RenderItem; result: boolean }>
  >();
  const annotations = new Map<RenderItem, WorkflowAnnotation>();
  const calls = new Map<ToolCallItem, { cursor?: Cursor; turn: number }>();
  let turn = 0;
  const state: WorkflowScanState = { declarations: new Map() };

  for (const item of items) {
    if (item.isSubagent) continue;
    const first = item.sourceMessages[0];
    if (first) {
      const entries = events.get(first) ?? [];
      entries.push({ item, result: false });
      events.set(first, entries);
    }
    if (item.type === "tool_call" && item.toolResult) {
      const resultSource = [...item.sourceMessages]
        .reverse()
        .find((message) => {
          const content = message.message?.content ?? message.content;
          return (
            Array.isArray(content) &&
            content.some(
              (block) =>
                block.type === "tool_result" && block.tool_use_id === item.id,
            )
          );
        });
      if (resultSource) {
        const entries = events.get(resultSource) ?? [];
        entries.push({ item, result: true });
        events.set(resultSource, entries);
      }
    }
  }

  for (const message of messages) {
    for (const event of events.get(message) ?? []) {
      const { item, result } = event;
      if (
        item.type === "user_prompt" ||
        (item.type === "system" && item.subtype === "compact_boundary")
      ) {
        turn++;
        state.cursor = undefined;
        state.activated = undefined;
        state.declarations = new Map();
      } else if (item.type === "text") {
        annotations.set(
          item,
          scanWorkflowText(
            item.text,
            state.cursor,
            false,
            item.isStreaming === true,
            state,
            schemaFiles,
          ),
        );
      } else if (item.type === "tool_call") {
        if (!result) {
          const cursor = state.cursor;
          calls.set(item, { cursor, turn });
          if (cursor?.path)
            annotations.set(item, {
              markers: [],
              parent: { path: cursor.path, title: stage(cursor).title },
            });
        } else {
          const call = calls.get(item);
          if (call?.turn === turn && item.toolResult) {
            const parts = toolOutputParts(item);
            const complete = item.status !== "pending";
            if (parts.some((part) => initialAcliFormat(part, complete))) {
              const context = captureToolContext(
                call.cursor,
                state,
                schemaFiles,
              );
              const jsonDeclared =
                item.toolName !== "Exec" &&
                parts.some(
                  (part) => initialAcliFormat(part, complete) === "json",
                );
              const streams = parts.map((part, index) =>
                new AcliStreamDecoder("unknown")
                  .appendSnapshot(
                    part,
                    complete,
                    item.toolName === "Exec"
                      ? initialAcliFormat(part, complete) === "json"
                      : index === 0 && jsonDeclared,
                  )
                  .flatMap(({ id, record }) =>
                    acliRecordFragments(`${index}:${id}`, record),
                  ),
              );
              const projection = projectWorkflowFragments(
                streams,
                context,
                state,
              );
              annotations.set(item, {
                ...projection.combined,
                toolContext: context,
              });
              continue;
            }
            const text = parts.join("\n");
            const annotation: WorkflowAnnotation = {
              markers: [],
              outputBoundaries: [],
            };
            const visibleRanges: NonNullable<
              WorkflowAnnotation["visibleRanges"]
            > = [];
            let offset = 0;
            for (const part of parts) {
              annotation.outputBoundaries!.push(offset);
              // Each result owns its fences and local activation. Joining
              // first would let one command reinterpret a sibling's stdout.
              const current = scanWorkflowText(
                part,
                call.cursor,
                true,
                item.status === "pending",
                state,
                schemaFiles,
              );
              annotation.parent = current.parent;
              if (current.view) annotation.view = current.view;
              annotation.markers.push(
                ...current.markers.map((marker) => ({
                  ...marker,
                  start: marker.start + offset,
                  end: marker.end + offset,
                })),
              );
              for (const range of current.visibleRanges ?? [
                { start: 0, end: part.length },
              ]) {
                visibleRanges.push({
                  start: range.start + offset,
                  end: range.end + offset,
                });
              }
              if (offset + part.length < text.length)
                visibleRanges.push({
                  start: offset + part.length,
                  end: offset + part.length + 1,
                });
              offset += part.length + 1;
            }
            if (annotation.view) annotation.visibleRanges = visibleRanges;
            if (annotation.view && text !== item.toolResult.content)
              annotation.outputText = text;
            annotations.set(item, annotation);
          }
        }
      }
    }
  }
  return items.map((item) => {
    const workflow = annotations.get(item);
    return workflow &&
      (workflow.markers.length ||
        workflow.parent ||
        workflow.view ||
        workflow.toolContext)
      ? { ...item, workflow }
      : item;
  });
}
