import type { toolDisplayContracts } from "./toolDisplayContracts";
import { decodeCodeModeOutput } from "@yep-anywhere/shared";
import { useI18n } from "../../../i18n";
import { ToolOutputText } from "../../ToolOutputText";
import { isAcliMetadata } from "../../../lib/toolOutputPresentation";
import styles from "./CodeModeOutput.module.css";
import { formatCommandDuration } from "@yep-anywhere/shared/transcript/shellToolOutput";

type CodeModeExecInput = import("zod").z.output<
  typeof toolDisplayContracts.Exec.input
>;
type CodeModeCall = CodeModeExecInput["calls"][number];
export function isCodeModeExecInput(
  input: CodeModeExecInput | undefined,
): input is CodeModeExecInput {
  return input !== undefined;
}

export function getCallPreview(call: CodeModeCall): string {
  if (
    call.toolName === "exec_command" &&
    call.input &&
    typeof call.input === "object"
  ) {
    const command = call.input.cmd;
    if (typeof command === "string" && command.trim()) {
      return command.trim();
    }
  }
  return call.toolName;
}

export function getCallCountSummary(
  input: CodeModeExecInput | undefined,
): string {
  if (!isCodeModeExecInput(input) || input.calls.length === 0) {
    return "done";
  }
  const noun = input.calls.every((call) => call.toolName === "exec_command")
    ? "command"
    : "tool call";
  const skills = [
    ...new Set(
      input.calls.flatMap((call) => {
        const skill = getSkillRead(call);
        return skill ? [`${skill.name}/SKILL.md`] : [];
      }),
    ),
  ];
  const count = `${input.calls.length} ${noun}${input.calls.length === 1 ? "" : "s"}`;
  return skills.length ? `${skills.join(", ")} · ${count}` : count;
}

// Only recognize a literal leading cat operand, never a path mentioned in code
// or a search query. A trailing command keeps the parent an ordinary Exec.
export function getSkillRead(call: CodeModeCall) {
  if (call.toolName !== "exec_command") return undefined;
  const match =
    /^cat\s+(?:'([^']+)'|"([^"$`]+)"|([^\s;|&<>"'$`]+))(?=\s|;|$)([\s\S]*)$/.exec(
      getCallPreview(call),
    );
  if (!match) return undefined;
  const path = match[1] ?? match[2] ?? match[3] ?? "";
  const segments = path.split(/[\\/]/);
  const name = segments.at(-2);
  if (!name || segments.at(-1) !== "SKILL.md") return undefined;
  return { name, onlyRead: /^\s*;?\s*$/.test(match[4] ?? "") };
}

function readSkillDocument(text: string) {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!frontmatter) return undefined;
  const name = /^name:\s*([\w.-]+)\s*$/m.exec(frontmatter[1] ?? "")?.[1];
  if (!name) return undefined;
  const description = /^description:[ \t]*(.+)$/m.exec(
    frontmatter[1] ?? "",
  )?.[1];
  return { name, description };
}

export function CodeModeOutput({
  result,
  isError,
  input,
  shellMetadata = false,
}: {
  shellMetadata?: boolean;
  result: unknown;
  isError: boolean;
  input?: CodeModeExecInput;
}) {
  const { t } = useI18n();
  const raw =
    typeof result === "string" ? result : JSON.stringify(result, null, 2);
  const decoded = decodeCodeModeOutput(result);
  const readsSkill =
    isCodeModeExecInput(input) &&
    input.calls.some((call) => getSkillRead(call));
  if (!decoded) {
    return (
      <pre className={`${styles.text} ${isError ? styles.error : ""}`}>
        {raw}
      </pre>
    );
  }
  return (
    <div className={`${styles.output} ${isError ? styles.error : ""}`}>
      {decoded.parts.map((part, index) => {
        const command = part.kind === "command-output" ? part : undefined;
        const { text } = part;
        const skill = readsSkill ? readSkillDocument(text) : undefined;
        const documentTitle = skill
          ? t("codeModeExecSkill", { name: skill.name })
          : isAcliMetadata(text.split("\n", 1)[0] ?? "")
            ? undefined
            : /^# ([^\r\n]+)\r?\n/.exec(text)?.[1];
        if (part.kind === "script-status") {
          return (
            <p className={styles.metadata} key={index}>
              {text}
            </p>
          );
        }
        const metadata = [
          command?.exitCode !== undefined &&
          (!shellMetadata || command.exitCode !== 0)
            ? shellMetadata
              ? `rc=${command.exitCode}`
              : t("codeModeExecExitCode", { code: command.exitCode })
            : "",
          command?.durationSeconds !== undefined
            ? formatCommandDuration(command.durationSeconds)
            : "",
        ]
          .filter(Boolean)
          .join(" · ");
        return (
          <div
            key={index}
            className={command?.exitCode ? styles.error : undefined}
          >
            {metadata && <p className={styles.metadata}>{metadata}</p>}
            {documentTitle ? (
              <details className={styles.document}>
                <summary className={styles.summary}>{documentTitle}</summary>
                {skill?.description && (
                  <p className={styles.description}>{skill.description}</p>
                )}
                <pre className={styles.text}>{text}</pre>
              </details>
            ) : (
              <pre className={styles.text}>
                <ToolOutputText text={text} />
              </pre>
            )}
          </div>
        );
      })}
      <details className={styles.document}>
        <summary className={styles.summary}>{t("codeModeExecRaw")}</summary>
        {isCodeModeExecInput(input) && (
          <pre className={styles.text}>{input.source}</pre>
        )}
        <pre className={styles.text}>{raw}</pre>
      </details>
    </div>
  );
}
