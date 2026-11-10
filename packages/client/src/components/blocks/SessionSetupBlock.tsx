import styles from "./SessionSetupBlock.module.css";
import collapsibleStyles from "../Collapsible.module.css";
import { memo } from "react";
import type { ContentBlock } from "../../types";
import { UserPromptBlock } from "./UserPromptBlock";

interface Props {
  title: string;
  prompts: Array<string | ContentBlock[]>;
}

function getPromptKey(prompt: string | ContentBlock[]): string {
  if (typeof prompt === "string") {
    return `s:${prompt.length}:${prompt.slice(0, 80)}`;
  }

  const text = prompt
    .filter(
      (block): block is ContentBlock & { type: "text"; text: string } =>
        block.type === "text" && typeof block.text === "string",
    )
    .map((block) => block.text)
    .join("\n");

  return `a:${prompt.length}:${text.length}:${text.slice(0, 80)}`;
}

export const SessionSetupBlock = memo(function SessionSetupBlock({
  title,
  prompts,
}: Props) {
  const promptKeyCounts = new Map<string, number>();

  return (
    <details className={`${styles.sessionSetupBlock}`} data-session-setup-block>
      <summary
        className={collapsibleStyles.collapsibleSummary}
        data-collapsible__summary
      >
        <span
          className={collapsibleStyles.collapsibleIcon}
          data-collapsible__icon
        >
          ▸
        </span>
        <span>{title}</span>
      </summary>
      <div
        className={collapsibleStyles.collapsibleContent}
        data-collapsible__content
      >
        {prompts.map((prompt) => {
          const baseKey = getPromptKey(prompt);
          const count = (promptKeyCounts.get(baseKey) ?? 0) + 1;
          promptKeyCounts.set(baseKey, count);
          return (
            <div
              className={styles.sessionSetupEntry}
              data-session-setup-entry
              key={`${baseKey}:${count}`}
            >
              <UserPromptBlock content={prompt} />
            </div>
          );
        })}
      </div>
    </details>
  );
});
