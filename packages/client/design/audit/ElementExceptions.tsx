import allowlist from "../census/button-allowlist.json";
import styles from "./Audit.module.css";
import { AllowanceGroup } from "./AuditRows";

export function ElementExceptions() {
  return (
    <div className={styles.groups}>
      <AllowanceGroup
        title="Raw buttons"
        element="<button>"
        entries={allowlist.rawButtons}
        close="Adopt Button, IconButton or a qualified shared choice pattern; preserve CSS-independent crash recovery, and remove cleared counts."
      />
      <AllowanceGroup
        title="Button roles"
        element={'role="button"'}
        entries={allowlist.roleButtons}
        close="Use a semantic ButtonBase or link while preserving nested content and keyboard behavior, then lower the count."
      />
      <AllowanceGroup
        title="Button look rules"
        element="Bare button selector"
        entries={allowlist.buttonLookRules}
        close="Move the look into the shared control or its owning module; retain only deliberate base inheritance and lower cleared counts."
      />
      <AllowanceGroup
        title="Selection roles"
        element="switch / radio / radiogroup role"
        entries={allowlist.selectionRoles}
        close="Adopt Switch or SegmentedControl and lower the count."
      />
      <AllowanceGroup
        title="Menu roles"
        element="menu / menuitem role"
        entries={allowlist.menuRoles}
        close="Adopt Menu and MenuItem and lower the count."
      />
      <AllowanceGroup
        title="Document listeners"
        element="Document / window press or focus listener"
        entries={allowlist.outsidePressListeners}
        close="Move outside dismissal to Popover; retain documented selection, gesture and routing listeners until their owning behavior is removed or consolidated."
      />
      <AllowanceGroup
        title="Raw fields"
        element="<input> / <select> / <textarea>"
        entries={allowlist.rawFields}
        close="Qualify Field or a shared chromeless/editor pattern while preserving sizing and sequential input acknowledgement, then lower the count."
      />
      <AllowanceGroup
        title="Field look rules"
        element="Bare input / select / textarea selector"
        entries={allowlist.fieldLookRules}
        close="Move the field look into shared controls; retain deliberate base inheritance and lower cleared counts."
      />
      <AllowanceGroup
        title="Tab roles"
        element="tab / tablist / tabpanel role"
        entries={allowlist.tabRoles}
        close="Adopt Tabs and TabPanel and lower the count."
      />
      <AllowanceGroup
        title="Rotating keyframes"
        element="@keyframes rotation"
        entries={allowlist.spinKeyframes}
        close="Use Spinner and remove the old keyframes, then lower the count."
      />
      <AllowanceGroup
        title="Native dialogs"
        element="window.confirm / alert / prompt"
        entries={allowlist.nativeDialogs}
        close="Use confirmDialog or promptDialog and lower the count."
      />
      <AllowanceGroup
        title="Modal roles"
        element="aria-modal / alertdialog"
        entries={allowlist.modalRoles}
        close="Qualify Dialog or a shared anchored/editor pattern; retain intentional inline announcements while required and lower cleared counts."
      />
      <AllowanceGroup
        title="Modal frame rules"
        element="Modal frame reach-in selector"
        entries={allowlist.modalFrameRules}
        close="Move sizing and spacing into Dialog or a shared viewer surface API, then lower the count; viewers may continue using Modal."
      />
    </div>
  );
}
