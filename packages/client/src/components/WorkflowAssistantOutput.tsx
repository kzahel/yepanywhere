import {
  ACLI_COMMENTARY_RENDERING_CAPABILITY,
  serverHasCapability,
} from "@yep-anywhere/shared";
import { Fragment, type ReactNode, useEffect, useMemo, useState } from "react";
import { usePublicShareContext } from "../contexts/PublicShareContext";
import { useOptionalSessionMetadata } from "../contexts/SessionMetadataContext";
import { useCurrentSourceRuntime } from "../contexts/SourceRuntimeContext";
import { useRetainedVersionInfo } from "../hooks/useVersion";
import { renderCommentary } from "../lib/renderCommentary";
import {
  type WorkflowAnnotation,
  workflowCommentarySegments,
} from "@yep-anywhere/shared/transcript/workflowTags";
import { WorkflowBoundary, WorkflowOutput } from "./WorkflowOutput";

export function WorkflowAssistantOutput({
  text,
  workflow,
  isStreaming,
  original,
  renderText,
}: {
  text: string;
  workflow: WorkflowAnnotation;
  isStreaming?: boolean;
  original: ReactNode;
  renderText: (text: string, html: string) => ReactNode;
}) {
  const runtime = useCurrentSourceRuntime();
  const metadata = useOptionalSessionMetadata();
  const publicShare = usePublicShareContext();
  const version = useRetainedVersionInfo(runtime.sourceKey);
  const projectId = metadata?.projectId;
  const supported =
    !publicShare &&
    !!projectId &&
    !!version &&
    serverHasCapability(version, ACLI_COMMENTARY_RENDERING_CAPABILITY);
  const segments = workflowCommentarySegments(text, workflow);
  const textsKey = JSON.stringify(
    segments.map((segment) => segment.text).filter((part) => part.trim()),
  );
  const texts: string[] = useMemo(() => JSON.parse(textsKey), [textsKey]);
  const requestKey = JSON.stringify([
    runtime.sourceKey,
    projectId,
    metadata?.sessionId,
    textsKey,
  ]);
  const [rendered, setRendered] = useState<{
    key: string;
    html: string[];
  } | null>(null);

  useEffect(() => {
    if (!supported || !projectId || isStreaming) return;
    const abort = new AbortController();
    void renderCommentary(runtime, projectId, texts, abort.signal).then(
      (html) => {
        if (!abort.signal.aborted) setRendered({ key: requestKey, html });
      },
      () => {
        // Failed rendering retains the ordinary assistant renderer.
        if (!abort.signal.aborted) setRendered(null);
      },
    );
    return () => abort.abort();
  }, [runtime, projectId, supported, isStreaming, texts, requestKey]);

  if (!supported || isStreaming || rendered?.key !== requestKey)
    return original;

  let index = 0;
  return (
    <WorkflowOutput
      text={text}
      workflow={workflow}
      original={original}
      preview={segments.map((segment, segmentIndex) => (
        <Fragment key={segmentIndex}>
          {segment.marker ? <WorkflowBoundary marker={segment.marker} /> : null}
          {segment.text.trim()
            ? renderText(segment.text, rendered.html[index++]!)
            : null}
        </Fragment>
      ))}
    />
  );
}
