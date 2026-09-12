import {
  AcliStreamDecoder,
  initialAcliFormat,
  acliRecordFragments,
  type AcliOutputFragment,
  getAcliContext,
  type AcliRecord,
} from "@yep-anywhere/shared";
import {
  projectWorkflowFragments,
  workflowCommentarySegments,
  type WorkflowAnnotation,
  type WorkflowMarker,
  type WorkflowToolContext,
} from "@yep-anywhere/shared/transcript/workflowTags";

export interface PresentedCommentary {
  id: string;
  text: string;
  html: string;
  getContext: (() => string) | null;
  workflow?: WorkflowAnnotation;
  segments?: Array<{ text: string; html: string; marker?: WorkflowMarker }>;
}

export interface AcliOutputProjection {
  stdout: string;
  stderr: string;
  commentary: PresentedCommentary[];
  failed: boolean;
  complete: boolean;
  fragments: { stdout: AcliOutputFragment[]; stderr: AcliOutputFragment[] };
  workflow?: WorkflowAnnotation;
}

interface PendingRecord {
  id: string;
  record: AcliRecord;
  stream: OutputStream;
  getPreviousContext: (() => string) | null;
}

class OutputStream {
  decoder: AcliStreamDecoder;
  data: string[] = [];
  fragments: AcliOutputFragment[] = [];
  constructor(
    readonly channel: "stdout" | "stderr",
    sequenced = true,
  ) {
    this.decoder = new AcliStreamDecoder(sequenced ? channel : "unknown");
  }
}

/** One invocation owns framing, context, render ordering, and publication. */
export class AcliToolOutput {
  private stdout: OutputStream;
  private stderr = new OutputStream("stderr");
  private finished = false;
  private records: PendingRecord[] = [];
  private active = false;
  private stopped = false;
  private projection: AcliOutputProjection = {
    stdout: "",
    stderr: "",
    commentary: [],
    failed: false,
    complete: false,
    fragments: { stdout: [], stderr: [] },
  };

  constructor(
    private render: (texts: string[]) => Promise<string[]>,
    private publish: (projection: AcliOutputProjection) => void,
    cached?: {
      source: string;
      stderr: string;
      projection: AcliOutputProjection;
    },
    stdoutSequenced = true,
    private workflowContext?: WorkflowToolContext,
  ) {
    this.stdout = new OutputStream("stdout", stdoutSequenced);
    if (cached) {
      this.stdout.decoder.source = cached.source;
      this.stderr.decoder.source = cached.stderr;
      this.finished = true;
      this.projection = cached.projection;
    }
  }

  appendSnapshot(source: string, complete: boolean, stderr = ""): boolean {
    if (this.stopped) return false;
    for (const [stream, text] of [
      [this.stdout, source],
      [this.stderr, stderr],
    ] as const)
      if (
        !text.startsWith(stream.decoder.source) ||
        (this.finished && text !== stream.decoder.source)
      )
        return false;
    if (this.finished) return true;
    const jsonDeclared = [source, stderr].some(
      (text) => initialAcliFormat(text, complete) === "json",
    );
    this.appendStream(this.stdout, source, complete, jsonDeclared);
    this.appendStream(this.stderr, stderr, complete, false);
    this.finished = complete;
    if (
      this.finished &&
      !this.active &&
      this.records.length === 0 &&
      !this.projection.complete
    ) {
      this.projection = { ...this.projection, complete: true };
      this.publish(this.projection);
    }
    void this.drain();
    return true;
  }

  private appendStream(
    stream: OutputStream,
    source: string,
    complete: boolean,
    jsonDeclared: boolean,
  ) {
    for (const decoded of stream.decoder.appendSnapshot(
      source,
      complete,
      jsonDeclared,
    )) {
      this.records.push({
        ...decoded,
        id: `${stream.channel}:${decoded.id}`,
        stream,
      });
    }
  }

  stop() {
    this.stopped = true;
    this.records = [];
  }

  private async drain(): Promise<void> {
    if (this.active || this.stopped || this.records.length === 0) return;
    this.active = true;
    try {
      while (!this.stopped && this.records.length > 0) {
        const batch = this.records.splice(0);
        const workflow = this.workflowContext
          ? projectWorkflowFragments(
              [this.stdout, this.stderr].map((stream) => [
                ...stream.fragments,
                ...batch
                  .filter((entry) => entry.stream === stream)
                  .flatMap(({ id, record }) => acliRecordFragments(id, record)),
              ]),
              this.workflowContext,
            )
          : undefined;
        const prepared = new Map(
          batch.flatMap(({ id, record }) =>
            record.commentary.map((item) => {
              const key = `${id}:${item.id}`;
              const annotation = workflow?.commentary[key];
              return [
                key,
                annotation
                  ? workflowCommentarySegments(item.text, annotation)
                  : [{ text: item.text }],
              ] as const;
            }),
          ),
        );
        const texts = [...prepared.values()].flatMap((parts) =>
          parts.filter((part) => part.text.trim()).map((part) => part.text),
        );
        let html: string[] | null;
        try {
          html = texts.length ? await this.render(texts) : [];
          if (html.length !== texts.length)
            throw new Error("Incomplete commentary rendering");
        } catch {
          html = null;
        }
        if (this.stopped) return;
        let index = 0;
        const commentary = [...this.projection.commentary];
        for (const { id, record, stream, getPreviousContext } of batch) {
          if (!html) {
            stream.data.push(record.source);
            stream.fragments.push({
              id,
              text: record.source,
              kind: "data",
              opaque: record.json,
            });
            continue;
          }
          stream.fragments.push(...acliRecordFragments(id, record));
          if (!record.metadataOnly) stream.data.push(record.data);
          for (const item of record.commentary) {
            const key = `${id}:${item.id}`;
            const segments = prepared.get(key)!.map((part) => ({
              ...part,
              html: part.text.trim() ? html[index++]! : "",
            }));
            commentary.push({
              id: key,
              text: item.text,
              html: segments.map((part) => part.html).join(""),
              ...(workflow
                ? { workflow: workflow.commentary[key], segments }
                : {}),
              getContext: item.context
                ? () => getAcliContext(record, item)!
                : record.metadataOnly
                  ? getPreviousContext
                  : null,
            });
          }
        }
        this.projection = {
          stdout: this.stdout.data.join(""),
          stderr: this.stderr.data.join(""),
          commentary,
          failed: this.projection.failed || html === null,
          complete: this.finished && this.records.length === 0,
          fragments: {
            stdout: [...this.stdout.fragments],
            stderr: [...this.stderr.fragments],
          },
          workflow: html
            ? workflow?.data
            : this.workflowContext
              ? projectWorkflowFragments(
                  [this.stdout.fragments, this.stderr.fragments],
                  this.workflowContext,
                ).data
              : undefined,
        };
        this.publish(this.projection);
      }
    } finally {
      this.active = false;
    }
  }
}
