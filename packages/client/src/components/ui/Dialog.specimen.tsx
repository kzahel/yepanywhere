import { type ReactNode, useState } from "react";
import type { SpecimenMeta } from "../../../design/specimen";
import { Button } from "./Button";
import { ConfirmDialogHost, confirmDialog } from "./ConfirmDialog";
import { Dialog, type DialogProps } from "./Dialog";
import { Field, Select, TextInput } from "./Field";

export default {
  title: "Controls/Dialog",
  component: Dialog,
  parameters: {
    layer: "control",
    description:
      "Dialog from components/ui/Dialog.tsx on Modal: title, optional description, a padded body and a footer action row (Cancel secondary first, one primary or danger last). Sizes small, medium and large; small and medium stay cards on phones. confirmDialog() replaces window.confirm. Each state opens its dialog; capture states isolated.",
  },
} satisfies SpecimenMeta;

/** Open on load, with a button to open it again after closing. */
function Opened({
  label,
  render,
}: {
  label: string;
  render: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <Button onClick={() => setOpen(true)}>{label}</Button>
      {open ? render(() => setOpen(false)) : null}
    </>
  );
}

function ConfirmBox(props: Partial<DialogProps> & { onClose: () => void }) {
  return (
    <Dialog
      size="small"
      role="alertdialog"
      title="Revoke this link?"
      description="Anyone holding it loses access at once. This cannot be undone."
      footer={
        <>
          <Button onClick={props.onClose}>Cancel</Button>
          <Button variant="danger" onClick={props.onClose}>
            Revoke
          </Button>
        </>
      }
      {...props}
    />
  );
}

export function Confirmation() {
  return (
    <Opened
      label="Revoke link"
      render={(close) => <ConfirmBox onClose={close} />}
    />
  );
}

export function Form() {
  return (
    <Opened
      label="Rename session"
      render={(close) => (
        <Dialog
          title="Session defaults"
          description="New sessions in this project start with these settings."
          onClose={close}
          footer={
            <>
              <Button onClick={close}>Cancel</Button>
              <Button
                type="submit"
                form="specimen-dialog-form"
                variant="primary"
              >
                Save
              </Button>
            </>
          }
        >
          <form
            id="specimen-dialog-form"
            onSubmit={(event) => {
              event.preventDefault();
              close();
            }}
            style={{ display: "grid", gap: "var(--space-3)" }}
          >
            <Field label="Name" hint="Shown in the session list.">
              <TextInput defaultValue="Refactor the session list" />
            </Field>
            <Field label="Model">
              <Select defaultValue="opus">
                <option value="opus">Opus</option>
                <option value="sonnet">Sonnet</option>
              </Select>
            </Field>
          </form>
        </Dialog>
      )}
    />
  );
}

export function LargeWithFooterStart() {
  return (
    <Opened
      label="Set up"
      render={(close) => (
        <Dialog
          size="large"
          title="Welcome"
          onClose={close}
          footerStart={
            <Button variant="ghost" onClick={close}>
              Skip
            </Button>
          }
          footer={
            <>
              <Button onClick={close}>Back</Button>
              <Button variant="primary" onClick={close}>
                Next
              </Button>
            </>
          }
        >
          <p>
            A large dialog holds a longer form, a list or a step of a setup
            flow. On phones it fills the screen like a viewer.
          </p>
          {Array.from({ length: 8 }, (_, index) => (
            <p key={index}>
              Step detail {index + 1}: the body scrolls between the header and
              the footer, which stay in place.
            </p>
          ))}
        </Dialog>
      )}
    />
  );
}

export function ConfirmHelper() {
  const [answer, setAnswer] = useState<string>("Not asked yet");
  return (
    <>
      <ConfirmDialogHost />
      <div
        style={{ display: "flex", gap: "var(--space-2)", alignItems: "center" }}
      >
        <Button
          onClick={async () => {
            const confirmed = await confirmDialog({
              title: "Delete user ada?",
              message: "Their sessions stay; they can no longer sign in.",
              confirmLabel: "Delete",
              tone: "danger",
            });
            setAnswer(confirmed ? "Deleted" : "Kept");
          }}
        >
          Delete user
        </Button>
        <span>{answer}</span>
      </div>
    </>
  );
}
