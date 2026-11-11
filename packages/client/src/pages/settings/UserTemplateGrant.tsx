import type { TemplateCreationGrant } from "@yep-anywhere/shared";
import { Banner } from "../../components/ui/Banner";
import { Checkbox } from "../../components/ui/Checkbox";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { useProjectTemplateChoices } from "../../hooks/useProjectTemplateChoices";
import { useI18n } from "../../i18n";
import styles from "./UserTemplateGrant.module.css";

export function UserTemplateGrant({
  value,
  onChange,
}: {
  value: TemplateCreationGrant;
  onChange: (value: TemplateCreationGrant) => void;
}) {
  const { choices, error } = useProjectTemplateChoices(true);
  const { t } = useI18n();
  const selected = value.mode === "selected" ? value.templates : [];
  const templates = choices?.templates ?? [];
  const unavailable = selected.filter(
    (item) =>
      !templates.some(
        (choice) =>
          choice.sourceId === item.sourceId && choice.id === item.templateId,
      ),
  );
  return (
    <fieldset className={styles.grant}>
      <legend>{t("usersTemplatesHeading")}</legend>
      <SegmentedControl
        aria-label={t("usersTemplatesHeading")}
        activation="manual"
        value={value.mode}
        options={(["none", "selected", "any"] as const).map((mode) => ({
          value: mode,
          label: t(`usersTemplates_${mode}`),
        }))}
        onChange={(mode) =>
          onChange(
            mode === "selected" ? { mode, templates: selected } : { mode },
          )
        }
      />
      {value.mode === "selected" && (
        <div className={styles.choices}>
          {[
            ...templates.map((item) => ({
              sourceId: item.sourceId,
              templateId: item.id,
              title: item.title,
              icon: item.icon,
            })),
            ...unavailable.map((item) => ({
              ...item,
              title: `${item.sourceId}/${item.templateId} (${t("usersTemplateUnavailable")})`,
              icon: undefined,
            })),
          ].map((item) => {
            const checked = selected.some(
              (entry) =>
                entry.sourceId === item.sourceId &&
                entry.templateId === item.templateId,
            );
            return (
              <Checkbox
                variant="row"
                key={`${item.sourceId}/${item.templateId}`}
                label={
                  <span className={styles.template}>
                    {item.icon && (
                      <img src={item.icon} alt="" width="24" height="24" />
                    )}
                    {item.title}
                  </span>
                }
                description={item.sourceId}
                checked={checked}
                onCheckedChange={() =>
                  onChange({
                    mode: "selected",
                    templates: checked
                      ? selected.filter(
                          (entry) =>
                            entry.sourceId !== item.sourceId ||
                            entry.templateId !== item.templateId,
                        )
                      : [
                          ...selected,
                          {
                            sourceId: item.sourceId,
                            templateId: item.templateId,
                          },
                        ],
                  })
                }
              />
            );
          })}
          {templates.length === 0 && <p>{t("templateNoReady")}</p>}
        </div>
      )}
      <p>{t("usersTemplatesHint")}</p>
      {error && <Banner tone="error">{error}</Banner>}
    </fieldset>
  );
}
