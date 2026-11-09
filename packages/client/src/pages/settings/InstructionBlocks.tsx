import { MAX_INSTRUCTION_BLOCKS } from "@yep-anywhere/shared";
import { Button, IconButton } from "../../components/ui/Button";
import { Textarea } from "../../components/ui/Field";
import { useI18n } from "../../i18n";
import { generateUUID } from "../../lib/uuid";
import styles from "./InstructionBlocks.module.css";

export interface InstructionBlockDraft {
  id: string;
  text: string;
}

export function instructionBlockDrafts(
  blocks: string[],
): InstructionBlockDraft[] {
  return blocks.map((text) => ({ id: generateUUID(), text }));
}

export function InstructionBlocks({
  value,
  onChange,
  disabled = false,
}: {
  value: InstructionBlockDraft[];
  onChange: (value: InstructionBlockDraft[]) => void;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  function move(index: number, direction: number) {
    const next = [...value];
    const other = index + direction;
    [next[index], next[other]] = [next[other]!, next[index]!];
    onChange(next);
  }
  return (
    <div className={styles.blocks}>
      {value.length === 0 && (
        <p className={styles.hint}>{t("usersInstructionsEmpty")}</p>
      )}
      {value.map((block, index) => (
        <div className={styles.block} key={block.id}>
          <Textarea
            className={styles.text}
            aria-label={t("usersInstructionLabel", { number: index + 1 })}
            rows={3}
            value={block.text}
            disabled={disabled}
            placeholder={t("usersInstructionPlaceholder")}
            onChange={(event) =>
              onChange(
                value.map((item) =>
                  item.id === block.id
                    ? { ...item, text: event.target.value }
                    : item,
                ),
              )
            }
          />
          <div className={styles.tools}>
            <IconButton
              disabled={disabled}
              label={t("usersInstructionRemove", { number: index + 1 })}
              onClick={() =>
                onChange(value.filter((item) => item.id !== block.id))
              }
            >
              ×
            </IconButton>
            {value.length > 1 && (
              <>
                <IconButton
                  disabled={disabled || index === 0}
                  label={t("usersInstructionUp", { number: index + 1 })}
                  onClick={() => move(index, -1)}
                >
                  ↑
                </IconButton>
                <IconButton
                  disabled={disabled || index === value.length - 1}
                  label={t("usersInstructionDown", { number: index + 1 })}
                  onClick={() => move(index, 1)}
                >
                  ↓
                </IconButton>
              </>
            )}
          </div>
        </div>
      ))}
      <Button
        disabled={disabled || value.length >= MAX_INSTRUCTION_BLOCKS}
        onClick={() => onChange([...value, ...instructionBlockDrafts([""])])}
      >
        {t("usersInstructionAdd")}
      </Button>
    </div>
  );
}
