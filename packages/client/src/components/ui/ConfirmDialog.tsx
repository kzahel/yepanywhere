/**
 * The styled confirmation (plan 182, family 7; topics/ui-design.md,
 * "Dialogs"), in place of `window.confirm`.
 *
 *   if (!(await confirmDialog({ title, message, confirmLabel, tone }))) return;
 *
 * resolves `true` for the confirm button and `false` for Cancel, Escape,
 * Android back or the overlay. It is a small `alertdialog`: the title says
 * what is about to happen ("Delete user?"), `message` the consequence, the
 * confirm button names the action ("Delete") and is `danger` for a
 * destructive one, `primary` otherwise. Focus starts on Cancel for a danger
 * confirmation and on the action otherwise.
 *
 * One `ConfirmDialogHost`, inside the I18nProvider of each entrypoint, shows
 * the requests one at a time. Without a mounted host (a component test
 * that renders a page alone) `confirmDialog` falls back to `window.confirm`
 * with the message, so such tests answer it the old way.
 *
 * `promptDialog` asks for one line of text the same way, in place of
 * `window.prompt`: it resolves the trimmed answer, or `null` when cancelled
 * or left empty.
 *
 * `pnpm buttons:check` rejects `window.confirm`, `alert` and `prompt`
 * outside this file.
 */
import {
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useI18n } from "../../i18n";
import { Button } from "./Button";
import { Dialog } from "./Dialog";
import { Field, TextInput } from "./Field";

export interface ConfirmOptions {
  /** What is about to happen, as a short question: "Delete this link?" */
  title: string;
  /** The consequence, one or two sentences. */
  message?: string;
  /** The action, as a verb: "Delete". */
  confirmLabel: string;
  /** Default: the translated "Cancel". */
  cancelLabel?: string;
  /** `danger` for a destructive or irreversible action. */
  tone?: "default" | "danger";
}

export interface PromptOptions {
  /** What the answer is for: "Copy project". */
  title: string;
  message?: string;
  /** The field's label: "New project name". */
  label: string;
  defaultValue?: string;
  confirmLabel: string;
  cancelLabel?: string;
}

type ConfirmRequest = { id: number } & (
  | (ConfirmOptions & {
      kind: "confirm";
      resolve: (confirmed: boolean) => void;
    })
  | (PromptOptions & {
      kind: "prompt";
      resolve: (answer: string | null) => void;
    })
);

let requests: readonly ConfirmRequest[] = [];
let requestSequence = 0;
let mountedHosts = 0;
const listeners = new Set<() => void>();

function publish(next: readonly ConfirmRequest[]) {
  requests = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** `answer`: confirmed or not, or a prompt's text (`null` if cancelled). */
function settle(id: number, answer: boolean | string | null) {
  const request = requests.find((candidate) => candidate.id === id);
  if (!request) return;
  publish(requests.filter((candidate) => candidate.id !== id));
  if (request.kind === "confirm") request.resolve(answer === true);
  else request.resolve(typeof answer === "string" && answer ? answer : null);
}

/**
 * The same question asked again while it is still open (a double click on
 * the button that asks) is answered "no" at once: the open one decides.
 */
function alreadyAsked(title: string, message: string | undefined) {
  return requests.some(
    (request) => request.title === title && request.message === message,
  );
}

function enqueue(request: Omit<ConfirmRequest, "id">) {
  requestSequence += 1;
  publish([...requests, { ...request, id: requestSequence } as ConfirmRequest]);
}

/** Ask the user to confirm an action; resolves whether they did. */
export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  if (mountedHosts === 0) {
    return Promise.resolve(window.confirm(options.message ?? options.title));
  }
  if (alreadyAsked(options.title, options.message))
    return Promise.resolve(false);
  return new Promise((resolve) => {
    enqueue({ ...options, kind: "confirm", resolve });
  });
}

/** Ask for one line of text; resolves it trimmed, or `null`. */
export function promptDialog(options: PromptOptions): Promise<string | null> {
  if (mountedHosts === 0) {
    const answer = window.prompt(
      options.message ?? options.label,
      options.defaultValue,
    );
    return Promise.resolve(answer?.trim() || null);
  }
  if (alreadyAsked(options.title, options.message))
    return Promise.resolve(null);
  return new Promise((resolve) => {
    enqueue({ ...options, kind: "prompt", resolve });
  });
}

function PromptDialogView({
  request,
}: {
  request: Extract<ConfirmRequest, { kind: "prompt" }>;
}) {
  const { t } = useI18n();
  const formId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(request.defaultValue ?? "");
  return (
    <Dialog
      size="small"
      title={request.title}
      description={request.message}
      onClose={() => settle(request.id, null)}
      initialFocusRef={inputRef}
      data-testid="prompt-dialog"
      footer={
        <>
          <Button onClick={() => settle(request.id, null)}>
            {request.cancelLabel ?? t("modalCancel")}
          </Button>
          <Button
            type="submit"
            form={formId}
            variant="primary"
            disabled={!value.trim()}
          >
            {request.confirmLabel}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        onSubmit={(event) => {
          event.preventDefault();
          if (value.trim()) settle(request.id, value.trim());
        }}
      >
        <Field label={request.label}>
          <TextInput
            ref={inputRef}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            onFocus={(event) => event.currentTarget.select()}
          />
        </Field>
      </form>
    </Dialog>
  );
}

function ConfirmDialogView({
  request,
}: {
  request: Extract<ConfirmRequest, { kind: "confirm" }>;
}) {
  const { t } = useI18n();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const danger = request.tone === "danger";
  return (
    <Dialog
      size="small"
      role="alertdialog"
      title={request.title}
      description={request.message}
      onClose={() => settle(request.id, false)}
      initialFocusRef={danger ? cancelRef : confirmRef}
      data-testid="confirm-dialog"
      footer={
        <>
          <Button ref={cancelRef} onClick={() => settle(request.id, false)}>
            {request.cancelLabel ?? t("modalCancel")}
          </Button>
          <Button
            ref={confirmRef}
            variant={danger ? "danger" : "primary"}
            onClick={() => settle(request.id, true)}
          >
            {request.confirmLabel}
          </Button>
        </>
      }
    />
  );
}

/** Shows `confirmDialog` and `promptDialog` requests; mount once per entrypoint. */
export function ConfirmDialogHost() {
  const pending = useSyncExternalStore(
    subscribe,
    () => requests,
    () => requests,
  );
  useEffect(() => {
    mountedHosts += 1;
    return () => {
      mountedHosts -= 1;
      if (mountedHosts === 0) {
        for (const request of requests) settle(request.id, null);
      }
    };
  }, []);
  const current = pending[0];
  if (!current) return null;
  return current.kind === "prompt" ? (
    <PromptDialogView key={current.id} request={current} />
  ) : (
    <ConfirmDialogView key={current.id} request={current} />
  );
}
