import type { SessionCreationStore } from "../sessions/SessionCreationStore.js";
import {
  thinkingOptionToConfig,
  type UrlProjectId,
} from "@yep-anywhere/shared";
import type { Supervisor } from "../supervisor/Supervisor.js";
import type { Process } from "../supervisor/Process.js";
import type { SessionCommandOwner } from "./session-commands.js";
import { CoreApiError } from "./errors.js";
import {
  RouterRefusedBeforeProvider,
  type RouterBindingRef,
  routerSelectionFromBinding,
} from "../services/AgentAuthRouter.js";

/** Uses incumbent native ownership. Monitoring is shared per process, not caller. */
export function nativeSessionCommandOwner(deps: {
  supervisor: Pick<
    Supervisor,
    "startSession" | "getAllProcesses" | "getProcessForSession"
  >;
  globalInstructions: () => string | undefined;
  creations?: SessionCreationStore;
  /**
   * The calling session's router pin and model, so a child of a routed
   * session runs on the router rather than the owner's direct login.
   */
  callerLaunch?: (
    sessionId: string,
  ) => { routerBinding?: RouterBindingRef; model?: string } | undefined;
}): SessionCommandOwner {
  type Watch = {
    pending: Map<string, { consumed: () => void; ended: () => void }>;
    release: () => void;
  };
  const watches = new Map<Process, Watch>();
  let pending = 0;
  const watch = (
    process: Process,
    id: string,
    consumed: () => void,
    ended: () => void,
  ) => {
    if (process.hasConsumedApiInput(id)) {
      consumed();
      return () => {};
    }
    if (process.isTerminated) {
      ended();
      return () => {};
    }
    if (watches.get(process)?.pending.has(id)) return () => {};
    if (pending >= 1024 || (!watches.has(process) && watches.size >= 128))
      throw new CoreApiError(
        "command_capacity",
        "Native input observation capacity reached",
        503,
      );
    let current = watches.get(process);
    if (!current) {
      const entry: Watch = { pending: new Map(), release: () => {} };
      const take = (id: string) => {
        const target = entry.pending.get(id);
        if (!target) return;
        entry.pending.delete(id);
        pending--;
        if (!entry.pending.size) entry.release();
        target.consumed();
      };
      const unsubscribeInput = process.observeApiInputConsumed(take);
      const unsubscribeCancelled = process.observeApiInputCancelled((id) => {
        const target = entry.pending.get(id);
        if (!target) return;
        entry.pending.delete(id);
        pending--;
        if (!entry.pending.size) entry.release();
        target.ended();
      });
      const unsubscribeState = process.subscribe((event) => {
        if (
          (event.type === "state-change" &&
            event.state.type === "terminated") ||
          event.type === "terminated" ||
          event.type === "complete"
        ) {
          const targets = [...entry.pending.values()];
          pending -= entry.pending.size;
          entry.pending.clear();
          entry.release();
          for (const target of targets) target.ended();
        }
      });
      entry.release = () => {
        unsubscribeInput();
        unsubscribeCancelled();
        unsubscribeState();
        if (watches.get(process) === entry) watches.delete(process);
      };
      watches.set(process, entry);
      current = entry;
    }
    const acquired = current;
    if (acquired.pending.has(id)) return () => {};
    acquired.pending.set(id, { consumed, ended });
    pending++;
    return () => {
      if (acquired.pending.delete(id)) pending--;
      if (!acquired.pending.size) acquired.release();
    };
  };
  return {
    close() {
      for (const entry of watches.values()) entry.release();
      watches.clear();
      pending = 0;
    },
    canSend(id) {
      const process = deps.supervisor.getProcessForSession(id);
      return Boolean(process && !process.isTerminated);
    },
    send(id, request, receipt, consumed, ended) {
      const process = deps.supervisor.getProcessForSession(id);
      if (!process || process.isTerminated) return { accepted: false };
      const release = watch(process, receipt.id, consumed, ended);
      try {
        process.noteInputIntent();
        const result = process.queueMessage(
          {
            text: request.message,
            uuid: receipt.id,
            tempId: receipt.id,
            metadata: {
              apiSubmissionId: receipt.id,
              origin: "coordination",
              sourceSessionId:
                receipt.creator.principal.kind === "peer"
                  ? undefined
                  : (receipt.creator.sessionId ?? undefined),
              serverReceivedAt: receipt.createdAt,
            },
          },
          { allowSteer: false },
        );
        if (!result.success) release();
        return { accepted: result.success };
      } catch (error) {
        release();
        throw error;
      }
    },
    async recover(receipt, consumed, ended) {
      const saved =
        receipt.kind === "createSession"
          ? deps.creations?.get({ kind: "superuser" }, receipt.id)
          : undefined;
      if (
        saved &&
        !saved.deleted &&
        saved.request?.input?.nativeReceiptId === receipt.id &&
        saved.initialInputId === receipt.id &&
        saved.attempt.delivery === "consumed"
      )
        return { sessionId: saved.sessionId, consumed: true };
      const bound = receipt.sessionId
        ? deps.supervisor.getProcessForSession(receipt.sessionId)
        : undefined;
      if (receipt.sessionId && !bound) return;
      const processes = bound ? [bound] : deps.supervisor.getAllProcesses();
      if (processes.length > 256) return;
      // Inherited transcript UUIDs are not proof of this process's admission.
      const candidates = processes.filter(
        (process) =>
          !process.isTerminated &&
          (process.hasConsumedApiInput(receipt.id) ||
            process.hasAcceptedApiInput(receipt.id)),
      );
      if (candidates.length !== 1) return;
      const process = candidates[0]!;
      if (consumed && ended) watch(process, receipt.id, consumed, ended);
      return {
        sessionId: process.sessionId,
        consumed: process.hasConsumedApiInput(receipt.id),
      };
    },
    async start(
      project,
      request,
      receipt,
      settled,
      failed,
      consumed = () => {},
      admitted = () => {},
      authorize = async () => {},
    ) {
      const thinking = request.thinking
        ? thinkingOptionToConfig(request.thinking)
        : { thinking: undefined, effort: undefined };
      const callerId =
        receipt.creator.principal.kind === "peer"
          ? undefined
          : (receipt.creator.sessionId ?? undefined);
      const caller = callerId ? deps.callerLaunch?.(callerId) : undefined;
      // A routed caller's child gets a fresh pick from the caller's pool, or
      // its explicit account through a new pin (plan 183); never Direct.
      const routed = caller?.routerBinding;
      let model = request.model === "default" ? undefined : request.model;
      if (routed) {
        if (routed.provider !== request.provider)
          return {
            rejected: true,
            message: `This session runs on an Agent Auth Router ${routed.provider} account, so it can start only ${routed.provider} sessions, which use the same router pool or account.`,
          };
        model ??= caller.model;
        if (!model)
          return {
            rejected: true,
            message:
              "Name a model: a session started from a router session needs one its router account offers.",
          };
      }
      let result: Awaited<ReturnType<Supervisor["startSession"]>>;
      try {
        result = await deps.supervisor.startSession(
          project.path,
          {
            text: request.message,
            uuid: receipt.id,
            tempId: receipt.id,
            metadata: {
              apiSubmissionId: receipt.id,
              origin: "coordination",
              sourceSessionId:
                receipt.creator.principal.kind === "peer"
                  ? undefined
                  : (receipt.creator.sessionId ?? undefined),
              serverReceivedAt: receipt.createdAt,
            },
          },
          request.permissionMode,
          {
            providerName: request.provider,
            model,
            requestedModel: request.model ?? model,
            ...thinking,
            ...(routed ? routerSelectionFromBinding(routed) : {}),
            serviceTier: request.serviceTier,
            globalInstructions: deps.globalInstructions(),
            recapMode: "off",
            promptSuggestionMode: "off",
          },
          {
            projectId: project.id as UrlProjectId,
            creation: {
              requestId: receipt.id,
              nativeReceiptId: receipt.id,
              context: {
                owner: { kind: "superuser" },
                source: { kind: "request", provenance: { surface: "api" } },
              },
              authorize,
              onAccepted: (saved) => admitted(saved.sessionId),
            },
            requireProviderSessionId: true,
            onStarted: (id, process) => {
              settled(id);
              try {
                watch(process, receipt.id, consumed, failed);
              } catch {
                failed();
              }
            },
            onFailed: failed,
            onRetryableFailure: failed,
          },
        );
      } catch (error) {
        // A router refusal precedes any provider start: a known rejection,
        // not an uncertain launch.
        if (error instanceof RouterRefusedBeforeProvider)
          return { rejected: true, message: error.message };
        throw error;
      }
      if ("error" in result) return { rejected: true };
      if ("queued" in result) return { queueId: result.queueId };
      return { sessionId: result.sessionId };
    },
  };
}
