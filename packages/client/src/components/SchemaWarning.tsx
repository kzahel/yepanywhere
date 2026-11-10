import styles from "./SchemaWarning.module.css";
import { useCallback, useState } from "react";
import type { ZodError } from "zod";
import { useI18n } from "../i18n";
import { Dialog } from "./ui/Dialog";

interface SchemaWarningProps {
  toolName: string;
  errors: ZodError;
}

/**
 * Format Zod errors into structured data for display.
 * Groups missing/invalid fields for clear presentation.
 */
function formatErrors(errors: ZodError): {
  missing: string[];
  invalid: Array<{ path: string; message: string }>;
} {
  const issues = errors.issues;
  const missing: string[] = [];
  const invalid: Array<{ path: string; message: string }> = [];

  for (const issue of issues) {
    const path = issue.path.join(".") || "(root)";
    if (
      issue.code === "invalid_type" &&
      issue.message.toLowerCase().includes("required")
    ) {
      missing.push(path);
    } else {
      invalid.push({ path, message: issue.message });
    }
  }

  return { missing, invalid };
}

const GITHUB_ISSUES_URL = "https://github.com/kzahel/yepanywhere/issues/new";

/**
 * Build a GitHub issue URL with pre-filled title and body for schema validation errors.
 */
function buildIssueUrl(
  toolName: string,
  missing: string[],
  invalid: Array<{ path: string; message: string }>,
): string {
  const title = `Schema validation error: ${toolName}`;

  const bodyParts: string[] = [`## Tool\n\n\`${toolName}\``];

  if (missing.length > 0) {
    bodyParts.push(
      `## Missing fields\n\n${missing.map((f) => `- \`${f}\``).join("\n")}`,
    );
  }

  if (invalid.length > 0) {
    bodyParts.push(
      `## Invalid fields\n\n${invalid.map(({ path, message }) => `- \`${path}\`: ${message}`).join("\n")}`,
    );
  }

  bodyParts.push(
    "## Context\n\n<!-- Please add any additional context here, such as what you were doing when this occurred -->",
  );

  const body = bodyParts.join("\n\n");

  const params = new URLSearchParams({
    title,
    body,
    labels: "bug,schema",
  });

  return `${GITHUB_ISSUES_URL}?${params.toString()}`;
}

/**
 * Small warning badge that appears on tool results that fail schema validation.
 * Clicking opens a modal with detailed error information.
 * Uses a span with role="button" to avoid nested button issues when rendered
 * inside clickable containers.
 */
export function SchemaWarning({ toolName, errors }: SchemaWarningProps) {
  const { t } = useI18n();
  const [isModalOpen, setIsModalOpen] = useState(false);
  const { missing, invalid } = formatErrors(errors);
  const issueUrl = buildIssueUrl(toolName, missing, invalid);

  const handleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setIsModalOpen(true);
  }, []);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      e.stopPropagation();
      setIsModalOpen(true);
    }
  }, []);

  const handleClose = useCallback(() => {
    setIsModalOpen(false);
  }, []);

  return (
    <>
      <span
        role="button"
        tabIndex={0}
        className={styles.schemaWarning}
        data-schema-warning
        onClick={handleClick}
        onKeyDown={handleKeyDown}
        title={t("schemaWarningTooltip" as never, { tool: toolName })}
      >
        <span
          className={styles.schemaWarningIcon}
          data-schema-warning-icon
          aria-hidden="true"
        >
          !
        </span>
      </span>
      {isModalOpen && (
        <Dialog
          title={t("schemaWarningTitle" as never, { tool: toolName })}
          size="medium"
          onClose={handleClose}
          footerStart={
            <a
              href={issueUrl}
              target="_blank"
              rel="noopener noreferrer"
              className={styles.schemaWarningReportLink}
              data-schema-warning-report-link
              onClick={(e) => e.stopPropagation()}
            >
              {t("schemaWarningReport" as never)}
            </a>
          }
        >
          {missing.length > 0 && (
            <div
              className={styles.schemaWarningSection}
              data-schema-warning-section
            >
              <div
                className={styles.schemaWarningSectionTitle}
                data-schema-warning-section-title
              >
                {t("schemaWarningMissing" as never)}
              </div>
              <ul className={styles.schemaWarningList} data-schema-warning-list>
                {missing.map((field) => (
                  <li
                    key={field}
                    className={styles.schemaWarningItem}
                    data-schema-warning-item
                  >
                    <code>{field}</code>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {invalid.length > 0 && (
            <div
              className={styles.schemaWarningSection}
              data-schema-warning-section
            >
              <div
                className={styles.schemaWarningSectionTitle}
                data-schema-warning-section-title
              >
                {t("schemaWarningInvalid" as never)}
              </div>
              <ul className={styles.schemaWarningList} data-schema-warning-list>
                {invalid.map(({ path, message }) => (
                  <li
                    key={path}
                    className={styles.schemaWarningItem}
                    data-schema-warning-item
                  >
                    <code>{path}</code>
                    <span
                      className={styles.schemaWarningMessage}
                      data-schema-warning-message
                    >
                      {message}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Dialog>
      )}
    </>
  );
}
