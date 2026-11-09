import { type ReactNode, useState } from "react";
import { useTooltipTrigger } from "../hooks/useTooltipTrigger";
import styles from "./RiskAffordance.module.css";
import { ButtonBase } from "./ui/Button";
import { Dialog } from "./ui/Dialog";

/**
 * The "what's the risk?" affordance shared by the external-session (amber) and
 * pending-tool (blue) banners: a link that reveals a hedged risk explanation on
 * hover (tooltip) and on click (modal). Both banners hang it off their elapsed
 * "… ago" text rather than a separate link, to keep the banner short. The same
 * `explanation` node renders in both the tooltip and the modal.
 */
export function RiskAffordance({
  label,
  labelClassName,
  modalTitle,
  explanation,
}: {
  label: ReactNode;
  labelClassName?: string;
  modalTitle: ReactNode;
  explanation: ReactNode;
}) {
  const [showModal, setShowModal] = useState(false);
  const [showTooltip, setShowTooltip] = useState(false);
  const tooltipTrigger = useTooltipTrigger({
    open: showTooltip,
    onOpenChange: setShowTooltip,
  });
  return (
    <span
      className={`${styles.root}${
        showTooltip ? ` ${styles.tooltipVisible}` : ""
      }`}
      onPointerEnter={tooltipTrigger.onPointerEnter}
      onPointerMove={tooltipTrigger.onPointerMove}
      onPointerLeave={tooltipTrigger.onPointerLeave}
    >
      <ButtonBase
        className={`${styles.link}${
          labelClassName ? ` ${labelClassName}` : ""
        }`}
        aria-haspopup="dialog"
        onFocus={tooltipTrigger.onFocus}
        onBlur={tooltipTrigger.onBlur}
        onClick={() => {
          tooltipTrigger.close();
          setShowModal(true);
        }}
      >
        {label}
      </ButtonBase>
      {showTooltip && (
        <div className={styles.tooltip} role="tooltip">
          {explanation}
        </div>
      )}
      {showModal && (
        <Dialog
          title={modalTitle}
          size="medium"
          onClose={() => setShowModal(false)}
        >
          {explanation}
        </Dialog>
      )}
    </span>
  );
}
