import collapsibleStyles from "../../Collapsible.module.css";
import { toolDisplayContracts } from "./toolDisplayContracts";
import { defineTool } from "./defineTool";
import styles from "./ExitPlanModeRenderer.module.css";
import { useSessionAppLinksHtml } from "../../SessionAppLinks";
import { InnerHtml } from "../../ui/InnerHtml";

/** Renders the plan content (markdown or plain text) */
function PlanContent({
  plan,
  renderedHtml,
}: {
  plan?: string;
  renderedHtml?: string;
}) {
  const rewrittenHtml = useSessionAppLinksHtml(renderedHtml ?? "");
  if (renderedHtml) {
    // Server-rendered markdown with Shiki highlighting is safe.
    return <InnerHtml trustedHtml={rewrittenHtml} />;
  }

  // Fallback to plain text when server-rendered HTML is not available
  return (
    <pre style={{ whiteSpace: "pre-wrap", fontFamily: "inherit" }}>{plan}</pre>
  );
}

export const exitPlanModeRenderer = defineTool(
  toolDisplayContracts.ExitPlanMode,
  {
    tool: "ExitPlanMode",

    // These are required by the interface but won't be used since renderInline takes over
    renderToolUse() {
      return null;
    },

    renderToolResult(result, isError) {
      if (isError) return <div className={styles.error}>{result.message}</div>;
      return (
        <PlanContent
          plan={result.plan ?? result.message}
          renderedHtml={result._renderedHtml}
        />
      );
    },

    // Render inline without any tool-row wrapper - full control over rendering
    renderInline(input, result, isError, status) {
      const planInput = input;
      const planResult = result;

      // Get plan content from input (tool_use) or result (tool_result)
      const plan: string | undefined = planInput?.plan || planResult?.plan;

      // Get pre-rendered HTML from server (if available)
      const renderedHtml: string | undefined =
        planInput?._renderedHtml || planResult?._renderedHtml;

      if (isError) {
        // Result can be a plain string or an object with message field
        let errorMessage = "Exit plan mode failed";
        if (typeof result === "string") {
          errorMessage = result;
        } else if (typeof result === "object" && result !== null) {
          const errorResult = "message" in result ? result : undefined;
          if (errorResult?.message) {
            errorMessage = String(errorResult.message);
          }
        }
        return <div className={styles.error}>{errorMessage}</div>;
      }

      // Show "Planning..." only if we don't have plan content yet
      if (!plan && !renderedHtml) {
        if (status === "pending") {
          return <div className={styles.pending}>Planning...</div>;
        }
        return null;
      }

      // Wrap in collapsible details element - expanded by default
      // Uses the same styling as ThinkingBlock for consistency
      return (
        <details className={`${styles.root}`} open>
          <summary
            className={collapsibleStyles.collapsibleSummary}
            data-collapsible__summary
          >
            <span>{status === "pending" ? "Planning..." : "Plan"}</span>
            <span
              className={collapsibleStyles.collapsibleIcon}
              data-collapsible__icon
            >
              ▸
            </span>
          </summary>
          <div
            className={collapsibleStyles.collapsibleContent}
            data-collapsible__content
          >
            <div className={styles.inline}>
              <PlanContent plan={plan} renderedHtml={renderedHtml} />
            </div>
          </div>
        </details>
      );
    },

    getUseSummary(_input) {
      return "Exit plan mode";
    },

    getResultSummary(_result, isError) {
      if (isError) return "Error";
      return "Plan";
    },
  },
);
