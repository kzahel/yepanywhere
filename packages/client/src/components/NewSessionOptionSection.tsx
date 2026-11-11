import type { ReactNode } from "react";
import optionStyles from "./NewSessionOptionsPanel.module.css";
import styles from "./NewSessionForm.module.css";

interface NewSessionOptionSectionProps {
  caption?: string;
  children: ReactNode;
  className: string | undefined;
  showCaption: boolean;
  title: string;
  placeholder?: boolean;
}

/**
 * One titled section of the New Session options, with its caption shown
 * below or as a tooltip. A placeholder keeps the layout but is inert.
 */
export function NewSessionOptionSection({
  caption,
  children,
  className,
  showCaption,
  title,
  placeholder = false,
}: NewSessionOptionSectionProps) {
  return (
    <div
      className={`${className}${placeholder ? ` ${styles.optionPlaceholder}` : ""}`}
      data-new-session-helper-section={
        className
          ?.split(" ")
          .includes(optionStyles.newSessionHelperSection ?? "") || undefined
      }
      data-new-session-provider-section={
        className
          ?.split(" ")
          .includes(optionStyles.newSessionProviderSection ?? "") || undefined
      }
      data-new-session-model-section={
        className
          ?.split(" ")
          .includes(optionStyles.newSessionModelSection ?? "") || undefined
      }
      data-new-session-model-field={
        className
          ?.split(" ")
          .includes(optionStyles.newSessionModelField ?? "") || undefined
      }
      data-new-session-mode-section={
        className
          ?.split(" ")
          .includes(optionStyles.newSessionModeSection ?? "") || undefined
      }
      title={showCaption ? undefined : caption}
      aria-hidden={placeholder || undefined}
      inert={placeholder || undefined}
    >
      <h3>{title}</h3>
      {children}
      {showCaption && caption && (
        <p className={styles.optionCaption}>{caption}</p>
      )}
    </div>
  );
}
