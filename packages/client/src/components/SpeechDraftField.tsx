import type { ReactNode } from "react";
import type { SpeechTranscriptInsertionParts } from "../lib/speechRecognition";

/**
 * A message box's textarea with the interim speech mirror drawn over it and
 * the tentative-transcript status line below. Shared by the new-session and
 * in-session boxes (docs/tactical/178-shared-composer-dictation.md slice 3);
 * the box passes its textarea as `children`.
 */
export function SpeechDraftField({
  interimDisplayTranscript,
  interimInsertion,
  interimTranscript,
  children,
}: {
  interimDisplayTranscript: string;
  interimInsertion: SpeechTranscriptInsertionParts;
  interimTranscript: string;
  children: ReactNode;
}) {
  return (
    <div
      className={`speech-draft-field ${
        interimDisplayTranscript ? "has-interim" : ""
      }`}
    >
      <div className="speech-draft-inline">
        {interimDisplayTranscript && (
          <div className="speech-draft-mirror" aria-hidden="true">
            <span>{interimInsertion.before}</span>
            {interimInsertion.separatorBefore}
            <span className="speech-interim-inline">
              {interimInsertion.transcript}
            </span>
            <span className="speech-interim-caret" />
            {interimInsertion.separatorAfter}
            <span>{interimInsertion.after}</span>
          </div>
        )}
        {children}
      </div>
      {interimTranscript && (
        <div
          className="speech-interim-status"
          role="status"
          aria-live="polite"
          aria-label="Tentative speech transcript"
        >
          {interimTranscript}
        </div>
      )}
    </div>
  );
}
